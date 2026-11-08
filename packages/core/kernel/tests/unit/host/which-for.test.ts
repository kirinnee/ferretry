import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { type ChildEnvironment, type ChildEnvironmentOpener, ChildEnvironmentPort } from '../../../contract/bound.ts';
import { defineHook } from '../../../contract/define.ts';
import type { HandleCommandLookup } from '../../../contract/ports.ts';
import { bootHost } from '../../../host/host.ts';
import { handleReaders, MAX_SEARCH_DIRECTORIES, whichForCommand } from '../../../host/which.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon, type Permissions } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { testHost } from '../../../testing/index.ts';

/**
 * K18 `kernel.paths.whichFor` (item #18, Q7): where ONE command resolves on the PATH a Vault handle WILL set, without
 * spending it — only for a plugin with `permissions.which`, only for a handle minted for itself or for a plugin that
 * offers a hook it takes (computed from the declared manifests, never from the caller), and never the PATH itself.
 * Every handle it may not read answers `unprovable`, the same as a forged one, so a guard fails closed.
 */
const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});
const folder = async (): Promise<string> => {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-which-for-`));
  parents.push(parent);
  return parent;
};

const SENTINEL = 'sentinel-folder-q7';

describe('K18 whichForCommand: the handle’s PATH only, failing closed', () => {
  const probe = (accepted: readonly string[]) => async (path: string) => accepted.includes(path);

  test('a PATH the Vault would not hand over is unprovable, never absent', async () => {
    expect(await whichForCommand('claude', undefined, probe(['/usr/bin/claude']))).toEqual({ kind: 'unprovable' });
  });

  test('a PATH with no folder this lookup may search is unprovable (empty, relative, odd)', async () => {
    for (const path of ['', ':', 'bin:./x', '../up', '/a/../b'])
      expect(await whichForCommand('claude', path, probe(['/usr/bin/claude']))).toEqual({ kind: 'unprovable' });
  });

  test('found on the handle’s PATH, or absent, with which’s rules (name grammar, relative entries dropped)', async () => {
    const path = `bin:/${SENTINEL}/a:/opt/fake`;
    expect(await whichForCommand('claude', path, probe(['/opt/fake/claude', 'bin/claude']))).toEqual({
      kind: 'found',
      path: '/opt/fake/claude',
    });
    expect(await whichForCommand('codex', path, probe([]))).toEqual({ kind: 'absent' });
    expect(await whichForCommand('../claude', path, probe(['/opt/fake/../claude']))).toEqual({ kind: 'absent' });
  });

  test('the 64-folder bound holds on a handle’s PATH too', async () => {
    const folders = Array.from({ length: MAX_SEARCH_DIRECTORIES + 1 }, (_, index) => `/d${String(index)}`);
    const last = `${folders.at(-1)}/claude`;
    expect(await whichForCommand('claude', folders.join(':'), probe([last]))).toEqual({ kind: 'absent' });
  });

  test('the PATH itself never comes back: an absent answer names no folder of it', async () => {
    const answer = await whichForCommand('claude', `/${SENTINEL}/bin:/usr/${SENTINEL}`, probe([]));
    expect(JSON.stringify(answer)).not.toContain(SENTINEL);
  });
});

describe('K18 handleReaders: the plugin itself and each one offering a hook it takes', () => {
  const Launch = defineHook('test.launch', { mode: 'observe' });
  const Other = defineHook('test.other', { mode: 'observe' });
  const manifests = [
    { id: 'launcher', hooks: { offers: [{ hook: Launch }, { hook: Other }] } },
    { id: 'runner', hooks: { takes: [{ hook: Launch }] } },
    { id: 'co-taker', hooks: { takes: [{ hook: Launch }] } },
    { id: 'elsewhere', hooks: { offers: [{ hook: Other }] } },
    { id: 'bare' },
  ];

  test('on the edge: the offerer of a taken hook; off it: co-takers and offerers of untaken hooks', () => {
    expect(handleReaders('runner', manifests)).toEqual(['runner', 'launcher']);
    expect(handleReaders('co-taker', manifests)).toEqual(['co-taker', 'launcher']);
    expect(handleReaders('launcher', manifests)).toEqual(['launcher']);
    expect(handleReaders('bare', manifests)).toEqual(['bare']);
    expect(handleReaders('unknown', manifests)).toEqual(['unknown']);
    expect(Object.isFrozen(handleReaders('runner', manifests))).toBe(true);
  });
});

// Both hosts ──────────────────────────────────────────────────────────────────────────────────────────────────────

const Launch = defineHook('test.launch', { mode: 'observe' });

/** A stand-in for the Vault's opener: each handle names its requester and PATH, and the readers asked are kept. */
const opener = () => {
  const minted = new WeakMap<object, { requester: string; path: string }>();
  const asked: (readonly string[])[] = [];
  const port: ChildEnvironmentOpener = {
    open: () => undefined,
    searchPathOf: (env, readers) => {
      asked.push([...readers]);
      const found = minted.get(env as object);
      return found !== undefined && readers.includes(found.requester) ? found.path : undefined;
    },
  };
  const mint = (requester: string, path: string): ChildEnvironment => {
    const handle = Object.freeze({ names: ['PATH'] });
    minted.set(handle, { requester, path });
    return handle as unknown as ChildEnvironment;
  };
  return { port, mint, asked };
};

type Seen = Record<string, (name: string, env: ChildEnvironment) => Promise<HandleCommandLookup>>;

const plugin = (id: string, seen: Seen, options: { permissions?: Permissions; offers?: true; takes?: true } = {}) =>
  implementDaemon(
    definePlugin({
      id,
      title: id,
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
      ...(options.offers === true ? { hooks: { offers: [{ hook: Launch }] } } : {}),
      ...(options.takes === true ? { hooks: { takes: [{ hook: Launch }] } } : {}),
    }),
    {
      build: ({ kernel }) => {
        seen[id] = async (name, env) => await kernel.paths.whichFor(name, env);
        return options.takes === true ? { hooks: { 'test.launch': () => {} } } : {};
      },
    },
  );

const vaultStandIn = (port: ChildEnvironmentOpener) =>
  implementDaemon(
    definePlugin({
      id: 'vault',
      title: 'Vault',
      version: '5.0.0',
      api: 5,
      core: true,
      kinds: [],
      provides: { childEnvironments: ChildEnvironmentPort },
    }),
    { build: () => ({ provides: { childEnvironments: port } }) },
  );

type Answer = HandleCommandLookup | { readonly refused: string };
const answer = async (call: () => Promise<HandleCommandLookup> | undefined): Promise<Answer> => {
  try {
    const result = call();
    if (result === undefined) throw new Error('plugin was not built');
    return await result;
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
};

describe('K18 parity: the real host and the testing host answer whichFor alike', () => {
  test('on-edge and self found; off-edge, forged, thrown and undeclared fail closed; the daemon PATH is never used', async () => {
    const parent = await folder();
    const handleBin = `${parent}/${SENTINEL}/bin`;
    await mkdir(handleBin, { recursive: true });
    await mkdir(`${parent}/daemon-bin`);
    for (const path of [`${handleBin}/claude`, `${parent}/daemon-bin/codex`]) {
      await writeFile(path, '#!/bin/sh\n');
      await chmod(path, 0o755);
    }
    const which: Permissions = { which: true };

    const run = async (host: 'real' | 'testing') => {
      const vault = opener();
      const throwing: ChildEnvironmentOpener = {
        open: () => undefined,
        searchPathOf: () => {
          throw new Error('not mine');
        },
      };
      const seen: Seen = {};
      const plugins = [
        plugin('launcher', seen, { offers: true, permissions: which }),
        plugin('runner', seen, { takes: true, permissions: which }),
        plugin('stranger', seen, { permissions: which }),
        plugin('undeclared', seen, { takes: true }),
      ];
      const fromLauncher = vault.mint('launcher', handleBin);
      const fromStranger = vault.mint('stranger', handleBin);
      const fromRunner = vault.mint('runner', handleBin);
      const forged = Object.freeze({ names: ['PATH'] }) as unknown as ChildEnvironment;
      const cases: readonly (() => Promise<HandleCommandLookup> | undefined)[] = [
        () => seen.runner?.('claude', fromLauncher), // on the edge
        () => seen.runner?.('claude', fromRunner), // its own handle
        () => seen.launcher?.('claude', fromLauncher), // the requester itself
        () => seen.runner?.('codex', fromLauncher), // on the daemon's PATH only: absent, never found
        () => seen.runner?.('claude', fromStranger), // off the edge: another requester
        () => seen.stranger?.('claude', fromLauncher), // off the edge: not a taker
        () => seen.launcher?.('claude', fromRunner), // the offerer never reads its taker's handle
        () => seen.runner?.('claude', forged), // forged: the same answer as off the edge
        () => seen.undeclared?.('claude', fromLauncher), // no permissions.which
      ];
      const answers: Answer[] = [];
      if (host === 'real') {
        const home = `${parent}/home-real`;
        const outcome = await bootHost({
          home,
          version: '5.0.0',
          adapters: {
            ...realAdapters(home, () => {}, { binary: 'fy' }),
            searchPath: () => `${parent}/daemon-bin`,
            clock: fixedClock(),
            homeLock: async () => ({ release: async () => {} }),
          },
          implementations: [vaultStandIn(vault.port), ...plugins],
        });
        try {
          if (outcome.kind !== 'running') throw new Error(outcome.sentence);
          for (const call of cases) answers.push(await answer(call));
        } finally {
          if (outcome.kind === 'running') await outcome.host.stop();
        }
      } else {
        const testing = await testHost({
          plugins: [vaultStandIn(vault.port), ...plugins],
          searchPath: `${parent}/daemon-bin`,
          executables: [`${handleBin}/claude`, `${parent}/daemon-bin/codex`],
        });
        for (const call of cases) answers.push(await answer(call));
        await testing.stop();
      }
      // A throwing opener is unprovable too, never answered from the daemon's PATH (where `codex` is).
      if (host === 'real') {
        const home = `${parent}/home-throwing`;
        const outcome = await bootHost({
          home,
          version: '5.0.0',
          adapters: {
            ...realAdapters(home, () => {}, { binary: 'fy' }),
            searchPath: () => `${parent}/daemon-bin`,
            clock: fixedClock(),
            homeLock: async () => ({ release: async () => {} }),
          },
          implementations: [vaultStandIn(throwing), plugin('runner', seen, { permissions: which })],
        });
        try {
          if (outcome.kind !== 'running') throw new Error(outcome.sentence);
          answers.push(await answer(() => seen.runner?.('codex', fromRunner)));
        } finally {
          if (outcome.kind === 'running') await outcome.host.stop();
        }
      } else {
        const thrown = await testHost({
          plugins: [plugin('runner', seen, { permissions: which })],
          searchPath: `${parent}/daemon-bin`,
          executables: [`${parent}/daemon-bin/codex`],
          childEnvironments: throwing,
        });
        answers.push(await answer(() => seen.runner?.('codex', fromRunner)));
        await thrown.stop();
      }
      return { answers, asked: vault.asked };
    };

    const real = await run('real');
    const testing = await run('testing');
    expect(testing.answers).toEqual(real.answers);
    expect(real.answers).toEqual([
      { kind: 'found', path: `${handleBin}/claude` },
      { kind: 'found', path: `${handleBin}/claude` },
      { kind: 'found', path: `${handleBin}/claude` },
      { kind: 'absent' },
      { kind: 'unprovable' },
      { kind: 'unprovable' },
      { kind: 'unprovable' },
      { kind: 'unprovable' },
      { refused: 'undeclared did not declare permissions.which, so it looks no command up.' },
      { kind: 'unprovable' },
    ]);
    // The readers came from the declared manifests alone, the same on both hosts.
    expect(testing.asked).toEqual(real.asked);
    expect(real.asked).toEqual([
      ['runner', 'launcher'],
      ['runner', 'launcher'],
      ['launcher'],
      ['runner', 'launcher'],
      ['runner', 'launcher'],
      ['stranger'],
      ['launcher'],
      ['runner', 'launcher'],
    ]);
    // Never the PATH: no found answer is anything but the one command's path, and no other answer names a folder.
    for (const one of real.answers.filter(item => !('kind' in item) || item.kind !== 'found'))
      expect(JSON.stringify(one)).not.toContain(SENTINEL);
  });
});
