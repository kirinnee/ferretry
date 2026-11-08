import { describe, expect, test } from 'bun:test';
import type { RedactionScope } from '@ferretry/kernel/contract';
import { type Duration, milliseconds, ok } from '@ferretry/std';
import type { FerretRecord, RunnerHandle, RunnerLook } from '../../../../contract/index.ts';
import {
  FakeHarness,
  FakeRunner,
  ferretId,
  fenced,
  T0,
  emptyChildEnvironment,
} from '../../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';
import { LastSnapshotCapture } from '../../../../daemon/lib/session/snapshot/index.ts';

const SECRET = 'sk-fixture-stop-0123456789';

const sleep = async (delay: Duration, signal?: AbortSignal): Promise<void> =>
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delay);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    });
  });

/** A stopped ferret with the real capture bound, recording what happened to the pane, in order. */
function fixture() {
  const id = ferretId('mw7bp88g-50e00159');
  const record: FerretRecord = {
    format: 1,
    id,
    name: 'fern',
    role: 'lead',
    harness: 'claude-code',
    runner: 'tmux',
    folder: '/work',
    state: 'stopped',
    createdAt: T0,
    stateAt: T0,
  };
  const registry = new FerretRegistry([record]);
  const runner = new FakeRunner();
  const harness = new FakeHarness();
  const events: string[] = [];
  const stored: string[] = [];
  const stopPane = harness.stop.bind(harness);
  harness.stop = async (...args: Parameters<FakeHarness['stop']>) => {
    events.push(`stop:${args[3]}`);
    await stopPane(...args);
  };
  const capture = new LastSnapshotCapture({
    store: () => ({
      write: async (_id, text) => {
        events.push('kept');
        stored.push(text);
      },
    }),
    redaction: {
      read: async <T>(fn: (scope: RedactionScope) => T | Promise<T>) => {
        const text = (s: string) => s.split(SECRET).join('*'.repeat(SECRET.length));
        return await fn({ text, cells: grid => grid, lines: lines => lines.map(text) });
      },
    },
    sleep,
    log: { warn: () => {} },
    bound: milliseconds(20),
  });
  const ports: FerretsPorts = {
    now: () => T0,
    newId: () => id,
    newName: () => 'fern',
    save: async () => {},
    saveTokens: async () => {},
    harness: () => harness,
    harnessKeys: () => ['claude-code'],
    runner: () => runner,
    decide: async () => ({ allow: true }),
    launchParts: () => [],
    sitrepSources: () => [],
    instructions: () => [],
    folder: path => ok(fenced(path)),
    changed: () => {},
    lastSnapshot: async (ferret, pane, handle) => {
      events.push('look');
      await capture.capture(ferret, pane, handle);
    },
    vault: { childEnvironment: async () => ok(emptyChildEnvironment()) },
    asks: { open: async () => [] },
  };
  const service = new FerretsService(registry, new FerretTokenDirectory(), ports);
  const live = async (status: string): Promise<RunnerHandle> => {
    await service.resume(id);
    const handle = (await service.handle(id)) as RunnerHandle;
    runner.screens.set(handle, { frame: 'f', working: false, atPrompt: true, permission: false, status });
    events.length = 0;
    return handle;
  };
  return { id, registry, runner, harness, ports, service, events, stored, live };
}

describe('F-0326 every stop keeps the last screen, masked, before the pane goes', () => {
  for (const [how, cause] of [
    ['now', undefined],
    ['polite', undefined],
    ['now', { kind: 'completed' }],
  ] as const)
    test(`F-0326 a ${how} stop${cause === undefined ? '' : ' (signal done)'} looks first, then stops the pane`, async () => {
      const f = fixture();
      await f.live(`last words ${SECRET}`);
      await f.service.stop(f.id, how, undefined, cause);
      expect(f.events).toEqual(['look', 'kept', `stop:${how}`]);
      expect(f.stored).toEqual([`last words ${'*'.repeat(SECRET.length)}`]);
      expect(f.registry.get(f.id)?.state).toBe('stopped');
    });

  test('F-0326 a pane a move replaces is kept before it is stopped', async () => {
    const f = fixture();
    await f.live('before the move');
    expect((await f.service.resume(f.id, undefined, { replaceLiveTerminal: true })).ok).toBe(true);
    expect(f.events.slice(0, 3)).toEqual(['look', 'kept', 'stop:now']);
    expect(f.stored).toEqual(['before the move']);
  });

  test('F-0326 a look that hangs never holds the stop: it completes after the bound with no file', async () => {
    const f = fixture();
    const handle = await f.live('never read');
    f.runner.look = async () => await new Promise<RunnerLook | undefined>(() => {});
    const started = Date.now();
    await f.service.stop(f.id, 'now');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(f.events).toEqual(['look', 'stop:now']);
    expect(f.stored).toEqual([]);
    expect(await f.runner.alive(handle)).toBe(false);
    expect(f.registry.get(f.id)?.state).toBe('stopped');
  });

  test('F-0326 a capture port that rejects never fails the stop', async () => {
    const f = fixture();
    await f.live('x');
    f.ports.lastSnapshot = async () => {
      throw new Error('the capture broke');
    };
    await f.service.stop(f.id, 'now');
    expect(f.events).toEqual(['stop:now']);
    expect(f.registry.get(f.id)?.state).toBe('stopped');
  });

  test('F-0326 a pane already gone keeps no file and the stop goes on; a stopped ferret is not looked at', async () => {
    const f = fixture();
    const handle = await f.live('gone');
    await f.runner.stop(handle);
    await f.service.stop(f.id, 'now');
    expect(f.events).toEqual(['look', 'stop:now']);
    expect(f.stored).toEqual([]);
    f.events.length = 0;
    await f.service.stop(f.id, 'now');
    expect(f.events).toEqual([]);
  });
});
