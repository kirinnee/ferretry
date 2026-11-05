import { expect, test } from 'bun:test';
import { VoiceProcessSpawner } from '../../../src/lib/voice/process-spawner.ts';
import type { VoiceProcessPort } from '../../../src/lib/voice/process-spawner.ts';
import type { VoiceClock } from '../../../src/lib/voice/ports.ts';
import { notInstalledVoiceDescription } from '../../../src/lib/voice/policy.ts';

async function turns(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
class Clock implements VoiceClock {
  time = 0;
  jobs: { at: number; cancelled: boolean; callback(): void }[] = [];
  after(ms: number, callback: () => void) {
    const job = { at: this.time + ms, cancelled: false, callback };
    this.jobs.push(job);
    return {
      cancel: () => {
        job.cancelled = true;
      },
    };
  }
  advance(ms: number): void {
    this.time += ms;
    for (const job of [...this.jobs])
      if (!job.cancelled && job.at <= this.time) {
        job.cancelled = true;
        job.callback();
      }
  }
}
function fixture(capped = false) {
  const clock = new Clock();
  const children: {
    argv: readonly string[];
    threads: number;
    handlers: Parameters<VoiceProcessPort['spawn']>[2];
    kills: number;
    sent: unknown[];
  }[] = [];
  const messages: unknown[] = [];
  const exits: string[] = [];
  let rss = 1;
  let failRss = false;
  let killGate: Promise<void> | undefined;
  const subject = new VoiceProcessSpawner({
    clock,
    runtime: '/bin/bun',
    entry: '/repo/fyd.ts',
    nonce: () => 'one',
    host: { platform: capped ? 'linux' : 'darwin', cpus: 8, memoryBytes: 8 * 1024 ** 3, unifiedHierarchy: capped },
    commands: { execute: async () => ({ code: 0, stdout: '', stderr: '' }) },
    processes: {
      spawn: (argv, threads, handlers) => {
        const child = { argv, threads, handlers, kills: 0, sent: [] as unknown[] };
        children.push(child);
        return {
          send: m => {
            child.sent.push(m);
          },
          kill: async () => {
            child.kills++;
            await killGate;
          },
          rss: async () => {
            if (failRss) throw new Error('rss unreadable');
            return rss;
          },
        };
      },
    },
  });
  const start = () =>
    subject.start({ message: m => messages.push(m), exited: r => exits.push(r) }, [notInstalledVoiceDescription(2)]);
  const ready = () =>
    children.at(-1)?.handlers.message({ version: 1, type: 'health', requestId: 'startup', state: 'ready' });
  return {
    subject,
    start,
    ready,
    clock,
    children,
    messages,
    exits,
    setRss: (value: number) => {
      rss = value;
    },
    failRss: () => {
      failRss = true;
    },
    holdKill: (promise: Promise<void>) => {
      killGate = promise;
    },
  };
}
test('startup waits for a parsed IPC greeting; forwards later messages and suppresses intentional exits', async () => {
  // Arrange
  const f = fixture();
  const pending = f.start();
  await turns();
  f.children[0]?.handlers.message({ malformed: true });
  f.ready();
  const handle = await pending;
  // Act
  f.children[0]?.handlers.message({ arbitrary: 'forward for host parsing' });
  handle.send({ version: 1, requestId: 'load', type: 'load', recognizers: [notInstalledVoiceDescription(2)] });
  f.clock.advance(1_000);
  await turns();
  f.children[0]?.handlers.exited('unexpected crash');
  await handle.stop();
  await handle.stop();
  f.children[0]?.handlers.exited('intentional');
  // Assert
  expect(f.children[0]).toMatchObject({ argv: ['/bin/bun', '/repo/fyd.ts', 'voice-worker'], threads: 2, kills: 1 });
  expect(f.children[0]?.sent).toHaveLength(1);
  expect(f.messages).toEqual([{ arbitrary: 'forward for host parsing' }]);
  expect(f.exits).toEqual(['unexpected crash']);
});
test('refused scope is reaped before the best-effort child starts and carries the refusal', async () => {
  // Arrange
  const f = fixture(true);
  const gate = Promise.withResolvers<void>();
  f.holdKill(gate.promise);
  const pending = f.start();
  await turns();
  // Act
  f.children[0]?.handlers.exited('systemd-run refused');
  await turns();
  expect(f.children).toHaveLength(1);
  gate.resolve();
  await turns();
  f.ready();
  const handle = await pending;
  // Assert
  expect(f.children[0]?.argv[0]).toBe('systemd-run');
  expect(f.children[1]?.argv[0]).toBe('/bin/bun');
  expect(handle.placement).toEqual({ hardCapped: false, reason: 'systemd-run refused' });
  await handle.stop();
});
test('startup timeout kills the child; a working kernel-capped launch keeps its hard-cap report', async () => {
  // Arrange
  const f = fixture();
  const pending = f.start();
  await turns();
  // Act
  f.clock.advance(10_000);
  // Assert
  await expect(pending).rejects.toThrow('startup did not answer');
  expect(f.children[0]?.kills).toBe(1);
  const capped = fixture(true);
  const starting = capped.start();
  await turns();
  capped.ready();
  const handle = await starting;
  expect(handle.placement).toEqual({ hardCapped: true });
  await handle.stop();
});
test('the watchdog stops a running worker over its cap and an unreadable fallback during startup', async () => {
  // Arrange
  const f = fixture();
  const pending = f.start();
  await turns();
  f.ready();
  const handle = await pending;
  // Act
  f.setRss(1_500_000_001);
  f.clock.advance(1_000);
  await turns();
  // Assert
  expect(f.exits).toEqual(['Speech worker exceeded its resident memory ceiling.']);
  expect(f.children[0]?.kills).toBe(1);
  await handle.stop();
  const failed = fixture();
  const starting = failed.start();
  await turns();
  failed.failRss();
  failed.clock.advance(1_000);
  await expect(starting).rejects.toThrow('RSS watchdog could not read memory');
  expect(failed.children[0]?.kills).toBe(1);
});
