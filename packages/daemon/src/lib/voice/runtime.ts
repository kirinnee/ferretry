import { VOICE_IPC_VERSION, VoiceWorkerRequestSchema } from './ipc.ts';
import type { VoiceRecognizerDescription, VoiceWorkerRequest } from './ipc.ts';
import type { VoiceRecognizer, VoiceWorkerChannel } from './ports.ts';

/** Child-only serial queue. A load replaces the active set; old native allocations are unloaded first. */
export class VoiceWorkerRuntime {
  private tail: Promise<void> = Promise.resolve();
  private loaded: readonly VoiceRecognizer[] = [];
  constructor(
    private readonly channel: VoiceWorkerChannel,
    private readonly available: readonly VoiceRecognizer[],
  ) {}
  start(): void {
    this.channel.receive(raw => {
      const parsed = VoiceWorkerRequestSchema.safeParse(raw);
      if (!parsed.success) {
        this.channel.send({
          version: VOICE_IPC_VERSION,
          type: 'error',
          requestId: 'invalid',
          code: 'worker_protocol',
          message: 'Invalid voice worker request.',
        });
        return;
      }
      this.tail = this.tail
        .then(() => this.handle(parsed.data))
        .catch(() => {
          this.channel.send({
            version: VOICE_IPC_VERSION,
            type: 'error',
            requestId: parsed.data.requestId,
            code: 'worker_crashed',
            message: 'Speech recognizer failed.',
          });
        });
    });
    this.channel.send({ version: VOICE_IPC_VERSION, type: 'health', requestId: 'startup', state: 'ready' });
  }
  private async handle(message: VoiceWorkerRequest): Promise<void> {
    const base = { version: VOICE_IPC_VERSION, requestId: message.requestId } as const;
    if (message.type === 'load') {
      const selected: VoiceRecognizer[] = [];
      for (const description of message.recognizers) {
        const model = this.available.find(model => sameDescription(model.description, description));
        if (model === undefined) {
          this.channel.send({
            ...base,
            type: 'error',
            code: 'worker_protocol',
            message: 'Recognizer declaration differs from the child.',
          });
          return;
        }
        selected.push(model);
      }
      const previous = this.loaded;
      this.loaded = [];
      for (const model of previous) await model.unload();
      for (const model of selected) {
        const outcome = await model.load();
        if (!outcome.ok) {
          await model.unload();
          for (const loaded of this.loaded) await loaded.unload();
          this.loaded = [];
          this.channel.send({ ...base, type: 'error', code: outcome.code, message: outcome.message });
          return;
        }
        this.loaded = [...this.loaded, model];
      }
      this.channel.send({ ...base, type: 'health', state: 'loaded' });
      return;
    }
    const stream = { ...base, streamId: message.streamId, streaming: message.streaming };
    const model = this.loaded.find(model => model.description.streaming === message.streaming);
    if (message.type === 'cancel') {
      model?.cancel(message.streamId);
      this.channel.send({ ...stream, type: 'result', text: '', final: false });
      return;
    }
    if (model === undefined) {
      this.channel.send({
        ...stream,
        type: 'error',
        code: 'voice_not_installed',
        message: 'Speech engine is not installed.',
      });
      return;
    }
    const result =
      message.type === 'audio'
        ? await model.audio(message.streamId, message.samples)
        : await model.finish(message.streamId);
    this.channel.send(
      result.ok
        ? { ...stream, type: 'result', text: result.value, final: message.type === 'finish' }
        : { ...stream, type: 'error', code: result.code, message: result.message },
    );
  }
}
/** Threads are the host's wish; the effective count is the clamped one this child was started with (policy owns it). */
function sameDescription(left: VoiceRecognizerDescription, right: VoiceRecognizerDescription): boolean {
  return Object.entries(left).every(
    ([key, value]) => key === 'threads' || right[key as keyof VoiceRecognizerDescription] === value,
  );
}

/** Deliberately the only shipped recognizer. Native loading and model selection are separate slices. */
export class NotInstalledVoiceRecognizer implements VoiceRecognizer {
  constructor(readonly description: VoiceRecognizerDescription) {}
  async load(): ReturnType<VoiceRecognizer['load']> {
    return { ok: false, code: 'voice_not_installed', message: 'Speech engine is not installed.' };
  }
  async audio(): ReturnType<VoiceRecognizer['audio']> {
    return { ok: false, code: 'voice_not_installed', message: 'Speech engine is not installed.' };
  }
  async finish(): ReturnType<VoiceRecognizer['finish']> {
    return { ok: false, code: 'voice_not_installed', message: 'Speech engine is not installed.' };
  }
  cancel(): void {}
  async unload(): Promise<void> {}
}
