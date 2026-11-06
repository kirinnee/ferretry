import { describe, expect, test } from 'bun:test';
import { NotInstalledVoiceRecognizer, VoiceWorkerRuntime } from '../../../src/lib/voice/runtime.ts';
import type { VoiceRecognizer, VoiceWorkerChannel } from '../../../src/lib/voice/ports.ts';
import { VoiceWorkerRequestSchema, type VoiceWorkerResponse } from '../../../src/lib/voice/ipc.ts';

const description = { modelId: 'fake', modelBytes: 10, peakResidentBytes: 20, streaming: true, threads: 1 };
async function turns(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function fixture(recognizer: VoiceRecognizer) {
  const sent: VoiceWorkerResponse[] = [];
  let receive: (raw: unknown) => void = () => {};
  const channel: VoiceWorkerChannel = {
    send: m => sent.push(m),
    receive: handler => {
      receive = handler;
    },
  };
  new VoiceWorkerRuntime(channel, [recognizer]).start();
  const request = async (message: Record<string, unknown>) => {
    receive({ version: 1, requestId: 'r', streaming: true, ...message });
    await turns();
  };
  return { sent, request };
}
describe('voice worker runtime', () => {
  test('real port declares bytes, streaming and threads; fake decodes serially inside worker', async () => {
    // Arrange
    const gate = Promise.withResolvers<void>();
    const calls: string[] = [];
    const subject = fixture({
      description,
      load: async () => ({ ok: true, value: undefined }),
      audio: async (id, samples) => {
        calls.push(`${id}:${samples.length}`);
        await gate.promise;
        return { ok: true, value: 'hello' };
      },
      finish: async id => {
        calls.push(`finish:${id}`);
        return { ok: true, value: 'hello world' };
      },
      cancel: id => {
        calls.push(`cancel:${id}`);
      },
      unload: async () => {},
    });
    // Act
    await subject.request({ type: 'load', recognizers: [description] });
    await subject.request({ type: 'audio', streamId: 'a', samples: new Float32Array(2) });
    await subject.request({ type: 'finish', streamId: 'a' });
    expect(calls).toEqual(['a:2']);
    gate.resolve();
    await turns();
    await subject.request({ type: 'cancel', streamId: 'a' });
    // Assert
    expect(calls).toEqual(['a:2', 'finish:a', 'cancel:a']);
    expect(subject.sent).toMatchObject([
      { type: 'health', state: 'ready' },
      { type: 'health', state: 'loaded' },
      { type: 'result', final: false, text: 'hello' },
      { type: 'result', final: true, text: 'hello world' },
      { type: 'result', text: '' },
    ]);
  });
  test('uninstalled engine and input before load return explicit failures', async () => {
    // Arrange
    const recognizer = new NotInstalledVoiceRecognizer(description);
    const subject = fixture(recognizer);
    // Act
    await subject.request({ type: 'audio', streamId: 'a', samples: new Float32Array(2) });
    await subject.request({ type: 'load', recognizers: [description] });
    // Assert
    expect(subject.sent.slice(1)).toMatchObject([
      { type: 'error', code: 'voice_not_installed' },
      { type: 'error', code: 'voice_not_installed' },
    ]);
    expect(await recognizer.audio()).toMatchObject({ code: 'voice_not_installed' });
    expect(await recognizer.finish()).toMatchObject({ code: 'voice_not_installed' });
    recognizer.cancel();
    await recognizer.unload();
  });
  test('boundary rejects invalid versions, JSON audio, non-finite and oversized arrays', async () => {
    // Arrange / Act / Assert
    for (const samples of [[1, 2], new Float32Array([Number.NaN]), new Float32Array(32_001)]) {
      expect(
        VoiceWorkerRequestSchema.safeParse({
          version: 1,
          requestId: 'r',
          type: 'audio',
          streamId: 'a',
          streaming: true,
          samples,
        }).success,
      ).toBe(false);
    }
    const subject = fixture(new NotInstalledVoiceRecognizer(description));
    await subject.request({ version: 2, type: 'load', recognizers: [description] });
    await subject.request({ type: 'load', recognizers: [{ ...description, modelId: 'other' }] });
    expect(subject.sent.slice(1)).toMatchObject([
      { type: 'error', code: 'worker_protocol' },
      { type: 'error', code: 'worker_protocol' },
    ]);
  });
  test('recognizer failures are replies and a thrown native-wrapper error does not break the queue', async () => {
    // Arrange
    const subject = fixture({
      description,
      load: async () => ({ ok: true, value: undefined }),
      audio: async () => {
        throw new Error('native failure');
      },
      finish: async () => ({ ok: false, code: 'engine_behind', message: 'behind' }),
      cancel: () => {},
      unload: async () => {},
    });
    // Act
    await subject.request({ type: 'load', recognizers: [description] });
    await subject.request({ type: 'audio', streamId: 'a', samples: new Float32Array(1) });
    await subject.request({ type: 'finish', streamId: 'a' });
    // Assert
    expect(subject.sent.slice(2)).toMatchObject([
      { type: 'error', code: 'worker_crashed' },
      { type: 'error', code: 'engine_behind' },
    ]);
  });
});

test('the worker loads only the selected pair and unloads before switching, never on top', async () => {
  // Arrange
  const calls: string[] = [];
  const make = (streaming: boolean): VoiceRecognizer => ({
    description: { ...description, modelId: streaming ? 'stream' : 'batch', streaming },
    load: async () => {
      calls.push(`load:${streaming}`);
      return { ok: true, value: undefined };
    },
    unload: async () => {
      calls.push(`unload:${streaming}`);
    },
    cancel: () => {},
    audio: async () => ({ ok: true, value: String(streaming) }),
    finish: async () => ({ ok: true, value: 'done' }),
  });
  const batch = make(false);
  const stream = make(true);
  let receive: (raw: unknown) => void = () => {};
  const sent: VoiceWorkerResponse[] = [];
  new VoiceWorkerRuntime(
    {
      send: m => sent.push(m),
      receive: handler => {
        receive = handler;
      },
    },
    [batch, stream],
  ).start();
  // Act
  receive({ version: 1, requestId: 'a', type: 'load', recognizers: [batch.description, stream.description] });
  await turns();
  receive({ version: 1, requestId: 'b', type: 'audio', streamId: 'b', streaming: false, samples: new Float32Array(1) });
  await turns();
  receive({ version: 1, requestId: 'c', type: 'audio', streamId: 's', streaming: true, samples: new Float32Array(1) });
  await turns();
  receive({ version: 1, requestId: 'd', type: 'load', recognizers: [batch.description] });
  await turns();
  // Assert
  expect(calls).toEqual(['load:false', 'load:true', 'unload:false', 'unload:true', 'load:false']);
  expect(sent[2]).toMatchObject({ text: 'false' });
  expect(sent[3]).toMatchObject({ text: 'true' });
});

test('partial pair load failure unloads both models instead of leaving a half-loaded set', async () => {
  // Arrange
  const unloaded: boolean[] = [];
  const make = (streaming: boolean): VoiceRecognizer => ({
    description: { ...description, modelId: String(streaming), streaming },
    load: async () =>
      streaming ? { ok: false, code: 'voice_not_installed', message: 'missing' } : { ok: true, value: undefined },
    unload: async () => {
      unloaded.push(streaming);
    },
    cancel: () => {},
    audio: async () => ({ ok: true, value: '' }),
    finish: async () => ({ ok: true, value: '' }),
  });
  const models = [make(false), make(true)];
  let receive: (raw: unknown) => void = () => {};
  const sent: VoiceWorkerResponse[] = [];
  new VoiceWorkerRuntime(
    {
      send: m => sent.push(m),
      receive: handler => {
        receive = handler;
      },
    },
    models,
  ).start();
  // Act
  receive({ version: 1, requestId: 'load', type: 'load', recognizers: models.map(model => model.description) });
  await turns();
  // Assert
  expect(unloaded).toEqual([true, false]);
  expect(sent.at(-1)).toMatchObject({ code: 'voice_not_installed' });
});
