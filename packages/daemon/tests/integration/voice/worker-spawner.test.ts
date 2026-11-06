import { VoiceProcessSpawner } from '../../../src/lib/voice/process-spawner.ts';
import { SpawnCgroupCommands } from '../../../src/adapters/cgroups/spawn-cgroup-commands.ts';
import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { BunVoiceWorkerProcesses } from '../../../src/adapters/voice/worker-spawner.ts';
import { VoiceWorkerResponseSchema } from '../../../src/lib/voice/ipc.ts';
import type { VoiceWorkerResponse } from '../../../src/lib/voice/ipc.ts';

/** CI only: advanced IPC and scope wrappers must be proved with an actual child process. */
test('source child exchanges typed audio and final words over advanced IPC', async () => {
  // Arrange
  const messages: VoiceWorkerResponse[] = [];
  const waiters = new Map<string, (message: VoiceWorkerResponse) => void>();
  const recognizer = { threads: 2, modelId: 'fake', modelBytes: 10, peakResidentBytes: 20, streaming: true };
  const subject = new VoiceProcessSpawner({
    processes: new BunVoiceWorkerProcesses(new SpawnCgroupCommands()),
    clock: {
      after: (ms, callback) => {
        const timer = setTimeout(callback, ms);
        return { cancel: () => clearTimeout(timer) };
      },
    },
    runtime: process.execPath,
    entry: fileURLToPath(new URL('../support/fake-voice-worker.ts', import.meta.url)),
    nonce: () => 'test',
    host: { platform: 'darwin', unifiedHierarchy: false, cpus: 8, memoryBytes: 8 * 1024 ** 3 },
    commands: {
      execute: async () => {
        throw new Error('Unsupported host must not invoke systemd');
      },
    },
  });
  const handle = await subject.start(
    {
      message: raw => {
        const message = VoiceWorkerResponseSchema.parse(raw);
        messages.push(message);
        waiters.get(message.requestId)?.(message);
      },
      exited: reason => {
        throw new Error(reason);
      },
    },
    [recognizer],
  );
  const request = (requestId: string) =>
    new Promise<VoiceWorkerResponse>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`No worker response for ${requestId}`)), 5_000);
      waiters.set(requestId, message => {
        clearTimeout(timeout);
        waiters.delete(requestId);
        resolve(message);
      });
    });
  try {
    // Act / Assert
    const loaded = request('load');
    handle.send({ version: 1, requestId: 'load', type: 'load', recognizers: [recognizer] });
    expect(await loaded).toMatchObject({ type: 'health', state: 'loaded' });
    const audio = request('audio');
    handle.send({
      version: 1,
      requestId: 'audio',
      type: 'audio',
      streamId: 'a',
      streaming: true,
      samples: new Float32Array([0.25, 0.5]),
    });
    expect(await audio).toMatchObject({ type: 'result', text: 'true:2:0.25', final: false });
    const final = request('finish');
    handle.send({ version: 1, requestId: 'finish', type: 'finish', streamId: 'a', streaming: true });
    expect(await final).toMatchObject({ type: 'result', text: 'final words', final: true });
    expect(handle.placement).toMatchObject({ hardCapped: false });
    expect(messages).toHaveLength(3);
  } finally {
    await handle.stop();
  }
}, 20_000);

test('the process adapter reads child RSS on both OS paths and reports failed ps reads', async () => {
  // Arrange
  const script = fileURLToPath(new URL('../support/fake-voice-worker.ts', import.meta.url));
  const commands = new SpawnCgroupCommands();
  // Act / Assert
  for (const platform of process.platform === 'linux' ? ['linux', 'darwin'] : ['darwin']) {
    const ready = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<string>();
    const subject = new BunVoiceWorkerProcesses(commands, platform);
    const child = subject.spawn([process.execPath, script], 2, {
      message: () => ready.resolve(),
      exited: r => exited.resolve(r),
    });
    try {
      await ready.promise;
      expect(Number.isInteger(await child.rss())).toBe(true);
    } finally {
      await child.kill();
    }
    expect(await exited.promise).toContain('Speech worker exited');
  }
  const ready = Promise.withResolvers<void>();
  const subject = new BunVoiceWorkerProcesses(
    { execute: async () => ({ code: 1, stdout: '', stderr: 'denied' }) },
    'darwin',
  );
  const child = subject.spawn([process.execPath, script], 2, { message: () => ready.resolve(), exited: () => {} });
  try {
    await ready.promise;
    await expect(child.rss()).rejects.toThrow('Could not read speech worker RSS');
  } finally {
    await child.kill();
  }
});
