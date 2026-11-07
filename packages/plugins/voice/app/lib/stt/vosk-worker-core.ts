/**
 * The Vosk worker's behaviour, with the worker taken out: what it does with each message.
 *
 * `src/worker/vosk-worker.ts` is the composition root — it binds the Vosk runtime (`vosk-runtime.ts`)
 * and the worker's `postMessage` to the ports here, and nothing else. Every decision is in this class,
 * where a test drives it with a fake runtime:
 *
 *   - the model is loaded lazily, once, and a failed load is not remembered, so the next dictation
 *     genuinely retries;
 *   - loading reads the INSTALLED bytes through the store, which verifies them again — the worker has
 *     no network path and never downloads;
 *   - Vosk STREAMS: one recognizer per utterance is fed audio as the person speaks, and answers with
 *     the words so far after every chunk. Words an endpoint closed are COMMITTED (Vosk never revises
 *     them); the words after the last endpoint are INTERIM. Only a change is posted;
 *   - one message at a time, in arrival order, on one queue: the runtime has no concurrency contract.
 */

import type { VoskLoadedModel, VoskRuntime, VoskStreamingRecognizer } from './vosk-runtime.ts';

/** Vosk is fed at the rate the shared audio capture decodes to. */
export const VOSK_SAMPLE_RATE = 16_000;

/** Messages the page sends the worker. */
export type VoskWorkerRequest =
  | { readonly type: 'load' }
  | { readonly type: 'open'; readonly id: number }
  | { readonly type: 'audio'; readonly id: number; readonly samples: Float32Array }
  | { readonly type: 'finish'; readonly id: number }
  | { readonly type: 'close'; readonly id: number };

export type VoskWorkerFailure = 'not-installed' | 'integrity' | 'load-failed' | 'transcribe-failed';

/** Messages the worker sends back. */
export type VoskWorkerReply =
  | { readonly type: 'ready' }
  | { readonly type: 'heard'; readonly id: number; readonly committed: string; readonly interim: string }
  | { readonly type: 'result'; readonly id: number; readonly text: string }
  | {
      readonly type: 'failed';
      /** The utterance that failed, or `null` for a `load` nobody is waiting on. */
      readonly id: number | null;
      readonly code: VoskWorkerFailure;
      readonly message: string;
    };

export interface VoskWorkerCoreOptions {
  /** Reads and re-verifies the installed bundle, by role. */
  read(): Promise<ReadonlyMap<string, Uint8Array>>;
  readonly runtime: VoskRuntime;
  post(reply: VoskWorkerReply): void;
}

const isId = (value: unknown): value is number => Number.isSafeInteger(value);

/** Parse a message from the page; anything else is ignored rather than trusted. */
export const parseVoskRequest = (data: unknown): VoskWorkerRequest | null => {
  if (typeof data !== 'object' || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.type === 'load') return { type: 'load' };
  if (!isId(message.id)) return null;
  if (message.type === 'audio')
    return message.samples instanceof Float32Array ? { type: 'audio', id: message.id, samples: message.samples } : null;
  if (message.type === 'open' || message.type === 'finish' || message.type === 'close')
    return { type: message.type, id: message.id };
  return null;
};

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim() !== '' ? error.message : fallback;

const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

/** Words in reading order, with one space between non-empty parts. */
const joined = (parts: readonly string[]): string => parts.filter(part => part !== '').join(' ');

/** One utterance in the worker. */
interface Utterance {
  readonly recognizer: VoskStreamingRecognizer;
  /** Text each endpoint closed, in order. */
  readonly committed: string[];
  interim: string;
}

export class VoskWorkerCore {
  readonly #options: VoskWorkerCoreOptions;
  readonly #utterances = new Map<number, Utterance>();
  #model: VoskLoadedModel | null = null;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: VoskWorkerCoreOptions) {
    this.#options = options;
  }

  /** Queue one message. Resolves once it has been handled. */
  handle(data: unknown): Promise<void> {
    const request = parseVoskRequest(data);
    if (request === null) return Promise.resolve();
    const run = this.#tail.then(() => this.#run(request));
    this.#tail = run;
    return run;
  }

  async #run(request: VoskWorkerRequest): Promise<void> {
    if (request.type === 'load' || request.type === 'open') {
      await this.#open(request.type === 'open' ? request.id : null);
      return;
    }
    const utterance = this.#utterances.get(request.id);
    if (request.type === 'close') {
      this.#utterances.delete(request.id);
      utterance?.recognizer.free();
      return;
    }
    if (utterance === undefined) {
      // Audio for an utterance that failed to open, or was closed, has nobody left to hear it.
      if (request.type === 'finish') this.#failed(request.id, 'transcribe-failed', 'Dictation already ended.');
      return;
    }
    try {
      if (request.type === 'audio') this.#hear(request.id, utterance, request.samples);
      else {
        this.#utterances.delete(request.id);
        const tail = utterance.recognizer.finish();
        this.#options.post({ type: 'result', id: request.id, text: joined([...utterance.committed, tail]) });
      }
    } catch (error) {
      this.#utterances.delete(request.id);
      utterance.recognizer.free();
      this.#failed(request.id, 'transcribe-failed', messageOf(error, 'Vosk could not transcribe that.'));
    }
  }

  async #open(id: number | null): Promise<void> {
    let model: VoskLoadedModel;
    try {
      model = await this.#load();
    } catch (error) {
      const code = codeOf(error);
      this.#failed(
        id,
        code === 'not-installed' || code === 'integrity' ? code : 'load-failed',
        messageOf(error, 'The Vosk speech model could not be loaded.'),
      );
      return;
    }
    if (id === null) {
      this.#options.post({ type: 'ready' });
      return;
    }
    try {
      this.#utterances.get(id)?.recognizer.free();
      this.#utterances.set(id, { recognizer: model.recognizer(VOSK_SAMPLE_RATE), committed: [], interim: '' });
    } catch (error) {
      this.#failed(id, 'load-failed', messageOf(error, 'Vosk could not start listening.'));
    }
  }

  #hear(id: number, utterance: Utterance, samples: Float32Array): void {
    const heard = utterance.recognizer.accept(samples);
    const before = { committed: utterance.committed.length, interim: utterance.interim };
    if (heard.endpoint) {
      if (heard.text !== '') utterance.committed.push(heard.text);
      utterance.interim = '';
    } else utterance.interim = heard.text;
    if (utterance.committed.length === before.committed && utterance.interim === before.interim) return;
    this.#options.post({ type: 'heard', id, committed: joined(utterance.committed), interim: utterance.interim });
  }

  #failed(id: number | null, code: VoskWorkerFailure, message: string): void {
    this.#options.post({ type: 'failed', id, code, message });
  }

  async #load(): Promise<VoskLoadedModel> {
    if (this.#model !== null) return this.#model;
    const model = await this.#options.runtime.load(await this.#options.read());
    this.#model = model;
    return model;
  }
}
