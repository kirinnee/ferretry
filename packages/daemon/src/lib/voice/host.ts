import { VOICE_IPC_VERSION, VOICE_SAMPLE_RATE, VoiceRecognizerSetSchema, VoiceWorkerResponseSchema } from './ipc.ts';
import type { VoiceFailureCode, VoiceRecognizerSet, VoiceWorkerRequest, VoiceWorkerResponse } from './ipc.ts';
import { VOICE_FINISH_MS, VOICE_IDLE_MS, VOICE_LOAD_MS, voiceMemoryAdmission } from './policy.ts';
import type { VoiceClock, VoiceOutcome, VoiceWorkerHandle, VoiceWorkerSpawner } from './ports.ts';

type Failure = Extract<VoiceOutcome<never>, { ok: false }>;
interface Stream {
  readonly deviceId: string;
  readonly streaming: boolean;
  readonly error: (failure: Failure) => void;
  samples: number;
  finishing: boolean;
}
interface Job {
  readonly request: VoiceWorkerRequest;
  readonly resolve: (result: VoiceOutcome<string>) => void;
  timer?: { cancel(): void };
}
export interface VoiceWorkerHostPorts {
  readonly spawner: VoiceWorkerSpawner;
  readonly recognizers: VoiceRecognizerSet;
  readonly availableMemory: () => Promise<number>;
  readonly clock: VoiceClock;
}

/** One instance per daemon lifetime. Only transports audio; all recognition happens across the port. */
export class VoiceWorkerHost {
  private readonly streams = new Map<string, Stream>();
  private readonly queue: Job[] = [];
  private readonly cancelling = new Map<string, string>();
  private active: Job | undefined;
  private child: VoiceWorkerHandle | undefined;
  private warming: Promise<VoiceOutcome<void>> | undefined;
  private retiring: Promise<void> = Promise.resolve();
  private idle: { cancel(): void } | undefined;
  private generation = 0;
  private counter = 0;
  private loaded = false;
  private switching = false;
  private recognizers: VoiceRecognizerSet;
  private closed = false;
  constructor(private readonly ports: VoiceWorkerHostPorts) {
    this.recognizers = VoiceRecognizerSetSchema.parse(ports.recognizers);
  }

  status(): { state: 'idle' | 'loading' | 'loaded'; placement: VoiceWorkerHandle['placement'] | undefined } {
    return {
      state: this.loaded ? 'loaded' : this.warming === undefined ? 'idle' : 'loading',
      placement: this.child?.placement,
    };
  }
  async open(
    streamId: string,
    deviceId: string,
    error: Stream['error'],
    streaming = false,
  ): Promise<VoiceOutcome<void>> {
    if (this.closed) return fail('voice_cancelled', 'Speech worker is shutting down.');
    if (
      this.switching ||
      this.streams.size + this.cancelling.size >= 2 ||
      this.streams.has(streamId) ||
      this.cancelling.has(streamId) ||
      [...this.streams.values()].some(s => s.deviceId === deviceId) ||
      [...this.cancelling.values()].includes(deviceId)
    )
      return fail('voice_busy', 'This machine accepts two speech streams and one per device.');
    if (!this.recognizers.some(model => model.streaming === streaming))
      return fail('voice_not_installed', 'This speech model is not selected.');
    const stream: Stream = { deviceId, streaming, error, samples: 0, finishing: false };
    this.streams.set(streamId, stream);
    this.idle?.cancel();
    const ready = await this.ensureLoaded();
    if (!ready.ok) {
      if (this.streams.get(streamId) === stream) this.streams.delete(streamId);
      this.scheduleIdle();
      return ready;
    }
    return this.streams.get(streamId) === stream ? ready : fail('voice_cancelled', 'Speech stream was cancelled.');
  }
  audio(streamId: string, samples: Float32Array): Promise<VoiceOutcome<string>> {
    const stream = this.streams.get(streamId);
    if (stream === undefined || stream.finishing || !this.loaded)
      return Promise.resolve(fail('voice_cancelled', 'Speech stream is not listening.'));
    if (samples.length === 0) return Promise.resolve({ ok: true, value: '' });
    if (stream.samples + samples.length > 2 * VOICE_SAMPLE_RATE) {
      const failure = fail('engine_behind', 'Speech worker has more than two seconds of unprocessed audio.');
      this.cancelStream(streamId, failure);
      return Promise.resolve(failure);
    }
    stream.samples += samples.length;
    // Copy once at admission: the caller may reuse its capture buffer before IPC sends this job.
    return this.enqueue({
      ...this.envelope(),
      type: 'audio',
      streamId,
      streaming: stream.streaming,
      samples: samples.slice(),
    });
  }
  finish(streamId: string): Promise<VoiceOutcome<string>> {
    const stream = this.streams.get(streamId);
    if (stream === undefined || stream.finishing || !this.loaded)
      return Promise.resolve(fail('voice_cancelled', 'Speech stream is not listening.'));
    stream.finishing = true;
    return this.enqueue({ ...this.envelope(), type: 'finish', streamId, streaming: stream.streaming }, VOICE_FINISH_MS);
  }
  /** Changes the active set only with no streams. Memory refusal preserves the current selection.
   * A successful switch reaps the old process, so new native allocations never overlap the old set. */
  async selectRecognizers(recognizers: VoiceRecognizerSet): Promise<VoiceOutcome<void>> {
    if (this.closed) return fail('voice_cancelled', 'Speech worker is shutting down.');
    if (this.switching || this.streams.size !== 0 || this.warming !== undefined)
      return fail('voice_busy', 'End the active speech streams before switching models.');
    const parsed = VoiceRecognizerSetSchema.safeParse(recognizers);
    if (!parsed.success) return fail('worker_protocol', 'Select at most one batch and one streaming model.');
    this.switching = true;
    try {
      const admission = voiceMemoryAdmission(await this.ports.availableMemory(), parsed.data);
      if (!admission.ok) return admission;
      if (this.closed) return fail('voice_cancelled', 'Speech worker is shutting down.');
      this.abort(fail('voice_cancelled', 'Speech model selection changed.'));
      await this.retiring;
      this.recognizers = parsed.data;
      return { ok: true, value: undefined };
    } catch {
      return fail('voice_no_memory', 'Could not verify speech model memory headroom.');
    } finally {
      this.switching = false;
    }
  }
  cancel(streamId: string): void {
    this.cancelStream(streamId, fail('voice_cancelled', 'Speech stream was cancelled.'));
  }
  async close(): Promise<void> {
    this.closed = true;
    this.abort(fail('voice_cancelled', 'Speech worker is shutting down.'));
    await this.warming;
    await this.retiring;
  }
  private envelope(): { version: 1; requestId: string } {
    return { version: VOICE_IPC_VERSION, requestId: String(++this.counter) };
  }
  private async ensureLoaded(): Promise<VoiceOutcome<void>> {
    if (this.warming !== undefined) return await this.warming;
    if (this.loaded) return { ok: true, value: undefined };
    const warming = this.warm();
    this.warming = warming;
    try {
      return await warming;
    } finally {
      if (this.warming === warming) this.warming = undefined;
    }
  }
  private async warm(): Promise<VoiceOutcome<void>> {
    try {
      await this.retiring;
      const admission = voiceMemoryAdmission(await this.ports.availableMemory(), this.recognizers);
      if (!admission.ok) return admission;
      if (this.closed || this.streams.size === 0) return fail('voice_cancelled', 'Speech stream was cancelled.');
      const generation = ++this.generation;
      const child = await this.ports.spawner.start(
        {
          message: raw => {
            if (generation === this.generation) this.receive(raw);
          },
          exited: reason => {
            if (generation === this.generation) this.abort(fail('worker_crashed', reason));
          },
        },
        this.recognizers,
      );
      if (generation !== this.generation || this.closed) {
        await child.stop();
        return fail('worker_crashed', 'Speech worker exited during startup.');
      }
      this.child = child;
      const outcome = await this.enqueue(
        { ...this.envelope(), type: 'load', recognizers: this.recognizers },
        VOICE_LOAD_MS,
      );
      this.loaded = outcome.ok;
      if (!outcome.ok) this.abort(outcome);
      return outcome.ok ? { ok: true, value: undefined } : outcome;
    } catch {
      const failure = fail('worker_crashed', 'Could not start the speech worker or read available memory.');
      this.abort(failure);
      return failure;
    }
  }
  private enqueue(request: VoiceWorkerRequest, timeout?: number): Promise<VoiceOutcome<string>> {
    return new Promise(resolve => {
      const job: Job = { request, resolve };
      if (timeout !== undefined)
        job.timer = this.ports.clock.after(timeout, () => {
          this.abort(fail('engine_timeout', 'Speech worker did not answer before its deadline.'));
        });
      this.queue.push(job);
      this.pump();
    });
  }
  private pump(): void {
    if (this.active !== undefined || this.child === undefined) return;
    this.active = this.queue.shift();
    if (this.active === undefined) return;
    try {
      this.child.send(this.active.request);
    } catch {
      this.abort(fail('worker_crashed', 'Speech worker IPC disconnected.'));
    }
  }
  private receive(raw: unknown): void {
    const parsed = VoiceWorkerResponseSchema.safeParse(raw);
    if (!parsed.success) {
      this.abort(fail('worker_protocol', 'Invalid speech worker response.'));
      return;
    }
    const response = parsed.data;
    if (response.type === 'health' && response.state === 'ready') return;
    const job = this.active;
    if (job === undefined || response.requestId !== job.request.requestId) return;
    if (!matches(job.request, response)) {
      this.abort(fail('worker_protocol', 'Unexpected speech worker response.'));
      return;
    }
    this.active = undefined;
    const result =
      response.type === 'error'
        ? fail(response.code, response.message)
        : { ok: true as const, value: response.type === 'result' ? response.text : '' };
    this.settle(job, result);
    if (!result.ok && job.request.type === 'cancel') {
      this.abort(result);
      return;
    }
    if ('streamId' in job.request) {
      const streamId = job.request.streamId;
      if (job.request.type === 'audio') {
        const stream = this.streams.get(streamId);
        if (stream !== undefined) stream.samples -= job.request.samples.length;
      }
      if (!result.ok) this.cancelStream(streamId, result);
      else if (job.request.type === 'cancel') this.cancelling.delete(streamId);
      else if (job.request.type === 'finish') {
        this.streams.delete(streamId);
        this.scheduleIdle();
      }
    }
    this.pump();
  }
  private settle(job: Job, result: VoiceOutcome<string>): void {
    job.timer?.cancel();
    job.resolve(result);
  }
  private cancelStream(streamId: string, failure: Failure): void {
    const stream = this.streams.get(streamId);
    if (stream === undefined) return;
    this.streams.delete(streamId);
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const job = this.queue[i];
      if (job !== undefined && 'streamId' in job.request && job.request.streamId === streamId) {
        this.queue.splice(i, 1);
        this.settle(job, failure);
      }
    }
    if (this.active !== undefined && 'streamId' in this.active.request && this.active.request.streamId === streamId) {
      // Keep the decode slot occupied until its reply; cancellation cannot make native work concurrent.
      this.active.timer?.cancel();
      this.active.resolve(failure);
      this.active.timer = this.ports.clock.after(VOICE_FINISH_MS, () =>
        this.abort(fail('engine_timeout', 'Cancelled decode did not stop.')),
      );
    }
    if (this.child !== undefined) {
      this.cancelling.set(streamId, stream.deviceId);
      void this.enqueue({ ...this.envelope(), type: 'cancel', streamId, streaming: stream.streaming });
    }
    stream.error(failure);
    this.scheduleIdle();
  }
  private abort(failure: Failure): void {
    this.generation++;
    this.idle?.cancel();
    const child = this.child;
    this.child = undefined;
    this.loaded = false;
    if (child !== undefined) this.retiring = child.stop();
    const active = this.active;
    this.active = undefined;
    if (active !== undefined) this.settle(active, failure);
    for (const job of this.queue.splice(0)) this.settle(job, failure);
    const streams = [...this.streams.values()];
    this.streams.clear();
    this.cancelling.clear();
    for (const stream of streams) stream.error(failure);
  }
  private scheduleIdle(): void {
    this.idle?.cancel();
    if (this.streams.size !== 0 || this.child === undefined) return;
    this.idle = this.ports.clock.after(VOICE_IDLE_MS, () => {
      if (this.streams.size === 0) this.abort(fail('voice_cancelled', 'Idle speech worker released.'));
    });
  }
}
function fail(code: VoiceFailureCode, message: string): Failure {
  return { ok: false, code, message };
}
function matches(request: VoiceWorkerRequest, response: VoiceWorkerResponse): boolean {
  if (response.type === 'error')
    return response.streamId === undefined || ('streamId' in request && response.streamId === request.streamId);
  if (request.type === 'load') return response.type === 'health' && response.state === 'loaded';
  return (
    response.type === 'result' &&
    response.streamId === request.streamId &&
    response.streaming === request.streaming &&
    response.final === (request.type === 'finish')
  );
}
