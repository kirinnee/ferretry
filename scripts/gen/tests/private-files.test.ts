/**
 * `private-files` (§7.7, §9.3): the manifest-declared private-files list, proven three ways.
 *
 * 1. The check itself, by planted violations: a secret-named state file with no declaration is refused, one declared
 *    public with a reason is allowed, one declared private is pinned, and an entry that names nothing is found.
 * 2. Every private file the REAL manifests declare, one test each: the real roots refuse a ferret that reaches it under
 *    another name, through an owner's root and through an internal one. The test reads the composed list from the real
 *    manifests, so dropping an entry from a manifest turns exactly that file's tests RED.
 * 3. The real workspace holds no secret-named state file that is declared neither way.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { FencedPath, WorkFolders } from '../../../packages/core/kernel/contract/bound.ts';
import type { FerretId } from '../../../packages/core/kernel/contract/ids.ts';
import type { RootHandle, RootName } from '../../../packages/core/kernel/contract/ports.ts';
import { type FileIdentity, type HostFs, nodeFs } from '../../../packages/core/kernel/host/adapters/node-fs.ts';
import { RootError, rootsPortFor } from '../../../packages/core/kernel/host/roots.ts';
import {
  composePrivateFiles,
  covers,
  privacyProblems,
  privatePlaces,
  stateFilePaths,
  UNDECLARED_FILES,
} from '../../../packages/core/kernel/manifest/privacy.ts';
import type { Manifest } from '../../../packages/core/kernel/manifest/types.ts';
import { check as privateFiles } from '../../validate/private-files.ts';
import { contextFor } from '../lib/check.ts';
import { loadManifests, loadWorkspace } from '../lib/workspace.ts';
import { type Fixture, type FixturePackage, LEAF, fixture } from './fixture.ts';

const made: Fixture[] = [];
const temps: string[] = [];
afterAll(async () => {
  for (const f of made) f.dispose();
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

const ws = (packages: readonly FixturePackage[]): Fixture => {
  const f = fixture(packages);
  made.push(f);
  return f;
};
const run = async (f: Fixture) => await privateFiles.run(contextFor(f.root));
const plugin = (manifest: string): FixturePackage => ({
  id: 'sample',
  manifestImports: `import { defineState } from '${LEAF}';`,
  manifest,
});
const state = (name: string, path: string): string =>
  `defineState({ name: '${name}', path: '${path}', store: 'json', format: 1 })`;

describe('private-files planted violations', () => {
  test('PF-check a new secret-named state file with no declaration is refused', async () => {
    const f = ws([plugin(`data: { state: [${state('session', 'session-token.json')}] },`)]);
    const findings = await run(f);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.map(finding => finding.message).join('\n')).toContain('session-token.json');
    expect(findings.every(finding => finding.check === 'private-files')).toBe(true);
  });

  test('PF-check a secret-named file declared PUBLIC with a written reason is allowed', async () => {
    const f = ws([
      plugin(
        `data: { state: [${state('session', 'session-token.json')}] },
        privacy: { public: [{ path: 'session-token.json', reason: 'Only the expiry date of a session, never a token.' }] },`,
      ),
    ]);
    expect(await run(f)).toEqual([]);
  });

  test('PF-check a secret-named file declared public with NO reason is refused', async () => {
    const f = ws([
      plugin(
        `data: { state: [${state('session', 'session-token.json')}] },
        privacy: { public: [{ path: 'session-token.json', reason: '' }] },`,
      ),
    ]);
    expect((await run(f)).map(finding => finding.message).join('\n')).toContain('written reason');
  });

  test('PF-check a secret-named file declared PRIVATE is allowed and pinned', async () => {
    const manifest = {
      id: 'sample',
      data: { state: [{ path: 'session-token.json' }] },
      privacy: { private: ['session-token.json'] },
    } as unknown as Manifest;
    expect(privacyProblems(manifest)).toEqual([]);
    expect(privatePlaces(manifest)).toEqual(['state/sample/session-token.json']);
    const f = ws([
      plugin(
        `data: { state: [${state('session', 'session-token.json')}] }, privacy: { private: ['session-token.json'] },`,
      ),
    ]);
    expect(await run(f)).toEqual([]);
  });

  test('PF-check a private entry that names no state file is found: a typo pins nothing', async () => {
    const f = ws([plugin(`data: { state: [${state('cards', 'cards.json')}] }, privacy: { private: ['crads.json'] },`)]);
    expect((await run(f)).map(finding => finding.message).join('\n')).toContain('pins nothing');
  });

  test('PF-check a plugin with no secret-named file and no declaration is quiet', async () => {
    expect(await run(ws([plugin(`data: { state: [${state('cards', 'cards.json')}] },`)]))).toEqual([]);
  });
});

/** What a ferret reaches through: the real roots, over a real home. */
const REAL = nodeFs(() => 'r');

function bound(base: HostFs, decoy: string, source: string): HostFs {
  const lie = (identity: FileIdentity): FileIdentity => ({ ...identity, links: 1 });
  const isDecoy = (path: string): boolean =>
    path === decoy || (path.startsWith('/proc/self/fd/') && path.endsWith(`/${basename(decoy)}`));
  return {
    ...base,
    identity: async path => {
      if (!isDecoy(path)) return await base.identity(path);
      const found = await base.identity(source);
      return found === undefined ? undefined : lie(found);
    },
    openRead: async path => {
      if (!isDecoy(path)) return await base.openRead(path);
      const opened = await base.openRead(source);
      return { ...opened, identity: lie(opened.identity) };
    },
  };
}

const workFolders = (folder: string): WorkFolders => ({
  folderOf: () => folder as FencedPath,
  check: (_ferret, path) =>
    path.startsWith(folder) ? { ok: true, value: path as FencedPath } : { ok: false, error: 'outside' },
});

const refusal = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return 'allowed';
  } catch (error) {
    return error instanceof RootError ? `refused:${error.refusal}` : `error:${String(error)}`;
  }
};

const workspace = loadWorkspace(join(import.meta.dir, '..', '..', '..'));
const { loaded, failures } = await loadManifests(workspace);
const manifests = loaded.map(item => item.manifest);

/** Where each private FOLDER really keeps the file that matters, below the folder (a deep fixture, not a depth-1 stand-in). */
const FOLDER_MEMBERS: Readonly<Record<string, string>> = {
  'logins/credentials': 'L1/auth.json',
  'browsers/data': 'P1/Default/Cookies',
  'browsers/x11': 'D99/Xauthority',
  'access/pairing-redirects': 'redirect.json',
};

/** One private entry: the plugin that declares it, and whether it is a folder (it covers a declared file below it). */
interface Entry {
  readonly plugin: string;
  readonly path: string;
  readonly folder: boolean;
}

/**
 * THE sweep, written down here and nowhere else: every private place the plugins keep, by plugin and path (a folder
 * is marked). Dropping an entry from a manifest turns the equality test below RED, and the per-file tests are made from
 * THIS table, so each stays and turns RED too (the composed list no longer holds what the table says it must).
 */
const SWEEP: readonly Entry[] = [
  ['kernel', 'identity.json', false],
  ['vault', 'vault.key', false],
  ['vault', 'vault.json', false],
  ['gate', 'admin-token', false],
  ['gate', 'warden-token', false],
  ['ferrets', 'tokens.json', false],
  ['ferrets', 'sessions/*/environment.json', false],
  ['access', 'passkeys.json', false],
  ['access', 'push-keys.json', false],
  ['access', 'devices.json', false],
  ['access', 'unlocks.json', false],
  ['access', 'push.json', false],
  ['access', 'pairing-redirects', true],
  ['mcp', 'oauth-secrets.json', false],
  ['conversation', 'message-token.key', false],
  ['accounts', 'login-secrets.json', false],
  ['accounts', 'accounts.json', false],
  ['catalogs', 'link-keys.json', false],
  ['catalogs', 'member-passkeys.json', false],
  ['catalogs', 'member-unlocks.json', false],
  ['browsers', 'data', true],
  ['browsers', 'x11', true],
  ['terminals', 'tmux.sock', false],
  ['logins', 'credentials', true],
].map(([plugin, path, folder]) => ({ plugin: plugin as string, path: path as string, folder: folder as boolean }));

const declared = (list: readonly Entry[]): string[] => list.map(entry => `${entry.plugin}/${entry.path}`).sort();
const entries: readonly Entry[] = manifests.flatMap(manifest =>
  (manifest.privacy?.private ?? []).map(path => ({
    plugin: manifest.id,
    path,
    folder: stateFilePaths(manifest).some(other => other !== path && covers(path, other)),
  })),
);

describe('PF-real the real workspace', () => {
  test('PF-real every manifest loads, and none holds a secret-named state file declared neither way', () => {
    expect(failures).toEqual([]);
    for (const manifest of manifests)
      expect(privacyProblems(manifest, UNDECLARED_FILES.get(manifest.id) ?? [])).toEqual([]);
  });

  test('PF-real the composed list holds every declared entry, once, each under its own plugin', () => {
    const composed = composePrivateFiles(manifests);
    expect(entries.length).toBeGreaterThan(10);
    for (const entry of entries) {
      // A trailing `*` pins the folder; a file after the `*` is kept whole (the fence pins it inside each member).
      const segments = entry.path.split('/');
      const star = segments.findIndex(segment => segment.includes('*'));
      const expected =
        star === -1 || star === segments.length - 1
          ? segments.slice(0, star === -1 ? undefined : star).join('/')
          : entry.path;
      expect(composed).toContain(`state/${entry.plugin}/${expected}`);
    }
    expect(new Set(composed).size).toBe(composed.length);
  });

  test('PF-real the declared private files are exactly the sweep: a file dropped from a manifest, or added to one, is seen here', () => {
    expect(declared(entries)).toEqual(declared(SWEEP));
    for (const entry of SWEEP)
      expect(entries.find(found => found.plugin === entry.plugin && found.path === entry.path)?.folder).toBe(
        entry.folder,
      );
  });

  test('PF-real a secret-named state file declared PUBLIC carries its reason in the manifest', () => {
    const publics = manifests.flatMap(manifest =>
      (manifest.privacy?.public ?? []).map(entry => ({ plugin: manifest.id, ...entry })),
    );
    expect(publics.map(entry => `${entry.plugin}/${entry.path}`)).toEqual(['mcp/oauth.json']);
    for (const entry of publics) expect(entry.reason.length).toBeGreaterThan(20);
  });
});

async function homeFor(entry: Entry) {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-pf-`));
  temps.push(parent);
  const home = join(parent, 'home');
  const work = join(parent, 'work');
  const agentHome = join(home, 'state', 'codex', 'agent-homes', 'F1');
  const place = join(home, 'state', entry.plugin, entry.path.replace('*', 'S2'));
  // A file entry is the file; a folder entry holds ONE member at the depth the plugin really keeps it (a login's sign-in
  // file is two levels down, a browser profile's cookies three), the file the fence must hold and a folder's own name never is.
  const member = entry.folder ? join(place, FOLDER_MEMBERS[`${entry.plugin}/${entry.path}`] ?? 'member.json') : place;
  await mkdir(join(member, '..'), { recursive: true });
  await writeFile(member, 'private-fixture');
  await mkdir(agentHome, { recursive: true });
  await mkdir(work, { recursive: true });
  return { home, work, agentHome, member };
}

function door(
  kind: 'work' | 'agent-homes',
  l: Awaited<ReturnType<typeof homeFor>>,
  fs: HostFs,
  privateList: readonly string[],
): RootHandle {
  const name: RootName = kind;
  const roots = rootsPortFor(
    fs,
    { home: l.home, plugin: 'codex', worktrees: `${l.home}-worktrees` },
    [name],
    () => workFolders(l.work),
    { random: () => 'r', privateFiles: privateList },
  );
  return roots.root(name, kind === 'work' ? { ferret: 'F1' as FerretId } : { subfolder: 'F1' });
}

const DECOY = 'Innocent.TXT';

describe('PF-file every private file a manifest declares: a ferret is refused, through every kind of root', () => {
  for (const entry of SWEEP)
    for (const kind of ['work', 'agent-homes'] as const)
      test(`PF-file ${entry.plugin}/${entry.path}: the ${kind} root refuses it under another name (read, write, delete)`, async () => {
        const l = await homeFor(entry);
        const folder = kind === 'work' ? l.work : l.agentHome;
        const decoy = join(folder, DECOY);
        await writeFile(decoy, 'decoy');
        const fs = bound(REAL, decoy, l.member);
        const root = door(kind, l, fs, composePrivateFiles(manifests));
        const resolved = root.resolve(DECOY);
        if (!resolved.ok) throw new Error(resolved.error);
        const path = resolved.value;
        expect(await refusal(() => root.readText(path))).toBe('refused:fenced');
        expect(await refusal(() => root.readDurable(path))).toBe('refused:fenced');
        expect(await refusal(() => root.writeText(path, 'overwritten'))).toBe('refused:fenced');
        expect(await refusal(() => root.publish(path, new Uint8Array([1])))).toBe('refused:fenced');
        expect(await refusal(() => root.remove(path))).toBe('refused:fenced');
        expect(await readFile(l.member, 'utf8')).toBe('private-fixture');
        expect(await readFile(decoy, 'utf8')).toBe('decoy');
      });
});

describe('PF-mutation each declared private file is what the refusal rests on', () => {
  for (const entry of SWEEP.filter(item => item.plugin !== 'kernel'))
    test(`PF-mutation ${entry.plugin}/${entry.path}: without its entry the same name is read from the agent home`, async () => {
      const l = await homeFor(entry);
      const decoy = join(l.agentHome, DECOY);
      await writeFile(decoy, 'decoy');
      const dropped = composePrivateFiles(
        manifests.map(manifest =>
          manifest.id === entry.plugin
            ? ({
                ...manifest,
                privacy: { private: (manifest.privacy?.private ?? []).filter(p => p !== entry.path) },
              } as Manifest)
            : manifest,
        ),
      );
      const root = door('agent-homes', l, bound(REAL, decoy, l.member), dropped);
      const resolved = root.resolve(DECOY);
      if (!resolved.ok) throw new Error(resolved.error);
      expect(await refusal(() => root.readText(resolved.value))).toBe('allowed');
    });
});
