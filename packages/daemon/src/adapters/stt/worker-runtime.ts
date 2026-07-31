import { STT_SAMPLE_RATE, type SttWorkerModel, type SttWorkerResponse } from '@ferretry/protocol';
import {
  audioDurationMs,
  audioRefusal,
  boundedWorkerMessage,
  classifyLoadFailure,
  isValidThreadCount,
  parseWorkerRequest,
  requestIdOf,
  sameWorkerModel,
  workerErrorResponse,
} from '../../lib/index.ts';

/** One loaded recognizer. Implemented by the native adapter, faked in tests. */
export interface SttRecognizer {
  transcribe(samples: Float32Array, sampleRate: number): string;
}

export interface SttRecognizerFactory {
  create(model: SttWorkerModel, threads: number): Promise<SttRecognizer>;
}

/** The child's side of the parent channel. */
export interface SttWorkerChannel {
  send(message: SttWorkerResponse): void;
  onMessage(handler: (message: unknown) => void): void;
  disconnect(): void;
}

export interface SttWorkerRuntimeClock {
  monotonicMs(): number;
}

/**
 * The worker's request loop, running inside the child process.
 *
 * Requests are serialized: the recognizer is single-threaded and a decode holds
 * the loop, so a second request must queue rather than interleave. Every reply
 * carries the request id it answers, and every failure is one of the narrow
 * worker codes — the child never throws at the parent.
 */
export class SttWorkerRuntime {
  private recognizer: SttRecognizer | undefined;
  private loaded: SttWorkerModel | undefined;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly channel: SttWorkerChannel,
    private readonly factory: SttRecognizerFactory,
    private readonly clock: SttWorkerRuntimeClock,
    private readonly onShutdown: () => void = () => {},
  ) {}

  /** Attach to the channel. Every message is handled in arrival order. */
  start(): void {
    this.channel.onMessage(message => {
      this.queue = this.queue
        .then(() => this.handle(message))
        .catch((error: unknown) => {
          this.reply(workerErrorResponse('decode_failed', boundedWorkerMessage(error, 'worker message failed')));
        });
    });
  }

  /** Resolves once every queued request has been answered. */
  async drain(): Promise<void> {
    await this.queue;
  }

  private reply(message: SttWorkerResponse): void {
    if (this.stopped) return;
    this.channel.send(message);
  }

  private async handle(message: unknown): Promise<void> {
    const request = parseWorkerRequest(message);
    if (request === undefined) {
      this.reply(workerErrorResponse('bad_request', 'invalid STT worker message', requestIdOf(message)));
      return;
    }
    if (request.type === 'shutdown') {
      this.recognizer = undefined;
      this.loaded = undefined;
      this.reply({ type: 'bye' });
      this.stopped = true;
      this.channel.disconnect();
      this.onShutdown();
      return;
    }
    if (request.type === 'load') {
      await this.load(request.model, request.threads, request.requestId);
      return;
    }
    this.transcribe(request.audio, request.requestId);
  }

  private async load(model: SttWorkerModel, threads: number, requestId: string): Promise<void> {
    if (!isValidThreadCount(threads)) {
      this.reply(workerErrorResponse('bad_request', 'thread count is out of range', requestId));
      return;
    }
    if (this.recognizer !== undefined && sameWorkerModel(this.loaded, model)) {
      this.reply({ type: 'ready', requestId, modelId: model.id, loadMs: 0 });
      return;
    }
    const startedAt = this.clock.monotonicMs();
    try {
      this.recognizer = await this.factory.create(model, threads);
      this.loaded = model;
      this.reply({
        type: 'ready',
        requestId,
        modelId: model.id,
        loadMs: Math.max(0, this.clock.monotonicMs() - startedAt),
      });
    } catch (error) {
      this.recognizer = undefined;
      this.loaded = undefined;
      this.reply(
        workerErrorResponse(classifyLoadFailure(error), boundedWorkerMessage(error, 'model load failed'), requestId),
      );
    }
  }

  private transcribe(samples: Float32Array, requestId: string): void {
    const recognizer = this.recognizer;
    const model = this.loaded;
    if (recognizer === undefined || model === undefined) {
      this.reply(workerErrorResponse('model_missing', 'the batch model is not loaded', requestId));
      return;
    }
    const refusal = audioRefusal(samples);
    if (refusal !== undefined) {
      this.reply(workerErrorResponse(refusal.code, refusal.message, requestId));
      return;
    }
    const startedAt = this.clock.monotonicMs();
    try {
      const text = recognizer.transcribe(samples, STT_SAMPLE_RATE);
      this.reply({
        type: 'result',
        requestId,
        modelId: model.id,
        text,
        audioMs: audioDurationMs(samples),
        decodeMs: Math.max(0, this.clock.monotonicMs() - startedAt),
      });
    } catch (error) {
      this.reply(workerErrorResponse('decode_failed', boundedWorkerMessage(error, 'batch decode failed'), requestId));
    }
  }
}
