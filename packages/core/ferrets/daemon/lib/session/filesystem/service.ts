import { isAbsolute, relative, sep } from 'node:path';
import { checkTreeIndexBounds, indexPinnedTree, type TreeIndexBounds } from '../../../../contract/tree-index.ts';
import type { SessionFileIndex } from '../../protocol/session-search.ts';
import {
  deniedSegment,
  gateCandidates,
  isDeniedPath,
  looksBinary,
  normalizeRelativePath,
  rootIsDenied,
} from './path-policy.ts';
import type {
  AfterValidationHook,
  ComponentIdentity,
  PinnedMetadata,
  PinnedOpenOptions,
  PinnedRoot,
  PinnedTarget,
  ReadTarget,
  SessionChangesView,
  SessionGit,
  SessionRootPinner,
  SpanChooser,
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
 * How much of a tree one index read may look at, and for how long: the shared {@link TreeIndexBounds} plus the
 * state-home fence an agent caller reads behind (the shared index is told only whether to fence, not whose fence).
 */
export interface IndexBounds extends Omit<TreeIndexBounds, 'fenced'> {
  /** The state-home fence an agent caller reads behind; see {@link FencedRead}. */
  readonly fence?: SessionReadFence;
}

/** Whether `path` is `directory` or inside it, as paths (a child named `..x` is inside). */
export function withinFolder(directory: string, path: string): boolean {
  const from = relative(directory, path);
  return from === '' || (from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from));
}

/**
 * What a read for an AGENT sits behind (S47, today's `agentFence`). The fence itself is the kernel's: the pin is
 * taken with `PinOptions.fence` `'agent'`, so every walk and probe beneath the held root refuses the state home —
 * by name and by identity, its pinned key files and folders included — and a file with more than one name. Every
 * name that never passes through that walk (Git's change list, a `HEAD` blob, a deleted file's diff, a listing's
 * badge, the index walk's tally) is asked of the held root's verdict ({@link PinnedRoot.fenced}) exactly where
 * today's `fenceRefusal` ran. Absent for a person, whose reads are unchanged: the pin is taken with `'none'`.
 */
export interface SessionReadFence {
  readonly caller: 'agent';
}

/** The one fence value: an agent's read. */
export const AGENT_READ_FENCE: SessionReadFence = Object.freeze({ caller: 'agent' });

/**
 * The state-home fence ({@link SessionReadFence}), for a read made on an AGENT's behalf.
 *
 * Absent for a person, whose reads are unchanged. Present, nothing whose real path is inside the daemon's
 * state home is opened, listed into or diffed — whatever the session's folder is, including a folder that
 * holds the home or one that IS it. The check is made inside the same pin as the read: the walk never
 * follows a link, so the pinned root's real path joined to the walked name IS the real path of what is
 * read, and a root swapped for a link into the home shows as a pinned root inside it.
 */
export interface FencedRead {
  readonly fence?: SessionReadFence;
}

/**
 * Today's `fenceRefusal` for many root-relative names at once: those an agent may not be told of, asked of the held
 * root's verdict. None for a person. A root that cannot answer fences every name, so a pin without a verdict closes
 * the surface rather than opening it.
 */
async function fencedNames(
  fence: SessionReadFence | undefined,
  pinned: PinnedRoot,
  rels: readonly string[],
): Promise<ReadonlySet<string>> {
  if (fence === undefined || rels.length === 0) return new Set();
  if (pinned.fenced === undefined) return new Set(rels);
  const verdicts = await pinned.fenced(rels);
  return new Set(rels.filter((_, index) => verdicts[index] !== false));
}

/** The refusal of a read that would reach the state home, or `undefined`. `rel` is root-relative. */
async function fenceRefusal(
  fence: SessionReadFence | undefined,
  pinned: PinnedRoot,
  rel: string,
): Promise<FsError | undefined> {
  return (await fencedNames(fence, pinned, [rel])).has(rel) ? homeRefusal() : undefined;
}

const homeRefusal = (): FsError =>
  new FsError(
    'denied',
    "that path is inside this daemon's state home, which holds this machine's credentials, so it is not read for an agent",
  );

/**
 * The refusal of a file with more than one name, for a read behind the fence: its other name could be inside
 * the state home (a hard link to `api-token` left in the session's folder), and nothing about the inode says
 * where. Asked of the OPENED descriptor's own `fstat`, so the file judged is the file read.
 */
function hardLinkRefusal(
  fence: SessionReadFence | undefined,
  rel: string,
  metadata: PinnedMetadata,
): FsError | undefined {
  if (fence === undefined || metadata.type !== 'file' || (metadata.links ?? 1) <= 1) return undefined;
  return new FsError(
    'denied',
    `${rel} is a hard link (the file has ${String(metadata.links)} names), and another of its names could be inside this daemon's state home, so it is not read for an agent`,
  );
}

/** What a caller may ask of the delivery of a working-tree read, beyond the gates every read passes. */
interface Delivery {
  readonly raw?: boolean;
  readonly span?: SpanChooser;
  readonly afterRead?: (file: ReadTarget) => void;
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
 * is the exact failure the pin exists to prevent. The one thing held between two questions is an index's
 * {@link PinnedFileProbe}, and it lives exactly as long as the one call that opened it, under that call's pin.
 */
export class SessionFilesystem {
  constructor(
    private readonly pinner: SessionRootPinner,
    private readonly git: SessionGit,
    /**
     * How this reads the clock, injected so a deadline can be proven without waiting for one.
     *
     * Defaulted rather than required because exactly one call in this class is timed, and making every
     * construction site name a clock to get the same answer would be ceremony that hides which one it is.
     */
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  /**
   * Pins `cwd`, behind the fence when there is one: a root inside the state home is refused here, before
   * anything under it is asked. The caller closes what this returns.
   */
  private async pin(cwd: string, fence: SessionReadFence | undefined): Promise<PinnedRoot> {
    // Caller-scoped, as today: the kernel fences every walk beneath the root for an agent, and none for a person.
    const pinned = await this.pinner.pin(cwd, { fence: fence === undefined ? 'none' : 'agent' });
    try {
      // The per-request gates judge paths RELATIVE to the root, so a root that is itself a key store (`~/.ssh`, `.git`,
      // a folder named `.env`) would make every name beneath it innocent. The shared secret-name rule is therefore
      // applied to the root's own pinned real path, for a person and an agent alike, before anything under it is asked.
      if (rootIsDenied(pinned.rootReal)) throw new FsError('denied', 'session cwd is not served');
      if (fence === undefined) return pinned;
      // The root by name and by identity too: a folder bound to the home has a name outside it.
      const refusal = await fenceRefusal(fence, pinned, '');
      if (refusal !== undefined) throw refusal;
    } catch (error) {
      await pinned.close();
      throw error;
    }
    return pinned;
  }

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
  async changes(cwd: string, options: FencedRead = {}): Promise<SessionChangesView> {
    const pinned = await this.pin(cwd, options.fence);
    try {
      const view = await this.git.changes(pinned.policyCwd);
      if (options.fence === undefined) return view;
      // Git names paths, and a repository that holds the state home would name what is in it.
      const fenced = await fencedNames(
        options.fence,
        pinned,
        view.changes.flatMap(change => (change.from === undefined ? [change.path] : [change.path, change.from])),
      );
      const outside = (rel: string | undefined): boolean => rel === undefined || !fenced.has(rel);
      return { ...view, changes: view.changes.filter(change => outside(change.path) && outside(change.from)) };
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
    const { fence, ...limits } = bounds;
    // A bound that is not a real one is refused before the pin, as it always was: nothing is held or asked for it.
    checkTreeIndexBounds(limits);
    const pinned = await this.pin(cwd, fence);
    try {
      // The algorithm is the shared tree index (`contract/tree-index.ts`); what this adds is the pin, whose fence
      // depends on whose read this is, and the two Git questions answered by the session's own `SessionGit`.
      return await indexPinnedTree(
        pinned,
        {
          git: {
            isInsideWorkTree: async (directory, budget) => (await this.git.repoInfo(directory, budget)).repo,
            listFiles: (directory, maxBytes, budget) => this.git.listFiles(directory, maxBytes, budget),
          },
          policy: { normalize: normalizeRelativePath, isDenied: isDeniedPath },
          nowMs: this.nowMs,
        },
        { ...limits, fenced: fence !== undefined },
      );
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
    options: FencedRead & { readonly afterValidation?: AfterValidationHook } = {},
  ): Promise<FsListing> {
    const pinned = await this.pin(cwd, options.fence);
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
      /** Return the gated bytes as they are, on the view's `bytes`, with no base64 or text coat. */
      readonly raw?: boolean;
      /** Asked after every gate and before the read: which span of the file to read (none: all of it). */
      readonly span?: SpanChooser;
      /**
       * Asked with the descriptor's own `fstat` AFTER the span was read, and it may refuse by throwing. A caller that
       * keyed a verdict on the open-time stat uses it to prove the bytes it just read are still that object's.
       */
      readonly afterRead?: (file: ReadTarget) => void;
      /** @internal Test-only barrier; see {@link AfterValidationHook}. */
      readonly afterValidation?: AfterValidationHook;
      readonly fence?: SessionReadFence;
    } = {},
  ): Promise<FsFileView> {
    const maxBytes = options.maxBytes ?? MAX_FILE_BYTES;
    const pinned = await this.pin(cwd, options.fence);
    try {
      const rel = normalizeRelativePath(relativePath);
      if (rel === '') throw new FsError('invalid_path', 'a file path is required');
      // Asked of the name before either branch: a `HEAD` read walks nothing, so the pinned walk cannot ask it.
      const fenced = await fenceRefusal(options.fence, pinned, rel);
      if (fenced !== undefined) throw fenced;
      return options.rev === 'head'
        ? await this.readHead(pinned, rel, maxBytes, options.base64)
        : await this.readWorking(pinned, rel, maxBytes, options.afterValidation, options.base64, options.fence, {
            ...(options.raw === true ? { raw: true } : {}),
            ...(options.span === undefined ? {} : { span: options.span }),
            ...(options.afterRead === undefined ? {} : { afterRead: options.afterRead }),
          });
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
  // read-scoped: none — internal diff bytes, never shown; the outbound projection redacts
  async diff(
    cwd: string,
    relativePath: string,
    options: {
      /** @internal Test-only barrier; see {@link AfterValidationHook}. */
      readonly afterValidation?: AfterValidationHook;
      readonly fence?: SessionReadFence;
    } = {},
  ): Promise<FsDiffView> {
    const pinned = await this.pin(cwd, options.fence);
    try {
      const rel = normalizeRelativePath(relativePath);
      if (rel === '') throw new FsError('invalid_path', 'a file path is required');
      // A deleted file's diff is read from `HEAD` without a walk, so the name is asked here.
      const fenced = await fenceRefusal(options.fence, pinned, rel);
      if (fenced !== undefined) throw fenced;

      // The same two-sided policy binding as readFile. Do not return early on a refusal yet: retaining
      // the pre-walk verdict while the deterministic hook swaps the parent is what proves an ignored
      // original cannot be laundered by an unignored replacement.
      const refusalBeforeOpen = await this.refusalFor(pinned, rel);
      const opened = await this.openForDiff(pinned, rel);
      const linked = opened === undefined ? undefined : hardLinkRefusal(options.fence, rel, opened.metadata);
      if (linked !== undefined) {
        await opened?.close();
        throw linked;
      }
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
    return {
      path: rel,
      diff: rendered.diff,
      kind,
      ...(rendered.truncated ? { truncated: true } : {}),
      sides: {
        ...(head ? { head: head.bytes } : {}),
        ...(working ? { working } : {}),
      },
    };
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
    fence?: SessionReadFence,
    delivery: Delivery = {},
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
      const linked = hardLinkRefusal(fence, rel, metadata);
      if (linked !== undefined) throw linked;

      // Validated, not yet read — the window. See AfterValidationHook.
      await afterValidation?.();

      const refusal = refusalBeforeOpen ?? (await this.refusalFor(pinned, rel, opened.canonical));
      if (refusal) return { ...refusal, size: metadata.size, mtime: metadata.mtime };
      if (!(await this.policyPathUnchanged(pinned, rel, opened.identities))) throw changedDuringPolicy(rel);

      const view: FsFileView = { path: rel, size: metadata.size, mtime: metadata.mtime };
      if (metadata.size > maxBytes) return { ...view, tooLarge: true };

      // Every refusal has run. What is left is how much to read: the caller may take one span of a large file.
      const identity = opened.identities.at(-1);
      const span =
        delivery.span === undefined || identity === undefined
          ? undefined
          : await delivery.span({ identity, size: metadata.size, mtime: metadata.mtime });
      const bytes = await opened.read(maxBytes, span);
      if (delivery.afterRead !== undefined) delivery.afterRead(await opened.restat());
      if (bytes === undefined) return { ...view, tooLarge: true };
      if (delivery.raw === true) return { ...view, bytes };
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
    options: FencedRead & { readonly afterValidation?: AfterValidationHook },
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

      return await this.enumerate(pinned, rel, target, options.fence);
    } finally {
      await target.close();
    }
  }

  private async enumerate(
    pinned: PinnedRoot,
    rel: string,
    target: PinnedTarget,
    fence?: SessionReadFence,
  ): Promise<FsListing> {
    const listing = await target.list(MAX_LISTING_ENTRIES);
    const childRelOf = (name: string): string => (rel ? `${rel}/${name}` : name);
    const fenced = await fencedNames(
      fence,
      pinned,
      listing.entries.map(child => childRelOf(child.name)),
    );

    // Each entry is judged on every path that names its bytes: the child path itself, and — for a
    // symlink — the canonical path of what it points at.
    const candidatesByName = new Map<string, readonly string[]>();
    const ignoreCandidates: string[] = [];
    const entries: FsEntry[] = [];
    for (const child of listing.entries) {
      const childRel = childRelOf(child.name);
      const candidates = gateCandidates(childRel, child.target);
      const entry: FsEntry = {
        name: child.name,
        type: child.type,
        ...(child.size === undefined ? {} : { size: child.size }),
        ...(child.mtime === undefined ? {} : { mtime: child.mtime }),
        ...(child.escapes ? { escapes: true } : {}),
        ...(candidates.some(candidate => isDeniedPath(candidate)) || fenced.has(childRel) ? { denied: true } : {}),
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
    const denied = candidates.map(candidate => deniedSegment(candidate)).find(segment => segment !== undefined);
    if (denied !== undefined) {
      return {
        path: rel,
        size: 0,
        denied: true,
        reason: 'denylist',
        rule: `the protected-secrets list refuses the name "${denied}"`,
      };
    }
    const verdict = await this.ignoreVerdict(pinned, candidates);
    return verdict.ignored ? { path: rel, size: 0, ignored: true, reason: 'ignored', rule: verdict.rule } : undefined;
  }

  /**
   * The gitignore verdict WITH the rule that decided it, for a refusal that has to say which rule.
   *
   * Two very different things refuse as `ignored`, and a reader must be able to tell them apart: Git
   * matched an ignore pattern — named here by file, line and pattern — or Git could not answer at all,
   * which fails closed and names the failure. Collapsing both into "gitignored, a secret, or outside the
   * folder" is how an agent's freshly written image got refused with no way to find out why.
   */
  private async ignoreVerdict(
    pinned: PinnedRoot,
    candidates: readonly string[],
  ): Promise<{ readonly ignored: false } | { readonly ignored: true; readonly rule: string }> {
    if (candidates.length === 0) return { ignored: false };
    let hits: ReadonlySet<string>;
    try {
      hits = await this.git.ignoredPaths(pinned.policyCwd, candidates);
    } catch (error) {
      const why = error instanceof Error ? (error.message.split('\n')[0] ?? '') : '';
      return {
        ignored: true,
        rule: `Git could not confirm it is not ignored, so it is refused (${why || 'git failed'})`,
      };
    }
    const matched = candidates.filter(candidate => hits.has(candidate));
    if (matched.length === 0) return { ignored: false };
    const rule = await this.git.ignoreRule(pinned.policyCwd, matched).catch(() => undefined);
    return { ignored: true, rule: rule === undefined ? 'Git ignores it' : `Git ignores it (${rule})` };
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
   * moving. A rename round trip that leaves the original object at the name is caught only as far as its
   * change time shows it — best-effort, and why that is safe, on {@link ComponentIdentity}.
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
      component.ctimeNs === other.ctimeNs &&
      component.mode === other.mode
    );
  });
}

function changedDuringPolicy(rel: string): FsError {
  return new FsError('not_found', `path changed while its secrets policy was being checked: ${rel}`);
}
