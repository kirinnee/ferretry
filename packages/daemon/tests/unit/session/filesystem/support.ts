import {
  FsError,
  type ComponentIdentity,
  type DiffSide,
  type HeadBlob,
  type HeadEntry,
  type PinnedDirectoryEntry,
  type PinnedListing,
  type PinnedOpenOptions,
  type PinnedRoot,
  type PinnedTarget,
  type RenderedDiff,
  type SessionChangesView,
  type SessionFileList,
  type SessionGit,
  type SessionRepoInfo,
  type SessionRootPinner,
  type SpawnBudget,
  type WorkBudget,
} from '../../../../src/lib/session/filesystem/index.ts';

/**
 * Programmable stand-ins for the two capabilities the working-tree viewer needs.
 *
 * These exist to test the DOMAIN's gate orchestration — which paths are gated, in what order, and what a
 * refusal from either side of the walk does — with a tree that can be swapped mid-request on demand rather
 * than by winning a race. They deliberately do NOT re-implement the containment walk: whether an interior
 * symlink is actually refused is a question about the kernel, and it is answered by the integration tests
 * against the real procfs pinner. A green run here says nothing about containment, and is not meant to.
 */

export const FAKE_ROOT = '/pinned/root';
export const FAKE_POLICY_CWD = '/proc/self/fd/7';
export const FAKE_MTIME = '2026-08-01T00:00:00.000Z';

/** One node of the fake tree, addressed by its root-relative path (`''` is the root). */
export interface FakeNode {
  readonly type?: 'file' | 'dir' | 'other';
  readonly bytes?: Uint8Array;
  /** Overrides the size derived from `bytes`, which is how a `tooLarge` view is provoked. */
  readonly size?: number;
  readonly mtime?: string;
  readonly mode?: number;
  /** The canonical path the walk reports, when it must differ from the requested one. */
  readonly canonical?: string;
  readonly identities?: readonly ComponentIdentity[];
  readonly entries?: readonly PinnedDirectoryEntry[];
  readonly truncated?: boolean;
  /** Raised instead of opening, so a test can stage any refusal the real walk can produce. */
  readonly error?: Error;
}

export type FakeTree = Map<string, FakeNode>;

/** Every component of `rel` gets a distinct identity, with the root first. */
function identitiesFor(rel: string): readonly ComponentIdentity[] {
  const depth = rel === '' ? 0 : rel.split('/').length;
  return Array.from({ length: depth + 1 }, (_unused, index) => ({
    dev: 1,
    ino: 100 + index,
    ctimeMs: 1000,
    mode: 0o40755,
  }));
}

class FakePinnedTarget implements PinnedTarget {
  closed = false;
  readonly readCalls: number[] = [];

  constructor(
    readonly metadata: PinnedTarget['metadata'],
    readonly canonical: string,
    readonly identities: readonly ComponentIdentity[],
    private readonly bytes: Uint8Array,
    private readonly listing: PinnedListing,
  ) {}

  async read(maxBytes: number): Promise<Uint8Array | undefined> {
    this.readCalls.push(maxBytes);
    return this.metadata.size > maxBytes ? undefined : this.bytes;
  }

  /**
   * The real enumeration stops where a spent budget finds it and says `truncated`; so does this one.
   *
   * Checked per entry rather than once, because the property under test is that a directory of many
   * children is abandoned from the INSIDE rather than after every one of them has been classified.
   */
  async list(maxEntries: number, budget?: WorkBudget): Promise<PinnedListing> {
    const entries: PinnedDirectoryEntry[] = [];
    for (const entry of this.listing.entries.slice(0, maxEntries)) {
      if (budget?.expired() === true) return { entries, truncated: true };
      entries.push(entry);
    }
    return { entries, truncated: this.listing.truncated };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export interface FakeRootOptions {
  readonly rootReal?: string;
  readonly tree?: FakeTree;
  /** Raised by `pin`. Typed as `Error` so a test can also stage a NON-domain failure and prove a route
   *  reports it as a server fault rather than as the client's mistake. */
  readonly pinError?: Error;
  /**
   * Called before each `open` resolves, with the path and how many times it has now been opened.
   *
   * This is the deterministic swap: a test mutates the tree from here, so the SECOND walk — the one the
   * domain performs to bind Git's verdict to the descriptor — sees a different object.
   */
  readonly onOpen?: (rel: string, attempt: number, tree: FakeTree) => void;
}

class FakePinnedRoot implements PinnedRoot {
  readonly opens: string[] = [];
  readonly targets: FakePinnedTarget[] = [];
  closed = false;
  private readonly attempts = new Map<string, number>();

  constructor(
    readonly rootReal: string,
    private readonly tree: FakeTree,
    private readonly onOpen: FakeRootOptions['onOpen'],
  ) {}

  get policyCwd(): string {
    return FAKE_POLICY_CWD;
  }

  async open(rel: string, _options: PinnedOpenOptions = {}): Promise<PinnedTarget> {
    const attempt = (this.attempts.get(rel) ?? 0) + 1;
    this.attempts.set(rel, attempt);
    this.opens.push(rel);
    this.onOpen?.(rel, attempt, this.tree);

    const node = this.tree.get(rel);
    if (node === undefined) throw new FsError('not_found', `no such path: ${rel}`);
    if (node.error) throw node.error;

    const bytes = node.bytes ?? new Uint8Array();
    const target = new FakePinnedTarget(
      {
        type: node.type ?? 'file',
        size: node.size ?? bytes.byteLength,
        mtime: node.mtime ?? FAKE_MTIME,
        mode: node.mode ?? 0o100644,
      },
      node.canonical ?? rel,
      node.identities ?? identitiesFor(rel),
      bytes,
      { entries: node.entries ?? [], truncated: node.truncated ?? false },
    );
    this.targets.push(target);
    return target;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class FakeRootPinner implements SessionRootPinner {
  readonly pinnedCwds: string[] = [];
  readonly roots: FakePinnedRoot[] = [];

  constructor(private readonly options: FakeRootOptions = {}) {}

  async pin(cwd: string): Promise<PinnedRoot> {
    this.pinnedCwds.push(cwd);
    if (this.options.pinError) throw this.options.pinError;
    const root = new FakePinnedRoot(
      this.options.rootReal ?? FAKE_ROOT,
      this.options.tree ?? new Map(),
      this.options.onOpen,
    );
    this.roots.push(root);
    return root;
  }

  /** The most recent pin, for asserting that a request closed what it opened. */
  get lastRoot(): FakePinnedRoot {
    const root = this.roots.at(-1);
    if (root === undefined) throw new Error('nothing has been pinned yet');
    return root;
  }
}

export interface SessionGitScript {
  readonly repoInfo?: (cwd: string) => SessionRepoInfo;
  /** May throw, which is how a repository Git cannot answer for is staged. */
  readonly listFiles?: (cwd: string, maxBytes: number) => SessionFileList;
  /** `call` counts from one, so a test can make a path become ignored between two verdicts. */
  readonly ignoredPaths?: (cwd: string, rels: readonly string[], call: number) => ReadonlySet<string>;
  readonly isTracked?: (cwd: string, rel: string) => boolean | Promise<boolean>;
  readonly changes?: (cwd: string) => SessionChangesView;
  readonly headEntry?: (cwd: string, rel: string, maxBytes: number) => HeadEntry | undefined;
  readonly readHeadBlob?: (cwd: string, rel: string, maxBytes: number) => HeadBlob | undefined;
  readonly diffSnapshots?: (rel: string, oldSide: DiffSide | undefined, newSide: DiffSide | undefined) => RenderedDiff;
}

const IN_REPO: SessionRepoInfo = { repo: true, root: FAKE_ROOT, prefix: '', hasHead: true };

export class FakeSessionGit implements SessionGit {
  readonly ignoreCalls: Array<{ readonly cwd: string; readonly rels: readonly string[] }> = [];
  readonly diffCalls: Array<{
    readonly rel: string;
    readonly oldSide: DiffSide | undefined;
    readonly newSide: DiffSide | undefined;
  }> = [];
  readonly listCalls: Array<{ readonly cwd: string; readonly maxBytes: number; readonly remainingMs?: number }> = [];
  readonly repoInfoCalls: Array<{ readonly cwd: string; readonly remainingMs?: number }> = [];
  readonly cwds: string[] = [];

  constructor(private readonly script: SessionGitScript = {}) {}

  async repoInfo(cwd: string, budget?: SpawnBudget): Promise<SessionRepoInfo> {
    this.cwds.push(cwd);
    const info = this.script.repoInfo?.(cwd) ?? IN_REPO;
    // Read AFTER the script, mirroring the real adapter: what is left is consulted when it is about to
    // start its SECOND command, by which time a caller may already have hung up.
    this.repoInfoCalls.push({ cwd, ...(budget === undefined ? {} : { remainingMs: budget.remainingMs() }) });
    return info;
  }

  async listFiles(cwd: string, maxBytes: number, budget?: SpawnBudget): Promise<SessionFileList> {
    this.listCalls.push({ cwd, maxBytes, ...(budget === undefined ? {} : { remainingMs: budget.remainingMs() }) });
    return this.script.listFiles?.(cwd, maxBytes) ?? { paths: [], truncated: false };
  }

  async ignoredPaths(cwd: string, rels: readonly string[]): Promise<ReadonlySet<string>> {
    this.ignoreCalls.push({ cwd, rels });
    return this.script.ignoredPaths?.(cwd, rels, this.ignoreCalls.length) ?? new Set();
  }

  async isTracked(cwd: string, rel: string): Promise<boolean> {
    return (await this.script.isTracked?.(cwd, rel)) ?? false;
  }

  async changes(cwd: string): Promise<SessionChangesView> {
    this.cwds.push(cwd);
    return this.script.changes?.(cwd) ?? { repo: true, changes: [] };
  }

  async headEntry(cwd: string, rel: string, maxBytes: number): Promise<HeadEntry | undefined> {
    return this.script.headEntry?.(cwd, rel, maxBytes);
  }

  async readHeadBlob(cwd: string, rel: string, maxBytes: number): Promise<HeadBlob | undefined> {
    return this.script.readHeadBlob?.(cwd, rel, maxBytes);
  }

  async diffSnapshots(
    rel: string,
    oldSide: DiffSide | undefined,
    newSide: DiffSide | undefined,
  ): Promise<RenderedDiff> {
    this.diffCalls.push({ rel, oldSide, newSide });
    return this.script.diffSnapshots?.(rel, oldSide, newSide) ?? { diff: '', truncated: false };
  }
}

/** A directory node holding the given children. */
export function directory(entries: readonly PinnedDirectoryEntry[], truncated = false): FakeNode {
  return { type: 'dir', entries, truncated };
}

/** A regular file node holding the given text. */
export function textFile(content: string, overrides: Partial<FakeNode> = {}): FakeNode {
  return { type: 'file', bytes: new TextEncoder().encode(content), ...overrides };
}

/** A tree built from `[path, node]` pairs, always including the root directory. */
export function treeOf(...nodes: readonly (readonly [string, FakeNode])[]): FakeTree {
  const tree: FakeTree = new Map([['', directory([])]]);
  for (const [rel, node] of nodes) tree.set(rel, node);
  return tree;
}
