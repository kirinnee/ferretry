/**
 * The Google transcriber worker's behaviour, with the worker taken out: what it does with each message.
 *
 * `app/worker/google-worker.ts` is the composition root — it binds MediaPipe's `AudioTranscriber` to
 * {@link GoogleTranscriberPort} and the worker's `postMessage` to `post`, and nothing else. Every decision is here,
 * where a test drives it with a fake transcriber. The page talks to this worker through the sherpa worker's protocol
 * (`SherpaWorkerRequest` / `SherpaWorkerReply`, `SherpaEngine`), because what a page needs from a live engine is the
 * same: load once, open a stream, push slices, read the words so far, close for the text.
 *
 *   - the model is loaded lazily, once, from the INSTALLED bytes the store verifies again on the way out — the worker has
 *     no network path and never downloads — and a failed load is not remembered;
 *   - one message at a time, in arrival order: MediaPipe's transcriber is ONE stateful stream, with no concurrency
 *     contract, so opening a take while another is open ends the old one first;
 *   - HOW THE WORDS ARRIVE. The transcriber works in 5 s windows that advance 2.5 s at a time. Each advance answers
 *     with the oldest 2.5 s as a FINAL segment — those words never change — and the 5 s ahead of it as an INTERIM
 *     segment that the next answer replaces. A slice that completes no advance answers nothing. So `committed` is every
 *     final so far, joined, and `interim` is the latest interim; closing flushes the tail as finals and answers the
 *     whole text. Punctuation and capitals come from the model, so nothing is rewritten here.
 */

import { onDeviceModel } from './model-catalog.ts';
import type { GoogleCatalogModel } from './google-transcriber-model.ts';
import { parseSherpaRequest, type SherpaWorkerReply, type SherpaWorkerRequest } from './sherpa-worker-core.ts';

/** One transcribed segment, as MediaPipe answers it. */
export interface GoogleSegment {
  readonly transcript: string;
  readonly isFinal: boolean;
}

/** What one call to the transcriber answers: the segments it newly emitted (none when it emitted nothing). */
export interface GoogleResult {
  readonly segments: readonly GoogleSegment[];
}

/** The slice of MediaPipe's `AudioTranscriber` this worker uses. */
export interface GoogleTranscriberPort {
  /** Feed the next slice of one continuous stream. */
  transcribeStream(samples: Float32Array): Promise<GoogleResult>;
  /** No more audio: flush what is left, as finals, and end the stream (the next call starts a new one). */
  finishStream(): Promise<GoogleResult>;
}

/** Turns the runtime binary and the model bytes into a transcriber. */
interface GoogleRuntime {
  load(runtime: Uint8Array, model: Uint8Array): Promise<GoogleTranscriberPort>;
}

interface GoogleInstalledBytes {
  readonly runtime: Uint8Array;
  readonly model: Uint8Array;
}

export interface GoogleWorkerCoreOptions {
  /** Reads and re-verifies the installed runtime and model. */
  read(model: GoogleCatalogModel): Promise<GoogleInstalledBytes>;
  readonly runtime: GoogleRuntime;
  post(reply: SherpaWorkerReply): void;
  /** Milliseconds on a monotonic clock, for the load time. */
  now(): number;
  /** The catalog entry for a model id; the shipped catalog by default, a suite's own otherwise. */
  readonly lookup?: (id: string) => GoogleCatalogModel | null;
}

const catalogLookup = (id: string): GoogleCatalogModel | null => {
  const model = onDeviceModel(id);
  return model?.runtime === 'mediapipe-audio' ? model : null;
};

/** Words joined by single spaces, empty parts dropped. */
const join = (parts: readonly string[]): string =>
  parts
    .map(part => part.trim())
    .filter(Boolean)
    .join(' ');

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim() !== '' ? error.message : fallback;

const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

interface OpenStream {
  readonly id: number;
  readonly finals: string[];
  interim: string;
}

export class GoogleWorkerCore {
  readonly #options: GoogleWorkerCoreOptions;
  #model: GoogleCatalogModel | null = null;
  #loaded: GoogleTranscriberPort | null = null;
  #open: OpenStream | null = null;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: GoogleWorkerCoreOptions) {
    this.#options = options;
  }

  /** Queue one message. Resolves once it has been answered. */
  handle(data: unknown): Promise<void> {
    const request = parseSherpaRequest(data);
    if (request === null) return Promise.resolve();
    const run = this.#tail.then(() => this.#run(request));
    this.#tail = run;
    return run;
  }

  async #run(request: SherpaWorkerRequest): Promise<void> {
    if (request.type === 'load') {
      const model = (this.#options.lookup ?? catalogLookup)(request.model);
      if (model !== null && this.#model === null) this.#model = model;
    }
    const id = request.type === 'load' ? null : request.id;
    let transcriber: GoogleTranscriberPort;
    try {
      transcriber = await this.#load();
    } catch (error) {
      const code = codeOf(error);
      this.#options.post({
        type: 'failed',
        id,
        code: code === 'not-installed' || code === 'integrity' ? code : 'load-failed',
        message: messageOf(error, 'The on-device speech model could not be loaded.'),
      });
      return;
    }
    if (request.type === 'load') return;
    try {
      await this.#answer(request, transcriber);
    } catch (error) {
      if (this.#open?.id === request.id) this.#open = null;
      this.#options.post({
        type: 'failed',
        id: request.id,
        code: 'transcribe-failed',
        message: messageOf(error, 'The on-device speech model could not transcribe that.'),
      });
    }
  }

  async #answer(
    request: Exclude<SherpaWorkerRequest, { type: 'load' }>,
    transcriber: GoogleTranscriberPort,
  ): Promise<void> {
    const post = this.#options.post;
    if (request.type === 'transcribe')
      throw new Error('This model listens while you speak; it cannot transcribe a whole take at once.');
    if (request.type === 'stream-open') {
      await this.#end(transcriber);
      this.#open = { id: request.id, finals: [], interim: '' };
      return;
    }
    if (request.type === 'stream-drop') {
      if (this.#open?.id === request.id) await this.#end(transcriber);
      return;
    }
    const stream = this.#open;
    if (stream === null || stream.id !== request.id) throw new Error('That stream is not open.');
    if (request.type === 'stream-push') {
      const result = await transcriber.transcribeStream(request.samples);
      if (result.segments.length === 0) return;
      const interim = result.segments.filter(segment => !segment.isFinal).map(segment => segment.transcript);
      stream.finals.push(...result.segments.filter(segment => segment.isFinal).map(segment => segment.transcript));
      stream.interim = join(interim);
      post({ type: 'partial', id: stream.id, committed: join(stream.finals), interim: stream.interim });
      return;
    }
    const result = await transcriber.finishStream();
    this.#open = null;
    stream.finals.push(...result.segments.map(segment => segment.transcript));
    post({ type: 'result', id: stream.id, text: join(stream.finals) });
  }

  /** End the open stream, if any, so the transcriber starts the next one clean. What it heard is dropped. */
  async #end(transcriber: GoogleTranscriberPort): Promise<void> {
    if (this.#open === null) return;
    this.#open = null;
    await transcriber.finishStream();
  }

  async #load(): Promise<GoogleTranscriberPort> {
    if (this.#loaded !== null) return this.#loaded;
    const model = this.#model;
    if (model === null) throw new Error('No Google transcriber model was named before the first request.');
    const startedAt = this.#options.now();
    const { runtime, model: bytes } = await this.#options.read(model);
    const loaded = await this.#options.runtime.load(runtime, bytes);
    this.#loaded = loaded;
    this.#options.post({ type: 'ready', loadMs: Math.max(0, this.#options.now() - startedAt) });
    return loaded;
  }
}
