import type { RedactionScope } from '@ferretry/kernel/contract';
import { type Duration, milliseconds, ok } from '@ferretry/std';
import { PERSON_ORIGIN, type FerretRecord, type RunnerHandle } from '../../../contract/index.ts';
import {
  FakeHarness,
  FakeRunner,
  ferretId,
  fenced,
  T0,
  emptyChildEnvironment,
} from '../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../daemon/lib/tokens/tokens.ts';
import { LastSnapshotCapture } from '../../../daemon/lib/session/snapshot/index.ts';

export const SECRET = 'sk-fixture-stop-0123456789';

const sleep = async (delay: Duration, signal?: AbortSignal): Promise<void> =>
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delay);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    });
  });

/** A stopped ferret with the real capture bound, recording what happened to the pane, in order. */
export function fixture() {
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
  const runner = Object.assign(new FakeRunner(), { requireFerret: true });
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
    await service.resume(id, undefined, { origin: PERSON_ORIGIN });
    const handle = (await service.handle(id)) as RunnerHandle;
    runner.screens.set(handle, { frame: 'f', working: false, atPrompt: true, permission: false, status });
    events.length = 0;
    return handle;
  };
  return { id, registry, runner, harness, ports, service, events, stored, live };
}
