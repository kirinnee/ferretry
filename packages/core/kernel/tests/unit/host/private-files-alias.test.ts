import { afterEach, describe, expect, mock, test } from 'bun:test';
import { link, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { err, ok } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import type { FerretId } from '../../../contract/ids.ts';
import type { RootHandle, RootName } from '../../../contract/ports.ts';
import { type FileIdentity, type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import type { Fence, PrivateGuard } from '../../../host/fence-guard.ts';
import { DEFAULT_RECHECK_MS, identityKey } from '../../../host/fence-index.ts';
import { composePrivateFiles } from '../../../manifest/privacy.ts';

/**
 * A live credential in a RESTING session folder (§7.7): every ferret relaunch writes a new `environment.json` into its
 * session folder, and a session folder unchanged for a minute is only looked at when its slice comes round. The fence
 * pins EVERY `*` member FOLDER by identity — one that holds the file, one that rests empty, one whose session ended —
 * so an alias of the folder (a bind mount made at any time) is recognised at once, whatever the folder holds and
 * however stale the slice is. The test runs through all SIX root kinds and four ways the folder came to rest:
 * `holder` (the file is rotated), `rebuild` (a new session is made between the build and the rotation, so the folder is
 * answered from its record), `empty` (it rested with no file and one is published), and `ended` (its file was removed
 * and a resume publishes a new one). A bind mount cannot be made without privilege in a unit test, so it is simulated
 * at the disk seam: every path below the alias answers as the same path below the source, and the alias itself has
 * the source's device and inode. What the pin cannot name — a folder REPLACED by another while it rests — is the
 * declared GAP (8) of §7.7, not tested here.
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
  const harnessHome = `${parent}/harness`;
  const project = `${parent}/project`;
  const sessions = `${home}/state/ferrets/sessions`;
  const agentHome = `${home}/state/codex/agent-homes/F1`;
  const fleetHome = `${home}/fleet/F1`;
  for (const folder of [agentHome, fleetHome, work, harnessHome, project]) {
    await mkdir(folder, { recursive: true });
    await writeFile(`${folder}/own.txt`, 'mine');
  }
  for (let from = 0; from < SESSIONS; from += 100)
    await Promise.all(
      Array.from({ length: Math.min(100, SESSIONS - from) }, async (_, offset) => {
        const folder = `${sessions}/s${String(from + offset).padStart(4, '0')}`;
        await mkdir(folder, { recursive: true });
        await writeFile(`${folder}/${ENV}`, 'FAKE-old-credential');
      }),
    );
  return { parent, home, work, harnessHome, project, sessions, agentHome, fleetHome, target: `${sessions}/${TARGET}` };
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

/** A root of kind `name` of the plugin `plugin`, scoped as that kind is. */
const rootOf = (
  l: Layout,
  fs: HostFs,
  plugin: string,
  name: RootName,
  scope: { readonly ferret?: FerretId; readonly subfolder?: string },
): RootHandle =>
  rootsPortFor(fs, { home: l.home, plugin, worktrees: `${l.home}-worktrees` }, [name], () => workFolders(l.work), {
    random: () => 'r',
    privateFiles: LIST,
    privateRecheckMs: DEFAULT_RECHECK_MS,
    projectFiles: ['own.txt', 'alias/environment.json'],
  }).root(name, scope);

/** One of the six kinds of root: the folder it reaches (where the alias is made) and how it is built. */
interface Door {
  readonly label: RootName;
  readonly folder: (l: Layout) => string;
  readonly make: (l: Layout, fs: HostFs) => RootHandle;
}

const DOORS: readonly Door[] = [
  {
    label: 'work',
    folder: l => l.work,
    make: (l, fs) => rootOf(l, fs, 'codex', 'work', { ferret: 'F1' as FerretId }),
  },
  {
    label: 'imports',
    folder: l => l.work,
    make: (l, fs) => rootOf(l, fs, 'codex', 'imports', { subfolder: l.work }),
  },
  {
    label: 'agent-homes',
    folder: l => l.agentHome,
    make: (l, fs) => rootOf(l, fs, 'codex', 'agent-homes', { subfolder: 'F1' }),
  },
  {
    label: 'project-files',
    folder: l => l.project,
    make: (l, fs) => rootOf(l, fs, 'mcp', 'project-files', { subfolder: l.project }),
  },
  {
    label: 'harness-home',
    folder: l => l.harnessHome,
    make: (l, fs) => rootOf(l, fs, 'runtimes', 'harness-home', { subfolder: l.harnessHome }),
  },
  {
    label: 'fleet',
    folder: l => l.fleetHome,
    make: (l, fs) => rootOf(l, fs, 'runtimes', 'fleet', { subfolder: 'F1' }),
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

const LOOKS = ['right after the rotation', 'one look later', 'two looks later'];

/** One identity the read asked the disk for on its way down the alias. */
interface Walked {
  readonly path: string;
  readonly key: string | undefined;
}

/**
 * One check the read ACTUALLY made, taken from the host's own calls (see {@link tap}): an owner's root asks the global
 * fence (`fencedReal`), an internal root asks its scoped guard (`privatelyHeld`, which the host asks twice: the kept
 * guard, then the guard it renewed). `has` answers from the very object the host consulted, so nothing is looked at again.
 */
interface Consult {
  readonly asked: 'global fence' | 'scoped guard';
  readonly real: string;
  readonly base: string | undefined;
  readonly has: (key: string) => boolean;
  readonly verdict: boolean;
}

/**
 * What the host's own checks did AT one read of the alias: every check it made (which guard, for which path, held or
 * not), the folder key of the alias target, and every identity the read walked under the alias. Nothing here is asked of
 * the disk or the index by the test: it is only what the read itself produced.
 */
interface Decision {
  readonly answer: string;
  readonly folderKey: string | undefined;
  readonly consults: readonly Consult[];
  readonly walked: readonly Walked[];
}

/** The recorder of the read in flight: switched on only around one read, so every other read passes straight through. */
const tap: { on: boolean; consults: Consult[] } = { on: false, consults: [] };

/**
 * The host's two checks of a path against the private places, wrapped to note which one a read consulted and what it
 * said. Each call goes straight to the real one with the same arguments, so the read behaves exactly as it would
 * without the spy: it adds no look, no scan and no remembered folder of its own.
 */
const original = { ...(await import('../../../host/fence-guard.ts')) };
mock.module('../../../host/fence-guard.ts', () => ({
  ...original,
  privatelyHeld: async (fs: HostFs, guard: PrivateGuard, real: string, base: string, now?: () => number) => {
    const verdict = await original.privatelyHeld(fs, guard, real, base, now);
    if (tap.on) tap.consults.push({ asked: 'scoped guard', real, base, has: key => guard.keys.has(key), verdict });
    return verdict;
  },
  fencedReal: async (fs: HostFs, fence: Fence, real: string) => {
    const verdict = await original.fencedReal(fs, fence, real);
    if (tap.on)
      tap.consults.push({ asked: 'global fence', real, base: undefined, has: key => fence.keys.has(key), verdict });
    return verdict;
  },
}));
const { RootError, rootsPortFor } = await import('../../../host/roots.ts');

/** A disk that notes every identity asked for a path at or under `alias` while the tap is on (the walk of one read). */
function recording(base: HostFs, alias: string, log: Walked[]): HostFs {
  return {
    ...base,
    identity: async path => {
      const found = await base.identity(path);
      if (tap.on && (path === alias || path.startsWith(`${alias}/`)))
        log.push({ path, key: found === undefined ? undefined : identityKey(found) });
      return found;
    },
  };
}

/** One read of the alias, with the checks the host made for it and the walk it took noted as they happen. */
async function decided(root: RootHandle, l: Layout, log: Walked[]): Promise<Decision> {
  const target = await REAL.identity(l.target);
  log.length = 0;
  tap.consults = [];
  tap.on = true;
  const answer = await readOf(root, `alias/${ENV}`);
  tap.on = false;
  return {
    answer,
    folderKey: target === undefined ? undefined : identityKey(target),
    consults: tap.consults,
    walked: [...log],
  };
}

/**
 * What a serve says, so a recurrence names its mechanism: for each look that served, which guard the read ACTUALLY
 * consulted (the global fence for an owner's root, the scoped guard for an internal one), whether it held the folder key
 * and said refuse, and every identity walked under the alias with whether the consulted guard holds its key. Only the
 * paths and keys are printed, never what a file holds.
 */
function servedLooks(l: Layout, decisions: readonly Decision[]): readonly string[] {
  const rel = (path: string): string => path.slice(l.parent.length);
  return decisions.flatMap((decision, at) => {
    if (!decision.answer.startsWith('served:')) return [];
    const folderKey = decision.folderKey;
    const checks =
      decision.consults.length === 0
        ? 'no guard was consulted'
        : decision.consults
            .map(
              check =>
                `${check.asked}${check.base === undefined ? '' : ` of ${rel(check.base)}`} for ${rel(check.real)}: held the folder key=${
                  folderKey !== undefined && check.has(folderKey)
                }, verdict=${check.verdict ? 'held' : 'clear'}`,
            )
            .join('; ');
    const walk = decision.walked
      .map(step => {
        const holders = decision.consults.map(check => step.key !== undefined && check.has(step.key));
        return `${rel(step.path)} key=${step.key ?? 'none'} held-by-consulted=[${holders.join(',')}]`;
      })
      .join('; ');
    return [`served ${LOOKS[at]}: consulted: [${checks}]; walked: [${walk}]`];
  });
}

const wait = async (ms: number): Promise<void> => {
  await new Promise(done => setTimeout(done, ms));
};

/**
 * What `rebuild` does between the second look and the credential that is published: a new session is made, so the next
 * look rebuilds the index and answers the resting folder from its record (the fast path every resting member takes).
 * The other ways are set up around the build: `holder` rotates the file that is there; `empty` rests with no file at
 * all; `ended` has its file removed right after the build, so the second look (the first slice, folder 400 in it) finds
 * a folder with no file.
 */
async function rebuilt(l: Layout, root: RootHandle): Promise<void> {
  await mkdir(`${l.sessions}/s9000`, { recursive: true });
  await writeFile(`${l.sessions}/s9000/${ENV}`, 'FAKE-new-session');
  await wait(LOOK_MS);
  expect(await readOf(root, 'own.txt')).toBe('served:mine');
}

describe('PF-flat a credential published into a RESTING session folder is never served through an alias of that folder', () => {
  for (const door of DOORS)
    for (const way of ['holder', 'rebuild', 'empty', 'ended'] as const)
      test(`PF-flat a bind mount of a resting session folder (${way}), read through the ${door.label} root, serves the credential 0 times`, async () => {
        const l = await layout();
        const rested = restedFolders(l);
        const alias = `${door.folder(l)}/alias`;
        await mkdir(alias, { recursive: true });
        // A folder that rests with no file at all: the session never had an environment, or it ended before this boot.
        if (way === 'empty') await rm(`${l.target}/${ENV}`);
        const log: Walked[] = [];
        const fs = recording(bind(resting(REAL, l.sessions, rested), alias, l.target), alias, log);
        const root = door.make(l, fs);
        // The first look builds the index; every session folder rests.
        expect(await readOf(root, 'own.txt')).toBe('served:mine');
        // The session ended: its file is gone (the index has not seen that yet).
        if (way === 'ended') await rm(`${l.target}/${ENV}`);
        // The second look visits the first slice (folders 0–511).
        await wait(LOOK_MS);
        expect(await readOf(root, 'own.txt')).toBe('served:mine');
        if (way === 'holder') expect(await readOf(root, `alias/${ENV}`)).toBe('refused:fenced');
        if (way === 'rebuild') await rebuilt(l, root);
        // A relaunch (or a resume) publishes a new credential into the resting session.
        await rotate(l.target);
        rested.delete(l.target);
        const decisions = [await decided(root, l, log)];
        // The next look visits 512–699 and 0–323: not folder 400. Then the one after reaches it.
        for (let look = 0; look < 2; look += 1) {
          await wait(LOOK_MS);
          decisions.push(await decided(root, l, log));
        }
        expect(servedLooks(l, decisions)).toEqual([]);
        expect(decisions.map(decision => decision.answer)).toEqual([
          'refused:fenced',
          'refused:fenced',
          'refused:fenced',
        ]);
        // The control: nothing else on the disk is refused by it.
        expect(await readOf(root, 'own.txt')).toBe('served:mine');
      }, 60_000);

  test('PF-flat a hard link of the rotated credential made into a work folder is refused too, whatever the slice says', async () => {
    const l = await layout();
    const rested = restedFolders(l);
    const root = rootOf(l, resting(REAL, l.sessions, rested), 'codex', 'work', { ferret: 'F1' as FerretId });
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
    const root = rootOf(l, resting(REAL, l.sessions, rested), 'codex', 'work', { ferret: 'F1' as FerretId });
    expect(await readOf(root, 'own.txt')).toBe('served:mine');
    await rotate(l.target);
    rested.delete(l.target);
    for (let look = 0; look < 3; look += 1) {
      await wait(LOOK_MS);
      expect(await readOf(root, 'own.txt')).toBe('served:mine');
    }
  }, 60_000);
});
