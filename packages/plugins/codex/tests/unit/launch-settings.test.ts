/**
 * W2-c: Codex records what a launch ran under and compares it with its settings now (`Harness.launchSettings`, RULING
 * #27 Q9; today's `FileLaunchSettingsDigest` over the login's wrapper, F-0422).
 */
import { describe, expect, test } from 'bun:test';
import type { LaunchSpec, Runner, RunSpec } from '@ferretry/core-ferrets/contract';
import type { FencedPath, FerretId, KernelPorts, RootHandle, StatePort } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { ok } from '@ferretry/std';
import { CODEX_LAUNCH_SETTINGS, CODEX_ROLLOUTS, type HarnessConfig } from '../../contract/index.ts';
import { codexHarness } from '../../daemon/adapters/codex-harness.ts';
import { realClock } from '../support/ports.ts';

const FERRET = 'f1' as FerretId;
const HOME = '/state/codex/agent-homes/f1' as FencedPath;
const FOLDER = '/work/project-w2c' as FencedPath;

const roots = (): KernelPorts['roots'] => {
  const handle = {
    name: 'agent-homes',
    resolve: (relative: string) =>
      ok((relative.startsWith('/') ? relative : relative === '' ? HOME : `${HOME}/${relative}`) as FencedPath),
    list: async () => [],
    entries: async () => [],
    stat: async () => undefined,
    writeText: async () => undefined,
    ensurePrivateDirectory: async () => undefined,
  } as unknown as RootHandle;
  return { root: () => handle } as unknown as KernelPorts['roots'];
};

const spec = {
  ferret: FERRET,
  name: 'f1',
  role: 'lead',
  harness: 'codex',
  folder: FOLDER,
  home: HOME,
  instructions: [],
  parts: [],
} as unknown as LaunchSpec;
const runner = {
  key: 'tmux',
  start: async (_spec: RunSpec) => ok({ handle: '%1', startedAt: '2026-11-08T09:00:00.000Z' }),
  resume: async (_spec: RunSpec, _conversation: string) => ok({ handle: '%1', startedAt: '2026-11-08T09:00:00.000Z' }),
  stop: async () => undefined,
} as unknown as Runner;

function over(mode: { value: HarnessConfig['permissionMode'] }, state: StatePort) {
  return codexHarness({
    kernel: {
      roots: roots(),
      state,
      log: undefined as never,
      clock: realClock(),
      redaction: { read: async fn => await fn({ text: (s: string) => s } as never) },
    },
    permissionMode: () => mode.value,
    locate: async () => ({
      outcome: 'located',
      path: '/opt/bin/codex',
      rule: 'inherited environment',
      declaredBy: 'PATH',
    }),
    probe: { version: async () => ({ state: 'ok', version: '0.145.0' }), startup: async () => ({ ok: true }) },
    update: {
      view: async () => {
        throw new Error('not used');
      },
      start: async () => {
        throw new Error('not used');
      },
      settled: async () => undefined,
    },
  });
}

const fresh = () => {
  const folder = new MemoryStateFolder();
  return { folder, state: folder.port([CODEX_ROLLOUTS, CODEX_LAUNCH_SETTINGS]) };
};

describe('F-0422 Codex records what a launch ran under', () => {
  test('F-0422 a start records two values-free fingerprints in state/codex/launch-settings/<ferret>.json and is current', async () => {
    const { folder, state } = fresh();
    const harness = over({ value: 'auto' }, state);

    expect((await harness.start(spec, runner, {} as never)).ok).toBe(true);
    const raw = folder.raw(CODEX_LAUNCH_SETTINGS, FERRET) ?? '';
    const record = JSON.parse(raw) as { format: number; sections: Record<string, string> };

    expect(record.format).toBe(1);
    expect(Object.keys(record.sections).toSorted()).toEqual(['fixed-layer', 'permission-mode']);
    for (const digest of Object.values(record.sections)) expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    for (const value of [FOLDER, HOME, 'auto', 'on-request', 'workspace-write']) expect(raw).not.toContain(value);
    expect(await harness.launchSettings?.(FERRET)).toEqual({ kind: 'current' });
  });

  test('F-0422 a permission mode changed since the launch names its sections, and a resume records afresh', async () => {
    const { state } = fresh();
    const mode = { value: 'auto' as HarnessConfig['permissionMode'] };
    const harness = over(mode, state);
    await harness.start(spec, runner, {} as never);

    mode.value = 'skip';
    const drifted = await harness.launchSettings?.(FERRET);
    await harness.resume(spec, runner, {} as never, 'thread-1');
    const after = await harness.launchSettings?.(FERRET);

    expect(drifted).toEqual({ kind: 'drifted', sections: ['permission-mode', 'fixed-layer'] });
    expect(after).toEqual({ kind: 'current' });
  });

  test('F-0422 no record, a damaged one, one too large to be a record, or an id that is not a plain name is unknown', async () => {
    const { folder, state } = fresh();
    const reads: string[] = [];
    const counted: StatePort = {
      ...state,
      read: async (file, name) => (reads.push(name ?? ''), await state.read(file, name)),
      version: async (file, name) => (reads.push(`version:${name ?? ''}`), await state.version(file, name)),
    };
    const harness = over({ value: 'auto' }, counted);

    const never = await harness.launchSettings?.(FERRET);
    folder.plant(CODEX_LAUNCH_SETTINGS, '{"format":1,"sections":{"permission-mode":"auto"}}', FERRET);
    const damaged = await harness.launchSettings?.(FERRET);
    folder.plant(CODEX_LAUNCH_SETTINGS, `{"format":1,"pad":"${'x'.repeat(8 * 1024)}"}`, FERRET);
    const before = reads.length;
    const oversized = await harness.launchSettings?.(FERRET);
    const crooked = await harness.launchSettings?.('../f2' as FerretId);

    for (const answer of [never, damaged, oversized, crooked]) expect(answer).toEqual({ kind: 'unknown' });
    // Bounded: the oversized record is sized by one lstat and never read; a crooked id never reaches the state port.
    expect(reads.slice(before)).toEqual([`version:${FERRET}`]);
  });

  test('F-0422 a state port that faults while reading is unknown, and what it threw is dropped unread', async () => {
    const { state } = fresh();
    const harness = over(
      { value: 'auto' },
      {
        ...state,
        version: async () => {
          throw new Error(`EIO at ${HOME}`);
        },
      },
    );

    const answer = await harness.launchSettings?.(FERRET);

    expect(answer).toEqual({ kind: 'unknown' });
    expect(JSON.stringify(answer)).not.toContain(HOME);
  });

  test('F-0422 a record that cannot be written never fails the launch, and an older launch’s record is not left to answer', async () => {
    const { folder, state } = fresh();
    const mode = { value: 'auto' as HarnessConfig['permissionMode'] };
    const harness = over(mode, state);
    await harness.start(spec, runner, {} as never);
    mode.value = 'skip';
    const failing = over(mode, {
      ...state,
      write: async (file, value, name) => {
        if (file === CODEX_LAUNCH_SETTINGS) throw new Error(`disk full at ${HOME}`);
        await state.write(file, value, name);
      },
    });

    const started = await failing.start(spec, runner, {} as never);

    expect(started.ok).toBe(true);
    expect(folder.raw(CODEX_LAUNCH_SETTINGS, FERRET)).toBeUndefined();
    expect(await harness.launchSettings?.(FERRET)).toEqual({ kind: 'unknown' });
  });
});
