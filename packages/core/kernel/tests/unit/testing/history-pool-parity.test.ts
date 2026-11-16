/**
 * The testing host's history-pool door stays in step with the real roots port: the same rules
 * (`host/history-pool.ts`, `manifest/history-pool.ts`) decide the root, the permission, the entry, the pool, the home and
 * what may already be at the name, in the same order, so a harness plugin's unit test meets exactly the refusals and the
 * link production makes. Every case runs on both and the outcomes must be equal.
 */
import { afterEach, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { err } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import { defineState } from '../../../contract/define.ts';
import type { KernelPorts, RootHandle } from '../../../contract/ports.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { HistoryPoolError } from '../../../host/history-pool.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import type { Manifest } from '../../../manifest/types.ts';
import { testHost } from '../../../testing/index.ts';

const POOL = defineState({ name: 'pool', path: 'history-pool/*', store: 'opaque', format: 1 });

const harnessManifest = definePlugin({
  id: 'harness',
  title: 'Harness',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  permissions: {
    roots: ['agent-homes', 'downloads'],
    historyPool: {
      state: 'pool',
      entries: [
        { name: 'projects', kind: 'folder' },
        { name: 'sessions', kind: 'folder' },
        { name: 'history.jsonl', kind: 'file' },
      ],
    },
  },
  data: { state: [POOL] },
});
const bareManifest = definePlugin({
  id: 'bare',
  title: 'Bare',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  permissions: { roots: ['agent-homes'] },
});

interface Side {
  readonly harness: KernelPorts['roots'];
  readonly bare: KernelPorts['roots'];
  /** What the pool holds at `entry` now: a folder, a file, or nothing. */
  pool(entry: string): Promise<'folder' | 'file' | 'nothing'>;
  /** Whether the pool folder itself exists. */
  poolFolder(): Promise<boolean>;
  /** A pool entry planted as the WRONG kind (a file where a folder is declared and the reverse). */
  plantWrongKind(entry: string, kind: 'folder' | 'file'): Promise<void>;
  /** The ferret home `f3` planted as a link out of agent-homes. */
  plantHomeLink(): Promise<void>;
}

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

async function real(): Promise<Side> {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-hist-parity-`));
  parents.push(parent);
  const home = `${parent}/home`;
  await mkdir(`${home}/state/harness`, { recursive: true, mode: 0o700 });
  const fs = nodeFs(() => crypto.randomUUID());
  await ensureInternalRootBases(fs, { home, plugin: 'harness' }, ['agent-homes', 'downloads']);
  await ensureInternalRootBases(fs, { home, plugin: 'bare' }, ['agent-homes']);
  const workFolders: WorkFolders = { folderOf: () => undefined, check: () => err('outside') };
  const port = (manifest: Manifest) =>
    rootsPortFor(
      fs,
      { home, plugin: manifest.id, worktrees: `${home}-worktrees` },
      manifest.permissions?.roots ?? [],
      () => workFolders,
      {
        ...(manifest.permissions?.historyPool === undefined ? {} : { historyPool: manifest.permissions.historyPool }),
        stateFiles: manifest.data?.state ?? [],
        privateFiles: [],
      },
    );
  const pooled = `${home}/state/harness/history-pool`;
  return {
    harness: port(harnessManifest),
    bare: port(bareManifest),
    pool: async entry => {
      const found = await lstat(`${pooled}/${entry}`).catch(() => undefined);
      return found === undefined ? 'nothing' : found.isDirectory() ? 'folder' : 'file';
    },
    poolFolder: async () => (await lstat(pooled).catch(() => undefined)) !== undefined,
    plantWrongKind: async (entry, kind) => {
      await mkdir(pooled, { recursive: true, mode: 0o700 });
      if (kind === 'folder') await mkdir(`${pooled}/${entry}`, { mode: 0o700 });
      else await writeFile(`${pooled}/${entry}`, 'x', { mode: 0o600 });
    },
    plantHomeLink: async () => {
      await mkdir(`${parent}/outside`, { recursive: true });
      await symlink(`${parent}/outside`, `${home}/state/harness/agent-homes/f3`);
    },
  };
}

async function testing(): Promise<Side> {
  const ports = new Map<string, KernelPorts['roots']>();
  const half = (manifest: Manifest) =>
    implementDaemon(manifest, {
      build: ctx => {
        ports.set(manifest.id, ctx.kernel.roots);
        return {};
      },
    });
  const host = await testHost({ plugins: [half(harnessManifest), half(bareManifest)] });
  const get = (id: string): KernelPorts['roots'] => {
    const found = ports.get(id);
    if (found === undefined) throw new Error(`${id} was not built`);
    return found;
  };
  const state = () => host.state('harness');
  return {
    harness: get('harness'),
    bare: get('bare'),
    pool: async entry => {
      const folder = `history-pool/${entry}`;
      if (state().directories.has(folder)) return 'folder';
      return state().bytes.has(folder) || state().files.has(folder) ? 'file' : 'nothing';
    },
    poolFolder: async () => state().directories.has('history-pool'),
    plantWrongKind: async (entry, kind) => {
      state().directories.set('history-pool', { mode: 0o700, modifiedMs: 0 });
      if (kind === 'folder') state().directories.set(`history-pool/${entry}`, { mode: 0o700, modifiedMs: 0 });
      else state().files.set(`history-pool/${entry}`, 'x');
    },
    plantHomeLink: async () => {
      host.putRootLink('agent-homes', 'f3');
    },
  };
}

const resolved = (root: RootHandle, path: string): FencedPath => {
  const answer = root.resolve(path);
  if (!answer.ok) throw new Error(answer.error);
  return answer.value;
};

/** What a call came to: the door's refusal, `root:<refusal>` for a root refusal, or the kind of thing now at the name. */
async function outcome(act: () => Promise<unknown>, look: () => Promise<string>): Promise<string> {
  try {
    await act();
    return `made:${await look()}`;
  } catch (error) {
    if (error instanceof HistoryPoolError) return `refused:${error.refusal}`;
    if (error instanceof RootError) return `root:${error.refusal}`;
    throw error;
  }
}

const kindAt = async (root: RootHandle, path: string): Promise<string> =>
  (await root.lstat(resolved(root, path)).catch(() => undefined))?.kind ?? 'nothing';

/** Links `entry` in ferret home `ferret` through the UNSCOPED handle of `roots`, answering what it came to. */
async function link(roots: KernelPorts['roots'], ferret: string, entry: string, make = true): Promise<string> {
  const all = roots.root('agent-homes');
  if (make) await all.makeDirectory(resolved(all, ferret)).catch(() => undefined);
  return await outcome(
    async () => await all.linkHistory(resolved(all, ferret), entry),
    async () => await kindAt(all, `${ferret}/${entry}`),
  );
}

type Case = (side: Side) => Promise<unknown>;

const CASES: Readonly<Record<string, Case>> = {
  'link: a folder entry and a file entry are made, in two ferret homes, to one pool': async side => ({
    f1Projects: await link(side.harness, 'f1', 'projects'),
    f1History: await link(side.harness, 'f1', 'history.jsonl'),
    f2Projects: await link(side.harness, 'f2', 'projects'),
    projects: await side.pool('projects'),
    history: await side.pool('history.jsonl'),
    other: await side.pool('sessions'),
    pool: await side.poolFolder(),
  }),
  'link: a scoped handle (one ferret home) links its own home': async side => {
    const all = side.harness.root('agent-homes');
    await all.makeDirectory(resolved(all, 'f1'));
    const own = side.harness.root('agent-homes', { subfolder: 'f1' });
    return await outcome(
      async () => await own.linkHistory(resolved(own, ''), 'projects'),
      async () => await kindAt(own, 'projects'),
    );
  },
  'not_permitted: a plugin without permissions.historyPool': async side => ({
    result: await link(side.bare, 'f1', 'projects'),
    pool: await side.poolFolder(),
  }),
  'denied: every credential, settings, instruction, code and hidden name': async side => {
    const answers: Record<string, string> = {};
    for (const name of [
      '.credentials.json',
      '.claude.json',
      '.hidden',
      'settings.json',
      'settings.local.json',
      'SETTINGS.JSON',
      'auth.json',
      'config.toml',
      'CLAUDE.md',
      'AGENTS.md',
      'skills',
      'Skills',
      'plugins',
      'a/b',
      '..',
      '.',
      '',
      'a\0b',
      'token-cache',
    ])
      answers[JSON.stringify(name)] = await link(side.harness, 'f1', name);
    return { answers, pool: await side.poolFolder() };
  },
  'not_listed: a legal name the manifest does not list': async side => ({
    result: await link(side.harness, 'f1', 'todos'),
    pool: await side.poolFolder(),
  }),
  'not_listed: the list is exact and case-sensitive': async side => ({
    result: await link(side.harness, 'f1', 'Projects'),
    pool: await side.poolFolder(),
  }),
  'not_home: the root itself, a folder two deep, a scoped handle that is not one home': async side => {
    const all = side.harness.root('agent-homes');
    await all.makeDirectory(resolved(all, 'f1/sub'));
    const nested = side.harness.root('agent-homes', { subfolder: 'f1/sub' });
    return {
      top: await outcome(
        async () => await all.linkHistory(resolved(all, ''), 'projects'),
        async () => 'x',
      ),
      deep: await outcome(
        async () => await all.linkHistory(resolved(all, 'f1/sub'), 'projects'),
        async () => 'x',
      ),
      nested: await outcome(
        async () => await nested.linkHistory(resolved(nested, ''), 'projects'),
        async () => 'x',
      ),
      pool: await side.poolFolder(),
    };
  },
  'exists: a folder or a file already at the name is left as it was, and the pool is not made': async side => {
    const all = side.harness.root('agent-homes');
    await all.makeDirectory(resolved(all, 'f1/projects'));
    await all.writeText(resolved(all, 'f1/history.jsonl'), 'mine');
    return {
      folder: await link(side.harness, 'f1', 'projects', false),
      file: await link(side.harness, 'f1', 'history.jsonl', false),
      pool: await side.poolFolder(),
      text: await all.readText(resolved(all, 'f1/history.jsonl')),
    };
  },
  'exists: a second link of the same entry is refused, never an overwrite': async side => ({
    first: await link(side.harness, 'f1', 'projects'),
    again: await link(side.harness, 'f1', 'projects', false),
  }),
  'exists: unlinking the link allows a new one': async side => {
    const first = await link(side.harness, 'f1', 'projects');
    const all = side.harness.root('agent-homes');
    await all.unlink(resolved(all, 'f1/projects'));
    return { first, again: await link(side.harness, 'f1', 'projects', false), pool: await side.pool('projects') };
  },
  'outside: the ferret home is not there, and this call makes none': async side => {
    const all = side.harness.root('agent-homes');
    return {
      result: await link(side.harness, 'nobody', 'projects', false),
      home: await kindAt(all, 'nobody'),
      pool: await side.poolFolder(),
    };
  },
  'link_escape: the ferret home is itself a link': async side => {
    await side.plantHomeLink();
    return { result: await link(side.harness, 'f3', 'projects', false), pool: await side.poolFolder() };
  },
  'changed: the pool holds a file where a folder is declared, and a folder where a file is': async side => {
    await side.plantWrongKind('projects', 'file');
    await side.plantWrongKind('history.jsonl', 'folder');
    return {
      folder: await link(side.harness, 'f1', 'projects'),
      file: await link(side.harness, 'f1', 'history.jsonl'),
    };
  },
  'not_internal: a downloads handle has no history door': async side => {
    const downloads = side.harness.root('downloads');
    return await outcome(
      async () => await downloads.linkHistory(resolved(downloads, 'f1'), 'projects'),
      async () => 'x',
    );
  },
};

for (const [name, run] of Object.entries(CASES))
  test(`parity: ${name}`, async () => {
    const onReal = await run(await real());
    const onTesting = await run(await testing());
    expect(onTesting).toEqual(onReal);
  });

test('the pinned outcomes, on the real roots', async () => {
  const side = await real();
  expect(
    await CASES['link: a folder entry and a file entry are made, in two ferret homes, to one pool']?.(side),
  ).toEqual({
    f1Projects: 'made:symlink',
    f1History: 'made:symlink',
    f2Projects: 'made:symlink',
    projects: 'folder',
    history: 'file',
    other: 'nothing',
    pool: true,
  });
  expect(await CASES['not_permitted: a plugin without permissions.historyPool']?.(await real())).toEqual({
    result: 'refused:not_permitted',
    pool: false,
  });
  expect(await CASES['not_listed: a legal name the manifest does not list']?.(await real())).toEqual({
    result: 'refused:not_listed',
    pool: false,
  });
  expect(await CASES['outside: the ferret home is not there, and this call makes none']?.(await real())).toEqual({
    result: 'root:outside',
    home: 'nothing',
    pool: false,
  });
  expect(await CASES['link_escape: the ferret home is itself a link']?.(await real())).toEqual({
    result: 'root:link_escape',
    pool: false,
  });
  expect(await CASES['not_internal: a downloads handle has no history door']?.(await real())).toBe(
    'refused:not_internal',
  );
});
