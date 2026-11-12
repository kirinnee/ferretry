/**
 * A link whose source OR target lies in a credential home is refused, whatever API writes it: `linkTo` and `copyTree` in
 * link mode, on the real roots port and on the testing host, by the one rule in `host/shared-credentials.ts`. A credential
 * home is an agent home (`agent-homes`: where a sign-in is placed) or a login's store (`credentials`). The folder that
 * holds a placed credential is such a home too, so a link to it (a containing-folder alias) would hand a second ferret the
 * credential: it is refused, and nothing is written. The dedicated `linkCredential` stays the one way a credential is
 * placed. A link between folders that are not credential homes (the fleet folder, Runtimes' own) is still made.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { err } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import { defineState } from '../../../contract/define.ts';
import type { KernelPorts, RootHandle } from '../../../contract/ports.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';
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
/** Runtimes alone holds `fleet`; it also holds `agent-homes`, so it reaches both ends of a link. */
const runtimesManifest = definePlugin({
  id: 'runtimes',
  title: 'Runtimes',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  permissions: { roots: ['fleet', 'agent-homes'] },
});

interface Side {
  readonly logins: KernelPorts['roots'];
  readonly codex: KernelPorts['roots'];
  readonly runtimes: KernelPorts['roots'];
  stop(): Promise<void> | void;
  /** What the filesystem gives for `<agent-homes>/<path>` read as a file (real roots only). */
  readThrough(path: string): Promise<string | undefined>;
}

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const resolved = (root: RootHandle, path: string): FencedPath => {
  const answer = root.resolve(path);
  if (!answer.ok) throw new Error(answer.error);
  return answer.value;
};

async function real(): Promise<Side> {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-cred-endpoints-`));
  parents.push(parent);
  const home = `${parent}/home`;
  await mkdir(`${home}/state/logins/credentials/work`, { recursive: true, mode: 0o700 });
  await writeFile(`${home}/state/logins/credentials/work/auth.json`, '{}\n', { mode: 0o600 });
  const fs = nodeFs(() => crypto.randomUUID());
  await ensureInternalRootBases(fs, { home, plugin: 'logins' }, ['credentials']);
  await ensureInternalRootBases(fs, { home, plugin: 'codex' }, ['agent-homes']);
  await ensureInternalRootBases(fs, { home, plugin: 'runtimes' }, ['fleet', 'agent-homes']);
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
    runtimes: port(runtimesManifest),
    stop: () => {
      for (const fn of stops.splice(0)) fn();
    },
    readThrough: async path => await readFile(`${home}/state/codex/agent-homes/${path}`, 'utf8').catch(() => undefined),
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
  const host = await testHost({ plugins: [half(loginsManifest), half(codexManifest), half(runtimesManifest)] });
  host.putRoot('credentials', 'work/auth.json', '{}\n');
  const get = (id: string): KernelPorts['roots'] => {
    const found = ports.get(id);
    if (found === undefined) throw new Error(`${id} was not built`);
    return found;
  };
  return {
    logins: get('logins'),
    codex: get('codex'),
    runtimes: get('runtimes'),
    stop: () => host.stop(),
    // The test world does not materialise a placed credential link as a readable file.
    readThrough: async () => undefined,
  };
}

const HOSTS = [
  ['real', real],
  ['testing', testing],
] as const;

/** The two APIs that write a link, each as `(root of the link, folder it points at, where it is written)`. */
const APIS = [
  [
    'linkTo',
    async (at: RootHandle, to: string, source: RootHandle, from: string) =>
      await at.linkTo(resolved(at, to), { root: source, path: resolved(source, from) }),
  ],
  [
    'copyTree link',
    async (at: RootHandle, to: string, source: RootHandle, from: string) =>
      await at.copyTree(source, resolved(source, from), resolved(at, to), { link: true }),
  ],
] as const;

/** What an act came to: the refusal of a root, or `made` (nothing refused). */
async function refusalOf(act: () => Promise<unknown>): Promise<string> {
  try {
    await act();
    return 'made';
  } catch (error) {
    if (error instanceof RootError) return error.refusal;
    throw error;
  }
}

async function placeAtF1(side: Side) {
  const codex = side.codex.root('agent-homes', { subfolder: 'f1' });
  await codex.linkCredential(
    await side.logins.shareCredential({ folder: 'work', file: 'auth.json', receiver: 'codex' }),
    resolved(codex, 'auth.json'),
  );
  return side.codex.root('agent-homes');
}

for (const [host, build] of HOSTS)
  for (const [api, link] of APIS)
    describe(`${host}: ${api} in a credential home`, () => {
      test('a folder that holds a placed credential cannot be linked to (containing-folder alias)', async () => {
        const side = await build();
        try {
          const all = await placeAtF1(side);
          expect(await refusalOf(async () => await link(all, 'f2', all, 'f1'))).toBe('link_escape');
          // Refused means nothing was written: no f2, so no credential reached through it.
          expect(await all.lstat(resolved(all, 'f2'))).toBeUndefined();
          expect(await side.readThrough('f2/auth.json')).toBeUndefined();
          expect((await all.lstat(resolved(all, 'f1/auth.json')))?.kind).toBe('symlink');
        } finally {
          await side.stop();
        }
      });

      test('a folder one level above the placed credential cannot be linked to either', async () => {
        const side = await build();
        try {
          const all = side.codex.root('agent-homes');
          await all.makeDirectory(resolved(all, 'group'));
          await all.makeDirectory(resolved(all, 'group/f1'));
          const home = side.codex.root('agent-homes', { subfolder: 'group/f1' });
          await home.linkCredential(
            await side.logins.shareCredential({ folder: 'work', file: 'auth.json', receiver: 'codex' }),
            resolved(home, 'auth.json'),
          );
          expect(await refusalOf(async () => await link(all, 'alias', all, 'group'))).toBe('link_escape');
          expect(await all.lstat(resolved(all, 'alias'))).toBeUndefined();
        } finally {
          await side.stop();
        }
      });

      test('SOURCE in a credential home: an agent home (credential-free yet) cannot be linked to', async () => {
        const side = await build();
        try {
          const all = side.codex.root('agent-homes');
          await all.makeDirectory(resolved(all, 'f1'));
          expect(await refusalOf(async () => await link(all, 'f2', all, 'f1'))).toBe('link_escape');
          expect(await all.lstat(resolved(all, 'f2'))).toBeUndefined();
        } finally {
          await side.stop();
        }
      });

      test('TARGET in a credential home: a link written into an agent home to a fleet folder is refused', async () => {
        const side = await build();
        try {
          const fleet = side.runtimes.root('fleet');
          await fleet.makeDirectory(resolved(fleet, 'homes'));
          const all = side.runtimes.root('agent-homes');
          expect(await refusalOf(async () => await link(all, 'f2', fleet, 'homes'))).toBe('link_escape');
          expect(await all.lstat(resolved(all, 'f2'))).toBeUndefined();
        } finally {
          await side.stop();
        }
      });

      test('SOURCE in a credential home, target in the fleet: refused, nothing written', async () => {
        const side = await build();
        try {
          const all = side.runtimes.root('agent-homes');
          await all.makeDirectory(resolved(all, 'f1'));
          const fleet = side.runtimes.root('fleet');
          expect(await refusalOf(async () => await link(fleet, 'alias', all, 'f1'))).toBe('link_escape');
          expect(await fleet.lstat(resolved(fleet, 'alias'))).toBeUndefined();
        } finally {
          await side.stop();
        }
      });

      test('a link between folders that are not credential homes is still made (the fleet)', async () => {
        const side = await build();
        try {
          const fleet = side.runtimes.root('fleet');
          await fleet.makeDirectory(resolved(fleet, 'homes'));
          expect(await refusalOf(async () => await link(fleet, 'alias', fleet, 'homes'))).toBe('made');
          // (The testing host's `copyTree` is a looser model of a copy and does not materialise the link it was asked for.)
          if (host === 'real' || api === 'linkTo')
            expect((await fleet.lstat(resolved(fleet, 'alias')))?.kind).toBe('symlink');
        } finally {
          await side.stop();
        }
      });
    });

for (const [host, build] of HOSTS)
  test(`${host}: the dedicated linkCredential still places the credential, and unlink still removes it`, async () => {
    const side = await build();
    try {
      const all = await placeAtF1(side);
      expect((await all.lstat(resolved(all, 'f1/auth.json')))?.kind).toBe('symlink');
      const home = side.codex.root('agent-homes', { subfolder: 'f1' });
      await home.unlink(resolved(home, 'auth.json'));
      expect(await all.lstat(resolved(all, 'f1/auth.json'))).toBeUndefined();
    } finally {
      await side.stop();
    }
  });
