import { expect, test } from 'bun:test';
import { VoiceWorkerHost } from '../../../src/lib/voice/host.ts';
import { VoiceProcessSpawner } from '../../../src/lib/voice/process-spawner.ts';
import type { VoiceProcessPort } from '../../../src/lib/voice/process-spawner.ts';
import { notInstalledVoiceDescription } from '../../../src/lib/voice/policy.ts';
import { NotInstalledVoiceRecognizer, VoiceWorkerRuntime } from '../../../src/lib/voice/runtime.ts';
import type { VoiceClock } from '../../../src/lib/voice/ports.ts';

const idleClock: VoiceClock = { after: () => ({ cancel: () => {} }) };
type Path = 'capped' | 'best-effort fallback' | 'recognizer switch';

/** Host + spawner + the real child runtime wired in memory: the child's description uses the thread count it was
 * started with, exactly as bin/voice-worker.ts does, so the declaration the host sends is compared for real. */
function fixture(path: Path, cpus: number, wished: number) {
  const started: number[] = [];
  const processes: VoiceProcessPort = {
    spawn: (command, threads, handlers) => {
      started.push(threads);
      if (command[0] === 'systemd-run') {
        queueMicrotask(() => handlers.exited('systemd-run refused'));
        return { send: () => {}, kill: async () => {}, rss: async () => 1 };
      }
      let receive: (raw: unknown) => void = () => {};
      new VoiceWorkerRuntime(
        {
          send: message => {
            queueMicrotask(() => handlers.message(message));
          },
          receive: handler => {
            receive = handler;
          },
        },
        [new NotInstalledVoiceRecognizer(notInstalledVoiceDescription(threads))],
      ).start();
      return {
        send: message => {
          queueMicrotask(() => receive(message));
        },
        kill: async () => {},
        rss: async () => 1,
      };
    },
  };
  const spawner = new VoiceProcessSpawner({
    clock: idleClock,
    runtime: '/bin/bun',
    entry: '/repo/fyd.ts',
    nonce: () => 'nonce',
    host: { platform: 'linux', cpus, memoryBytes: 64 * 1024 ** 3, unifiedHierarchy: true },
    commands: {
      execute: async argv => ({
        code: path === 'best-effort fallback' && argv[0] === 'systemd-run' ? 1 : 0,
        stdout: '',
        stderr: path === 'best-effort fallback' ? 'refused' : '',
      }),
    },
    processes,
  });
  const initial = path === 'recognizer switch' ? 1 : wished;
  const host = new VoiceWorkerHost({
    spawner,
    clock: idleClock,
    availableMemory: async () => 64 * 1024 ** 3,
    recognizers: [notInstalledVoiceDescription(initial)],
  });
  return { host, started };
}

for (const [cpus, wished, effective] of [
  [8, 4, 2],
  [4, 4, 1],
] as const)
  for (const path of ['capped', 'best-effort fallback', 'recognizer switch'] as const)
    test(`load of a wish of ${wished} threads on ${cpus} cores reaches the recognizer on the ${path} path`, async () => {
      // Arrange
      const { host, started } = fixture(path, cpus, wished);
      if (path === 'recognizer switch')
        expect(await host.selectRecognizers([notInstalledVoiceDescription(wished)])).toEqual({
          ok: true,
          value: undefined,
        });
      // Act
      const opened = await host.open('stream', 'device', () => {});
      // Assert: the recognizer's own result, never the host/child declaration mismatch
      expect(opened).toMatchObject({ ok: false, code: 'voice_not_installed' });
      expect(started.at(-1)).toBe(effective);
      await host.close();
    });
