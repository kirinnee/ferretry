import {
  compareShallowFirst,
  coverageOf,
  indexPinnedTree,
  isIndexExcludedPath,
  isSharedSecretPath,
  MAX_INDEX_DIRECTORIES,
  MAX_PROJECT_INDEX_CANDIDATES,
  MAX_PROJECT_INDEX_FILES,
  type SessionFileIndexEntry,
  SessionFileIndexEntrySchema,
  type SkipTally,
  skipRecord,
  tally,
  TreeRootDeniedError,
  type TreeGit,
  type TreeIndexBounds,
  type TreePolicy,
  MAX_INDEX_WALL_MS,
} from '@ferretry/core-ferrets/contract';
import { FsError, type HeldRoot, type PinnedTarget, type SpawnBudget } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import {
  MAX_PROJECT_WORKTREES_NAMED,
  PROJECT_BIGGEST_FOLDERS,
  type ProjectFolderCount,
  type ProjectIndexSummary,
} from '../../../contract/index.ts';
import { GitTimedOut, type FolderPins, type PinRefusal } from './pins.ts';

/**
 * Builds a project's file index (&F6061 U5): every file name in the project folder that Git does not ignore, once, with
 * what it left out.
 *
 * WHAT IS GIT'S AND WHAT IS OURS. Inside a repository the list is Git's whole answer at any depth (`indexPinnedTree`, the
 * tree index a ferret's `fs/index` shares): depth 5 would hide 58% of this repository's own files, and every IDE lets Git's
 * ignore rules decide rather than a depth. OUTSIDE a repository there is no ignore rule, so the walk is ours: breadth
 * first, {@link MAX_PROJECT_DEPTH} folders deep (Zed's `file_scan_depth`, owner decision D1), which is how far down it looks
 * for repositories and for plain files. A folder holding a `.git` FOLDER is a repository and is indexed whole.
 *
 * NESTED CHECKOUTS (owner decision D4). A linked worktree or a submodule checkout keeps a `.git` FILE. It is not indexed:
 * one repository's thirty worktrees would be thirty copies of the same files (this checkout: 1,027,574 names with them,
 * 14,002 without). It is counted as `excluded` and named, so the app can say what it did not enter.
 *
 * ONE CAP, ONE ORDER. {@link MAX_PROJECT_INDEX_FILES} files are kept across every repository, shallow first, so a cap that
 * bites drops `a/very/deep/file` before `README.md`, and says so (`truncated`, partial). Every name passes the ONE shared
 * secret-name rule (`isSharedSecretPath`, in `@ferretry/std`) and is counted as `denied`, exactly as a ferret's index does.
 *
 * NAMES ONLY, and only in memory (the cache). The kernel's file probe answers a regular file's kind, not its size or its
 * time, so those are not stored: no contents, no hashes, no sizes.
 */

/** How many folders below the project folder the non-repository walk opens (the project folder is 0). */
const MAX_PROJECT_DEPTH = 5;

/** The most names one folder of the walk reports; one past it makes the build partial. */
const MAX_FOLDER_NAMES = 5_000;

/** What a build is allowed to look at. Tests narrow these; the shipped route narrows nothing. */
export interface ProjectIndexLimits {
  readonly maxFiles: number;
  readonly maxCandidates: number;
  readonly maxFolders: number;
  readonly maxDepth: number;
  readonly budgetMs: number;
}

export const DEFAULT_PROJECT_INDEX_LIMITS: ProjectIndexLimits = {
  maxFiles: MAX_PROJECT_INDEX_FILES,
  maxCandidates: MAX_PROJECT_INDEX_CANDIDATES,
  maxFolders: MAX_INDEX_DIRECTORIES,
  maxDepth: MAX_PROJECT_DEPTH,
  budgetMs: MAX_INDEX_WALL_MS,
};

/** What a build needs from outside: the held folders, Git, a clock and the limits. */
export interface ProjectIndexDeps {
  /** The pins for ONE build (the privacy policy is read once, inside), spent from the build's own deadline. */
  readonly pins: (budget: SpawnBudget) => Promise<FolderPins>;
  readonly git: Pick<TreeGit, 'isInsideWorkTree' | 'listFiles'>;
  readonly nowMs: () => number;
  readonly instant: () => Instant;
  readonly limits?: ProjectIndexLimits;
}

/** A finished build: the summary the app shows, and every name held for searching. */
export interface ProjectIndex {
  readonly summary: ProjectIndexSummary;
  /** Shallow first, then byte order. */
  readonly files: readonly SessionFileIndexEntry[];
}

/** The project folder cannot be indexed at all: nothing verified is there, or the privacy policy refuses it. */
export class ProjectFolderRefused extends Error {
  constructor(readonly reason: Exclude<PinRefusal, 'spent'>) {
    super(
      reason === 'private' ? 'the project folder is private and is not indexed' : 'the project folder is not available',
    );
    this.name = 'ProjectFolderRefused';
  }
}

/** A names-only policy: the shared secret rule is the contract's own floor, so a project withholds nothing beyond it. */
const POLICY: TreePolicy = { normalize: rel => rel, isDenied: () => false };

/** The deadline of one build, asked as the budget every nested read takes. */
class Deadline implements SpawnBudget {
  private readonly end: number;
  constructor(
    private readonly nowMs: () => number,
    budgetMs: number,
  ) {
    this.end = nowMs() + budgetMs;
  }
  expired(): boolean {
    return this.nowMs() >= this.end;
  }
  remainingMs(): number {
    return Math.max(0, this.end - this.nowMs());
  }
}

interface State {
  /** Accepted rows, never more than twice the cap: {@link accept} keeps the shallowest as it goes. */
  readonly files: SessionFileIndexEntry[];
  readonly skips: SkipTally;
  readonly worktrees: string[];
  /** Folders opened or repositories indexed: the one bound on how much of the disk a build touches. */
  opened: number;
  /** Names looked at across the WHOLE project, every repository and the plain walk together: the one candidate budget. */
  candidates: number;
}

/** What one build shares across its repositories: the deps, the pins, the limits, the ONE deadline and the one verdict memo. */
interface Run {
  readonly deps: ProjectIndexDeps;
  readonly pins: FolderPins;
  readonly state: State;
  readonly limits: ProjectIndexLimits;
  readonly deadline: Deadline;
  readonly judge: Judge;
  /** The device of the project folder, read from its held descriptor: a descendant on another device is not entered. */
  readonly device: string;
}

const depthOf = (rel: string): number => (rel === '' ? 0 : rel.split('/').length);
const join = (parent: string, name: string): string => (parent === '' ? name : `${parent}/${name}`);
const below = (real: string, rel: string): string => `${real === '/' ? '' : real}/${rel}`;
const parentOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

/**
 * The device (`st_dev`) of the folder `rel` inside a held root (`''` is the held folder itself), read from the DESCRIPTOR the
 * pinned walk opened — never from a path that could be swapped for another after it was looked at. `undefined` when it is
 * not a folder there now.
 */
async function deviceOf(root: HeldRoot, rel: string): Promise<string | undefined> {
  try {
    const target = await root.open(rel, { wantDirectory: true });
    try {
      return target.identities.at(-1)?.dev.toString();
    } finally {
      await target.close();
    }
  } catch {
    return undefined;
  }
}

/** Why a folder below the project was not entered: the policy said private, it is on another disk, or nothing was proved. */
type Verdict = 'ok' | 'private' | 'device' | 'unreadable' | 'spent';

/** Counts what a refused folder (or each file below one) costs the answer, in the words the skip list already has. */
function refuse(state: State, verdict: Exclude<Verdict, 'ok'>, count = 1): void {
  tally(
    state.skips,
    verdict === 'private'
      ? 'denied'
      : verdict === 'device'
        ? 'excluded'
        : verdict === 'spent'
          ? 'truncated'
          : 'unreadable',
    count,
  );
}

/**
 * The ONE judgment of an ordinary folder below the project folder, shared by the walk and by the folders a Git list names:
 * the shared folder policy (`pins.descendant`: a key store by name or by where it REALLY is, a folder holding a sign-in
 * file) AND the same disk as the project folder (`find -xdev`), read from the held descriptor. Every folder from the held
 * root down is judged, ancestors first, so a private folder closes everything beneath it; each verdict is remembered, so a
 * folder is asked once however many files it holds.
 */
class Judge {
  private readonly memo = new Map<string, Verdict>();
  constructor(
    private readonly pins: FolderPins,
    private readonly device: string,
    private readonly deadline: Deadline,
  ) {}

  async dir(root: HeldRoot, rel: string): Promise<Verdict> {
    if (rel === '') return 'ok';
    const above = await this.dir(root, parentOf(rel));
    if (above !== 'ok') return above;
    const real = below(root.rootReal, rel);
    const known = this.memo.get(real);
    if (known !== undefined) return known;
    if (this.deadline.expired()) return 'spent';
    const verdict = await this.judge(root, rel, real);
    this.memo.set(real, verdict);
    return verdict;
  }

  private async judge(root: HeldRoot, rel: string, real: string): Promise<Verdict> {
    const policy = await this.pins.descendant(real);
    if (policy !== undefined) return policy;
    const device = await deviceOf(root, rel);
    return device === undefined ? 'unreadable' : device === this.device ? 'ok' : 'device';
  }
}

/** What `<rel>/.git` is, asked of the held root before any listing: a folder, a file, nothing there, or not established. */
async function gitMarker(root: HeldRoot, rel: string): Promise<'directory' | 'file' | 'absent' | 'indeterminate'> {
  const path = `${rel}/.git`;
  const attempt = async (wantDirectory: boolean) => {
    const target = await root.open(path, { wantDirectory });
    try {
      return target.metadata.type;
    } finally {
      await target.close();
    }
  };
  try {
    return (await attempt(true)) === 'dir' ? 'directory' : 'indeterminate';
  } catch (error) {
    if (error instanceof FsError && error.code === 'not_found') return 'absent';
    if (!(error instanceof FsError && error.code === 'not_a_directory')) return 'indeterminate';
  }
  try {
    return (await attempt(false)) === 'file' ? 'file' : 'indeterminate';
  } catch {
    return 'indeterminate';
  }
}

/**
 * Keeps an accepted row. The rows are held shallow first and never past twice the cap: a project of many repositories each
 * holding up to the cap would otherwise grow without a bound until the final sort.
 */
function accept(state: State, rows: readonly SessionFileIndexEntry[], limits: ProjectIndexLimits): void {
  for (const row of rows) state.files.push(row);
  if (state.files.length <= limits.maxFiles * 2) return;
  state.files.sort((left, right) => compareShallowFirst(left.path, right.path));
  tally(state.skips, 'truncated', state.files.length - limits.maxFiles);
  state.files.length = limits.maxFiles;
}

/** One indexed row for a name the walk met, or `undefined` for a spelling the file routes would refuse. */
function entryFor(rel: string): SessionFileIndexEntry | undefined {
  const parsed = SessionFileIndexEntrySchema.safeParse({ path: rel, name: rel.split('/').at(-1) ?? '' });
  return parsed.success ? parsed.data : undefined;
}

/**
 * Indexes the project folder at `path`. Throws {@link ProjectFolderRefused} when it cannot be held or is private; every
 * other trouble is a counted skip in the answer, never a failure.
 */
export async function buildProjectIndex(path: string, deps: ProjectIndexDeps): Promise<ProjectIndex> {
  const limits = deps.limits ?? DEFAULT_PROJECT_INDEX_LIMITS;
  // ONE deadline for the whole build, started BEFORE anything is held: reading the privacy policy and holding the folder can
  // list whole folders, and that time is spent from the same budget the walk has.
  const deadline = new Deadline(deps.nowMs, limits.budgetMs);
  const state: State = { files: [], skips: new Map(), worktrees: [], opened: 0, candidates: 0 };
  const pins = await deps.pins(deadline);
  const held = await pins.project(path);
  // The time ran out before the folder could be held: an empty answer that says so, never a claim that it is not there.
  if (!held.ok && held.reason === 'spent') {
    tally(state.skips, 'truncated', 1);
    return finish(state, limits, deps.instant());
  }
  if (!held.ok) throw new ProjectFolderRefused(held.reason as Exclude<PinRefusal, 'spent'>);
  const root = held.root;
  try {
    // The folder itself is a key store or a secret name (`~/.ssh`, a folder called `.env`): nothing beneath it is innocent.
    if (isSharedSecretPath(root.rootReal.split('/').filter(Boolean).join('/')))
      throw new ProjectFolderRefused('private');
    // Nothing below can be proved on the project's own disk without knowing which disk that is.
    const device = await deviceOf(root, '');
    if (device === undefined) throw new ProjectFolderRefused('unavailable');
    const run: Run = { deps, pins, state, limits, deadline, judge: new Judge(pins, device, deadline), device };
    let inside: boolean | undefined;
    try {
      inside = await deps.git.isInsideWorkTree(root.policyCwd, deadline);
    } catch (error) {
      // Git cannot say (unsafe ownership, a broken repository): never walk what its ignore rules might close. A child that
      // ran out of the build's time is the budget, not damage: it is counted as cut short.
      tally(state.skips, error instanceof GitTimedOut || deadline.expired() ? 'truncated' : 'unreadable', 1);
    }
    // A spent budget answers `false` without a child; the walk then stops at its first step and says so.
    if (inside === true) await indexRepository(root, '', run);
    else if (inside === false) await walk(root, run);
  } finally {
    await root.close().catch(() => undefined);
  }
  return finish(state, limits, deps.instant());
}

/**
 * One repository: Git's whole list, then each nested repository it named, each with its own list.
 *
 * `prefix` is where this repository sits below the project folder (`''` for the project folder itself). Git prints a
 * nested repository or linked worktree as one `dir/` entry and does not enter it; those entries are taken out of the list
 * (they would otherwise be counted as unsupported names) and handled here.
 */
async function indexRepository(pinned: HeldRoot, prefix: string, run: Run): Promise<void> {
  const { deps, state, limits, deadline } = run;
  // What the project folder and the repositories before this one already looked at is spent: one budget, not one per repository.
  const room = limits.maxCandidates - state.candidates;
  if (room <= 0) return void tally(state.skips, 'truncated', 1);
  const nested: string[] = [];
  const git: Pick<TreeGit, 'isInsideWorkTree' | 'listFiles'> = {
    // Established by the caller: a `.git` folder is there, or Git already said so for the project folder.
    isInsideWorkTree: async () => true,
    listFiles: async (cwd, maxBytes, budget) => {
      let listed: Awaited<ReturnType<typeof deps.git.listFiles>>;
      try {
        listed = await deps.git.listFiles(cwd, maxBytes, budget);
      } catch (error) {
        // A child that ran out of the build's time is the budget being spent, not an unreadable repository.
        if (error instanceof GitTimedOut || deadline.expired()) return { paths: [], truncated: true };
        throw error;
      }
      // ONE allowance for every name looked at, nested repositories and plain files alike: what the shared candidate budget
      // has left is taken shallow first BEFORE either kind is admitted, so a folder past it is never inspected.
      const kept =
        listed.paths.length > room ? [...listed.paths].sort(compareShallowFirst).slice(0, room) : listed.paths;
      state.candidates += kept.length;
      nested.push(...kept.filter(name => name.endsWith('/')).map(name => name.slice(0, -1)));
      return {
        paths: kept.filter(name => !name.endsWith('/')),
        truncated: listed.truncated || kept.length < listed.paths.length,
      };
    },
  };
  const bounds: TreeIndexBounds = {
    scale: 'project',
    maxFiles: limits.maxFiles,
    maxCandidates: room,
    budgetMs: Math.ceil(deadline.remainingMs()),
  };
  try {
    const result = await indexPinnedTree(pinned, { git, policy: POLICY, nowMs: deps.nowMs }, bounds);
    for (const skip of result.skipped) tally(state.skips, skip.reason, skip.count);
    accept(state, await admitted(pinned, prefix, result.files, run), limits);
  } catch (error) {
    tally(state.skips, error instanceof TreeRootDeniedError ? 'denied' : 'unreadable', 1);
    return;
  }
  const folders = [...new Set(nested)].sort();
  for (const [position, folder] of folders.entries()) {
    if (deadline.expired() || state.opened >= limits.maxFolders) {
      tally(state.skips, 'truncated', folders.length - position);
      return;
    }
    await indexNested(pinned, folder, join(prefix, folder), run);
  }
}

/**
 * The rows of one repository's Git list whose every folder passes the shared folder policy and is on the project's disk.
 * Git names files at any depth and says nothing about what a folder is, so each distinct folder is judged once (ancestors
 * first); what is under a refused one is counted by the reason and not returned. The rows come back as the project names
 * them (below the project folder).
 */
async function admitted(
  pinned: HeldRoot,
  prefix: string,
  files: readonly SessionFileIndexEntry[],
  run: Run,
): Promise<SessionFileIndexEntry[]> {
  const kept: SessionFileIndexEntry[] = [];
  for (const file of files) {
    const verdict = await run.judge.dir(pinned, parentOf(file.path));
    if (verdict === 'ok') kept.push(prefix === '' ? file : { path: join(prefix, file.path), name: file.name });
    else refuse(run.state, verdict);
  }
  return kept;
}

/** One folder Git would not enter: a repository (indexed on its own), a linked worktree or submodule (named), or neither. */
async function indexNested(parent: HeldRoot, folder: string, rel: string, run: Run): Promise<void> {
  const { state, limits } = run;
  if (isSharedSecretPath(rel)) return void tally(state.skips, 'denied', 1);
  if (isIndexExcludedPath(rel) || depthOf(rel) > limits.maxDepth) return void tally(state.skips, 'excluded', 1);
  // Every folder from the parent down to the one Git named is judged like any other descendant (a repository under a
  // sign-in folder is under it), by the policy and the disk, before a marker is asked about or anything is held.
  const judged = await run.judge.dir(parent, folder);
  if (judged !== 'ok') return void refuse(state, judged);
  const kind = await gitMarker(parent, folder);
  // Git named it a repository: no `.git` there now, or not established, is not one to enter.
  if (kind === 'absent' || kind === 'indeterminate') return void tally(state.skips, 'unreadable', 1);
  if (kind === 'file') return void noteWorktree(state, rel);
  await indexHeld(parent, folder, rel, run);
}

/** A repository whose `.git` folder was established: held as a child of the folder it is in, and indexed whole. */
async function indexHeld(parent: HeldRoot, folder: string, rel: string, run: Run): Promise<void> {
  const { state } = run;
  state.opened += 1;
  const held = await run.pins.nested(below(parent.rootReal, folder));
  if (!held.ok)
    return void tally(
      state.skips,
      held.reason === 'private' ? 'denied' : held.reason === 'spent' ? 'truncated' : 'unreadable',
      1,
    );
  try {
    // The held object must be the very folder that was judged: a name swapped for a link or a mount lands somewhere else.
    if (held.root.rootReal !== below(parent.rootReal, folder)) return void tally(state.skips, 'denied', 1);
    if ((await deviceOf(held.root, '')) !== run.device) return void tally(state.skips, 'excluded', 1);
    await indexRepository(held.root, rel, run);
  } finally {
    await held.root.close().catch(() => undefined);
  }
}

/** A linked worktree or submodule checkout: counted as excluded and named, never entered. */
function noteWorktree(state: State, rel: string): void {
  tally(state.skips, 'excluded', 1);
  state.worktrees.push(rel);
}

/**
 * The walk outside a repository: breadth first, {@link ProjectIndexLimits.maxDepth} folders deep.
 *
 * Every folder is opened from the held root by the pinned walk, which refuses a link at ANY component, so nothing here
 * leaves the project. A folder that cannot be opened costs its own subtree and nothing else. Hidden folders, the index's
 * noisy roots and secret-named entries are skipped and counted; a plain file met on the way is indexed.
 */
async function walk(root: HeldRoot, run: Run): Promise<void> {
  const { state, limits, deadline } = run;
  const queue: { readonly rel: string; readonly depth: number }[] = [{ rel: '', depth: 0 }];
  walking: while (true) {
    const next = queue.shift();
    if (next === undefined) break;
    if (state.opened >= limits.maxFolders || deadline.expired()) {
      tally(state.skips, 'truncated', 1 + queue.length);
      break;
    }
    state.opened += 1;
    if (next.rel !== '') {
      // BEFORE the folder is listed: the shared folder policy and the disk, then whether it is a repository. A listing is
      // capped, so it can miss a `.git` that is there; the marker is asked of the held root, and what cannot be established
      // is not listed (listing it would name what Git's ignore rules close, or enter a linked worktree).
      const verdict = await run.judge.dir(root, next.rel);
      if (verdict === 'spent') {
        tally(state.skips, 'truncated', 1 + queue.length);
        break;
      }
      if (verdict !== 'ok') {
        refuse(state, verdict);
        continue;
      }
      const marker = await gitMarker(root, next.rel);
      if (marker === 'directory') {
        await indexHeld(root, next.rel, next.rel, run);
        continue;
      }
      if (marker === 'file') {
        noteWorktree(state, next.rel);
        continue;
      }
      if (marker === 'indeterminate') {
        tally(state.skips, 'unreadable', 1);
        continue;
      }
    }
    let target: PinnedTarget;
    try {
      target = await root.open(next.rel, { wantDirectory: true });
    } catch {
      tally(state.skips, 'unreadable', 1);
      continue;
    }
    try {
      const listing = await target.list(MAX_FOLDER_NAMES, deadline);
      if (listing.truncated) tally(state.skips, 'truncated', 1);
      const children = [...listing.entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const child of children) {
        if (state.candidates >= limits.maxCandidates || deadline.expired()) {
          tally(state.skips, 'truncated', 1);
          break walking;
        }
        state.candidates += 1;
        const rel = join(next.rel, child.name);
        if (child.type === 'dir' && child.name.startsWith('.')) {
          tally(state.skips, 'excluded', 1);
          continue;
        }
        if (isIndexExcludedPath(rel)) {
          tally(state.skips, 'excluded', 1);
          continue;
        }
        if (isSharedSecretPath(rel)) {
          tally(state.skips, 'denied', 1);
          continue;
        }
        // A link is never served at any depth, and one that escapes would name a place outside the project.
        if (child.escapes === true || child.type === 'symlink') {
          tally(state.skips, 'unsupported', 1);
          continue;
        }
        if (child.type === 'dir') {
          if (next.depth + 1 > limits.maxDepth) tally(state.skips, 'excluded', 1);
          else queue.push({ rel, depth: next.depth + 1 });
          continue;
        }
        const entry = child.type === 'file' ? entryFor(rel) : undefined;
        if (entry === undefined) tally(state.skips, 'unsupported', 1);
        else accept(state, [entry], limits);
      }
    } catch {
      tally(state.skips, 'unreadable', 1);
    } finally {
      await target.close();
    }
  }
}

/** Sorts shallow first, applies the one cap, and turns the tally into the summary the app shows. */
function finish(state: State, limits: ProjectIndexLimits, builtAt: Instant): ProjectIndex {
  // At most twice the cap is held (`accept`), so this sort is bounded work however many repositories fed it.
  const sorted = [...state.files].sort((left, right) => compareShallowFirst(left.path, right.path));
  tally(state.skips, 'truncated', sorted.length - limits.maxFiles);
  const files = sorted.slice(0, limits.maxFiles);
  return {
    files,
    summary: {
      builtAt,
      indexed: files.length,
      coverage: coverageOf(state.skips),
      skipped: skipRecord(state.skips),
      biggestFolders: biggestFolders(files),
      nestedWorktrees: [...state.worktrees].sort().slice(0, MAX_PROJECT_WORKTREES_NAMED),
    },
  };
}

/** The top-level folders holding the most indexed files: where a cap bit, in the words a person uses. */
function biggestFolders(files: readonly SessionFileIndexEntry[]): ProjectFolderCount[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const at = file.path.indexOf('/');
    if (at > 0) counts.set(file.path.slice(0, at), (counts.get(file.path.slice(0, at)) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, PROJECT_BIGGEST_FOLDERS)
    .map(([folder, count]) => ({ folder, files: count }));
}
