/**
 * The testing host's `ConfigPort.watchState` and its `configChanges` (the `kernel.config-changed` frames the real host
 * would publish) stay in step with the real config service: the same move rule (`host/config/state-change.ts`) decides
 * both, so a plugin's unit test hears the same transitions — written, held, a held removal, a set, broken, fixed — that
 * production gives. Etags differ by host (the real one hashes the file's text), so each step compares the paths,
 * names and states, and that an etag moved where it must.
 */
import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineConfig } from '../../../contract/index.ts';
import type { ConfigPort, ConfigStateChange } from '../../../contract/ports.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { configChangedPayload } from '../../../host/config/state-change.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';
import { captureLog, HOME, manualClock } from '../host-config/support.ts';

const limitsDef = defineConfig({
  file: 'limits.yaml',
  schema: z.strictObject({ limit: z.number().int().default(10) }),
  axis: 'configure',
  loosens: (before, after) => (after.limit > (before?.limit ?? 10) ? ['raises the limit'] : []),
});
const itemsDef = defineConfig({
  collection: 'items',
  name: /^[a-z]{1,10}$/,
  schema: z.strictObject({ budget: z.number().optional() }),
  axis: 'configure',
  loosens: (before, after) =>
    (after.budget ?? Number.POSITIVE_INFINITY) > (before?.budget ?? Number.POSITIVE_INFINITY)
      ? ['raises or removes the budget']
      : [],
});
const strangerDef = defineConfig({
  file: 'stranger.yaml',
  schema: z.strictObject({}),
  axis: 'configure',
  loosens: () => [],
});

const manifest = definePlugin({
  id: 'runtimes',
  title: 'Runtimes',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  data: { config: [limitsDef, itemsDef] },
});

interface Side {
  readonly config: ConfigPort;
  /** Every frame the host would publish, as the shared payload builder makes it. */
  frames(): readonly { plugin: string; path: string; state: string; etag: string }[];
  /** A hand edit of limits.yaml to a value its schema refuses, then the load that sees it; `fix` puts a good one back. */
  breakLimits(): Promise<void>;
  fixLimits(): Promise<void>;
  stop(): Promise<void>;
}

async function testing(): Promise<Side> {
  let config: ConfigPort | undefined;
  const half = implementDaemon(manifest, {
    build: ctx => {
      config = ctx.kernel.config;
      return {};
    },
  });
  // no loosening is let through, as the real service with no judge
  const host = await testHost({ plugins: [half], gate: { judgeConfigWrite: () => 'hold' } as never });
  if (config === undefined) throw new Error('the half was not built');
  return {
    config,
    frames: () => host.configChanges,
    breakLimits: async () => host.setConfig('limits.yaml', { limit: 'many' }),
    fixLimits: async () => host.setConfig('limits.yaml', { limit: 2 }),
    stop: () => host.stop(),
  };
}

async function real(): Promise<Side> {
  const fs = createMemoryHostFs();
  const files = createConfigFiles({
    home: HOME,
    fs,
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    defs: [
      { plugin: 'runtimes', def: limitsDef },
      { plugin: 'runtimes', def: itemsDef },
    ],
  });
  await files.reload();
  const frames: { plugin: string; path: string; state: string; etag: string }[] = [];
  files.onStateChange((plugin, move) => void frames.push(configChangedPayload(plugin, move)));
  return {
    config: files.port('runtimes'),
    frames: () => frames,
    breakLimits: async () => {
      fs.seed(`${HOME}/config/limits.yaml`, 'limit: many\n');
      await files.reload();
    },
    fixLimits: async () => {
      fs.seed(`${HOME}/config/limits.yaml`, 'limit: 2\n');
      await files.reload();
    },
    stop: async () => undefined,
  };
}

/** One step: what it does to a side, and the moves (path, name, state) both sides must hear, in path order. */
const STEPS: readonly {
  readonly label: string;
  readonly act: (side: Side) => Promise<unknown>;
  readonly moves: readonly { path: string; name?: string; state: ConfigStateChange['state'] }[];
}[] = [
  {
    label: 'a first file written',
    act: side => side.config.write(limitsDef, undefined, 'limit: 5\n'),
    moves: [{ path: 'limits.yaml', state: 'valid' }],
  },
  {
    label: 'a tightening: still valid, at a new etag',
    act: side => side.config.write(limitsDef, undefined, 'limit: 3\n'),
    moves: [{ path: 'limits.yaml', state: 'valid' }],
  },
  {
    label: 'two collection items written',
    act: async side => {
      await side.config.write(itemsDef, 'a', 'budget: 5\n');
      await side.config.write(itemsDef, 'b', 'budget: 2\n');
    },
    moves: [
      { path: 'items/a.yaml', name: 'a', state: 'valid' },
      { path: 'items/b.yaml', name: 'b', state: 'valid' },
    ],
  },
  {
    label: 'a loosening held for the owner',
    act: side => side.config.write(itemsDef, 'a', 'budget: 50\n'),
    moves: [{ path: 'items/a.yaml', name: 'a', state: 'held' }],
  },
  {
    label: "another item's write leaves the held one held",
    act: side => side.config.write(itemsDef, 'b', 'budget: 1\n'),
    moves: [{ path: 'items/b.yaml', name: 'b', state: 'valid' }],
  },
  {
    label: 'a removal that loosens is held',
    act: side => side.config.remove(itemsDef, 'b'),
    moves: [{ path: 'items/b.yaml', name: 'b', state: 'held' }],
  },
  {
    label: 'a set written whole: each of its files moves once',
    act: side =>
      side.config.writeAll([
        { def: limitsDef, edit: 'limit: 2\n' },
        { def: itemsDef, name: 'c', edit: 'budget: 1\n' },
      ]),
    moves: [
      { path: 'items/c.yaml', name: 'c', state: 'valid' },
      { path: 'limits.yaml', state: 'valid' },
    ],
  },
  {
    label: 'a held set writes nothing, so nothing moves',
    act: side => side.config.writeAll([{ def: limitsDef, edit: 'limit: 50\n' }]),
    moves: [],
  },
  {
    label: 'a refused write moves nothing',
    act: side => side.config.write(limitsDef, undefined, 'limit: many\n'),
    moves: [],
  },
  {
    label: 'a file broken by hand is invalid',
    act: side => side.breakLimits(),
    moves: [{ path: 'limits.yaml', state: 'invalid' }],
  },
  {
    label: 'fixed by hand, valid again',
    act: side => side.fixLimits(),
    moves: [{ path: 'limits.yaml', state: 'valid' }],
  },
];

test('watchState parity: the testing host hears every step the real service does (same paths, names, states)', async () => {
  const sides = { real: await real(), testing: await testing() };
  const heard = { real: [] as ConfigStateChange[], testing: [] as ConfigStateChange[] };
  for (const key of ['real', 'testing'] as const) {
    sides[key].config.watchState(limitsDef, change => void heard[key].push(change));
    sides[key].config.watchState(itemsDef, change => void heard[key].push(change));
  }
  try {
    for (const step of STEPS) {
      for (const key of ['real', 'testing'] as const) {
        const side = sides[key];
        const framesBefore = side.frames().length;
        const heardBefore = heard[key].length;
        await step.act(side);
        const frames = side.frames().slice(framesBefore);
        const changes = heard[key].slice(heardBefore);
        const label = `${step.label} (${key})`;
        // the frames: plugin, path and state as the step says (path order: the order within one act is not promised)
        expect(
          frames
            .map(({ plugin, path, state }) => ({ plugin, path, state }))
            .toSorted((a, b) => a.path.localeCompare(b.path)),
          label,
        ).toEqual(step.moves.map(({ path, state }) => ({ plugin: 'runtimes', path, state })));
        // what watchState heard is the same moves, named, never more than a name, a state and an etag
        expect(
          changes
            .map(({ name, state }) => ({ ...(name === undefined ? {} : { name }), state }))
            .toSorted((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
          label,
        ).toEqual(
          step.moves
            .map(({ name, state }) => ({ ...(name === undefined ? {} : { name }), state }))
            .toSorted((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
        );
        for (const change of changes)
          expect(Object.keys(change).every(k => ['name', 'state', 'etag'].includes(k))).toBe(true);
      }
    }
    // a removal held, or any absent file, names the same etag on both hosts; every other etag moved where it must
    for (const key of ['real', 'testing'] as const) {
      const limits = sides[key].frames().filter(frame => frame.path === 'limits.yaml');
      for (const [index, frame] of limits.entries())
        if (index > 0) expect(frame.etag).not.toBe(limits[index - 1]?.etag);
      expect(sides[key].frames().find(frame => frame.path === 'items/b.yaml' && frame.state === 'held')?.etag).toBe(
        'absent',
      );
    }
    // another plugin's def is refused on both
    for (const key of ['real', 'testing'] as const)
      expect(() => sides[key].config.watchState(strangerDef, () => {})).toThrow();
  } finally {
    await sides.real.stop();
    await sides.testing.stop();
  }
});

test('the testing host: the first world is the baseline, and a cancelled watchState hears nothing more', async () => {
  let config: ConfigPort | undefined;
  const half = implementDaemon(manifest, {
    build: ctx => {
      config = ctx.kernel.config;
      return {};
    },
  });
  const host = await testHost({ plugins: [half], config: { 'limits.yaml': { limit: 5 } } });
  try {
    const changes: ConfigStateChange[] = [];
    const cancel = config?.watchState(limitsDef, change => void changes.push(change));
    expect(host.configChanges).toEqual([]);
    await config?.write(limitsDef, undefined, 'limit: 4\n');
    cancel?.();
    await config?.write(limitsDef, undefined, 'limit: 3\n');
    expect(changes.map(change => change.state)).toEqual(['valid']);
    expect(host.configChanges.map(change => change.state)).toEqual(['valid', 'valid']);
  } finally {
    await host.stop();
  }
});
