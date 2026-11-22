import type { PinnedFileKind, PinnedRoot, PinnedTarget, SpawnBudget, WorkBudget } from '@ferretry/kernel/contract';
import { isSecretFileName, isSecretFolderName } from '@ferretry/std';
import type { TreeGit } from './tree-git.ts';
import {
  type SessionFileIndex,
  type SessionFileIndexCoverage,
  type SessionFileIndexEntry,
  SessionFileIndexEntrySchema,
  type SessionFileIndexSkip,
  type SessionFileIndexSkipReason,
  SessionFileIndexSkipReasonSchema,
} from './view/session-search.ts';

/**
 * The tree index, owned once (&F6061 U2): every file under a held root that a read could serve, as NAMES, in one
 * answer, with what it left out.
 *
 * It is a ferret's `fs/index` today and a project's file finder next. Both hold a folder open through the kernel, ask
 * Git once for the names Git does not ignore, prove each name a current regular file through the held root, and count
 * every omission. What differs between them is two caller facts handed in — the secret-name rule ({@link TreePolicy})
 * and the clock — so the algorithm has one owner and the callers have none.
 *
 * WHY A REPOSITORY IS ONE COMMAND AND EVERYTHING ELSE IS A WALK. Inside a worktree, `--exclude-standard` is the
 * gitignore rule applied by the tool that defines it, in a single answer whatever the tree's depth — which is both the
 * right owner and the difference between one round trip and thousands. Outside one there is no ignore rule to honour,
 * so a bounded descriptor walk is both cheaper and safer than asking Git about a directory that is not in a repository.
 *
 * WHAT THIS IS NOT. It is a list of NAMES, never of bytes, and it grants nothing: every path it returns is re-gated by
 * the read that follows. The secret rule runs here anyway, because a name like `deploy/prod.pem` is itself worth
 * withholding.
 */

/**
 * The bounds on ONE whole-tree index, so a search over a large tree costs a known amount.
 *
 * A working tree has no upper size, and an index read is the one call that walks all of it. Every bound reports itself
 * as a `truncated` skip and downgrades coverage rather than silently returning a short list, because a short list
 * nobody was told about reads as "that file does not exist".
 *
 * The file count is generous on purpose: it is a name and a basename per row, so twenty thousand of them is a few
 * hundred kilobytes. The candidate count prevents ignored, excluded, missing or unsupported entries from making the
 * daemon inspect an arbitrarily larger set just to find those files. The directory count bounds a NON-repository walk,
 * which is the only path that opens one descriptor per directory; a Git worktree asks Git once whatever its depth. The
 * byte cap bounds that answer's size.
 */
export const MAX_INDEX_FILES = 20_000;
export const MAX_INDEX_CANDIDATES = 40_000;
export const MAX_INDEX_DIRECTORIES = 4_000;
export const MAX_INDEX_LIST_BYTES = 8 * 1024 * 1024;

/**
 * The same bounds at PROJECT scale (&F6061 U5): a project holds many repositories, so its finder keeps 2.5× the files a
 * ferret's does (owner decision D2), with the candidate ratio the ferret index already uses (2:1). The ceilings are
 * opted into with {@link TreeIndexBounds.scale}; a route that says nothing runs under the ferret ceilings above.
 */
export const MAX_PROJECT_INDEX_FILES = 50_000;
export const MAX_PROJECT_INDEX_CANDIDATES = 100_000;

/** Which ceilings a read runs under, and the order it keeps names in when a ceiling bites. */
export type TreeIndexScale = 'session' | 'project';

/** The most names one folder of a non-repository walk reports; one name past it makes the walk partial. */
export const MAX_INDEX_FOLDER_ENTRIES = 2_000;

/**
 * The WALL-CLOCK bound, which is the only one of these that bounds what a caller actually waits for.
 *
 * The counts above bound how much is looked at; they do not bound how long looking takes. Proving a Git candidate is a
 * current regular file is a component-by-component walk from the pin, so the candidate cap alone admits a request
 * measured in tens of seconds on a large monorepo — and the server closes an idle connection at thirty, which turns an
 * answer this schema has exact words for (`coverage: 'partial'`) into a dropped socket the client can say nothing about.
 * Fifteen seconds leaves the response room to be built and written inside that window. It is a budget for the WHOLE
 * call, because a per-operation timeout multiplied by an unbounded operation count is not a bound at all.
 */
export const MAX_INDEX_WALL_MS = 15_000;

/**
 * How much of a tree one index read may look at, and for how long.
 *
 * Tests narrow these; a route narrows nothing and supplies only the caller's `signal`, so the shipped surface always
 * runs under the full defaults.
 */
export interface TreeIndexBounds {
  readonly maxFiles?: number;
  readonly maxCandidates?: number;
  readonly maxDirectories?: number;
  /** Wall-clock budget for the WHOLE read. Defaults to {@link MAX_INDEX_WALL_MS}. */
  readonly budgetMs?: number;
  /** The caller's cancellation. A client that hung up is work nobody will read. */
  readonly signal?: AbortSignal;
  /**
   * The read is made on an agent's behalf: every name that never passes through the held root's own walk (the walk's
   * children, Git's names) is asked of the root's state-home verdict first. A root that cannot answer fences every name.
   */
  readonly fenced?: boolean;
  /**
   * The ceilings a bound may be raised to, and the order names survive a ceiling in. `'session'` (the default) is a
   * ferret's: path order. `'project'` keeps SHALLOW FIRST — fewest folders, then path — so a bound that bites drops
   * `a/very/deep/file` before `README.md`.
   */
  readonly scale?: TreeIndexScale;
}

/**
 * Does any segment of this path name a secret by the ONE shared rule (`secret-names.ts` in `@ferretry/std`)?
 *
 * This is the contract's own floor and it is unconditional: it is applied to every name an index returns and to the
 * root's own real path, whatever a caller's {@link TreePolicy} says. A caller cannot lower it by handing in a lax
 * policy, which is the point of owning it here rather than asking each caller for it.
 */
export function isSharedSecretPath(rel: string): boolean {
  return rel.split('/').some(segment => segment !== '' && (isSecretFileName(segment) || isSecretFolderName(segment)));
}

/**
 * The root a tree index was asked to read is itself a key store or a secret name (`~/.ssh`, a folder called `.env`).
 *
 * Every name beneath such a root is innocent when judged relative to it, so the root is refused before anything under it
 * is asked. The caller maps this to its own refusal.
 */
export class TreeRootDeniedError extends Error {
  constructor() {
    super('the folder is a secret store and is not indexed');
    this.name = 'TreeRootDeniedError';
  }
}

/**
 * The caller's secret-name rule, which is ADDITIVE to {@link isSharedSecretPath}.
 *
 * Two functions, because there are two questions a name meets: is it spelled as something no read route would accept,
 * and does the caller withhold it beyond the shared rule (a ferret's own `.git` and `node_modules`, for one). A caller
 * that withholds nothing extra passes `() => false`; it never has to restate the shared secret names, and could not
 * remove them by trying.
 */
export interface TreePolicy {
  /** The syntactic gate a read route applies: forward slashes, no `..`, no control characters. Throws on a bad path. */
  normalize(rel: string): string;
  /** Is this path withheld by the caller's own rule, in addition to the shared secret names? */
  isDenied(rel: string): boolean;
}

/** Is this name withheld: by the shared secret rule, or by anything the caller adds. */
function isWithheld(policy: TreePolicy, rel: string): boolean {
  return isSharedSecretPath(rel) || policy.isDenied(rel);
}

/** The held root an index reads: the kernel's pin, plus its optional state-home verdict. */
export type TreeRoot = PinnedRoot & {
  fenced?(rels: readonly string[]): Promise<readonly boolean[]>;
};

/** What an index needs from the outside besides the root: Git, the secret rule and a clock. */
export interface TreeIndexDeps {
  readonly git: Pick<TreeGit, 'isInsideWorkTree' | 'listFiles'>;
  readonly policy: TreePolicy;
  /** The clock, injected so a deadline can be proven without waiting for one. */
  readonly nowMs: () => number;
}

/**
 * How many tracked names one probe call proves before the event loop is handed back.
 *
 * The probe is synchronous where the platform is (macOS), so this is the longest any index can hold the loop: a few
 * hundred metadata calls, rather than one turn for the whole tree — which on a host whose endpoint security intercepts
 * every call was a ten-second stall of every timer in the daemon.
 */
const INDEX_PROBE_BATCH = 256;

/**
 * Roots a filename search never enters, even when they are not ignored.
 *
 * This is intentionally INDEX policy rather than the filesystem denylist: a person may explicitly open an ordinary
 * source-map under `dist`, while putting every generated artifact into a global search makes that search slower and
 * noisier. Secret-like basenames still go through {@link TreePolicy.isDenied}; Git's own ignore rules are applied before
 * this list by `git ls-files --exclude-standard`.
 */
const INDEX_EXCLUDED_DIRECTORIES = new Set([
  '.cache',
  '.git',
  '.gradle',
  '.hg',
  '.next',
  '.svn',
  '.terraform',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'generated',
  'node_modules',
  'out',
  'target',
  'vendor',
  'venv',
]);

/** Is any component an explicitly noisy index root? Exported so a project's own folder walk applies the SAME list. */
export function isIndexExcludedPath(rel: string): boolean {
  return rel.split('/').some(segment => INDEX_EXCLUDED_DIRECTORIES.has(segment.toLowerCase()));
}

/** Locale-independent byte-order spelling for deterministic traversal and response order. */
function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** How many folders deep a root-relative file path sits (`README.md` is 0). */
function folderDepth(rel: string): number {
  let depth = 0;
  for (const character of rel) if (character === '/') depth += 1;
  return depth;
}

/**
 * The project order: fewest folders first, then byte order. Exported so the merge of several reads keeps the same order
 * each one kept its own names in.
 */
export function compareShallowFirst(left: string, right: string): number {
  return folderDepth(left) - folderDepth(right) || comparePath(left, right);
}

/** Test-only narrowed bounds still have to be real bounds. */
function indexLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > fallback) {
    throw new RangeError(`${label} must be a non-negative safe integer no larger than ${fallback}`);
  }
  return limit;
}

/** The four limits of one read, each proved a real bound, and the order its names are kept in. */
function resolveBounds(bounds: TreeIndexBounds): {
  readonly maxFiles: number;
  readonly maxCandidates: number;
  readonly maxDirectories: number;
  readonly budgetMs: number;
  readonly order: (left: string, right: string) => number;
} {
  const project = bounds.scale === 'project';
  return {
    maxFiles: indexLimit(bounds.maxFiles, project ? MAX_PROJECT_INDEX_FILES : MAX_INDEX_FILES, 'index file limit'),
    maxCandidates: indexLimit(
      bounds.maxCandidates,
      project ? MAX_PROJECT_INDEX_CANDIDATES : MAX_INDEX_CANDIDATES,
      'index candidate limit',
    ),
    maxDirectories: indexLimit(bounds.maxDirectories, MAX_INDEX_DIRECTORIES, 'index directory limit'),
    budgetMs: indexLimit(bounds.budgetMs, MAX_INDEX_WALL_MS, 'index time budget'),
    order: project ? compareShallowFirst : comparePath,
  };
}

/**
 * Throws a `RangeError` when a bound is not a real one. A caller that pins first calls this BEFORE pinning, so a bad
 * bound never holds a descriptor or asks Git anything.
 */
export function checkTreeIndexBounds(bounds: TreeIndexBounds): void {
  resolveBounds(bounds);
}

/** What one index read left out, counted while it happens and turned into rows only at the end. */
export type SkipTally = Map<SessionFileIndexSkipReason, number>;

/** Records `amount` more omissions for one reason. A zero is not an omission and never becomes a row. */
export function tally(skips: SkipTally, reason: SessionFileIndexSkipReason, amount: number): void {
  if (amount <= 0) return;
  skips.set(reason, (skips.get(reason) ?? 0) + amount);
}

/** The tally as the total record the wire carries. */
export function skipRecord(skips: SkipTally): SessionFileIndexSkip[] {
  return SessionFileIndexSkipReasonSchema.options.flatMap(reason => {
    const count = skips.get(reason);
    return count === undefined ? [] : [{ reason, count }];
  });
}

/** Only a bound biting or a subtree we could not read means the walk itself did not finish. */
export function coverageOf(skips: SkipTally): SessionFileIndexCoverage {
  return skips.has('unreadable') || skips.has('truncated') ? 'partial' : 'complete';
}

/** Sort the fully inspected rows before applying the response bound, and record every omitted row. */
function boundedIndexFiles(
  files: readonly SessionFileIndexEntry[],
  maxFiles: number,
  skips: SkipTally,
  order: (left: string, right: string) => number,
): SessionFileIndexEntry[] {
  const sorted = [...files].sort((left, right) => order(left.path, right.path));
  tally(skips, 'truncated', sorted.length - maxFiles);
  return sorted.slice(0, maxFiles);
}

/**
 * One indexed row, or `undefined` for a path no read route would accept anyway.
 *
 * Everything that reaches an index is re-validated by the SAME syntactic gate the read routes apply, so an index can
 * never offer a row that answers 400 when a reader opens it. A filename holding a control character or a backslash is
 * legal on disk and is exactly such a row.
 */
function indexEntry(policy: TreePolicy, rel: string): SessionFileIndexEntry | undefined {
  let normalized: string;
  try {
    normalized = policy.normalize(rel);
  } catch {
    return undefined;
  }
  const name = normalized.split('/').at(-1) ?? '';
  const parsed = SessionFileIndexEntrySchema.safeParse({ path: normalized, name });
  return parsed.success ? parsed.data : undefined;
}

/**
 * The names an agent may not be told of, asked of the held root's verdict: none for a person. A root that cannot
 * answer fences every name, so a pin without a verdict closes the surface rather than opening it.
 */
async function fencedNames(
  fenced: boolean | undefined,
  pinned: TreeRoot,
  rels: readonly string[],
): Promise<ReadonlySet<string>> {
  if (fenced !== true || rels.length === 0) return new Set();
  if (pinned.fenced === undefined) return new Set(rels);
  const verdicts = await pinned.fenced(rels);
  return new Set(rels.filter((_, index) => verdicts[index] !== false));
}

/**
 * A deadline and a caller's cancellation, asked as one question.
 *
 * Both mean the same thing to every loop below — stop starting things — so they are one predicate rather than two
 * checks that could disagree about which one fired. The clock is read through the injected reader so a test can expire
 * a budget deterministically instead of sleeping.
 */
class IndexBudget implements SpawnBudget {
  private readonly deadlineMs: number;

  constructor(
    private readonly nowMs: () => number,
    budgetMs: number,
    private readonly signal: AbortSignal | undefined,
  ) {
    this.deadlineMs = nowMs() + budgetMs;
  }

  expired(): boolean {
    return this.signal?.aborted === true || this.nowMs() >= this.deadlineMs;
  }

  /**
   * What is left for a child this call is about to start — zero exactly when {@link expired} is true.
   *
   * A caller who has hung up has no time left, not merely a deadline that has not arrived yet. Saying otherwise would
   * let an implementation that bounds a spawn by this number alone start one for nobody.
   */
  remainingMs(): number {
    if (this.signal?.aborted === true) return 0;
    return Math.max(0, this.deadlineMs - this.nowMs());
  }
}

/**
 * Every file under the held root a read could serve, in ONE answer, with what it left out.
 *
 * The CALLER pins the root (it knows whose read this is and which fence applies) and closes it afterwards; what comes
 * back says `root` as pinned, never as configured.
 *
 * A refusal is a COUNTED ROW here, never the answer: a client that wants to search filenames used to walk the tree
 * itself and, meeting a 403 in the first listing of any Git checkout, reported the whole session as having no files.
 */
export async function indexPinnedTree(
  pinned: TreeRoot,
  deps: TreeIndexDeps,
  bounds: TreeIndexBounds = {},
): Promise<SessionFileIndex> {
  const { maxFiles, maxCandidates, maxDirectories, budgetMs, order } = resolveBounds(bounds);
  // First, before any budget answer: a root that is a key store is refused whatever the caller's policy or fence says.
  // The pinned REAL path is judged, so a symlink to a key store cannot launder it.
  if (isSharedSecretPath(pinned.rootReal.split('/').filter(Boolean).join('/'))) throw new TreeRootDeniedError();
  const budget = new IndexBudget(deps.nowMs, budgetMs, bounds.signal);
  const skips: SkipTally = new Map();
  // A caller who has already gone away gets the shape of an answer and none of the work. The pin is still taken,
  // because `root` is a fact about the root that only the pin can state, and it is one open-and-close rather than a
  // tree walk. Nothing beneath it is asked anything.
  if (budget.expired()) {
    tally(skips, 'truncated', 1);
    return { root: pinned.rootReal, files: [], coverage: coverageOf(skips), skipped: skipRecord(skips) };
  }
  // Deliberately NOT caught: a worktree whose ignore rules cannot be established must not fall back to the walk,
  // because that walk would enumerate exactly the directories the ignore gate closes. Given the remaining budget
  // because this asks Git too, and a bound that only covered the reads AFTER it would be a bound on the cheaper half.
  const inside = await deps.git.isInsideWorkTree(pinned.policyCwd, budget);
  // Asked again before anything else starts. An abort that landed while Git was answering must not be the reason a NEW
  // child is spawned; what it cannot do is reach into one already running.
  if (budget.expired()) {
    tally(skips, 'truncated', 1);
    return { root: pinned.rootReal, files: [], coverage: coverageOf(skips), skipped: skipRecord(skips) };
  }
  const files = inside
    ? await indexTracked(pinned, deps, maxFiles, maxCandidates, skips, budget, order)
    : await indexWalk(pinned, deps, maxFiles, maxCandidates, maxDirectories, skips, budget, bounds.fenced, order);
  return { root: pinned.rootReal, files, coverage: coverageOf(skips), skipped: skipRecord(skips) };
}

/**
 * A Git worktree's index: one command, then the denylist over what it named.
 *
 * A failure to ask Git is recorded as `unreadable` rather than raised. The caller asked "what can I search here", and
 * the honest answer to a broken interrogation is an empty PARTIAL index — a 403 would be the client's cue to render "no
 * files", which is the defect this whole function replaces.
 */
async function indexTracked(
  pinned: TreeRoot,
  deps: TreeIndexDeps,
  maxFiles: number,
  maxCandidates: number,
  skips: SkipTally,
  budget: SpawnBudget,
  order: (left: string, right: string) => number,
): Promise<SessionFileIndexEntry[]> {
  const { policy } = deps;
  let listed: Awaited<ReturnType<TreeIndexDeps['git']['listFiles']>>;
  try {
    // Git gets what is left of the whole call, not a timeout of its own: a child allowed to run for longer than the
    // answer is worth would spend the budget the walk after it still has to fit in.
    listed = await deps.git.listFiles(pinned.policyCwd, MAX_INDEX_LIST_BYTES, budget);
  } catch {
    tally(skips, 'unreadable', 1);
    return [];
  }

  const candidates = [...new Set(listed.paths)].sort(order);
  const files: SessionFileIndexEntry[] = [];
  let denied = 0;
  let excluded = 0;
  let unsupported = 0;
  let overflow = listed.truncated ? 1 : 0;
  if (candidates.length > maxCandidates) overflow += candidates.length - maxCandidates;
  const considered = candidates.slice(0, maxCandidates);
  // `git ls-files --cached` can name a deleted file and either half can be a symlink. The pinned walk is therefore the
  // final authority, never Git's pathname — asked through ONE probe, so the directories it walks are walked once for
  // every file beneath them rather than once per file.
  const probe = pinned.probe();
  try {
    let position = 0;
    while (position < considered.length) {
      // `maxFiles` belongs here rather than only in the response bound: the candidates are already in the
      // comparator's order, so once that many rows are accepted every remaining one sorts after all of them and would
      // be sliced off after being proved for nothing.
      if (files.length >= maxFiles) {
        overflow += considered.length - position;
        break;
      }
      // The cheap refusals are pure and cost nothing to ask, so they are settled while the batch is gathered. A batch
      // never asks for more than the response still has room for.
      const batch: SessionFileIndexEntry[] = [];
      const room = Math.min(INDEX_PROBE_BATCH, maxFiles - files.length);
      while (position < considered.length && batch.length < room) {
        const path = considered[position] ?? '';
        position += 1;
        if (isIndexExcludedPath(path)) {
          excluded += 1;
          continue;
        }
        if (isWithheld(policy, path)) {
          denied += 1;
          continue;
        }
        const entry = indexEntry(policy, path);
        // The gates are asked again of the name the walk will prove, because normalising is what could turn an
        // innocent spelling into a gated one.
        if (entry === undefined || isIndexExcludedPath(entry.path) || isWithheld(policy, entry.path)) unsupported += 1;
        else batch.push(entry);
      }
      if (batch.length === 0) continue;
      let kinds: readonly PinnedFileKind[];
      try {
        kinds = await probe.classify(
          batch.map(entry => entry.path),
          budget,
        );
      } catch {
        // A probe that cannot answer at all proved none of these names; it says nothing about the next.
        tally(skips, 'unreadable', batch.length);
        continue;
      }
      for (const [index, kind] of kinds.entries()) {
        const entry = batch[index];
        if (entry === undefined) continue;
        if (kind === 'file') files.push(entry);
        else if (kind === 'unsupported') unsupported += 1;
        else tally(skips, 'unreadable', 1);
      }
      // A short answer is a spent budget. What it never reached and everything after it were not looked at, which is
      // the same position for a reader and so the same word.
      if (kinds.length < batch.length) {
        overflow += batch.length - kinds.length + (considered.length - position);
        break;
      }
    }
  } finally {
    await probe.close();
  }
  tally(skips, 'denied', denied);
  tally(skips, 'excluded', excluded);
  tally(skips, 'unsupported', unsupported);
  tally(skips, 'truncated', overflow);
  return boundedIndexFiles(files, maxFiles, skips, order);
}

/**
 * A non-repository tree's index: a bounded breadth-first walk through the PIN.
 *
 * Every directory is opened from the pinned root by the same component-by-component walk the listing uses, so nothing
 * here escapes the root and no interior symlink is followed. A directory that cannot be opened or enumerated costs its
 * own subtree and NOTHING else — that isolation is the whole reason this is a walk with a tally rather than one
 * `Promise.all` that rejects.
 */
async function indexWalk(
  pinned: TreeRoot,
  deps: TreeIndexDeps,
  maxFiles: number,
  maxCandidates: number,
  maxDirectories: number,
  skips: SkipTally,
  budget: WorkBudget,
  fenced: boolean | undefined,
  order: (left: string, right: string) => number,
): Promise<SessionFileIndexEntry[]> {
  const { policy } = deps;
  const files: SessionFileIndexEntry[] = [];
  const queue: string[] = [''];
  let inspected = 0;
  let visited = 0;
  let denied = 0;
  let excluded = 0;
  let unsupported = 0;
  let unreadable = 0;
  let overflow = 0;

  walk: while (true) {
    const rel = queue.shift();
    if (rel === undefined) break;
    if (visited >= maxDirectories || budget.expired()) {
      // This directory plus everything still queued behind it. A floor, not a total: what those directories hold is
      // exactly what was not looked at. A spent budget stops here for the same reason a spent directory count does,
      // and says so in the same word.
      overflow += 1 + queue.length;
      break;
    }
    visited += 1;

    let target: PinnedTarget;
    try {
      target = await pinned.open(rel, { wantDirectory: true });
    } catch {
      unreadable += 1;
      continue;
    }
    try {
      const listing = await target.list(MAX_INDEX_FOLDER_ENTRIES, budget);
      if (listing.truncated) overflow += 1;
      const children = [...listing.entries].sort((left, right) => comparePath(left.name, right.name));
      const childRelOf = (name: string): string => (rel === '' ? name : `${rel}/${name}`);
      const fencedChildren = await fencedNames(
        fenced,
        pinned,
        children.map(child => childRelOf(child.name)),
      );
      for (const child of children) {
        if (inspected >= maxCandidates || budget.expired()) {
          // A floor: the current entry exists, and the queue proves more work may remain.
          overflow += 1;
          break walk;
        }
        inspected += 1;
        const childRel = childRelOf(child.name);
        if (isIndexExcludedPath(childRel)) {
          excluded += 1;
          continue;
        }
        if (isWithheld(policy, childRel) || fencedChildren.has(childRel)) {
          denied += 1;
          continue;
        }
        // A symlink is never served by this viewer at any depth, so indexing one would offer a row that cannot be
        // opened; an escaping one would also name a path outside the root.
        if (child.escapes || child.type === 'symlink') {
          unsupported += 1;
          continue;
        }
        if (child.type === 'dir') {
          queue.push(childRel);
          continue;
        }
        const entry = indexEntry(policy, childRel);
        if (entry === undefined) {
          unsupported += 1;
          continue;
        }
        files.push(entry);
      }
    } catch {
      unreadable += 1;
    } finally {
      await target.close();
    }
  }

  tally(skips, 'denied', denied);
  tally(skips, 'excluded', excluded);
  tally(skips, 'unsupported', unsupported);
  tally(skips, 'unreadable', unreadable);
  tally(skips, 'truncated', overflow);
  return boundedIndexFiles(files, maxFiles, skips, order);
}
