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
import type { HeldRoot, PinnedTarget, SpawnBudget } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import {
  MAX_PROJECT_WORKTREES_NAMED,
  PROJECT_BIGGEST_FOLDERS,
  type ProjectFolderCount,
  type ProjectIndexSummary,
} from '../../../contract/index.ts';
import type { FolderPins, PinRefusal } from './pins.ts';

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
  /** The pins for ONE build (the privacy policy is read once, inside). */
  readonly pins: () => Promise<FolderPins>;
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
  constructor(readonly reason: PinRefusal) {
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
  readonly files: SessionFileIndexEntry[];
  readonly skips: SkipTally;
  readonly worktrees: string[];
  /** Folders opened or repositories indexed: the one bound on how much of the disk a build touches. */
  opened: number;
}

const depthOf = (rel: string): number => (rel === '' ? 0 : rel.split('/').length);
const join = (parent: string, name: string): string => (parent === '' ? name : `${parent}/${name}`);
const below = (real: string, rel: string): string => `${real === '/' ? '' : real}/${rel}`;

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
  const pins = await deps.pins();
  const held = await pins.project(path);
  if (!held.ok) throw new ProjectFolderRefused(held.reason);
  const root = held.root;
  const state: State = { files: [], skips: new Map(), worktrees: [], opened: 0 };
  const deadline = new Deadline(deps.nowMs, limits.budgetMs);
  try {
    // The folder itself is a key store or a secret name (`~/.ssh`, a folder called `.env`): nothing beneath it is innocent.
    if (isSharedSecretPath(root.rootReal.split('/').filter(Boolean).join('/')))
      throw new ProjectFolderRefused('private');
    let inside: boolean | undefined;
    try {
      inside = await deps.git.isInsideWorkTree(root.policyCwd, deadline);
    } catch {
      // Git cannot say (unsafe ownership, a broken repository): never walk what its ignore rules might close.
      tally(state.skips, 'unreadable', 1);
    }
    // A spent budget answers `false` without a child; the walk then stops at its first step and says so.
    if (inside === true) await indexRepository(root, '', deps, pins, state, limits, deadline);
    else if (inside === false) await walk(root, deps, pins, state, limits, deadline);
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
async function indexRepository(
  pinned: HeldRoot,
  prefix: string,
  deps: ProjectIndexDeps,
  pins: FolderPins,
  state: State,
  limits: ProjectIndexLimits,
  deadline: Deadline,
): Promise<void> {
  const nested: string[] = [];
  const git: Pick<TreeGit, 'isInsideWorkTree' | 'listFiles'> = {
    // Established by the caller: a `.git` folder is there, or Git already said so for the project folder.
    isInsideWorkTree: async () => true,
    listFiles: async (cwd, maxBytes, budget) => {
      const listed = await deps.git.listFiles(cwd, maxBytes, budget);
      nested.push(...listed.paths.filter(name => name.endsWith('/')).map(name => name.slice(0, -1)));
      return { paths: listed.paths.filter(name => !name.endsWith('/')), truncated: listed.truncated };
    },
  };
  const bounds: TreeIndexBounds = {
    scale: 'project',
    maxFiles: limits.maxFiles,
    maxCandidates: limits.maxCandidates,
    budgetMs: Math.ceil(deadline.remainingMs()),
  };
  try {
    const result = await indexPinnedTree(pinned, { git, policy: POLICY, nowMs: deps.nowMs }, bounds);
    for (const file of result.files)
      state.files.push(prefix === '' ? file : { path: join(prefix, file.path), name: file.name });
    for (const skip of result.skipped) tally(state.skips, skip.reason, skip.count);
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
    await indexNested(pinned, folder, join(prefix, folder), deps, pins, state, limits, deadline);
  }
}

/** One folder Git would not enter: a repository (indexed on its own), a linked worktree or submodule (named), or neither. */
async function indexNested(
  parent: HeldRoot,
  folder: string,
  rel: string,
  deps: ProjectIndexDeps,
  pins: FolderPins,
  state: State,
  limits: ProjectIndexLimits,
  deadline: Deadline,
): Promise<void> {
  if (isSharedSecretPath(rel)) return void tally(state.skips, 'denied', 1);
  if (isIndexExcludedPath(rel) || depthOf(rel) > limits.maxDepth) return void tally(state.skips, 'excluded', 1);
  const kind = await gitKindOf(parent, folder);
  if (kind === 'none') return void tally(state.skips, 'unreadable', 1);
  if (kind === 'file') return void noteWorktree(state, rel);
  state.opened += 1;
  const held = await pins.nested(below(parent.rootReal, folder));
  if (!held.ok) return void tally(state.skips, held.reason === 'private' ? 'denied' : 'unreadable', 1);
  try {
    // The held object must be the very folder Git named: a name swapped for a link lands somewhere else.
    if (held.root.rootReal !== below(parent.rootReal, folder)) return void tally(state.skips, 'denied', 1);
    await indexRepository(held.root, rel, deps, pins, state, limits, deadline);
  } finally {
    await held.root.close().catch(() => undefined);
  }
}

/** What `<folder>/.git` is, walked through the held parent (no link at any component): a folder, a file, or neither. */
async function gitKindOf(parent: HeldRoot, folder: string): Promise<'directory' | 'file' | 'none'> {
  for (const wantDirectory of [true, false]) {
    try {
      const target = await parent.open(`${folder}/.git`, { wantDirectory });
      const type = target.metadata.type;
      await target.close();
      if (type === 'dir') return 'directory';
      if (type === 'file') return 'file';
    } catch {
      // Not a folder (or not there); the second try asks whether it is a file.
    }
  }
  return 'none';
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
async function walk(
  root: HeldRoot,
  deps: ProjectIndexDeps,
  pins: FolderPins,
  state: State,
  limits: ProjectIndexLimits,
  deadline: Deadline,
): Promise<void> {
  const queue: { readonly rel: string; readonly depth: number }[] = [{ rel: '', depth: 0 }];
  let inspected = 0;
  walking: while (true) {
    const next = queue.shift();
    if (next === undefined) break;
    if (state.opened >= limits.maxFolders || deadline.expired()) {
      tally(state.skips, 'truncated', 1 + queue.length);
      break;
    }
    state.opened += 1;
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
      const git = children.find(child => child.name === '.git');
      if (git !== undefined && next.rel !== '') {
        // A repository is its own folder: indexed whole (Git's list, any depth), never listed name by name here.
        if (git.type === 'file') noteWorktree(state, next.rel);
        else if (git.type === 'dir') await indexFound(root, next.rel, deps, pins, state, limits, deadline);
        else tally(state.skips, 'unsupported', 1);
        continue;
      }
      for (const child of children) {
        if (inspected >= limits.maxCandidates || deadline.expired()) {
          tally(state.skips, 'truncated', 1);
          break walking;
        }
        inspected += 1;
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
        else state.files.push(entry);
      }
    } catch {
      tally(state.skips, 'unreadable', 1);
    } finally {
      await target.close();
    }
  }
}

/** A repository the walk found: held as a child of the project folder and indexed whole. */
async function indexFound(
  root: HeldRoot,
  rel: string,
  deps: ProjectIndexDeps,
  pins: FolderPins,
  state: State,
  limits: ProjectIndexLimits,
  deadline: Deadline,
): Promise<void> {
  const held = await pins.nested(below(root.rootReal, rel));
  if (!held.ok) return void tally(state.skips, held.reason === 'private' ? 'denied' : 'unreadable', 1);
  try {
    if (held.root.rootReal !== below(root.rootReal, rel)) return void tally(state.skips, 'denied', 1);
    await indexRepository(held.root, rel, deps, pins, state, limits, deadline);
  } finally {
    await held.root.close().catch(() => undefined);
  }
}

/** Sorts shallow first, applies the one cap, and turns the tally into the summary the app shows. */
function finish(state: State, limits: ProjectIndexLimits, builtAt: Instant): ProjectIndex {
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
