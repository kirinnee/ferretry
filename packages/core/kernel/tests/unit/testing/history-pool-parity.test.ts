/**
 * The testing host's history-pool door stays in step with the real roots port: the same rules
 * (`host/history-pool.ts`, `manifest/history-pool.ts`) decide the root, the permission, the entry, the pool, the home and
 * what may already be at the name, in the same order, so a harness plugin's unit test meets exactly the refusals and the
 * link production makes. Every case runs on both and the outcomes must be equal.
 */
import { afterEach, expect, test } from 'bun:test';
import {
  link as hardlink,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';

import { tmpdir } from 'node:os';
import { err } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import { defineState } from '../../../contract/define.ts';
import type { KernelPorts, RootHandle } from '../../../contract/ports.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { HistoryPoolError } from '../../../host/history-pool.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';
import { definePlugin, implementDaemon, reachFaults } from '../../../manifest/index.ts';
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

const otherManifest = definePlugin({ ...harnessManifest, id: 'other' });
const noRootsManifest = definePlugin({
  ...harnessManifest,
  id: 'no-roots',
  permissions: { ...harnessManifest.permissions, roots: [] },
});
const notOwnManifest = definePlugin({ ...harnessManifest, id: 'not-own', data: { state: [] } });
const privateManifest = definePlugin({ ...harnessManifest, id: 'private', privacy: { private: ['history-pool'] } });
const CREDENTIALS = defineState({ name: 'credentials', path: 'credentials/*', store: 'opaque', format: 1 });
const loginsManifest = definePlugin({
  ...bareManifest,
  id: 'logins',
  permissions: { roots: ['credentials'], shareCredentials: ['auth.json'] },
  data: { state: [CREDENTIALS] },
  privacy: { private: ['credentials'] },
});
const additional = [otherManifest, privateManifest, loginsManifest];

interface Side {
  readonly harness: KernelPorts['roots'];
  readonly bare: KernelPorts['roots'];
  readonly additional: ReadonlyMap<string, KernelPorts['roots']>;
  /** What the pool holds at `entry` now: a folder, a file, or nothing. */
  pool(entry: string): Promise<'folder' | 'file' | 'nothing'>;
  /** Whether the pool folder itself exists. */
  poolFolder(): Promise<boolean>;
  /** A pool entry planted as the WRONG kind (a file where a folder is declared and the reverse). */
  plantWrongKind(entry: string, kind: 'folder' | 'file'): Promise<void>;
  /** The ferret home `f3` planted as a link out of agent-homes. */
  plantHomeLink(): Promise<void>;
  /** The pool folder itself planted as a link to somewhere else in the state folder, or as a plain file. */
  plantPoolFolder(kind: 'link' | 'file'): Promise<void>;
  /** The pool entry planted as a link to somewhere else. */
  plantPoolEntryLink(entry: string): Promise<void>;
  /** Whether anything exists in the plugin's state folder besides the pool and the roots (a folder invented beside the pool). */
  strays(): Promise<readonly string[]>;
  plantHardLink(): Promise<void>;
  plantPoolLink(): Promise<void>;
  plantPoolHardLink(): Promise<void>;
  noReach(): void;
  stateWrite(text: string): Promise<void>;
  stateRead(): Promise<string>;
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
  const disk = nodeFs(() => crypto.randomUUID());
  let noReach = false;
  const fs = {
    ...disk,
    openDirectory: async (path: string) => {
      const folder = await disk.openDirectory(path);
      return noReach ? { ...folder, entryPath: () => undefined, at: undefined } : folder;
    },
  };
  await ensureInternalRootBases(fs, { home, plugin: 'harness' }, ['agent-homes', 'downloads'], {
    historyPool: harnessManifest.permissions.historyPool,
    stateFiles: harnessManifest.data.state,
  });
  await ensureInternalRootBases(fs, { home, plugin: 'bare' }, ['agent-homes']);
  await ensureInternalRootBases(fs, { home, plugin: 'logins' }, ['credentials']);
  await mkdir(`${home}/state/logins/credentials/work`, { mode: 0o700 });
  await writeFile(`${home}/state/logins/credentials/work/auth.json`, '{}', { mode: 0o600 });
  await ensureInternalRootBases(fs, { home, plugin: 'other' }, ['agent-homes'], {
    historyPool: harnessManifest.permissions.historyPool,
    stateFiles: [POOL],
  });
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
        ...(manifest.permissions?.shareCredentials === undefined
          ? {}
          : { shareCredentials: manifest.permissions.shareCredentials }),
        privateFiles: ['state/private/history-pool/*', 'state/logins/credentials/*'],
      },
    );
  const pooled = `${home}/state/harness/history-pool`;
  return {
    harness: port(harnessManifest),
    bare: port(bareManifest),
    additional: new Map(
      [...additional, noRootsManifest, notOwnManifest].map(manifest => [manifest.id, port(manifest)]),
    ),
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
    plantPoolFolder: async kind => {
      await rm(pooled, { recursive: true, force: true });
      await mkdir(`${home}/state/harness/inside`, { recursive: true });
      if (kind === 'link') await symlink(`${home}/state/harness/inside`, pooled);
      else await writeFile(pooled, 'a file', { mode: 0o600 });
    },
    plantPoolEntryLink: async entry => {
      await mkdir(`${home}/state/harness/inside`, { recursive: true });
      await mkdir(pooled, { recursive: true, mode: 0o700 });
      await symlink(`${home}/state/harness/inside`, `${pooled}/${entry}`);
    },
    strays: async () =>
      (await readdir(`${home}/state/harness`)).filter(
        name => !['agent-homes', 'downloads', 'history-pool', 'inside'].includes(name),
      ),
    plantHardLink: async () => {
      await hardlink(`${home}/state/harness/agent-homes/f1/projects/a`, `${parent}/hard`);
    },
    plantPoolLink: async () => {
      await symlink(`${pooled}/projects`, `${pooled}/alias`);
    },
    plantPoolHardLink: async () => {
      await hardlink(`${pooled}/projects/a`, `${parent}/pool-hard`);
    },
    noReach: () => {
      noReach = true;
    },
    stateWrite: async text => {
      await mkdir(`${pooled}/projects`, { recursive: true });
      await writeFile(`${pooled}/projects/state-new`, text);
      await rename(`${pooled}/projects/state-new`, `${pooled}/projects/state`);
    },
    stateRead: async () => await readFile(`${pooled}/projects/view`, 'utf8'),
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
  const settings: { plugins: ReturnType<typeof half>[]; noDescriptorReach?: true } = {
    plugins: [half(harnessManifest), half(bareManifest), ...additional.map(half)],
  };
  const host = await testHost(settings);
  host.putRoot('credentials', 'work/auth.json', '{}');
  const get = (id: string): KernelPorts['roots'] => {
    const found = ports.get(id);
    if (found === undefined) throw new Error(`${id} was not built`);
    return found;
  };
  const state = () => host.state('harness');
  return {
    harness: get('harness'),
    bare: get('bare'),
    additional: new Map(additional.map(manifest => [manifest.id, get(manifest.id)])),
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
    plantPoolFolder: async kind => {
      state().directories.delete('history-pool');
      if (kind === 'link') state().symlinks.set('history-pool', '/state/harness/inside');
      else state().files.set('history-pool', 'a file');
    },
    plantPoolEntryLink: async entry => {
      state().directories.set('history-pool', { mode: 0o700, modifiedMs: 0 });
      state().symlinks.set(`history-pool/${entry}`, '/state/harness/inside');
    },
    strays: async () =>
      [...state().directories.keys()].filter(name => !name.startsWith('history-pool') && name !== 'inside'),
    plantHardLink: async () => {
      host.putRootHardLink('agent-homes', 'f1/projects/a', 'mine');
    },
    plantPoolLink: async () => {
      state().symlinks.set('history-pool/alias', '/state/harness/history-pool/projects');
    },
    plantPoolHardLink: async () => {
      state().hardLinks.add('history-pool/projects/a');
    },
    noReach: () => {
      settings.noDescriptorReach = true;
    },
    stateWrite: async text => {
      await state().port([POOL]).write(POOL, text, 'projects/state');
    },
    stateRead: async () =>
      new TextDecoder().decode(state().bytes.get('history-pool/projects/view')) ||
      state().files.get('history-pool/projects/view') ||
      '',
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
  'view: a held file keeps its bytes and notices a state-port replacement': async side => {
    const view = side.harness.historyPool();
    await side.stateWrite('old state');
    const path = resolved(view, 'projects/state');
    const held = await view.openBytes?.(path);
    expect(held).toBeDefined();
    await side.stateWrite('new state');
    try {
      return {
        held: new TextDecoder().decode(await held?.read(0, 9)),
        stillNames: await held?.stillNames(),
        now: await side.harness.historyPool().readText(path),
      };
    } finally {
      await held?.close();
    }
  },
  'move: placed credentials, themselves and inside a folder, stay in their home': async side => {
    const root = side.harness.root('agent-homes');
    const pool = side.harness.historyPool();
    await root.makeDirectory(resolved(root, 'f1/projects'));
    const own = side.harness.root('agent-homes', { subfolder: 'f1/projects' });
    const logins = side.additional.get('logins')!;
    const credential = await logins.shareCredential({ folder: 'work', file: 'auth.json', receiver: 'harness' });
    const refusedPlacement = await outcome(
      async () => await pool.linkCredential(credential, resolved(pool, 'auth.json')),
      async () => 'linked',
    );
    await own.linkCredential(credential, resolved(own, 'auth.json'));
    const results = [];
    for (const source of ['projects/auth.json', 'projects'])
      results.push(
        await outcome(
          async () => await root.moveToHistoryPool(resolved(root, `f1/${source}`), pool, resolved(pool, source)),
          async () => 'moved',
        ),
      );
    return {
      results,
      refusedPlacement,
      source: await kindAt(root, 'f1/projects/auth.json'),
      target: await kindAt(pool, 'projects'),
    };
  },
  'view: ownership, private-place and root-declaration refusals have the same precedence': async side => {
    const answers: Record<string, string> = {};
    for (const id of ['private'])
      answers[id] = await outcome(
        async () => side.additional.get(id)?.historyPool(),
        async () => 'view',
      );
    return answers;
  },
  'view: bytes and windows share the state-port store in both directions': async side => {
    const view = side.harness.historyPool();
    await side.stateWrite('from state');
    const state = await view.readText(resolved(view, 'projects/state'));
    const file = resolved(view, 'projects/view');
    await view.writeBytes(file, new TextEncoder().encode('from view'));
    const held = await view.openBytes?.(file);
    try {
      return {
        state,
        view: await side.stateRead(),
        internal: view.internal,
        list: await view.list(resolved(view, 'projects')),
        window: [...(await view.readBytes(file, { offset: 2, length: 4 }))],
        held: [...((await held?.read(2, 4)) ?? [])],
        stillNames: await held?.stillNames(),
      };
    } finally {
      await held?.close();
    }
  },
  'view: unpermitted access, no history door, no generic links in either direction': async side => {
    const view = side.harness.historyPool();
    await view.makeDirectory(resolved(view, 'projects'));
    const downloads = side.harness.root('downloads');
    await downloads.makeDirectory(resolved(downloads, 'd'));
    const results = [];
    const refusal = async (act: () => Promise<unknown>) => await outcome(act, async () => 'ok');
    results.push(await refusal(async () => side.bare.historyPool()));
    results.push(await refusal(async () => await view.linkHistory(resolved(view, ''), 'projects')));
    results.push(
      await refusal(
        async () => await view.moveToHistoryPool(resolved(view, 'projects'), view, resolved(view, 'projects/a')),
      ),
    );
    for (const [target, source, from] of [
      [view, downloads, 'd'],
      [downloads, view, 'projects'],
    ] as const) {
      results.push(
        await refusal(
          async () => await target.linkTo(resolved(target, 'alias'), { root: source, path: resolved(source, from) }),
        ),
      );
      results.push(
        await refusal(
          async () => await target.copyTree(source, resolved(source, from), resolved(target, 'alias'), { link: true }),
        ),
      );
    }
    return results;
  },
  'view: an alias inside the pool is never followed': async side => {
    const view = side.harness.historyPool();
    await view.writeText(resolved(view, 'projects/a'), 'mine');
    await side.plantPoolLink();
    return await outcome(
      async () => await view.readText(resolved(view, 'alias/a')),
      async () => 'x',
    );
  },
  'view: a hard-linked pool file is refused by ordinary, windowed and held reads': async side => {
    const view = side.harness.historyPool();
    const path = resolved(view, 'projects/a');
    await view.writeText(path, 'mine');
    await side.plantPoolHardLink();
    return await Promise.all([
      outcome(
        async () => await view.readText(path),
        async () => 'read',
      ),
      outcome(
        async () => await view.readBytes(path, { offset: 0, length: 2 }),
        async () => 'read',
      ),
      outcome(
        async () => await view.openBytes?.(path),
        async () => 'read',
      ),
    ]);
  },
  'move: numbered root-file conflicts preserve the earlier journal': async side => {
    const home = side.harness.root('agent-homes');
    const pool = side.harness.historyPool();
    await home.makeDirectory(resolved(home, 'f1'));
    await home.writeText(resolved(home, 'f1/history.jsonl'), 'new journal');
    await pool.makeDirectory(resolved(pool, '.conflicts/f1'));
    await pool.writeText(resolved(pool, '.conflicts/f1/history.jsonl'), 'earlier journal');
    await home.moveToHistoryPool(
      resolved(home, 'f1/history.jsonl'),
      pool,
      resolved(pool, '.conflicts/f1/history.jsonl.2'),
    );
    return {
      source: await kindAt(home, 'f1/history.jsonl'),
      earlier: await pool.readText(resolved(pool, '.conflicts/f1/history.jsonl')),
      moved: await pool.readText(resolved(pool, '.conflicts/f1/history.jsonl.2')),
    };
  },
  'move: two homes merge and a conflict keeps the source ferret name': async side => {
    const root = side.harness.root('agent-homes');
    const pool = side.harness.historyPool();
    const identities = [];
    for (const ferret of ['f1', 'f2']) {
      await root.makeDirectory(resolved(root, `${ferret}/projects/-work`));
      await root.writeText(resolved(root, `${ferret}/projects/-work/${ferret}`), ferret);
      const own = side.harness.root('agent-homes', { subfolder: ferret });
      const before = await own.fileIdentity(resolved(own, `projects/-work/${ferret}`));
      await own.moveToHistoryPool(
        resolved(own, `projects/-work/${ferret}`),
        pool,
        resolved(pool, `projects/-work/${ferret}`),
      );
      const after = await pool.fileIdentity(resolved(pool, `projects/-work/${ferret}`));
      identities.push(before?.device === after?.device && before?.inode === after?.inode);
    }
    await root.writeText(resolved(root, 'f1/projects/-work/f2'), 'conflict');
    await root.moveToHistoryPool(
      resolved(root, 'f1/projects/-work/f2'),
      pool,
      resolved(pool, '.conflicts/f1/projects/-work/f2'),
    );
    return {
      identities,
      names: await pool.list(resolved(pool, 'projects/-work')),
      one: await pool.readText(resolved(pool, 'projects/-work/f1')),
      two: await pool.readText(resolved(pool, 'projects/-work/f2')),
      conflict: await pool.readText(resolved(pool, '.conflicts/f1/projects/-work/f2')),
      source: await kindAt(root, 'f1/projects/-work/f2'),
    };
  },
  'move: lexical refusals and forged/wrong-plugin pools leave both sides intact': async side => {
    const root = side.harness.root('agent-homes');
    const pool = side.harness.historyPool();
    await root.makeDirectory(resolved(root, 'f1/projects'));
    await root.writeText(resolved(root, 'f1/projects/a'), 'mine');
    const results = [];
    const move = async (source: string, to: string, handle = root, targetPool = pool) =>
      await outcome(
        async () => await handle.moveToHistoryPool(resolved(handle, source), targetPool, resolved(pool, to)),
        async () => 'moved',
      );
    results.push(await move('', 'projects/a'));
    results.push(await move('f1', 'projects/a'));
    for (const entry of ['auth.json', 'settings.json', 'skills', '.hidden', 'unlisted']) {
      await root.writeText(resolved(root, `f1/${entry}`), 'kept');
      results.push(await move(`f1/${entry}`, entry));
      results.push(await root.readText(resolved(root, `f1/${entry}`)));
    }
    for (const target of ['sessions/a', '.conflicts/f2/projects/a', '.conflicts/f1/sessions/a', 'projects/.hidden/a'])
      results.push(await move('f1/projects/a', target));
    for (const targetPool of [
      root,
      { ...pool },
      side.bare.root('agent-homes'),
      side.additional.get('other')!.historyPool(),
    ])
      results.push(await move('f1/projects/a', 'projects/a', root, targetPool));
    const bare = side.bare.root('agent-homes');
    results.push(await move('f1/projects/a', 'projects/a', bare));
    const downloads = side.harness.root('downloads');
    results.push(await move('f1/projects/a', 'projects/a', downloads));
    return {
      results,
      source: await root.readText(resolved(root, 'f1/projects/a')),
      target: await kindAt(pool, 'projects/a'),
    };
  },
  'move: hard-linked source is refused and leaves both names untouched': async side => {
    const root = side.harness.root('agent-homes');
    const pool = side.harness.historyPool();
    await root.makeDirectory(resolved(root, 'f1/projects'));
    await root.writeText(resolved(root, 'f1/projects/a'), 'mine');
    await side.plantHardLink();
    return {
      result: await outcome(
        async () => await root.moveToHistoryPool(resolved(root, 'f1/projects/a'), pool, resolved(pool, 'projects/a')),
        async () => 'moved',
      ),
      source: await kindAt(root, 'f1/projects/a'),
      target: await kindAt(pool, 'projects/a'),
    };
  },
  'move: one file only; a folder holding a hard-linked file never carries it into the pool': async side => {
    const root = side.harness.root('agent-homes');
    const pool = side.harness.historyPool();
    await root.makeDirectory(resolved(root, 'f1/projects'));
    await root.makeDirectory(resolved(root, 'f1/sessions'));
    await root.writeText(resolved(root, 'f1/projects/a'), 'mine');
    await side.plantHardLink();
    const results = [];
    for (const source of ['projects', 'sessions', 'projects/a'])
      results.push(
        await outcome(
          async () => await root.moveToHistoryPool(resolved(root, `f1/${source}`), pool, resolved(pool, source)),
          async () => 'moved',
        ),
      );
    return {
      results,
      source: await kindAt(root, 'f1/projects/a'),
      projects: await kindAt(pool, 'projects'),
      sessions: await kindAt(pool, 'sessions'),
    };
  },
  'move: an existing target, missing parent/source and linked home all refuse': async side => {
    const root = side.harness.root('agent-homes');
    const pool = side.harness.historyPool();
    await root.makeDirectory(resolved(root, 'f1/projects'));
    await root.writeText(resolved(root, 'f1/projects/a'), 'mine');
    await pool.writeText(resolved(pool, 'projects/a'), 'target');
    const results = [];
    for (const source of ['f1/projects/a', 'f1/projects/absent', 'f1/sessions/missing/a'])
      results.push(
        await outcome(
          async () =>
            await root.moveToHistoryPool(
              resolved(root, source),
              pool,
              resolved(pool, source.includes('/sessions/') ? 'sessions/a' : 'projects/a'),
            ),
          async () => 'moved',
        ),
      );
    await side.plantHomeLink();
    results.push(
      await outcome(
        async () =>
          await root.moveToHistoryPool(resolved(root, 'f3/projects/a'), pool, resolved(pool, 'projects/other')),
        async () => 'moved',
      ),
    );
    results.push(
      await outcome(
        async () =>
          await root.moveToHistoryPool(resolved(root, 'f1/projects/a'), pool, resolved(pool, 'projects/a/child')),
        async () => 'moved',
      ),
    );
    return {
      results,
      source: await root.readText(resolved(root, 'f1/projects/a')),
      target: await pool.readText(resolved(pool, 'projects/a')),
    };
  },
  'move: no descriptor reach refuses before a parent or target is made': async side => {
    const root = side.harness.root('agent-homes');
    const pool = side.harness.historyPool();
    await root.makeDirectory(resolved(root, 'f1/projects'));
    await root.writeText(resolved(root, 'f1/projects/a'), 'mine');
    side.noReach();
    return await outcome(
      async () => await root.moveToHistoryPool(resolved(root, 'f1/projects/a'), pool, resolved(pool, 'projects/a')),
      async () => 'moved',
    );
  },
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
  'link_escape: the pool folder is a link, and the testing host makes no link behind it': async side => {
    await side.plantPoolFolder('link');
    return { result: await link(side.harness, 'f1', 'projects'), home: await side.pool('projects') };
  },
  'link_escape: a pool entry is a link, folder and file alike': async side => {
    await side.plantPoolEntryLink('projects');
    await side.plantPoolEntryLink('history.jsonl');
    return {
      folder: await link(side.harness, 'f1', 'projects'),
      file: await link(side.harness, 'f1', 'history.jsonl'),
    };
  },
  'changed: the pool folder is a file, and no folder is invented beside it': async side => {
    await side.plantPoolFolder('file');
    return { result: await link(side.harness, 'f1', 'projects'), strays: await side.strays() };
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

test('both hosts reject an invalid pool declaration at boot, before granting a view', async () => {
  const side = await real();
  for (const [manifest, refusal] of [
    [noRootsManifest, 'root:not_declared'],
    [notOwnManifest, 'refused:not_own'],
  ] as const) {
    const fault = reachFaults([manifest])[0];
    expect(fault).toBeDefined();
    await expect(testHost({ plugins: [implementDaemon(manifest, { build: () => ({}) })] })).rejects.toThrow(
      fault!.sentence,
    );
    expect(
      await outcome(
        async () => side.additional.get(manifest.id)?.historyPool(),
        async () => 'view',
      ),
    ).toBe(refusal);
  }
});

test('the pinned outcomes, on the real roots', async () => {
  const side = await real();
  expect(await CASES['move: numbered root-file conflicts preserve the earlier journal']?.(await real())).toEqual({
    source: 'nothing',
    earlier: 'earlier journal',
    moved: 'new journal',
  });
  expect(
    await CASES['move: one file only; a folder holding a hard-linked file never carries it into the pool']?.(
      await real(),
    ),
  ).toEqual({
    results: ['refused:not_file', 'refused:not_file', 'root:hard_link'],
    source: 'file',
    projects: 'nothing',
    sessions: 'nothing',
  });
  const existingTargetCase = CASES['move: an existing target, missing parent/source and linked home all refuse'];
  if (existingTargetCase === undefined) throw new Error('the target-conflict case is missing');
  const existingTarget = (await existingTargetCase(await real())) as { results: string[] };
  expect(existingTarget.results[0]).toBe('refused:exists');
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
    pool: true,
  });
  expect(await CASES['not_listed: a legal name the manifest does not list']?.(await real())).toEqual({
    result: 'refused:not_listed',
    pool: true,
  });
  expect(await CASES['outside: the ferret home is not there, and this call makes none']?.(await real())).toEqual({
    result: 'root:outside',
    home: 'nothing',
    pool: true,
  });
  expect(await CASES['link_escape: the ferret home is itself a link']?.(await real())).toEqual({
    result: 'root:link_escape',
    pool: true,
  });
  expect(
    await CASES['link_escape: the pool folder is a link, and the testing host makes no link behind it']?.(await real()),
  ).toEqual({
    result: 'root:link_escape',
    home: 'nothing',
  });
  expect(await CASES['link_escape: a pool entry is a link, folder and file alike']?.(await real())).toEqual({
    folder: 'root:link_escape',
    file: 'root:link_escape',
  });
  expect(
    await CASES['changed: the pool folder is a file, and no folder is invented beside it']?.(await real()),
  ).toEqual({
    result: 'root:changed',
    strays: [],
  });
  expect(await CASES['not_internal: a downloads handle has no history door']?.(await real())).toBe(
    'refused:not_internal',
  );
});
