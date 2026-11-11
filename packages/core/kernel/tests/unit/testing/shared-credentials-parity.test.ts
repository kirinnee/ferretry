/**
 * The testing host's shared credentials stay in step with the real roots port: the same rules
 * (`host/shared-credentials.ts`) decide who may mint, from what, who may place it and where, so a plugin's unit test meets
 * the refusals and the link production makes. (The identity re-check, `changed`, needs a real rename and is proved on the
 * real port only: the test world's files have no inode that moves.)
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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
  return {
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

const CASES: Readonly<Record<string, Case>> = {
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
    const credential = await mint(side);
    const home = homeOf(side.codex);
    await home.linkCredential(credential, resolved(home, 'auth.json'));
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
