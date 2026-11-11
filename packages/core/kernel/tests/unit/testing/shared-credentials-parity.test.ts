/**
 * The testing host's shared credentials stay in step with the real roots port: the same rules
 * (`host/shared-credentials.ts`) decide who may mint, from what, who may place it and where, so a plugin's unit test meets
 * the refusals and the link production makes, `changed` and the single use of a credential included (the test world gives a
 * file a new stand-in inode whenever it is removed and written again, as a rename-over does on disk). What the testing host
 * still models more loosely is the placed link itself (`entries`, `fileIdentity`, renaming it back), not these rules.)
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { err } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import { defineState } from '../../../contract/define.ts';
import type { KernelPorts, RootHandle, SharedCredential } from '../../../contract/ports.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';
import { SharedTreeError } from '../../../host/shared-trees.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import type { Manifest } from '../../../manifest/types.ts';
import { testHost } from '../../../testing/index.ts';

const CREDENTIALS = defineState({ name: 'credentials', path: 'credentials/*', store: 'opaque', format: 1 });

const loginsManifest = definePlugin({
  id: 'logins',
  title: 'Logins',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  permissions: { roots: ['credentials'], shareCredentials: ['auth.json'] },
  privacy: { private: ['credentials'] },
  data: { state: [CREDENTIALS] },
});
const codexManifest = definePlugin({
  id: 'codex',
  title: 'Codex',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  permissions: { roots: ['agent-homes'] },
});
const skillsManifest = definePlugin({
  id: 'skills',
  title: 'Skills',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  permissions: { roots: ['agent-homes'] },
});

interface Side {
  readonly logins: KernelPorts['roots'];
  readonly codex: KernelPorts['roots'];
  readonly skills: KernelPorts['roots'];
  /** A plugin that is not Logins but declares everything Logins does. */
  readonly impostor: KernelPorts['roots'];
  stop(): Promise<void> | void;
  /** The sign-in file replaced by another inode (a rename-over, a re-sign-in): what a mint no longer names. */
  replaceCredential(): Promise<void>;
  /** The receiver's ferret home `f1` planted as a symlink out of agent-homes. */
  plantHomeLink(): Promise<void>;
}

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const impostorManifest = definePlugin({
  id: 'impostor',
  title: 'Impostor',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  permissions: { roots: ['agent-homes'], shareCredentials: ['auth.json'] },
});

async function real(): Promise<Side> {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-cred-parity-`));
  parents.push(parent);
  const home = `${parent}/home`;
  await mkdir(`${home}/state/logins/credentials/work`, { recursive: true, mode: 0o700 });
  await writeFile(`${home}/state/logins/credentials/work/auth.json`, '{}\n', { mode: 0o600 });
  const fs = nodeFs(() => crypto.randomUUID());
  await ensureInternalRootBases(fs, { home, plugin: 'logins' }, ['credentials']);
  for (const plugin of ['codex', 'skills', 'impostor'])
    await ensureInternalRootBases(fs, { home, plugin }, ['agent-homes']);
  const workFolders: WorkFolders = { folderOf: () => undefined, check: () => err('outside') };
  const stops: (() => void)[] = [];
  const port = (manifest: Manifest) =>
    rootsPortFor(
      fs,
      { home, plugin: manifest.id, worktrees: `${home}-worktrees` },
      manifest.permissions?.roots ?? [],
      () => workFolders,
      {
        ...(manifest.permissions?.shareCredentials === undefined
          ? {}
          : { shareCredentials: manifest.permissions.shareCredentials }),
        stateFiles: manifest.data?.state ?? [],
        privateFiles: ['state/logins/credentials'],
        onStop: fn => stops.push(fn),
      },
    );
  const canonical = `${home}/state/logins/credentials/work/auth.json`;
  return {
    replaceCredential: async () => {
      await rename(canonical, `${canonical}.saved`);
      await writeFile(canonical, '{"fake":"REPLACEMENT"}\n', { mode: 0o600 });
    },
    plantHomeLink: async () => {
      await mkdir(`${parent}/outside`, { recursive: true });
      await symlink(`${parent}/outside`, `${home}/state/codex/agent-homes/f1`);
    },
    logins: port(loginsManifest),
    codex: port(codexManifest),
    skills: port(skillsManifest),
    impostor: port(impostorManifest),
    stop: () => {
      for (const fn of stops.splice(0)) fn();
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
  const host = await testHost({
    plugins: [half(loginsManifest), half(codexManifest), half(skillsManifest), half(impostorManifest)],
  });
  host.putRoot('credentials', 'work/auth.json', '{}\n');
  const get = (id: string): KernelPorts['roots'] => {
    const found = ports.get(id);
    if (found === undefined) throw new Error(`${id} was not built`);
    return found;
  };
  return {
    replaceCredential: async () => {
      const creds = get('logins').root('credentials');
      const at = resolved(creds, 'work/auth.json');
      await creds.remove(at);
      await creds.writeText(at, '{"fake":"REPLACEMENT"}\n');
    },
    plantHomeLink: async () => {
      host.putRootLink('agent-homes', 'f1');
    },
    logins: get('logins'),
    codex: get('codex'),
    skills: get('skills'),
    impostor: get('impostor'),
    stop: () => host.stop(),
  };
}

const resolved = (root: RootHandle, path: string): FencedPath => {
  const answer = root.resolve(path);
  if (!answer.ok) throw new Error(answer.error);
  return answer.value;
};

/** What a case came to: the shared-credential refusal, `root:<refusal>` for a root refusal, or the link kind made. */
async function outcome(act: () => Promise<RootHandle | undefined>, to = 'auth.json') {
  try {
    const home = await act();
    const lstat = home === undefined ? undefined : await home.lstat?.(resolved(home, to));
    return { made: lstat?.kind ?? 'nothing' };
  } catch (error) {
    if (error instanceof SharedTreeError) return { refused: error.refusal };
    if (error instanceof RootError) return { refused: `root:${error.refusal}` };
    throw error;
  }
}

const mint = async (side: Side, over: { folder?: string; file?: string; receiver?: string } = {}) =>
  await side.logins.shareCredential({ folder: 'work', file: 'auth.json', receiver: 'codex', ...over });
const homeOf = (roots: KernelPorts['roots'], ferret = 'f1'): RootHandle =>
  roots.root('agent-homes', { subfolder: ferret });
const placing =
  (side: Side, credential: () => Promise<SharedCredential>, to = 'auth.json', roots?: KernelPorts['roots']) =>
  async (): Promise<RootHandle> => {
    const home = homeOf(roots ?? side.codex);
    await home.linkCredential(await credential(), resolved(home, to));
    return home;
  };

type Case = (side: Side) => Promise<unknown>;

/** Places the credential at f1/auth.json (unless `place` is false), makes f2, runs `move` and answers what it came to and what is where. */
async function afterMove(side: Side, move: (all: RootHandle) => Promise<void>, place = true) {
  const home = homeOf(side.codex);
  if (place) await home.linkCredential(await mint(side), resolved(home, 'auth.json'));
  const all = side.codex.root('agent-homes');
  await all.makeDirectory(resolved(all, 'f2')).catch(() => undefined);
  const result = await move(all).then(
    () => 'moved',
    (error: unknown) => (error instanceof RootError ? `root:${error.refusal}` : 'unexpected-error'),
  );
  const kind = async (path: string) => (await all.lstat(resolved(all, path)).catch(() => undefined))?.kind ?? 'nothing';
  return {
    result,
    placed: await kind('f1/auth.json'),
    other: await kind('f2/auth.json'),
    renamedHome: await kind('g1/auth.json'),
    inOther: await kind('f2/f1/auth.json'),
    renamedHere: await kind('f1/other.json'),
  };
}

const CASES: Readonly<Record<string, Case>> = {
  'changed: the sign-in file replaced by another inode after the mint': async side => {
    const credential = await mint(side);
    await side.replaceCredential();
    return await outcome(placing(side, async () => credential));
  },
  'link_escape: the receiver’s home is itself a link': async side => {
    await side.plantHomeLink();
    return await outcome(placing(side, () => mint(side)));
  },
  'link_escape: every read and stat through the placed link': async side => {
    const home = homeOf(side.codex);
    await home.linkCredential(await mint(side), resolved(home, 'auth.json'));
    const path = resolved(home, 'auth.json');
    const answers: string[] = [];
    for (const call of [
      () => home.readText(path),
      () => home.readBytes(path),
      () => home.readBytes(path, 4),
      () => home.readTail(path, 4),
      () => home.stat(path),
    ])
      answers.push(
        await call().then(
          () => 'read',
          (error: unknown) => (error instanceof RootError ? `root:${error.refusal}` : 'unexpected-error'),
        ),
      );
    return answers;
  },
  'not shared: a re-link with a credential already placed, even after its file was replaced': async side => {
    const credential = await mint(side);
    const home = homeOf(side.codex);
    await home.linkCredential(credential, resolved(home, 'auth.json'));
    await side.replaceCredential();
    return await outcome(async () => {
      await home.linkCredential(credential, resolved(home, 'auth.json'));
      return home;
    });
  },
  'link: the receiver places the credential at <home>/auth.json': async side =>
    await outcome(placing(side, () => mint(side))),
  'not permitted: a plugin other than Logins mints': async side =>
    await outcome(
      placing(side, () => side.impostor.shareCredential({ folder: 'work', file: 'auth.json', receiver: 'codex' })),
    ),
  'not permitted: a file the manifest does not list': async side =>
    await outcome(placing(side, () => mint(side, { file: 'other.json' }))),
  'not own: a folder that is a path': async side => await outcome(placing(side, () => mint(side, { folder: 'a/b' }))),
  'not own: a folder that climbs': async side => await outcome(placing(side, () => mint(side, { folder: '..' }))),
  'absent: no such login folder': async side => await outcome(placing(side, () => mint(side, { folder: 'nobody' }))),
  'not receiver: another plugin’s home': async side =>
    await outcome(placing(side, () => mint(side), 'auth.json', side.skills)),
  'not shared: forged': async side => await outcome(placing(side, async () => ({}) as SharedCredential)),
  'not shared: a JSON round trip': async side =>
    await outcome(placing(side, async () => JSON.parse(JSON.stringify(await mint(side))) as SharedCredential)),
  'outside: another name': async side =>
    await outcome(
      placing(side, () => mint(side), 'other.json'),
      'other.json',
    ),
  'outside: a nested name': async side =>
    await outcome(
      placing(side, () => mint(side), 'sub/auth.json'),
      'sub/auth.json',
    ),
  'outside: an unscoped handle': async side => {
    const roots = side.codex.root('agent-homes');
    return await outcome(async () => {
      await roots.linkCredential(await mint(side), resolved(roots, 'auth.json'));
      return roots;
    });
  },
  'outside: something already at the name': async side => {
    const home = homeOf(side.codex);
    await home.linkCredential(await mint(side), resolved(home, 'auth.json'));
    return await outcome(async () => {
      await home.linkCredential(await mint(side), resolved(home, 'auth.json'));
      return home;
    });
  },
  'not shared: the same credential after its link was removed': async side => {
    const credential = await mint(side);
    const home = homeOf(side.codex);
    await home.linkCredential(credential, resolved(home, 'auth.json'));
    await home.unlink(resolved(home, 'auth.json'));
    return await outcome(async () => {
      await home.linkCredential(credential, resolved(home, 'auth.json'));
      return home;
    });
  },
  'not shared: the same credential into another ferret’s home': async side => {
    const credential = await mint(side);
    const first = homeOf(side.codex, 'f1');
    await first.linkCredential(credential, resolved(first, 'auth.json'));
    const second = homeOf(side.codex, 'f2');
    return await outcome(async () => {
      await second.linkCredential(credential, resolved(second, 'auth.json'));
      return second;
    });
  },
  'link: a refused attempt does not spend the credential': async side => {
    const credential = await mint(side);
    const home = homeOf(side.codex);
    // a nested name is refused before anything is made...
    await home.linkCredential(credential, resolved(home, 'sub/auth.json')).catch(() => undefined);
    // ...so the credential still links where it should
    return await outcome(async () => {
      await home.linkCredential(credential, resolved(home, 'auth.json'));
      return home;
    });
  },
  'not internal: a credentials destination': async side => {
    const credential = await mint(side);
    const creds = side.logins.root('credentials');
    return await outcome(async () => {
      await creds.linkCredential(credential, resolved(creds, 'work/other.json'));
      return creds;
    }, 'work/other.json');
  },
  'link_escape: the placed link renamed into another ferret’s home': async side =>
    await afterMove(side, all => all.rename(resolved(all, 'f1/auth.json'), resolved(all, 'f2/auth.json'))),
  'link_escape: the placed link renamed to another name in its own home': async side =>
    await afterMove(side, all => all.rename(resolved(all, 'f1/auth.json'), resolved(all, 'f1/other.json'))),
  'link_escape: the ferret home holding the placed link renamed': async side =>
    await afterMove(side, all => all.rename(resolved(all, 'f1'), resolved(all, 'g1'))),
  'link_escape: the ferret home holding the placed link moved into another home': async side =>
    await afterMove(side, all => all.rename(resolved(all, 'f1'), resolved(all, 'f2/f1'))),
  'outside: the placed link renamed onto its own name (moves nothing, as for any name)': async side =>
    await afterMove(side, all => all.rename(resolved(all, 'f1/auth.json'), resolved(all, 'f1/auth.json'))),
  'link: an ordinary file in the home still moves': async side => {
    const all = side.codex.root('agent-homes');
    await all.makeDirectory(resolved(all, 'f1'));
    await all.makeDirectory(resolved(all, 'f2'));
    await all.writeText(resolved(all, 'f1/notes.txt'), 'x');
    return await afterMove(
      side,
      all2 => all2.rename(resolved(all2, 'f1/notes.txt'), resolved(all2, 'f2/notes.txt')),
      false,
    );
  },
  'link: the placed link removed, then its name reused by another file, moves': async side => {
    const home = homeOf(side.codex);
    await home.linkCredential(await mint(side), resolved(home, 'auth.json'));
    await home.unlink(resolved(home, 'auth.json'));
    await home.writeText(resolved(home, 'auth.json'), 'mine');
    const all = side.codex.root('agent-homes');
    await all.makeDirectory(resolved(all, 'f2'));
    await all.rename(resolved(all, 'f1/auth.json'), resolved(all, 'f2/auth.json'));
    return {
      f1: (await all.lstat(resolved(all, 'f1/auth.json')))?.kind,
      f2: (await all.lstat(resolved(all, 'f2/auth.json')))?.kind,
    };
  },
  'link: the home of a removed placed link moves': async side => {
    const home = homeOf(side.codex);
    await home.linkCredential(await mint(side), resolved(home, 'auth.json'));
    await home.unlink(resolved(home, 'auth.json'));
    await home.writeText(resolved(home, 'notes.txt'), 'x');
    const all = side.codex.root('agent-homes');
    await all.rename(resolved(all, 'f1'), resolved(all, 'g1'));
    return { g1: (await all.lstat(resolved(all, 'g1')))?.kind };
  },
  'revoked: the minter stopped': async side => {
    const credential = await mint(side);
    await side.stop();
    return await outcome(placing(side, async () => credential));
  },
};

for (const [name, run] of Object.entries(CASES))
  test(`parity: ${name}`, async () => {
    const onReal = await run(await real());
    const onTesting = await run(await testing());
    expect(onTesting).toEqual(onReal);
  });

test('the new cases each refuse, on the real roots', async () => {
  expect(await CASES['changed: the sign-in file replaced by another inode after the mint']?.(await real())).toEqual({
    refused: 'root:changed',
  });
  expect(await CASES['link_escape: the receiver’s home is itself a link']?.(await real())).toEqual({
    refused: 'root:link_escape',
  });
  expect(await CASES['link_escape: every read and stat through the placed link']?.(await real())).toEqual(
    Array.from({ length: 5 }, () => 'root:link_escape'),
  );
  expect(
    await CASES['not shared: a re-link with a credential already placed, even after its file was replaced']?.(
      await real(),
    ),
  ).toEqual({ refused: 'not_shared' });
  expect(await CASES['not shared: the same credential after its link was removed']?.(await real())).toEqual({
    refused: 'not_shared',
  });
  expect(await CASES['not shared: the same credential into another ferret’s home']?.(await real())).toEqual({
    refused: 'not_shared',
  });
  expect(await CASES['link: a refused attempt does not spend the credential']?.(await real())).toEqual({
    made: 'symlink',
  });
});

test('the cases cover each answer (the parity is not vacuous)', async () => {
  expect(await CASES['link: the receiver places the credential at <home>/auth.json']?.(await real())).toEqual({
    made: 'symlink',
  });
  for (const [name, refusal] of [
    ['not permitted: a plugin other than Logins mints', 'not_permitted'],
    ['not permitted: a file the manifest does not list', 'not_permitted'],
    ['not own: a folder that is a path', 'not_own'],
    ['not own: a folder that climbs', 'not_own'],
    ['absent: no such login folder', 'absent'],
    ['not receiver: another plugin’s home', 'not_receiver'],
    ['not shared: forged', 'not_shared'],
    ['not shared: a JSON round trip', 'not_shared'],
    ['outside: another name', 'root:outside'],
    ['outside: a nested name', 'root:outside'],
    ['outside: an unscoped handle', 'root:outside'],
    ['outside: something already at the name', 'root:outside'],
    ['not internal: a credentials destination', 'not_internal'],
    ['revoked: the minter stopped', 'not_shared'],
  ] as const)
    expect(await CASES[name]?.(await real())).toEqual({ refused: refusal });
});

test('moving a placed credential link is refused on the real roots and the testing host, and nothing is written', async () => {
  const refused = {
    result: 'root:link_escape',
    placed: 'symlink',
    other: 'nothing',
    renamedHome: 'nothing',
    inOther: 'nothing',
    renamedHere: 'nothing',
  };
  for (const name of [
    'link_escape: the placed link renamed into another ferret’s home',
    'link_escape: the placed link renamed to another name in its own home',
    'link_escape: the ferret home holding the placed link renamed',
    'link_escape: the ferret home holding the placed link moved into another home',
  ])
    for (const build of [real, testing]) expect(await CASES[name]?.(await build())).toEqual(refused);
  expect(
    await CASES['outside: the placed link renamed onto its own name (moves nothing, as for any name)']?.(await real()),
  ).toEqual({
    ...refused,
    result: 'root:outside',
  });
  expect(await CASES['link: an ordinary file in the home still moves']?.(await real())).toMatchObject({
    result: 'moved',
  });
  expect(
    await CASES['link: the placed link removed, then its name reused by another file, moves']?.(await real()),
  ).toEqual({
    f1: undefined,
    f2: 'file',
  });
  expect(await CASES['link: the home of a removed placed link moves']?.(await real())).toEqual({ g1: 'directory' });
});
