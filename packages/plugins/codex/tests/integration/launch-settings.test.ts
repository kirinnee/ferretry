/**
 * W2-c: Codex records what a launch ran under and compares it with its settings now (`Harness.launchSettings`, RULING
 * #27 Q9; today's `FileLaunchSettingsDigest` over the login's wrapper, F-0422).
 */
import { describe, expect, test } from 'bun:test';
import type { LaunchSpec, Runner, RunSpec } from '@ferretry/core-ferrets/contract';
import type { FencedPath, FerretId, KernelPorts, RootHandle, StatePort } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { state as kernelState } from '@ferretry/kernel/host';
import { ok } from '@ferretry/std';
import { CODEX_LAUNCH_SETTINGS, CODEX_ROLLOUTS, CODEX_SETTINGS, type HarnessConfig } from '../../contract/index.ts';
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

function over(
  mode: { value: HarnessConfig['permissionMode'] },
  state: StatePort,
  items: ReadonlyMap<string, unknown> = new Map(),
) {
  return codexHarness({
    kernel: {
      roots: roots(),
      state,
      log: undefined as never,
      clock: realClock(),
      redaction: { read: async fn => await fn({ text: (s: string) => s } as never) },
      config: { collection: (definition: unknown) => (definition === CODEX_SETTINGS ? items : new Map()) } as never,
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

/**
 * The REAL kernel state port (the subsystem damage policy is the kernel's, not `MemoryStateFolder`'s) over an
 * in-memory disk, holding one healthy record (`f2`) and one record of the named kind of bad (`f1`).
 */
const damagedShapes = {
  'wrong schema': '{"format":1,"sections":{}}\n',
  'not JSON': 'not json at all',
  'a link (the disk refuses to read it)': undefined,
} as const;

async function realPortWithBadRecord(shape: keyof typeof damagedShapes, healthy: string) {
  const memory = kernelState.createMemoryHostFs();
  const base = '/fy/state/codex/launch-settings';
  const link = `${base}/f1.json`;
  await memory.writeAtomic(`${base}/f2.json`, healthy, 0o600);
  await memory.writeAtomic(link, damagedShapes[shape] ?? '{}', 0o600);
  const fs = {
    ...memory,
    readText: async (path: string) => {
      if (shape.startsWith('a link') && path === link) throw new Error('ELOOP: a link is never followed');
      return await memory.readText(path);
    },
    readBytes: async (path: string) => {
      if (shape.startsWith('a link') && path === link) throw new Error('ELOOP: a link is never followed');
      return await memory.readBytes(path);
    },
  };
  const opening = await kernelState.openPluginState({
    home: '/fy',
    pluginId: 'codex',
    files: [CODEX_ROLLOUTS, CODEX_LAUNCH_SETTINGS],
    fs,
    clock: { now: () => 0 as never },
    kind: 'plugin',
    liveTargets: true,
  });
  const changed: unknown[] = [];
  const port = kernelState.createStatePort({
    home: '/fy',
    pluginId: 'codex',
    files: [CODEX_ROLLOUTS, CODEX_LAUNCH_SETTINGS],
    fs,
    initialDamage: opening.damaged,
    initialNarrowed: opening.narrowed,
    changed: damage => changed.push(damage),
  });
  return { opening, port, changed, memory };
}

const HEALTHY_RECORD = `${JSON.stringify({
  format: 1,
  sections: { 'permission-mode': 'a'.repeat(64), 'fixed-layer': 'b'.repeat(64), settings: 'c'.repeat(64) },
})}\n`;

describe('F-0422 one bad launch-settings record is that ferret’s nothing-to-say, never the whole plugin’s damage', () => {
  for (const shape of Object.keys(damagedShapes) as (keyof typeof damagedShapes)[]) {
    test(`F-0422 ${shape}: the plugin stays healthy at boot and on a read, the answer is unknown, and another ferret is unaffected`, async () => {
      const { opening, port, changed } = await realPortWithBadRecord(shape, HEALTHY_RECORD);
      expect(CODEX_LAUNCH_SETTINGS.onDamaged).not.toBe('subsystem');
      expect(opening.damaged).toEqual([]);

      const harness = over({ value: 'auto' }, port);
      const bad = await harness.launchSettings?.(FERRET);
      const good = await harness.launchSettings?.('f2' as FerretId);

      expect(bad).toEqual({ kind: 'unknown' });
      expect(port.damaged()).toEqual([]);
      expect(changed).toEqual([]);
      // The neighbour's record still reads: it is another ferret's, and answers a comparison.
      expect(good?.kind).not.toBe('unknown');
    });

    test(`F-0422 ${shape}: the ferret's next launch still starts and clears the bad record, with the plugin healthy throughout`, async () => {
      const { port, changed, memory } = await realPortWithBadRecord(shape, HEALTHY_RECORD);
      const harness = over({ value: 'auto' }, port);

      const started = await harness.start(spec, runner, {} as never);

      expect(started.ok).toBe(true);
      expect(port.damaged()).toEqual([]);
      expect(changed).toEqual([]);
      expect(await memory.readText('/fy/state/codex/launch-settings/f1.json')).toBeUndefined();
    });
  }
});

describe('F-0422 Codex records what a launch ran under', () => {
  test('F-0422 a start records three values-free fingerprints in state/codex/launch-settings/<ferret>.json and is current', async () => {
    const { folder, state } = fresh();
    const harness = over({ value: 'auto' }, state);

    expect((await harness.start(spec, runner, {} as never)).ok).toBe(true);
    const raw = folder.raw(CODEX_LAUNCH_SETTINGS, FERRET) ?? '';
    const record = JSON.parse(raw) as { format: number; sections: Record<string, string> };

    expect(record.format).toBe(1);
    expect(Object.keys(record.sections).toSorted()).toEqual(['fixed-layer', 'permission-mode', 'settings']);
    for (const digest of Object.values(record.sections)) expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    for (const value of [FOLDER, HOME, 'auto', 'on-request', 'workspace-write']) expect(raw).not.toContain(value);
    expect(await harness.launchSettings?.(FERRET)).toEqual({ kind: 'current' });
  });

  test('F-0422 a launch reads the permission mode once, so the argv and the record describe the same setting', async () => {
    const { state } = fresh();
    let reads = 0;
    const flipping = {
      get value(): HarnessConfig['permissionMode'] {
        reads += 1;
        return reads === 1 ? 'auto' : 'skip';
      },
    };
    const harness = over(flipping, state);

    expect((await harness.start(spec, runner, {} as never)).ok).toBe(true);
    expect(reads).toBe(1);
    // The one read was 'auto'; the next read (the comparison) is 'skip', so the record shows that mode as the launched one.
    expect(await harness.launchSettings?.(FERRET)).toEqual({
      kind: 'drifted',
      sections: ['permission-mode', 'fixed-layer'],
    });
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

describe('F-0422 a changed Codex settings item says relaunch needed, as Claude Code’s does', () => {
  const guard = (value: string) => ({
    settings: { shell_environment_policy: { set: { GUARD: value } } },
  });

  test('F-0422 settings unchanged since the launch is current', async () => {
    const { state } = fresh();
    const items = new Map<string, unknown>([['guard', guard('one')]]);
    const harness = over({ value: 'auto' }, state, items);
    await harness.start(spec, runner, {} as never);

    expect(await harness.launchSettings?.(FERRET)).toEqual({ kind: 'current' });
  });

  test('F-0422 an item changed, added or removed since the launch drifts in the settings section only', async () => {
    const { state } = fresh();
    const items = new Map<string, unknown>([['guard', guard('one')]]);
    const harness = over({ value: 'auto' }, state, items);
    await harness.start(spec, runner, {} as never);
    const drifted = { kind: 'drifted', sections: ['settings'] } as const;

    items.set('guard', guard('two'));
    expect(await harness.launchSettings?.(FERRET)).toEqual(drifted);

    items.set('guard', guard('one'));
    expect(await harness.launchSettings?.(FERRET)).toEqual({ kind: 'current' });

    items.set('extra', { settings: { model: 'other' } });
    expect(await harness.launchSettings?.(FERRET)).toEqual(drifted);

    items.delete('extra');
    items.delete('guard');
    expect(await harness.launchSettings?.(FERRET)).toEqual(drifted);
  });

  test('F-0422 the record keeps no settings value, and a resume records the settings afresh', async () => {
    const { folder, state } = fresh();
    const items = new Map<string, unknown>([['guard', guard('secret-looking-value')]]);
    const harness = over({ value: 'auto' }, state, items);
    await harness.start(spec, runner, {} as never);
    expect(folder.raw(CODEX_LAUNCH_SETTINGS, FERRET) ?? '').not.toContain('secret-looking-value');

    items.set('guard', guard('two'));
    await harness.resume(spec, runner, {} as never, 'thread-1');

    expect(await harness.launchSettings?.(FERRET)).toEqual({ kind: 'current' });
  });
});
