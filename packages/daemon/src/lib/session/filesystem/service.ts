import {
  SessionFileIndexEntrySchema,
  SessionFileIndexSkipReasonSchema,
  type SessionFileIndex,
  type SessionFileIndexCoverage,
  type SessionFileIndexEntry,
  type SessionFileIndexSkip,
  type SessionFileIndexSkipReason,
} from '@ferretry/protocol';
import { gateCandidates, isDeniedPath, looksBinary, normalizeRelativePath } from './path-policy.ts';
import type {
  AfterValidationHook,
  ComponentIdentity,
  PinnedOpenOptions,
  PinnedRoot,
  PinnedTarget,
  SessionChangesView,
  SessionGit,
  SessionRootPinner,
} from './ports.ts';
import {
  type FsDiffView,
  type FsEntry,
  FsError,
  type FsFileView,
  type FsListing,
  MAX_DIFF_SIDE_BYTES,
  MAX_FILE_BYTES,
  MAX_INDEX_CANDIDATES,
  MAX_INDEX_DIRECTORIES,
  MAX_INDEX_FILES,
  MAX_INDEX_LIST_BYTES,
  MAX_LISTING_ENTRIES,
  type ResolvedTarget,
} from './types.ts';

/** How much of a tree one index read may look at. Tests narrow these; a route never does. */
export interface IndexBounds {
  readonly maxFiles?: number;
  readonly maxCandidates?: number;
  readonly maxDirectories?: number;
}

/**
 * Roots a filename search never enters, even when they are not ignored.
 *
 * This is intentionally INDEX policy rather than the filesystem denylist: a person may explicitly open
 * an ordinary source-map under `dist`, while putting every generated artifact into a global search makes
 * that search slower and noisier. Secret-like basenames still go through {@link isDeniedPath}; Git's own
 * ignore rules are applied before this list by `git ls-files --exclude-standard`.
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

/** Is any component an explicitly noisy index root? */
function isIndexExcludedPath(rel: string): boolean {
  return rel.split('/').some(segment => INDEX_EXCLUDED_DIRECTORIES.has(segment.toLowerCase()));
}

/** Locale-independent byte-order spelling for deterministic traversal and response order. */
function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Test-only narrowed bounds still have to be real bounds. */
function indexLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > fallback) {
    throw new RangeError(`${label} must be a non-negative safe integer no larger than ${fallback}`);
  }
  return limit;
}

/** What one index read left out, counted while it happens and turned into rows only at the end. */
type SkipTally = Map<SessionFileIndexSkipReason, number>;

/** Records `amount` more omissions for one reason. A zero is not an omission and never becomes a row. */
function tally(skips: SkipTally, reason: SessionFileIndexSkipReason, amount: number): void {
  if (amount <= 0) return;
  skips.set(reason, (skips.get(reason) ?? 0) + amount);
}

/** The tally as the total record the wire carries. */
function skipRecord(skips: SkipTally): SessionFileIndexSkip[] {
  return SessionFileIndexSkipReasonSchema.options.flatMap(reason => {
    const count = skips.get(reason);
    return count === undefined ? [] : [{ reason, count }];
  });
}

/** Only a bound biting or a subtree we could not read means the walk itself did not finish. */
function coverageOf(skips: SkipTally): SessionFileIndexCoverage {
  return skips.has('unreadable') || skips.has('truncated') ? 'partial' : 'complete';
}

/** Sort the fully inspected rows before applying the response bound, and record every omitted row. */
function boundedIndexFiles(
  files: readonly SessionFileIndexEntry[],
  maxFiles: number,
  skips: SkipTally,
): SessionFileIndexEntry[] {
  const sorted = [...files].sort((left, right) => comparePath(left.path, right.path));
  tally(skips, 'truncated', sorted.length - maxFiles);
  return sorted.slice(0, maxFiles);
}

/**
 * One indexed row, or `undefined` for a path no read route would accept anyway.
 *
 * Everything that reaches an index is re-validated by the SAME syntactic gate the read routes apply, so
 * an index can never offer a row that answers 400 when a reader opens it. A filename holding a control
 * character or a backslash is legal on disk and is exactly such a row.
 */
function indexEntry(rel: string): SessionFileIndexEntry | undefined {
  let normalized: string;
  try {
    normalized = normalizeRelativePath(rel);
  } catch {
    return undefined;
  }
  const name = normalized.split('/').at(-1) ?? '';
  const parsed = SessionFileIndexEntrySchema.safeParse({ path: normalized, name });
  return parsed.success ? parsed.data : undefined;
}

/** A Git candidate that is absent or not an ordinary current file is safely unsupported, not unreadable. */
function unsupportedCandidate(error: unknown): boolean {
  return (
    error instanceof FsError && ['not_found', 'not_a_directory', 'not_a_file', 'escapes_root'].includes(error.code)
  );
}

/**
 * Read-only working-tree access for ONE session, rooted at its own cwd.
 *
 * Every method follows the same shape: pin the root, validate the request syntactically, walk to the
 * target by descriptor, run the secrets gates on every path that names the resulting bytes, prove the
 * walk still describes those bytes, and only then serve. The gates are re-run on both sides of the walk
 * and a refusal from EITHER side wins, because the first verdict belongs to the object named when the
 * request began and the second belongs to whatever the name resolves to afterwards.
 *
 * The service is stateless and takes both capabilities by constructor injection, so one instance serves
 * every session and every daemon: the pinned root is derived from the cwd handed to each call and never
 * cached. There is deliberately no memoisation anywhere in this subsystem — a cache keyed by anything
 * short of "this descriptor, right now" would serve one tree's bytes for another tree's request, which
 * is the exact failure the pin exists to prevent.
 */
export class SessionFilesystem {
  constructor(
    private readonly pinner: SessionRootPinner,
    private readonly git: SessionGit,
  ) {}

  /** The session root, freshly resolved. A since-deleted worktree is a clean `not_found`. */
  async resolveRoot(cwd: string): Promise<string> {
    const pinned = await this.pinner.pin(cwd);
    try {
      return pinned.rootReal;
    } finally {
      await pinned.close();
    }
  }

  /** Does this cwd sit in a Git worktree? A `false` hides every diff affordance in a client. */
  async isRepo(cwd: string): Promise<boolean> {
    const pinned = await this.pinner.pin(cwd);
    try {
      return (await this.git.repoInfo(pinned.policyCwd)).repo;
    } finally {
      await pinned.close();
    }
  }

  /** Changes under the session cwd, reported against the PINNED tree. Non-Git cwd gives `repo: false`. */
  async changes(cwd: string): Promise<SessionChangesView> {
    const pinned = await this.pinner.pin(cwd);
    try {
      return await this.git.changes(pinned.policyCwd);
    } finally {
      await pinned.close();
    }
  }

  /**
   * Every file under the session root a read could serve, in ONE answer, with what it left out.
   *
   * WHY THIS EXISTS AT ALL. A client that wants to search filenames used to walk the tree itself, one
   * HTTP call per directory, and the daemon refuses to enumerate `.git`, `node_modules` and every
   * gitignored directory — so the client met a 403 in the FIRST listing of any Git checkout and, having
   * no way to tell "this subtree is closed" from "this read failed", reported the whole session as
   * having no files. The inversion is the point: a refusal is a COUNTED ROW here, never the answer.
   *
   * WHY A REPOSITORY IS ONE COMMAND AND EVERYTHING ELSE IS A WALK. Inside a worktree, `--exclude-standard`
   * is the gitignore rule applied by the tool that defines it, in a single answer whatever the tree's
   * depth — which is both the right owner and the difference between one round trip and thousands.
   * Outside one there is no ignore rule to honour, so a bounded descriptor walk is both cheaper and
   * safer than asking Git about a directory that is not in a repository at all.
   *
   * WHAT THIS IS NOT. It is a list of NAMES, never of bytes, and it grants nothing: every path it
   * returns is re-gated by {@link SessionFilesystem.readFile} before a single byte is served. The
   * denylist runs here anyway, because a name like `deploy/prod.pem` is itself worth withholding.
   */
  async index(cwd: string, bounds: IndexBounds = {}): Promise<SessionFileIndex> {
    const maxFiles = indexLimit(bounds.maxFiles, MAX_INDEX_FILES, 'index file limit');
    const maxCandidates = indexLimit(bounds.maxCandidates, MAX_INDEX_CANDIDATES, 'index candidate limit');
    const maxDirectories = indexLimit(bounds.maxDirectories, MAX_INDEX_DIRECTORIES, 'index directory limit');
    const pinned = await this.pinner.pin(cwd);
    try {
      const skips: SkipTally = new Map();
      // Deliberately NOT caught: a worktree whose ignore rules cannot be established must not fall back
      // to the walk, because that walk would enumerate exactly the directories the ignore gate closes.
      const repo = await this.git.repoInfo(pinned.policyCwd);
      const files = repo.repo
        ? await this.indexTracked(pinned, maxFiles, maxCandidates, skips)
        : await this.indexWalk(pinned, maxFiles, maxCandidates, maxDirectories, skips);
      return { root: pinned.rootReal, files, coverage: coverageOf(skips), skipped: skipRecord(skips) };
    } finally {
      await pinned.close();
    }
  }

  /**
   * A Git worktree's index: one command, then the denylist over what it named.
   *
   * A failure to ask Git is recorded as `unreadable` rather than raised. The caller asked "what can I
   * search here", and the honest answer to a broken interrogation is an empty PARTIAL index — a 403
   * would be the client's cue to render "no files", which is the defect this whole method replaces.
   */
  private async indexTracked(
    pinned: PinnedRoot,
    maxFiles: number,
    maxCandidates: number,
    skips: SkipTally,
  ): Promise<SessionFileIndexEntry[]> {
    let listed: Awaited<ReturnType<SessionGit['listFiles']>>;
    try {
      listed = await this.git.listFiles(pinned.policyCwd, MAX_INDEX_LIST_BYTES);
    } catch {
      tally(skips, 'unreadable', 1);
      return [];
    }

    const candidates = [...new Set(listed.paths)].sort(comparePath);
    const files: SessionFileIndexEntry[] = [];
    let denied = 0;
    let excluded = 0;
    let unsupported = 0;
    let overflow = listed.truncated ? 1 : 0;
    if (candidates.length > maxCandidates) overflow += candidates.length - maxCandidates;
    for (const path of candidates.slice(0, maxCandidates)) {
      if (isIndexExcludedPath(path)) {
        excluded += 1;
        continue;
      }
      if (isDeniedPath(path)) {
        denied += 1;
        continue;
      }
      const entry = indexEntry(path);
      if (entry === undefined) {
        unsupported += 1;
        continue;
      }
      let target: PinnedTarget;
      try {
        // `git ls-files --cached` can name a deleted file and either half can be a symlink. The same
        // descriptor-confined walk as a read is therefore the final authority, never Git's pathname.
        target = await pinned.open(entry.path);
      } catch (error) {
        if (unsupportedCandidate(error)) unsupported += 1;
        else tally(skips, 'unreadable', 1);
        continue;
      }
      try {
        if (
          target.metadata.type !== 'file' ||
          target.canonical !== entry.path ||
          isIndexExcludedPath(target.canonical) ||
          isDeniedPath(target.canonical)
        ) {
          unsupported += 1;
          continue;
        }
        files.push(entry);
      } finally {
        await target.close();
      }
    }
    tally(skips, 'denied', denied);
    tally(skips, 'excluded', excluded);
    tally(skips, 'unsupported', unsupported);
    tally(skips, 'truncated', overflow);
    return boundedIndexFiles(files, maxFiles, skips);
  }

  /**
   * A non-repository tree's index: a bounded breadth-first walk through the PIN.
   *
   * Every directory is opened from the pinned root by the same component-by-component walk the listing
   * uses, so nothing here escapes the session folder and no interior symlink is followed. A directory
   * that cannot be opened or enumerated costs its own subtree and NOTHING else — that isolation is the
   * whole reason this is a walk with a tally rather than one `Promise.all` that rejects.
   */
  private async indexWalk(
    pinned: PinnedRoot,
    maxFiles: number,
    maxCandidates: number,
    maxDirectories: number,
    skips: SkipTally,
  ): Promise<SessionFileIndexEntry[]> {
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
      if (visited >= maxDirectories) {
        // This directory plus everything still queued behind it. A floor, not a total: what those
        // directories hold is exactly what was not looked at.
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
        const listing = await target.list(MAX_LISTING_ENTRIES);
        if (listing.truncated) overflow += 1;
        const children = [...listing.entries].sort((left, right) => comparePath(left.name, right.name));
        for (const child of children) {
          if (inspected >= maxCandidates) {
            // A floor: the current entry exists, and the queue proves more work may remain.
            overflow += 1;
            break walk;
          }
          inspected += 1;
          const childRel = rel === '' ? child.name : `${rel}/${child.name}`;
          if (isIndexExcludedPath(childRel)) {
            excluded += 1;
            continue;
          }
          if (isDeniedPath(childRel)) {
            denied += 1;
            continue;
          }
          // A symlink is never served by this viewer at any depth, so indexing one would offer a row
          // that cannot be opened; an escaping one would also name a path outside the session folder.
          if (child.escapes || child.type === 'symlink') {
            unsupported += 1;
            continue;
          }
          if (child.type === 'dir') {
            queue.push(childRel);
            continue;
          }
          const entry = indexEntry(childRel);
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
    return boundedIndexFiles(files, maxFiles, skips);
  }

  /**
   * Resolve a validated relative path inside the root, via the pinned walk.
   *
   * For callers that only want the location. Any symlinked component raises `not_a_file` or
   * `escapes_root`.
   */
  async resolve(cwd: string, relativePath: string | undefined): Promise<ResolvedTarget> {
    const pinned = await this.pinner.pin(cwd);
    try {
      const rootReal = pinned.rootReal;
      const rel = normalizeRelativePath(relativePath);
      if (rel === '') return { rootReal, rel, absolute: rootReal };

      const opened = await pinned.open(rel);
      try {
        return { rootReal, rel, absolute: `${rootReal}/${opened.canonical}` };
      } finally {
        await opened.close();
      }
    } finally {
      await pinned.close();
    }
  }

  /** One level of a directory: directories first, then files, each name once. */
  async list(
    cwd: string,
    relativePath?: string,
    options: { readonly afterValidation?: AfterValidationHook } = {},
  ): Promise<FsListing> {
    const pinned = await this.pinner.pin(cwd);
    try {
      return await this.listPinned(pinned, relativePath, options);
    } finally {
      await pinned.close();
    }
  }

  /**
   * Read one file from the working tree, or from `HEAD` with `rev: 'head'`.
   *
   * Size is checked before any read rather than stream-then-truncate, so a two-gigabyte file costs a
   * `stat`. Both gates run before the bytes are touched, and a `HEAD` read passes through the same
   * gates — the point of the denylist is not "the working copy is secret", it is "these bytes never
   * leave the machine".
   */
  async readFile(
    cwd: string,
    relativePath: string,
    options: {
      readonly rev?: 'head';
      /** Return the bounded, policy-gated bytes as base64 rather than decoding them as text. */
      readonly base64?: boolean;
      readonly maxBytes?: number;
      /** @internal Test-only barrier; see {@link AfterValidationHook}. */
      readonly afterValidation?: AfterValidationHook;
    } = {},
  ): Promise<FsFileView> {
    const maxBytes = options.maxBytes ?? MAX_FILE_BYTES;
    const pinned = await this.pinner.pin(cwd);
    try {
      const rel = normalizeRelativePath(relativePath);
      if (rel === '') throw new FsError('invalid_path', 'a file path is required');
      return options.rev === 'head'
        ? await this.readHead(pinned, rel, maxBytes, options.base64)
        : await this.readWorking(pinned, rel, maxBytes, options.afterValidation, options.base64);
    } finally {
      await pinned.close();
    }
  }

  /**
   * Unified diff for one path, behind the same two gates as content — a diff of a secret is a secret.
   *
   * A DELETED file is the common case that must still work: it is exactly what a Changes list shows a
   * ` D` row for, and it no longer exists on disk, so requiring the walk to succeed would 404 every
   * deletion. The path is therefore walked when it exists (full containment) and otherwise admitted only
   * when Git confirms it is tracked in this cwd — itself a containment proof, since the index is queried
   * with literal pathspecs relative to the session cwd. An arbitrary missing path still 404s.
   */
  async diff(
    cwd: string,
    relativePath: string,
    options: {
      /** @internal Test-only barrier; see {@link AfterValidationHook}. */
      readonly afterValidation?: AfterValidationHook;
    } = {},
  ): Promise<FsDiffView> {
    const pinned = await this.pinner.pin(cwd);
    try {
      const rel = normalizeRelativePath(relativePath);
      if (rel === '') throw new FsError('invalid_path', 'a file path is required');

      // The same two-sided policy binding as readFile. Do not return early on a refusal yet: retaining
      // the pre-walk verdict while the deterministic hook swaps the parent is what proves an ignored
      // original cannot be laundered by an unignored replacement.
      const refusalBeforeOpen = await this.refusalFor(pinned, rel);
      const opened = await this.openForDiff(pinned, rel);
      try {
        return await this.renderDiff(pinned, rel, opened, refusalBeforeOpen, options.afterValidation);
      } finally {
        await opened?.close();
      }
    } finally {
      await pinned.close();
    }
  }

  /**
   * Walk to the working-tree side of a diff, tolerating only its absence.
   *
   * A missing path is the deleted-file case the Changes list depends on, and the index answers for it.
   * Every other refusal — a symlinked component, a denied root, a directory where a file was asked for —
   * is final.
   */
  private async openForDiff(pinned: PinnedRoot, rel: string): Promise<PinnedTarget | undefined> {
    let opened: PinnedTarget | undefined;
    try {
      opened = await pinned.open(rel);
      if (opened.metadata.type !== 'file') throw new FsError('not_a_file', `not a regular file: ${rel}`);
      return opened;
    } catch (error) {
      await opened?.close();
      if (error instanceof FsError && error.code === 'not_found') return undefined;
      throw error;
    }
  }

  private async renderDiff(
    pinned: PinnedRoot,
    rel: string,
    opened: PinnedTarget | undefined,
    refusalBeforeOpen: FsFileView | undefined,
    afterValidation: AfterValidationHook | undefined,
  ): Promise<FsDiffView> {
    // The window a name-reopening implementation would lose in: validated, but not yet read.
    await afterValidation?.();

    const tracked = await this.git.isTracked(pinned.policyCwd, rel).catch(() => false);
    const refusal = refusalBeforeOpen ?? (await this.refusalFor(pinned, rel, opened?.canonical));
    if (refusal) {
      // `refusalFor` only ever reports the two content gates; `escapes` is raised as an FsError by the
      // walk, never as a view.
      return refusal.denied
        ? { path: rel, diff: '', kind: 'none', denied: true, reason: 'denylist' }
        : { path: rel, diff: '', kind: 'none', ignored: true, reason: 'ignored' };
    }
    if (opened && !(await this.policyPathUnchanged(pinned, rel, opened.identities))) {
      throw changedDuringPolicy(rel);
    }

    const repo = await this.git.repoInfo(pinned.policyCwd);
    if (!repo.repo) {
      if (!opened) throw new FsError('not_found', `no such path: ${rel}`);
      return { path: rel, diff: '', kind: 'none' };
    }

    // Both sides are bytes WE read: HEAD from the object database, which is content addressed and needs
    // no worktree walk, and the working tree from the descriptor above. Git only formats them. Handing
    // Git the pathname instead is what leaked, because it re-resolves every component at spawn time.
    //
    // Ask HEAD even when the index no longer tracks the path: `git rm` removes it from the index while
    // the Changes list still advertises the staged deletion, and HEAD is the exact old side a reviewer
    // needs.
    const head = await this.git.headEntry(pinned.policyCwd, rel, MAX_DIFF_SIDE_BYTES);
    if (!opened && !tracked && !head) throw new FsError('not_found', `no such path: ${rel}`);
    const working = opened ? await opened.read(MAX_DIFF_SIDE_BYTES) : undefined;
    const kind = tracked || head ? 'tracked' : 'untracked';

    // Either side over the cap: report truncation rather than diffing a partial file, which would render
    // as spurious removals.
    if ((opened && !working) || head?.truncated) return { path: rel, diff: '', kind, truncated: true };

    const executable = ((opened?.metadata.mode ?? 0) & 0o111) !== 0;
    const rendered = await this.git.diffSnapshots(
      rel,
      head ? { bytes: head.bytes, mode: head.mode } : undefined,
      working ? { bytes: working, mode: executable ? 0o100755 : 0o100644 } : undefined,
    );
    return { path: rel, diff: rendered.diff, kind, ...(rendered.truncated ? { truncated: true } : {}) };
  }

  /**
   * Read `HEAD:<rel>`.
   *
   * There is no walk here — a tree read never touches the working copy — so the syntactic gate is what
   * contains it: `HEAD:./../x` really does resolve outside a subdirectory cwd, which is why `..` must
   * already be gone. Git still runs from the PINNED root, so a cwd swapped for a symlink to another
   * repository cannot answer for this one.
   */
  private async readHead(pinned: PinnedRoot, rel: string, maxBytes: number, base64 = false): Promise<FsFileView> {
    const refusalBeforeRead = await this.refusalFor(pinned, rel);
    if (refusalBeforeRead) return { ...refusalBeforeRead, rev: 'head' };

    const blob = await this.git.readHeadBlob(pinned.policyCwd, rel, maxBytes);
    // HEAD bytes come from the pinned object database, but ignore policy is worktree state. Recheck
    // after the read so a path that becomes ignored during the request is never served on the strength
    // of the earlier verdict.
    const refusalAfterRead = await this.refusalFor(pinned, rel);
    if (refusalAfterRead) return { ...refusalAfterRead, rev: 'head' };
    if (!blob) throw new FsError('not_found', `not in HEAD: ${rel}`);
    if (!blob.bytes) return { path: rel, size: blob.size, tooLarge: true, rev: 'head' };
    if (base64) return { path: rel, size: blob.size, base64: Buffer.from(blob.bytes).toString('base64'), rev: 'head' };
    if (looksBinary(blob.bytes)) return { path: rel, size: blob.size, binary: true, rev: 'head' };
    return { path: rel, size: blob.size, content: new TextDecoder().decode(blob.bytes), rev: 'head' };
  }

  private async readWorking(
    pinned: PinnedRoot,
    rel: string,
    maxBytes: number,
    afterValidation: AfterValidationHook | undefined,
    base64 = false,
  ): Promise<FsFileView> {
    // Evaluate policy before the walk and again after it. Retaining both verdicts is what prevents a
    // rename or replacement from evaluating the gate on one tree while the pinned descriptor supplies
    // another tree's bytes.
    const refusalBeforeOpen = await this.refusalFor(pinned, rel);

    // The walk IS the containment proof AND the open: every component is opened no-follow from its
    // already-open parent, and the handle it returns is the object the bytes come from. No pathname is
    // re-walked, so there is no window in which a parent or the root can be substituted.
    const opened = await pinned.open(rel);
    try {
      const metadata = opened.metadata;
      if (metadata.type !== 'file') throw new FsError('not_a_file', `not a regular file: ${rel}`);

      // Validated, not yet read — the window. See AfterValidationHook.
      await afterValidation?.();

      const refusal = refusalBeforeOpen ?? (await this.refusalFor(pinned, rel, opened.canonical));
      if (refusal) return { ...refusal, size: metadata.size, mtime: metadata.mtime };
      if (!(await this.policyPathUnchanged(pinned, rel, opened.identities))) throw changedDuringPolicy(rel);

      const view: FsFileView = { path: rel, size: metadata.size, mtime: metadata.mtime };
      if (metadata.size > maxBytes) return { ...view, tooLarge: true };

      const bytes = await opened.read(maxBytes);
      if (bytes === undefined) return { ...view, tooLarge: true };
      if (base64) return { ...view, base64: Buffer.from(bytes).toString('base64') };
      if (looksBinary(bytes)) return { ...view, binary: true };
      return { ...view, content: new TextDecoder().decode(bytes) };
    } finally {
      await opened.close();
    }
  }

  private async listPinned(
    pinned: PinnedRoot,
    relativePath: string | undefined,
    options: { readonly afterValidation?: AfterValidationHook },
  ): Promise<FsListing> {
    const rel = normalizeRelativePath(relativePath);

    // First half of the policy/object binding. A directory can be renamed away after this check, so the
    // same gate runs again once its descriptor is open; either verdict refuses. That catches both
    // directions of a swap: ignored original to unignored replacement, and the reverse.
    const ignoredBeforeOpen = rel === '' ? false : await this.isIgnored(pinned, [rel]);

    // Open the directory THROUGH the pinned root, component by component, and keep the handle:
    // everything below enumerates that descriptor, so a parent renamed and symlinked away mid-request
    // cannot redirect the listing.
    const target = await pinned.open(rel, { wantDirectory: true });
    try {
      const canonicalDir = target.canonical;
      if (isDeniedPath(rel) || isDeniedPath(canonicalDir)) throw new FsError('denied', `path is not served: ${rel}`);
      if (target.metadata.type !== 'dir') throw new FsError('not_a_directory', `not a directory: ${rel || '.'}`);

      // Validated and pinned, not yet enumerated — the listing's equivalent of the file barrier.
      await options.afterValidation?.();

      // Refuse to ENUMERATE a gitignored directory, not just to serve its files. A client renders an
      // ignored directory as inert, but a token holder calls the endpoint directly: `build` would
      // otherwise walk the whole ignored tree, and the names in it are themselves the leak.
      const candidates = gateCandidates(rel, canonicalDir);
      const ignoredAfterOpen = candidates.length === 0 ? false : await this.isIgnored(pinned, candidates);
      if (ignoredBeforeOpen || ignoredAfterOpen) throw new FsError('ignored', `path is not served: ${rel}`);
      if (rel !== '' && !(await this.policyPathUnchanged(pinned, rel, target.identities, { wantDirectory: true }))) {
        throw changedDuringPolicy(rel);
      }

      return await this.enumerate(pinned, rel, target);
    } finally {
      await target.close();
    }
  }

  private async enumerate(pinned: PinnedRoot, rel: string, target: PinnedTarget): Promise<FsListing> {
    const listing = await target.list(MAX_LISTING_ENTRIES);

    // Each entry is judged on every path that names its bytes: the child path itself, and — for a
    // symlink — the canonical path of what it points at.
    const candidatesByName = new Map<string, readonly string[]>();
    const ignoreCandidates: string[] = [];
    const entries: FsEntry[] = [];
    for (const child of listing.entries) {
      const childRel = rel ? `${rel}/${child.name}` : child.name;
      const candidates = gateCandidates(childRel, child.target);
      const entry: FsEntry = {
        name: child.name,
        type: child.type,
        ...(child.size === undefined ? {} : { size: child.size }),
        ...(child.mtime === undefined ? {} : { mtime: child.mtime }),
        ...(child.escapes ? { escapes: true } : {}),
        ...(candidates.some(candidate => isDeniedPath(candidate)) ? { denied: true } : {}),
      };
      // A denied entry is still classified: the badges are about serving bytes, not about what may be
      // said of a path. An escaping symlink is excluded because its in-root name tells Git nothing.
      if (!child.escapes) {
        candidatesByName.set(child.name, candidates);
        ignoreCandidates.push(...candidates);
      }
      entries.push(entry);
    }

    // One batched ignore check for the whole directory rather than one spawn per entry. Never fatal
    // here: a repository that cannot be interrogated simply has no ignore data for the BADGES, and the
    // gates that decide whether bytes are served run again on the read itself.
    const ignored = await this.git.ignoredPaths(pinned.policyCwd, ignoreCandidates).catch(() => new Set<string>());
    const flagged = entries.map(entry => {
      const candidates = candidatesByName.get(entry.name) ?? [];
      return candidates.some(candidate => ignored.has(candidate)) ? { ...entry, ignored: true } : entry;
    });

    flagged.sort((left, right) => {
      const leftDirectory = left.type === 'dir' ? 0 : 1;
      const rightDirectory = right.type === 'dir' ? 0 : 1;
      if (leftDirectory !== rightDirectory) return leftDirectory - rightDirectory;
      return left.name.localeCompare(right.name);
    });

    return {
      root: pinned.rootReal,
      path: rel,
      entries: flagged,
      ...(listing.truncated ? { truncated: true } : {}),
    };
  }

  /**
   * Run both secrets gates over every path that names one target's bytes.
   *
   * `denied` means the hard denylist ("never served"); `ignored` means the gitignore gate. They are
   * distinct flags because clients render distinct badges, and conflating them would label every build
   * artifact a secret. A Git failure is a refusal: a viewer that cannot prove a file is unignored must
   * not claim it is safe to serve.
   */
  private async refusalFor(pinned: PinnedRoot, rel: string, canonical?: string): Promise<FsFileView | undefined> {
    const candidates = gateCandidates(rel, canonical);
    if (candidates.some(candidate => isDeniedPath(candidate))) {
      return { path: rel, size: 0, denied: true, reason: 'denylist' };
    }
    return (await this.isIgnored(pinned, candidates))
      ? { path: rel, size: 0, ignored: true, reason: 'ignored' }
      : undefined;
  }

  /**
   * Is any of these paths gitignored — and, when that cannot be established, `true`.
   *
   * Fail-closed is the whole contract of this helper. Outside a repository the port answers with an
   * empty set (the gate is vacuous there), so reaching the catch means a repository exists and Git could
   * not prove the path unignored: a timeout, a corrupt index, a locked worktree.
   */
  private async isIgnored(pinned: PinnedRoot, candidates: readonly string[]): Promise<boolean> {
    if (candidates.length === 0) return false;
    try {
      const ignored = await this.git.ignoredPaths(pinned.policyCwd, candidates);
      return candidates.some(candidate => ignored.has(candidate));
    } catch {
      return true;
    }
  }

  /**
   * Re-walk the lexical name after Git's policy verdict and prove every component is still the object
   * whose descriptor supplied the bytes or the directory.
   *
   * Git only accepts pathnames, so this post-check is the binding between its verdict and the descriptor
   * walk. A mismatch fails closed; a caller may retry from a fresh request once the worktree stops
   * moving.
   */
  private async policyPathUnchanged(
    pinned: PinnedRoot,
    rel: string,
    expected: readonly ComponentIdentity[],
    options: PinnedOpenOptions = {},
  ): Promise<boolean> {
    let reopened: PinnedTarget | undefined;
    try {
      reopened = await pinned.open(rel, options);
      return sameComponentWalk(expected, reopened.identities);
    } catch {
      return false;
    } finally {
      await reopened?.close();
    }
  }
}

function sameComponentWalk(left: readonly ComponentIdentity[], right: readonly ComponentIdentity[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((component, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      component.dev === other.dev &&
      component.ino === other.ino &&
      component.ctimeMs === other.ctimeMs &&
      component.mode === other.mode
    );
  });
}

function changedDuringPolicy(rel: string): FsError {
  return new FsError('not_found', `path changed while its secrets policy was being checked: ${rel}`);
}
