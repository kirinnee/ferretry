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
  MAX_LISTING_ENTRIES,
  type ResolvedTarget,
} from './types.ts';

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
        ? await this.readHead(pinned, rel, maxBytes)
        : await this.readWorking(pinned, rel, maxBytes, options.afterValidation);
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
  private async readHead(pinned: PinnedRoot, rel: string, maxBytes: number): Promise<FsFileView> {
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
    if (looksBinary(blob.bytes)) return { path: rel, size: blob.size, binary: true, rev: 'head' };
    return { path: rel, size: blob.size, content: new TextDecoder().decode(blob.bytes), rev: 'head' };
  }

  private async readWorking(
    pinned: PinnedRoot,
    rel: string,
    maxBytes: number,
    afterValidation: AfterValidationHook | undefined,
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
