import { afterEach, describe, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { err, ok } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import type { FerretId } from '../../../contract/ids.ts';
import type { RootHandle } from '../../../contract/ports.ts';
import { type FileIdentity, type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { DEFAULT_RECHECK_MS } from '../../../host/fence-index.ts';
import { RootError, rootsPortFor } from '../../../host/roots.ts';
import { composePrivateFiles } from '../../../manifest/privacy.ts';

/**
 * A rotated `fys_` credential in a RESTING session folder (§7.7, GAP 7 closed): every ferret relaunch writes a new
 * `environment.json` into its session folder, and a session folder unchanged for a minute is only looked at when its
 * slice comes round. The fence pins each `*` member FOLDER by identity beside its file, so an alias of the folder —
 * a bind mount made at any time — is recognised at once, whatever the folder holds and however stale the slice is.
 * A bind mount cannot be made without privilege in a unit test, so it is simulated at the disk seam: every path below
 * the alias answers as the same path below the source, and the alias itself has the source's device and inode.
 */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const REAL = nodeFs(() => 'r');
const ENV = 'environment.json';
/** More resting folders than one slice (512), so a folder that is not yet in the slice is not looked at. */
const SESSIONS = 700;
/**
 * The folder whose credential rotates. Of the 700 resting folders the first look after the build visits 0–511 and the
 * next 512–699 and 0–323, so folder 400 is the one the look right after a rotation does NOT reach: it stays unrecognised
 * until the look after that.
 */
const TARGET = 's0400';
/** The look interval the host uses; the tests wait a little longer than it between looks. */
const LOOK_MS = DEFAULT_RECHECK_MS + 50;
const TWO_HOURS_NS = 7_200_000_000_000n;

const LIST = composePrivateFiles([
  { id: 'logins', privacy: { private: ['credentials'] } },
  { id: 'ferrets', privacy: { private: ['tokens.json', 'sessions/*/environment.json'] } },
]);

async function layout() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-private-alias-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const work = `${parent}/work`;
  const sessions = `${home}/state/ferrets/sessions`;
  const agentHome = `${home}/state/codex/agent-homes/F1`;
  await mkdir(agentHome, { recursive: true });
  await writeFile(`${agentHome}/own.txt`, 'mine');
  await mkdir(work, { recursive: true });
  await writeFile(`${work}/own.txt`, 'mine');
  for (let from = 0; from < SESSIONS; from += 100)
    await Promise.all(
      Array.from({ length: Math.min(100, SESSIONS - from) }, async (_, offset) => {
        const folder = `${sessions}/s${String(from + offset).padStart(4, '0')}`;
        await mkdir(folder, { recursive: true });
        await writeFile(`${folder}/${ENV}`, 'FAKE-old-credential');
      }),
    );
  return { parent, home, work, sessions, agentHome, target: `${sessions}/${TARGET}` };
}

type Layout = Awaited<ReturnType<typeof layout>>;

/**
 * A disk where the session folders are two hours old (they rest) and are listed in name order, and where a folder
 * leaves `rested` the moment a test stirs it (what the disk then reports is the folder as it really is now).
 */
function resting(base: HostFs, sessions: string, rested: Set<string>): HostFs {
  const older = (path: string, found: FileIdentity | undefined): FileIdentity | undefined =>
    found !== undefined && rested.has(path)
      ? { ...found, mtimeNs: found.mtimeNs - TWO_HOURS_NS, ctimeNs: found.ctimeNs - TWO_HOURS_NS }
      : found;
  return {
    ...base,
    list: async path => (path === sessions ? [...(await base.list(path))].sort() : await base.list(path)),
    identity: async path => older(path, await base.identity(path)),
  };
}

/**
 * A bind mount of the folder `source` at `alias`: the alias and everything below it is the source, with the source's
 * device and inode (a bind mount of a folder keeps both), and a path found under it is reported under the alias.
 */
function bind(base: HostFs, alias: string, source: string): HostFs {
  const toSource = <T>(value: T): T =>
    typeof value === 'string' && (value === alias || value.startsWith(`${alias}/`))
      ? (`${source}${value.slice(alias.length)}` as T)
      : value;
  return new Proxy(base, {
    get(target, key) {
      const member = (target as never)[key] as unknown;
      if (typeof member !== 'function' || key === 'symlink') return member;
      return async (...args: unknown[]) => {
        const answer = await (member as (...a: unknown[]) => Promise<unknown>).apply(target, args.map(toSource));
        return key === 'realpath' && typeof answer === 'string' && answer.startsWith(source)
          ? `${alias}${answer.slice(source.length)}`
          : answer;
      };
    },
  });
}

const workFolders = (folder: string): WorkFolders => ({
  folderOf: () => folder as FencedPath,
  check: (_ferret, path) => (path.startsWith(folder) ? ok(path as FencedPath) : err('outside')),
});

interface Door {
  readonly label: string;
  readonly folder: (l: Layout) => string;
  readonly make: (l: Layout, fs: HostFs) => RootHandle;
}

const rootOf = (
  l: Layout,
  fs: HostFs,
  name: 'work' | 'imports' | 'agent-homes',
  scope: { readonly ferret?: FerretId; readonly subfolder?: string },
): RootHandle =>
  rootsPortFor(
    fs,
    { home: l.home, plugin: 'codex', worktrees: `${l.home}-worktrees` },
    [name],
    () => workFolders(l.work),
    {
      random: () => 'r',
      privateFiles: LIST,
      privateRecheckMs: DEFAULT_RECHECK_MS,
    },
  ).root(name, scope);

const DOORS: readonly Door[] = [
  { label: 'work', folder: l => l.work, make: (l, fs) => rootOf(l, fs, 'work', { ferret: 'F1' as FerretId }) },
  { label: 'imports', folder: l => l.work, make: (l, fs) => rootOf(l, fs, 'imports', { subfolder: l.work }) },
  {
    label: 'agent-homes',
    folder: l => l.agentHome,
    make: (l, fs) => rootOf(l, fs, 'agent-homes', { subfolder: 'F1' }),
  },
];

const named = (root: RootHandle, relative: string): FencedPath => {
  const path = root.resolve(relative);
  if (!path.ok) throw new Error(`resolve ${relative}: ${path.error}`);
  return path.value;
};

/** What a read of `relative` gave: the text it served, or the refusal. */
const readOf = async (root: RootHandle, relative: string): Promise<string> => {
  try {
    return `served:${await root.readText(named(root, relative))}`;
  } catch (error) {
    return error instanceof RootError ? `refused:${error.refusal}` : `error:${String(error)}`;
  }
};

/** What a ferret relaunch does to a session's credential: a 0600 temp file renamed over the name (a new inode). */
async function rotate(folder: string): Promise<void> {
  await writeFile(`${folder}/${ENV}.new`, 'FAKE-rotated-live-credential', { mode: 0o600 });
  await rename(`${folder}/${ENV}.new`, `${folder}/${ENV}`);
}

/** Every session folder (and the folder that holds them) of `l`: the folders `resting` reports as two hours old. */
const restedFolders = (l: Layout): Set<string> =>
  new Set([l.sessions, ...Array.from({ length: SESSIONS }, (_, n) => `${l.sessions}/s${String(n).padStart(4, '0')}`)]);

const wait = async (ms: number): Promise<void> => {
  await new Promise(done => setTimeout(done, ms));
};

describe('PF-flat a rotated credential in a RESTING session folder is never served through an alias of that folder', () => {
  for (const door of DOORS)
    test(`PF-flat a bind mount of a resting session folder, read through the ${door.label} root, serves the rotated credential 0 times`, async () => {
      const l = await layout();
      const rested = restedFolders(l);
      const alias = `${door.folder(l)}/alias`;
      await mkdir(alias, { recursive: true });
      const root = door.make(l, bind(resting(REAL, l.sessions, rested), alias, l.target));
      // The first look builds the index; every session folder rests.
      expect(await readOf(root, 'own.txt')).toBe('served:mine');
      // The second look visits the first slice (folders 0–511). The alias holds the pinned old file: refused.
      await wait(LOOK_MS);
      expect(await readOf(root, 'own.txt')).toBe('served:mine');
      expect(await readOf(root, `alias/${ENV}`)).toBe('refused:fenced');
      // A relaunch rotates the credential of the resting session.
      await rotate(l.target);
      rested.delete(l.target);
      const answers = [await readOf(root, `alias/${ENV}`)];
      // The next look visits 512–699 and 0–323: not folder 400. Then the one after reaches it.
      for (let look = 0; look < 2; look += 1) {
        await wait(LOOK_MS);
        answers.push(await readOf(root, `alias/${ENV}`));
      }
      expect(answers.filter(answer => answer.startsWith('served:'))).toEqual([]);
      expect(answers).toEqual(['refused:fenced', 'refused:fenced', 'refused:fenced']);
      // The control: nothing else on the disk is refused by it.
      expect(await readOf(root, 'own.txt')).toBe('served:mine');
    }, 60_000);

  test('PF-flat a hard link of the rotated credential made into a work folder is refused too, whatever the slice says', async () => {
    const l = await layout();
    const rested = restedFolders(l);
    const root = rootOf(l, resting(REAL, l.sessions, rested), 'work', { ferret: 'F1' as FerretId });
    expect(await readOf(root, 'own.txt')).toBe('served:mine');
    await wait(LOOK_MS);
    await rotate(l.target);
    rested.delete(l.target);
    await link(`${l.target}/${ENV}`, `${l.work}/hardlink.txt`);
    for (let look = 0; look < 3; look += 1) {
      expect(await readOf(root, 'hardlink.txt')).not.toStartWith('served:');
      await wait(LOOK_MS);
    }
  }, 60_000);

  test('PF-flat a session folder that is NOT aliased is unaffected: the folder pin costs no ordinary read', async () => {
    const l = await layout();
    const rested = restedFolders(l);
    const root = rootOf(l, resting(REAL, l.sessions, rested), 'work', { ferret: 'F1' as FerretId });
    expect(await readOf(root, 'own.txt')).toBe('served:mine');
    await rotate(l.target);
    rested.delete(l.target);
    for (let look = 0; look < 3; look += 1) {
      await wait(LOOK_MS);
      expect(await readOf(root, 'own.txt')).toBe('served:mine');
    }
  }, 60_000);
});
