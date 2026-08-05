import { describe, it } from 'bun:test';
import path from 'node:path';
import should from 'should';
import {
  mergeSharedHistoryJsonl,
  SharedHistoryAccessRefusedError,
  type SharedHistoryFileSystem,
  SharedHistoryMigration,
  SharedHistoryMigrationError,
  type SharedHistoryNode,
  type SharedHistoryRecoveryEvidence,
  SharedHistoryRecoveryRequiredError,
  type SharedHistoryRefusal,
  type SharedHistoryRequest,
  sharedHistoryEntries,
  sharedHistoryEntryNeedsPooledTree,
  sharedHistoryJsonlAdditions,
} from '../../src/lib/shared-history.ts';

type FlatNode =
  | { readonly kind: 'file'; readonly modifiedAtMs: number; readonly deviceId: number; readonly text: string }
  | { readonly kind: 'directory'; readonly modifiedAtMs: number; readonly deviceId: number }
  | {
      readonly kind: 'symbolic-link';
      readonly modifiedAtMs: number;
      readonly deviceId: number;
      readonly target: string;
    }
  | { readonly kind: 'other'; readonly modifiedAtMs: number; readonly deviceId: number };

/** The fake's stand-in for the kernel's link-resolution limit, so a cycle fails instead of hanging. */
const MEMORY_LINK_HOPS = 8;

interface SnapshotCall {
  readonly target: string;
  readonly recursive: boolean | undefined;
  readonly readText: boolean | undefined;
}

class MemorySharedHistoryFileSystem implements SharedHistoryFileSystem {
  private readonly nodes = new Map<string, FlatNode>();
  readonly failures = new Map<string, Error>();
  readonly snapshots: SnapshotCall[] = [];
  afterExclusiveWrite: ((target: string) => void) | undefined;

  seed(target: string, node: SharedHistoryNode): void {
    if (node.kind === 'directory') {
      this.nodes.set(target, { kind: 'directory', modifiedAtMs: node.modifiedAtMs, deviceId: node.deviceId });
      for (const [name, child] of Object.entries(node.children)) this.seed(path.join(target, name), child);
      return;
    }
    this.nodes.set(
      target,
      node.kind === 'file'
        ? { kind: 'file', modifiedAtMs: node.modifiedAtMs, deviceId: node.deviceId, text: node.text ?? '' }
        : { ...node },
    );
  }

  has(target: string): boolean {
    return this.nodes.has(target);
  }

  async snapshot(
    target: string,
    options: { readonly readText?: boolean; readonly recursive?: boolean } = {},
  ): Promise<SharedHistoryNode | undefined> {
    this.snapshots.push({ target, recursive: options.recursive, readText: options.readText });
    const failure = this.failures.get(`snapshot:${target}`);
    if (failure) throw failure;
    // Ancestors resolve through their links exactly as the kernel resolves them, so a path reached
    // through an aliased parent reads the same entry. Without that the fake cannot show the case
    // this planner exists to refuse: one home directory named two ways.
    const resolved = this.resolveAncestors(target);
    const node = this.nodes.get(resolved);
    if (!node) return undefined;
    if (node.kind === 'file') {
      return {
        kind: 'file',
        modifiedAtMs: node.modifiedAtMs,
        deviceId: node.deviceId,
        size: new TextEncoder().encode(node.text).byteLength,
        ...(options.readText ? { text: node.text } : {}),
      };
    }
    if (node.kind !== 'directory') return node;
    const children: Record<string, SharedHistoryNode> = {};
    if (options.recursive === false) {
      return { kind: 'directory', modifiedAtMs: node.modifiedAtMs, deviceId: node.deviceId, children };
    }
    for (const [candidate] of [...this.nodes].sort(([left], [right]) => left.localeCompare(right))) {
      if (path.dirname(candidate) !== resolved) continue;
      const child = await this.snapshot(candidate);
      if (child) children[path.basename(candidate)] = child;
    }
    return { kind: 'directory', modifiedAtMs: node.modifiedAtMs, deviceId: node.deviceId, children };
  }

  /** Resolve every component through its links, the way the kernel does, and give up on a cycle. */
  async canonicalDirectoryOf(target: string): Promise<string> {
    return this.canonicalise(path.resolve(target), 0);
  }

  /** The same resolution an `lstat` gets: every ancestor followed, the final component left alone. */
  private resolveAncestors(target: string): string {
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(this.canonicalise(parent, 0), path.basename(target));
  }

  private canonicalise(target: string, hops: number): string {
    if (hops > MEMORY_LINK_HOPS) throw new Error(`too many levels of symbolic links: ${target}`);
    const parent = path.dirname(target);
    if (parent === target) return target;
    const resolved = path.join(this.canonicalise(parent, hops), path.basename(target));
    const node = this.nodes.get(resolved);
    if (node?.kind !== 'symbolic-link') return resolved;
    return this.canonicalise(path.resolve(path.dirname(resolved), node.target), hops + 1);
  }

  async deviceIdOf(target: string): Promise<number> {
    let candidate = target;
    while (candidate !== path.dirname(candidate)) {
      const node = this.nodes.get(candidate);
      if (node) return node.deviceId;
      candidate = path.dirname(candidate);
    }
    return 1;
  }

  async ensureDirectory(target: string): Promise<void> {
    this.throwIfFailed('ensureDirectory', target);
    const existing = this.nodes.get(target);
    if (existing) {
      if (existing.kind !== 'directory') throw new Error(`not a directory: ${target}`);
      return;
    }
    this.nodes.set(target, { kind: 'directory', modifiedAtMs: 0, deviceId: 1 });
  }

  async ensureFile(target: string): Promise<void> {
    this.throwIfFailed('ensureFile', target);
    const existing = this.nodes.get(target);
    if (existing) {
      if (existing.kind !== 'file') throw new Error(`not a file: ${target}`);
      return;
    }
    this.nodes.set(target, { kind: 'file', modifiedAtMs: 0, deviceId: 1, text: '' });
  }

  async move(source: string, destination: string): Promise<void> {
    this.throwIfFailed('move', `${source}->${destination}`);
    if (!this.nodes.has(source)) throw new Error(`missing: ${source}`);
    if (this.nodes.has(destination)) throw new Error(`occupied: ${destination}`);
    const moving = [...this.nodes].filter(([candidate]) => candidate === source || candidate.startsWith(`${source}/`));
    for (const [candidate] of moving) this.nodes.delete(candidate);
    for (const [candidate, node] of moving) {
      this.nodes.set(`${destination}${candidate.slice(source.length)}`, node);
    }
  }

  async writeTextAtomic(target: string, text: string): Promise<void> {
    this.throwIfFailed('writeTextAtomic', target);
    const existing = this.nodes.get(target);
    if (existing && existing.kind !== 'file') throw new Error(`not a file: ${target}`);
    this.nodes.set(target, { kind: 'file', modifiedAtMs: 1, deviceId: 1, text });
  }

  async writeTextExclusive(target: string, text: string): Promise<void> {
    this.throwIfFailed('writeTextExclusive', target);
    if (this.nodes.has(target)) throw new Error(`occupied: ${target}`);
    this.nodes.set(target, { kind: 'file', modifiedAtMs: 1, deviceId: 1, text });
    this.afterExclusiveWrite?.(target);
  }

  async appendTextIfPrefix(target: string, expected: string, addition: string): Promise<boolean> {
    this.throwIfFailed('appendTextIfPrefix', target);
    const existing = this.nodes.get(target);
    if (existing?.kind !== 'file') throw new Error(`not a file: ${target}`);
    if (!existing.text.startsWith(expected)) return false;
    this.nodes.set(target, {
      ...existing,
      modifiedAtMs: existing.modifiedAtMs + 1,
      text: `${existing.text}${addition}`,
    });
    return true;
  }

  async createSymbolicLink(target: string, destination: string): Promise<void> {
    this.throwIfFailed('createSymbolicLink', destination);
    if (this.nodes.has(destination)) throw new Error(`occupied: ${destination}`);
    this.nodes.set(destination, { kind: 'symbolic-link', modifiedAtMs: 0, deviceId: 1, target });
  }

  async removeSymbolicLink(target: string, expectedTarget: string): Promise<void> {
    this.throwIfFailed('removeSymbolicLink', target);
    const existing = this.nodes.get(target);
    if (existing?.kind !== 'symbolic-link' || existing.target !== expectedTarget) {
      throw new Error(`not the expected link: ${target}`);
    }
    this.nodes.delete(target);
  }

  async removeEmptyDirectory(target: string): Promise<void> {
    this.throwIfFailed('removeEmptyDirectory', target);
    if (this.nodes.get(target)?.kind !== 'directory') throw new Error(`not a directory: ${target}`);
    if ([...this.nodes.keys()].some(candidate => candidate.startsWith(`${target}/`))) {
      throw Object.assign(new Error(`not empty: ${target}`), { code: 'ENOTEMPTY' });
    }
    this.nodes.delete(target);
  }

  async removeFile(target: string): Promise<void> {
    this.throwIfFailed('removeFile', target);
    if (this.nodes.get(target)?.kind !== 'file') throw new Error(`not a file: ${target}`);
    this.nodes.delete(target);
  }

  private throwIfFailed(operation: string, target: string): void {
    const failure = this.failures.get(`${operation}:${target}`);
    if (failure) throw failure;
  }
}

const directory = (
  children: Readonly<Record<string, SharedHistoryNode>> = {},
  modifiedAtMs = 1,
  deviceId = 1,
): SharedHistoryNode => ({ kind: 'directory', modifiedAtMs, deviceId, children });

const file = (text: string, modifiedAtMs: number, deviceId = 1): SharedHistoryNode => ({
  kind: 'file',
  modifiedAtMs,
  deviceId,
  size: new TextEncoder().encode(text).byteLength,
  text,
});

const link = (target: string, modifiedAtMs = 1): SharedHistoryNode => ({
  kind: 'symbolic-link',
  modifiedAtMs,
  deviceId: 1,
  target,
});

const ROOT = '/state/fleet/shared';
const POOL = `${ROOT}/claude`;
const CONFLICTS = `${POOL}/.migration-conflicts`;
const JOURNAL = `${POOL}/.migration-journal`;
const PROGRESS = `${POOL}/.migration-progress`;
const HOME_A = '/state/fleet/homes/a';
const HOME_B = '/state/fleet/homes/b';

const request = (patch: Partial<SharedHistoryRequest> = {}): SharedHistoryRequest => ({
  kind: 'claude',
  poolRoot: ROOT,
  homes: [
    { account: 'account-a', path: HOME_A },
    { account: 'account-b', path: HOME_B },
  ],
  ...patch,
});

const onlyA = (patch: Partial<SharedHistoryRequest> = {}): SharedHistoryRequest =>
  request({ homes: [{ account: 'account-a', path: HOME_A }], ...patch });

function seededMigration(): {
  readonly files: MemorySharedHistoryFileSystem;
  readonly subject: SharedHistoryMigration;
} {
  const files = new MemorySharedHistoryFileSystem();
  files.seed(`${HOME_A}/projects`, directory({ project: directory({ 'session.jsonl': file('older\n', 10) }) }));
  files.seed(`${HOME_A}/history.jsonl`, file('{"display":"one","timestamp":1}\n', 10));
  files.seed(
    `${HOME_B}/projects`,
    directory({
      project: directory({ 'session.jsonl': file('newer\n', 20), 'other.jsonl': file('other\n', 20) }),
    }),
  );
  files.seed(`${HOME_B}/history.jsonl`, file('{"display":"two","timestamp":2}\n{"display":"one","timestamp":1}\n', 20));
  return { files, subject: new SharedHistoryMigration(files) };
}

const journalText = (patch: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: 1,
    kind: 'claude',
    pool: POOL,
    actions: [
      { kind: 'move', source: `${HOME_A}/projects`, destination: `${POOL}/projects` },
      { kind: 'link', path: `${HOME_A}/projects`, target: `${POOL}/projects` },
    ],
    ...patch,
  });

const progressText = (patch: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 1, kind: 'claude', pool: POOL, state: 'applying', completed: 0, ...patch });

describe('shared history policy', () => {
  it('should keep Claude and Codex session-state lists independent', () => {
    // Act
    const claude = sharedHistoryEntries('claude').map(entry => entry.name);
    const codex = sharedHistoryEntries('codex').map(entry => entry.name);

    // Assert
    should(claude).deepEqual([
      'projects',
      'sessions',
      'session-env',
      'file-history',
      'plans',
      'tasks',
      'todos',
      'shell-snapshots',
      'paste-cache',
      'history.jsonl',
    ]);
    should(codex).deepEqual(['sessions', 'archived_sessions', 'history.jsonl']);
  });

  it('should merge prompt history by timestamp, order malformed evidence last, and drop blank lines', () => {
    // Act
    const actual = mergeSharedHistoryJsonl(
      '{"display":"three","timestamp":3}\nmalformed\n',
      '{"display":"one","ts":1}\n{"display":"three","timestamp":3}\n',
      '{"display":"two","timestamp":2}\n',
    );

    // Assert
    should(actual).equal(
      '{"display":"one","ts":1}\n{"display":"two","timestamp":2}\n{"display":"three","timestamp":3}\nmalformed\n',
    );
    should(mergeSharedHistoryJsonl('', '\n')).equal('');
  });

  it('should keep repeats inside one history but never let a re-merge inflate them', () => {
    // Arrange — the same prompt typed twice is two facts; the same file merged twice is one.
    const twice = '{"display":"same","timestamp":1}\n{"display":"same","timestamp":1}\n';
    const once = '{"display":"same","timestamp":1}\n';

    // Act
    const withinOneDocument = mergeSharedHistoryJsonl(twice);
    const remergedIdentically = mergeSharedHistoryJsonl(twice, twice);
    const acrossDocuments = mergeSharedHistoryJsonl(once, once);
    const growingSource = mergeSharedHistoryJsonl(once, twice);

    // Assert — identity is the exact line, multiplicity is the maximum any one document holds.
    should(withinOneDocument).equal(twice);
    should(remergedIdentically).equal(twice);
    should(acrossDocuments).equal(once);
    should(growingSource).equal(twice);
  });

  it('should reduce a merge to the lines the pool does not already hold', () => {
    // Arrange
    const pooled = '{"display":"one","timestamp":1}\n{"display":"same","timestamp":9}\n';
    const incoming = '{"display":"same","timestamp":9}\n{"display":"two","timestamp":2}\n{"display":"same","ts":9}\n';

    // Act
    const additions = sharedHistoryJsonlAdditions(pooled, incoming);
    const nothingNew = sharedHistoryJsonlAdditions(pooled, pooled);
    const intoEmpty = sharedHistoryJsonlAdditions('', '{"display":"first","timestamp":1}\n');

    // Assert — the pooled copy of "same" already covers the incoming one; a distinct line is added.
    should(additions).equal('{"display":"two","timestamp":2}\n{"display":"same","ts":9}\n');
    should(nothingNew).equal('');
    should(intoEmpty).equal('{"display":"first","timestamp":1}\n');
    // Appending exactly this to the pooled document yields the same multiset as the full union.
    should(mergeSharedHistoryJsonl(pooled, incoming).split('\n').toSorted()).deepEqual(
      `${pooled}${additions}`.split('\n').toSorted(),
    );
  });

  it('should only need the pooled tree for an entry no home has already linked', () => {
    // Act
    const linked = sharedHistoryEntryNeedsPooledTree(
      link(`${POOL}/projects`),
      `${HOME_A}/projects`,
      `${POOL}/projects`,
    );
    const relativeLink = sharedHistoryEntryNeedsPooledTree(
      link(path.relative(HOME_A, `${POOL}/projects`)),
      `${HOME_A}/projects`,
      `${POOL}/projects`,
    );
    const foreignLink = sharedHistoryEntryNeedsPooledTree(link('/foreign'), `${HOME_A}/projects`, `${POOL}/projects`);
    const realDirectory = sharedHistoryEntryNeedsPooledTree(directory(), `${HOME_A}/projects`, `${POOL}/projects`);
    const absent = sharedHistoryEntryNeedsPooledTree(undefined, `${HOME_A}/projects`, `${POOL}/projects`);

    // Assert
    should(linked).be.false();
    should(relativeLink).be.false();
    should(foreignLink).be.true();
    should(realDirectory).be.true();
    should(absent).be.false();
  });
});

describe('SharedHistoryMigration', () => {
  it('should preview every move, collision, emptied source and link without writing', async () => {
    // Arrange
    const { files, subject } = seededMigration();

    // Act
    const actual = await subject.preview(request());

    // Assert
    should(actual.kind).equal('claude');
    should(actual.pool).equal(POOL);
    should(actual.migrated).equal(4);
    should(actual.conflicts).equal(1);
    should(actual.links).equal(20);
    should(actual.refusals).deepEqual([]);
    should(actual.changes).containDeep([
      {
        kind: 'collision',
        incoming: `${HOME_B}/projects/project/session.jsonl`,
        pooled: `${POOL}/projects/project/session.jsonl`,
        winner: `${HOME_B}/projects/project/session.jsonl`,
        loser: `${POOL}/projects/project/session.jsonl`,
        // The pooled loser is account A's transcript, so it is quarantined under account A.
        preservedAt: `${CONFLICTS}/account-a/projects/project/session.jsonl`,
      },
      {
        kind: 'merge-jsonl',
        source: `${HOME_B}/history.jsonl`,
        destination: `${POOL}/history.jsonl`,
        sourcePreservedAt: `${CONFLICTS}/account-b/history.jsonl`,
      },
    ]);
    should(actual.emptiedSourceDirectories).deepEqual([`${HOME_B}/projects/project`, `${HOME_B}/projects`]);
    should(files.has(`${HOME_A}/projects`)).be.true();
    should(files.has(`${POOL}/projects`)).be.false();
  });

  it('should rename existing trees into one pool, preserve collision evidence, and link every home', async () => {
    // Arrange
    const { files, subject } = seededMigration();

    // Act
    const actual = await subject.materialize(request());

    // Assert
    should(actual.conflicts).equal(1);
    should(await files.snapshot(`${HOME_A}/projects`)).match({ kind: 'symbolic-link', target: `${POOL}/projects` });
    should(await files.snapshot(`${HOME_B}/projects`)).match({ kind: 'symbolic-link', target: `${POOL}/projects` });
    should(await files.snapshot(`${POOL}/projects/project/session.jsonl`, { readText: true })).match({
      kind: 'file',
      text: 'newer\n',
    });
    should(await files.snapshot(`${CONFLICTS}/account-a/projects/project/session.jsonl`, { readText: true })).match({
      kind: 'file',
      text: 'older\n',
    });
    should(await files.snapshot(`${POOL}/history.jsonl`, { readText: true })).match({
      kind: 'file',
      text: '{"display":"one","timestamp":1}\n{"display":"two","timestamp":2}\n',
    });
    should(await files.snapshot(`${CONFLICTS}/account-b/history.jsonl`, { readText: true })).match({
      kind: 'file',
      text: '{"display":"two","timestamp":2}\n{"display":"one","timestamp":1}\n',
    });
    // The emptied source directories are gone; the path only still reads through the pool link.
    should(files.has(`${HOME_B}/projects/project`)).be.false();
    should(await files.snapshot(`${HOME_B}/projects`)).match({ kind: 'symbolic-link' });
  });

  it('should file a loser nothing in this run contributed under the reserved pooled identity', async () => {
    // Arrange — the pooled copy predates every account in the request and still loses on mtime.
    const files = new MemorySharedHistoryFileSystem();
    files.seed(`${POOL}/projects`, directory({ same: file('pooled\n', 5) }));
    files.seed(`${HOME_A}/projects`, directory({ same: file('incoming\n', 50) }));
    const subject = new SharedHistoryMigration(files);

    // Act
    const actual = await subject.materialize(onlyA());

    // Assert
    should(actual.changes).containDeep([
      {
        kind: 'collision',
        winner: `${HOME_A}/projects/same`,
        loser: `${POOL}/projects/same`,
        preservedAt: `${CONFLICTS}/.pooled/projects/same`,
      },
    ]);
    should(await files.snapshot(`${CONFLICTS}/.pooled/projects/same`, { readText: true })).match({ text: 'pooled\n' });
    should(await files.snapshot(`${POOL}/projects/same`, { readText: true })).match({ text: 'incoming\n' });
  });

  it('should be idempotent and heal a missing target behind an existing pool link', async () => {
    // Arrange
    const files = new MemorySharedHistoryFileSystem();
    files.seed(`${HOME_A}/projects`, link(`${POOL}/projects`));
    const subject = new SharedHistoryMigration(files);

    // Act
    const first = await subject.materialize(onlyA());
    const second = await subject.preview(onlyA());

    // Assert
    should(first.changes).containDeep([{ kind: 'create-pooled-entry', path: `${POOL}/projects` }]);
    should(second.migrated).equal(0);
    should(second.conflicts).equal(0);
    should(second.links).equal(0);
    should(await files.snapshot(`${POOL}/projects`)).match({ kind: 'directory' });
  });

  it('should not walk the pool when every home entry is already the link to it', async () => {
    // Arrange — a steady fleet must not pay for reading every pooled transcript on every apply.
    const files = new MemorySharedHistoryFileSystem();
    for (const entry of sharedHistoryEntries('claude')) {
      files.seed(`${POOL}/${entry.name}`, entry.type === 'directory' ? directory() : file('', 1));
      files.seed(`${HOME_A}/${entry.name}`, link(`${POOL}/${entry.name}`));
    }
    files.seed(`${POOL}/projects/project/session.jsonl`, file('pooled\n', 1));
    const subject = new SharedHistoryMigration(files);

    // Act
    const actual = await subject.preview(onlyA());
    const pooledProjects = files.snapshots.filter(call => call.target === `${POOL}/projects`);
    const pooledHistory = files.snapshots.filter(call => call.target === `${POOL}/history.jsonl`);

    // Assert
    should(actual.changes.every(change => change.kind === 'already-shared')).be.true();
    should(pooledProjects).matchEvery({ recursive: false });
    should(pooledHistory).matchEvery({ readText: false });
    should(files.snapshots.some(call => call.target === `${POOL}/projects/project`)).be.false();
    should(files.snapshots.filter(call => call.target === CONFLICTS)).matchEvery({ recursive: false });
  });

  it('should treat an equivalent relative pool link as already shared', async () => {
    // Arrange
    const files = new MemorySharedHistoryFileSystem();
    files.seed(`${POOL}/projects`, directory());
    files.seed(`${HOME_A}/projects`, link(path.relative(HOME_A, `${POOL}/projects`)));
    const subject = new SharedHistoryMigration(files);

    // Act
    const actual = await subject.preview(onlyA());

    // Assert
    should(actual.changes).containDeep([
      { kind: 'already-shared', path: `${HOME_A}/projects`, target: `${POOL}/projects` },
    ]);
  });

  it('should preserve an older incoming collision and never overwrite an occupied conflict path', async () => {
    // Arrange
    const files = new MemorySharedHistoryFileSystem();
    files.seed(`${POOL}/projects`, directory({ same: file('pool\n', 20) }));
    files.seed(`${HOME_A}/projects`, directory({ same: file('incoming\n', 10) }));
    files.seed(
      CONFLICTS,
      directory({ 'account-a': directory({ projects: directory({ same: file('previous\n', 1) }) }) }),
    );
    const subject = new SharedHistoryMigration(files);

    // Act
    const actual = await subject.materialize(onlyA());

    // Assert
    should(actual.changes).containDeep([
      {
        kind: 'collision',
        winner: `${POOL}/projects/same`,
        loser: `${HOME_A}/projects/same`,
        preservedAt: `${CONFLICTS}/account-a/projects/same.1`,
      },
    ]);
    should(await files.snapshot(`${CONFLICTS}/account-a/projects/same`, { readText: true })).match({
      text: 'previous\n',
    });
    should(await files.snapshot(`${CONFLICTS}/account-a/projects/same.1`, { readText: true })).match({
      text: 'incoming\n',
    });
  });

  it('should preserve a foreign link before replacing it with the pool link', async () => {
    // Arrange
    const files = new MemorySharedHistoryFileSystem();
    files.seed(`${HOME_A}/projects`, link('/foreign/projects'));
    const subject = new SharedHistoryMigration(files);

    // Act
    const actual = await subject.materialize(onlyA());

    // Assert
    should(actual.conflicts).equal(1);
    should(await files.snapshot(`${HOME_A}/projects`)).match({ kind: 'symbolic-link', target: `${POOL}/projects` });
    should(await files.snapshot(`${CONFLICTS}/account-a/projects`)).match({
      kind: 'symbolic-link',
      target: '/foreign/projects',
    });
  });

  it('should refuse a rename that would cross a filesystem device, in the preview', async () => {
    // Arrange — a pool on another volume can only be reached by copying, which orphans open inodes.
    const otherPool = new MemorySharedHistoryFileSystem();
    otherPool.seed(POOL, directory({}, 1, 2));
    otherPool.seed(`${HOME_A}/projects`, directory({ session: file('evidence', 1) }));
    const otherConflicts = new MemorySharedHistoryFileSystem();
    otherConflicts.seed(`${POOL}/history.jsonl`, file('{"display":"pooled","timestamp":1}\n', 1));
    otherConflicts.seed(`${HOME_A}/history.jsonl`, file('{"display":"incoming","timestamp":2}\n', 2));
    otherConflicts.seed(CONFLICTS, directory({}, 1, 7));

    // Act
    const poolPromise = new SharedHistoryMigration(otherPool).preview(onlyA());
    const conflictsPromise = new SharedHistoryMigration(otherConflicts).preview(onlyA());

    // Assert
    await should(poolPromise).be.rejectedWith(/refusing a cross-device shared-history rename/u);
    await should(poolPromise).be.rejectedWith(/on device 1 and .* on device 2/u);
    await should(conflictsPromise).be.rejectedWith(/on device 1 and .* on device 7/u);
    should(otherPool.has(`${HOME_A}/projects/session`)).be.true();
    should(otherConflicts.has(`${HOME_A}/history.jsonl`)).be.true();
  });

  it('should refuse a planted non-directory ancestor beneath the conflict root', async () => {
    // Arrange — writing beneath this link would escape in a merely lexical filesystem adapter.
    const files = new MemorySharedHistoryFileSystem();
    files.seed(`${POOL}/projects`, directory({ same: file('pool\n', 20) }));
    files.seed(`${HOME_A}/projects`, directory({ same: file('incoming\n', 10) }));
    files.seed(CONFLICTS, directory({ 'account-a': link('/outside') }));

    // Act
    const promise = new SharedHistoryMigration(files).preview(onlyA());

    // Assert
    await should(promise).be.rejectedWith(/conflict parent must be a directory/u);
    should(files.has(`${HOME_A}/projects/same`)).be.true();
  });

  it('should fail closed on damaged pooled state before moving any home', async () => {
    // Arrange
    const files = new MemorySharedHistoryFileSystem();
    files.seed(`${POOL}/projects`, file('not a directory', 1));
    files.seed(`${HOME_A}/projects`, directory({ session: file('history', 1) }));
    const subject = new SharedHistoryMigration(files);

    // Act
    const promise = subject.materialize(onlyA());

    // Assert
    await should(promise).be.rejectedWith(/pooled projects must be a directory/);
    should(await files.snapshot(`${HOME_A}/projects/session`, { readText: true })).match({ text: 'history' });
  });

  it('should fail closed when a pooled directory cannot be read', async () => {
    // Arrange
    const files = new MemorySharedHistoryFileSystem();
    const failure = new Error('permission denied');
    files.failures.set(`snapshot:${POOL}/projects`, failure);
    files.seed(`${HOME_A}/projects`, directory({ session: file('history', 1) }));
    const subject = new SharedHistoryMigration(files);

    // Act
    const promise = subject.materialize(onlyA());

    // Assert
    await should(promise).be.rejectedWith(failure);
    should(files.has(`${HOME_A}/projects`)).be.true();
  });

  it('should reject unsupported entries and a non-directory conflict root as damaged evidence', async () => {
    // Arrange
    const unsupported = new MemorySharedHistoryFileSystem();
    unsupported.seed(`${HOME_A}/projects`, directory({ socket: { kind: 'other', modifiedAtMs: 1, deviceId: 1 } }));
    const badConflicts = new MemorySharedHistoryFileSystem();
    badConflicts.seed(`${HOME_A}/projects`, directory({ session: file('history', 1) }));
    badConflicts.seed(CONFLICTS, file('bad', 1));

    // Act
    const unsupportedPromise = new SharedHistoryMigration(unsupported).preview(onlyA());
    const conflictsPromise = new SharedHistoryMigration(badConflicts).preview(onlyA());

    // Assert
    await should(unsupportedPromise).be.rejectedWith(/unsupported filesystem entry/);
    await should(conflictsPromise).be.rejectedWith(/conflicts path must be a directory/);
  });

  it('should refuse a symbolic link at the pool boundary and a home that is not a directory', async () => {
    // Arrange
    const fileHome = new MemorySharedHistoryFileSystem();
    fileHome.seed(HOME_A, file('not a home', 1));
    const linkedPool = new MemorySharedHistoryFileSystem();
    linkedPool.seed(POOL, link('/foreign/pool'));

    // Act
    const homePromise = new SharedHistoryMigration(fileHome).preview(onlyA());
    const poolPromise = new SharedHistoryMigration(linkedPool).preview(onlyA());

    // Assert
    await should(homePromise).be.rejectedWith(/account home must be a directory, found file/);
    await should(poolPromise).be.rejectedWith(/pool must be a directory/);
  });

  it('should follow an account home that is a link to a real directory', async () => {
    // Arrange
    const files = new MemorySharedHistoryFileSystem();
    files.seed('/volume/home-a', directory());
    files.seed(HOME_A, link('/volume/home-a'));
    const subject = new SharedHistoryMigration(files);

    // Act
    const actual = await subject.preview(onlyA());

    // Assert — the home is usable and links are still planned at the configured path.
    should(actual.links).equal(10);
    should(actual.changes).containDeep([{ kind: 'link', path: `${HOME_A}/projects`, target: `${POOL}/projects` }]);
  });

  it('should refuse every account-home link it cannot safely stand behind, naming the link', async () => {
    // Arrange
    const dangling = new MemorySharedHistoryFileSystem();
    dangling.seed(HOME_A, link('/volume/missing'));
    const notDirectory = new MemorySharedHistoryFileSystem();
    notDirectory.seed('/volume/file', file('evidence', 1));
    notDirectory.seed(HOME_A, link('/volume/file'));
    const intoPool = new MemorySharedHistoryFileSystem();
    intoPool.seed(`${POOL}/inside`, directory());
    intoPool.seed(HOME_A, link(`${POOL}/inside`));
    const shared = new MemorySharedHistoryFileSystem();
    shared.seed('/volume/one', directory());
    shared.seed(HOME_A, link('/volume/one'));
    shared.seed(HOME_B, link('/volume/one'));
    const cycle = new MemorySharedHistoryFileSystem();
    cycle.seed('/volume/loop-a', link('/volume/loop-b'));
    cycle.seed('/volume/loop-b', link('/volume/loop-a'));
    cycle.seed(HOME_A, link('/volume/loop-a'));

    // Act
    const promises = [
      { subject: dangling, request: onlyA(), pattern: /points at a missing directory/u },
      { subject: notDirectory, request: onlyA(), pattern: /account home must be a directory, found file/u },
      { subject: intoPool, request: onlyA(), pattern: /home and pool must not overlap/u },
      { subject: shared, request: request(), pattern: /resolve to the same home directory/u },
      { subject: cycle, request: onlyA(), pattern: /too many levels of symbolic links/u },
    ].map(async testCase => ({
      promise: new SharedHistoryMigration(testCase.subject).preview(testCase.request),
      pattern: testCase.pattern,
    }));

    // Assert
    for (const testCase of promises) {
      const resolved = await testCase;
      await should(resolved.promise).be.rejectedWith(resolved.pattern);
    }
  });

  it('should see one directory reached two ways as one home, not two, before planning anything', async () => {
    // Arrange — `alias` is a link to `real`, so `real/a` and `alias/a` are the same directory. Read
    // as two homes it fabricates a collision between a file and itself and a merge of a file that
    // has already been renamed away, and the apply that follows can only fail.
    const files = new MemorySharedHistoryFileSystem();
    files.seed(
      '/volume/real/a',
      directory({
        projects: directory({ 'session.jsonl': file('evidence\n', 10) }),
        'history.jsonl': file('{"display":"one","timestamp":1}\n', 10),
      }),
    );
    files.seed('/volume/alias', link('/volume/real'));
    const subject = new SharedHistoryMigration(files);

    // Act
    const promise = subject.preview(
      request({
        homes: [
          { account: 'real', path: '/volume/real/a' },
          { account: 'alias', path: '/volume/alias/a' },
        ],
      }),
    );

    // Assert
    await should(promise).be.rejectedWith(/accounts real and alias resolve to the same home directory/u);
    should(files.has('/volume/real/a/projects/session.jsonl')).be.true();
  });

  it('should refuse homes that nest, whether the nesting is canonical or merely spelled out', async () => {
    // Arrange — one home inside another double counts the inner one exactly as an alias would.
    const canonical = new MemorySharedHistoryFileSystem();
    canonical.seed(
      '/volume/outer',
      directory({
        inner: directory(),
        projects: directory({ 'session.jsonl': file('evidence\n', 10) }),
      }),
    );
    canonical.seed('/volume/alias', link('/volume/outer'));
    const subject = new SharedHistoryMigration(canonical);
    const lexical = new SharedHistoryMigration(new MemorySharedHistoryFileSystem());

    // Act
    const canonicalPromise = subject.preview(
      request({
        homes: [
          { account: 'outer', path: '/volume/outer' },
          { account: 'inner', path: '/volume/alias/inner' },
        ],
      }),
    );
    // Neither of these exists yet, so only the pure check can catch them — and it must, because
    // provisioning is about to create both.
    const lexicalPromise = lexical.preview(
      request({
        homes: [
          { account: 'outer', path: '/state/fleet/homes/outer' },
          { account: 'inner', path: '/state/fleet/homes/outer/inner' },
        ],
      }),
    );

    // Assert
    await should(canonicalPromise).be.rejectedWith(/account homes must not contain one another/u);
    await should(lexicalPromise).be.rejectedWith(/account homes must not contain one another/u);
    should(canonical.has('/volume/outer/projects/session.jsonl')).be.true();
  });

  it('should compare a home against the pool by canonical identity, not by spelling', async () => {
    // Arrange — the pool reached through a link is still the pool.
    const files = new MemorySharedHistoryFileSystem();
    files.seed(`${POOL}/inside`, directory());
    files.seed('/volume/pool-alias', link(POOL));
    files.seed(HOME_A, link('/volume/pool-alias/inside'));
    const subject = new SharedHistoryMigration(files);

    // Act
    const promise = subject.preview(onlyA());

    // Assert
    await should(promise).be.rejectedWith(/home and pool must not overlap/u);
  });

  it('should report an unreadable home as a structured refusal and never migrate around it', async () => {
    // Arrange — an explicitly configured home outside the writable roots must not hide the plan.
    const files = new MemorySharedHistoryFileSystem();
    files.failures.set(`snapshot:${HOME_A}`, new SharedHistoryAccessRefusedError(HOME_A, [ROOT]));
    files.seed(`${HOME_B}/projects`, directory({ session: file('history', 1) }));
    const subject = new SharedHistoryMigration(files);

    // Act
    const preview = await subject.preview(request());
    const promise = subject.materialize(request());

    // Assert — the readable home is still fully planned, and applying refuses the whole migration.
    const refusals = preview.refusals ?? [];
    should(refusals).deepEqual([
      {
        account: 'account-a',
        home: HOME_A,
        path: HOME_A,
        reason: `refusing shared-history access outside configured roots: ${HOME_A}`,
      } satisfies SharedHistoryRefusal,
    ]);
    should(preview.links).equal(10);
    should(preview.changes).containDeep([{ kind: 'move', source: `${HOME_B}/projects` }]);
    await should(promise).be.rejectedWith(
      /refusing to migrate claude history while 1 account home\(s\) cannot be read/u,
    );
    should(files.has(`${HOME_B}/projects/session`)).be.true();
  });

  it('should refuse an unfinished journal with validated, actionable recovery evidence', async () => {
    // Arrange
    const files = new MemorySharedHistoryFileSystem();
    files.seed(JOURNAL, file(journalText(), 1));
    files.seed(PROGRESS, file(progressText({ completed: 1 }), 1));
    const subject = new SharedHistoryMigration(files);

    // Act
    const evidence = await subject.inspectRecovery(onlyA());
    const error = await subject.preview(onlyA()).catch(caught => caught);

    // Assert
    should(evidence).deepEqual({
      journalPath: JOURNAL,
      progressPath: PROGRESS,
      kind: 'claude',
      pool: POOL,
      state: 'applying',
      recovery: 'undo-applied-actions',
      completedAtLeast: 1,
      totalActions: 2,
      appliedActions: [{ kind: 'move', source: `${HOME_A}/projects`, destination: `${POOL}/projects` }],
      uncertainAction: { kind: 'link', path: `${HOME_A}/projects`, target: `${POOL}/projects` },
      pendingActions: [],
      rollbackFailures: [],
    } satisfies SharedHistoryRecoveryEvidence);
    should(error).be.instanceOf(SharedHistoryRecoveryRequiredError);
    should((error as SharedHistoryRecoveryRequiredError).message).match(
      /at least 1 of 2 actions applied, action 2 \(link\) may be half applied/u,
    );
    // The only record of what was applied is still on disk.
    should(files.has(JOURNAL)).be.true();
    should(files.has(PROGRESS)).be.true();
  });

  it('should treat a journal with no progress record as nothing proven applied', async () => {
    // Arrange
    const files = new MemorySharedHistoryFileSystem();
    files.seed(JOURNAL, file(journalText(), 1));
    const subject = new SharedHistoryMigration(files);

    // Act
    const evidence = await subject.inspectRecovery(onlyA());

    // Assert
    should(evidence).match({
      state: 'applying',
      completedAtLeast: 0,
      appliedActions: [],
      uncertainAction: { kind: 'move' },
      pendingActions: [{ kind: 'link' }],
    });
  });

  it('should refuse a malformed or foreign migration record rather than guess at it', async () => {
    // Arrange
    const cases = [
      { journal: 'not json at all', pattern: /migration journal is not valid JSON/u },
      { journal: journalText({ version: 2 }), pattern: /migration journal is malformed/u },
      { journal: journalText({ actions: [{ kind: 'teleport' }] }), pattern: /migration journal is malformed/u },
      { journal: journalText({ pool: '/somewhere/else' }), pattern: /belongs to a different migration/u },
      { journal: journalText({ kind: 'codex' }), pattern: /belongs to a different migration/u },
    ];

    // Act
    const promises = cases.map(testCase => {
      const files = new MemorySharedHistoryFileSystem();
      files.seed(JOURNAL, file(testCase.journal, 1));
      return { promise: new SharedHistoryMigration(files).inspectRecovery(onlyA()), pattern: testCase.pattern };
    });
    const directoryJournal = new MemorySharedHistoryFileSystem();
    directoryJournal.seed(JOURNAL, directory());
    const orphanProgress = new MemorySharedHistoryFileSystem();
    orphanProgress.seed(PROGRESS, file(progressText({ completed: 3 }), 1));

    // Assert
    for (const testCase of promises) await should(testCase.promise).be.rejectedWith(testCase.pattern);
    await should(new SharedHistoryMigration(directoryJournal).inspectRecovery(onlyA())).be.rejectedWith(
      /migration journal must be a readable file/u,
    );
    await should(new SharedHistoryMigration(orphanProgress).inspectRecovery(onlyA())).be.rejectedWith(
      /reports state applying but its journal is gone/u,
    );
  });

  it('should ignore a completed progress record whose cleanup was interrupted', async () => {
    // Arrange
    const files = new MemorySharedHistoryFileSystem();
    files.seed(PROGRESS, file(progressText({ state: 'complete', completed: 2 }), 1));
    files.seed(`${HOME_A}/projects`, directory({ session: file('history', 1) }));
    const subject = new SharedHistoryMigration(files);

    // Act
    const nothingToRecover = await subject.inspectRecovery(onlyA());
    const actual = await subject.materialize(onlyA());

    // Assert
    should(nothingToRecover).be.undefined();
    should(actual.migrated).equal(1);
    should(files.has(PROGRESS)).be.false();
  });

  it('should journal the action list once and advance only a fixed-size cursor', async () => {
    // Arrange
    const { files, subject } = seededMigration();
    const journalWrites: string[] = [];
    const progressWrites: number[] = [];
    const writeExclusive = files.writeTextExclusive.bind(files);
    const writeAtomic = files.writeTextAtomic.bind(files);
    files.writeTextExclusive = async (target, text) => {
      if (target === JOURNAL) journalWrites.push(text);
      await writeExclusive(target, text);
    };
    files.writeTextAtomic = async (target, text) => {
      if (target === PROGRESS) progressWrites.push(text.length);
      await writeAtomic(target, text);
    };

    // Act
    await subject.materialize(request());

    // Assert — one copy of the plan, and a cursor whose size never grows with it.
    should(journalWrites).have.length(1);
    should(JSON.parse(journalWrites[0] ?? '')).match({ version: 1, kind: 'claude', pool: POOL });
    should(progressWrites.length).be.greaterThan(10);
    should(Math.max(...progressWrites) - Math.min(...progressWrites)).be.lessThan(8);
    should(files.has(JOURNAL)).be.false();
    should(files.has(PROGRESS)).be.false();
  });

  it('should never undo a committed migration because its crash record would not go away', async () => {
    // Arrange
    const stuckJournal = new MemorySharedHistoryFileSystem();
    stuckJournal.seed(`${HOME_A}/projects`, directory({ session: file('history', 1) }));
    stuckJournal.failures.set(`removeFile:${JOURNAL}`, new Error('journal is read only'));
    const stuckProgress = new MemorySharedHistoryFileSystem();
    stuckProgress.seed(`${HOME_A}/projects`, directory({ session: file('history', 1) }));
    stuckProgress.failures.set(`removeFile:${PROGRESS}`, new Error('progress is read only'));

    // Act
    const journalError = await new SharedHistoryMigration(stuckJournal).materialize(onlyA()).catch(caught => caught);
    const withResidue = await new SharedHistoryMigration(stuckProgress).materialize(onlyA());
    const nextPreview = await new SharedHistoryMigration(stuckJournal).preview(onlyA()).catch(caught => caught);

    // Assert — a stuck journal is reported without touching the migrated state...
    should((journalError as Error).message).match(/completed but its journal could not be retired/u);
    should(await stuckJournal.snapshot(`${POOL}/projects/session`, { readText: true })).match({ text: 'history' });
    should(await stuckJournal.snapshot(`${HOME_A}/projects`)).match({ kind: 'symbolic-link' });
    // ...and the next plan tells the operator to clean up, never to undo a migration that landed.
    should(nextPreview).be.instanceOf(SharedHistoryRecoveryRequiredError);
    should((nextPreview as SharedHistoryRecoveryRequiredError).evidence).match({ state: 'complete' });
    should((nextPreview as SharedHistoryRecoveryRequiredError).message).match(/undo NOTHING/u);
    should((nextPreview as SharedHistoryRecoveryRequiredError).message).not.match(/undo the applied actions/u);
    // A stuck progress record on its own is harmless residue the next apply reads as finished.
    should(withResidue.migrated).equal(1);
    should(await stuckProgress.snapshot(PROGRESS, { readText: true })).match({ text: /"state":"complete"/u });
    should(stuckProgress.has(JOURNAL)).be.false();
  });

  it('should roll back and replan when a live directory gains a child after observation', async () => {
    // Arrange
    const { files, subject } = seededMigration();
    let planted = false;
    files.afterExclusiveWrite = () => {
      if (planted) return;
      planted = true;
      files.seed(`${HOME_B}/projects/project/late.jsonl`, file('late\n', 30));
    };

    // Act
    const actual = await subject.materialize(request());

    // Assert — the first attempt hit ENOTEMPTY and rolled back; the retry included the late file.
    should(planted).be.true();
    should(actual.migrated).equal(5);
    should(await files.snapshot(`${POOL}/projects/project/late.jsonl`, { readText: true })).match({ text: 'late\n' });
    should(await files.snapshot(JOURNAL)).equal(undefined);
  });

  it('should give up with the retry ceiling named when the homes never stop changing', async () => {
    // Arrange
    const { files, subject } = seededMigration();
    let attempt = 0;
    files.afterExclusiveWrite = () => {
      files.seed(`${HOME_B}/projects/project/late-${attempt++}.jsonl`, file('late\n', 30));
    };

    // Act
    const error = await subject.materialize(request()).catch(caught => caught);

    // Assert
    should(error).be.instanceOf(SharedHistoryMigrationError);
    should((error as SharedHistoryMigrationError).message).match(
      /state kept changing across 3 attempts; retry when the claude homes are idle/u,
    );
    should(attempt).equal(3);
    should((error as SharedHistoryMigrationError).rollbackFailures).deepEqual([]);
    should(files.has(JOURNAL)).be.false();
    should(files.has(`${HOME_A}/projects/project/session.jsonl`)).be.true();
  });

  it('should replan a prompt-history merge when its source changes after observation', async () => {
    // Arrange
    const { files, subject } = seededMigration();
    let appended = false;
    files.afterExclusiveWrite = () => {
      if (appended) return;
      appended = true;
      files.seed(
        `${HOME_B}/history.jsonl`,
        file('{"display":"two","timestamp":2}\n{"display":"late","timestamp":3}\n', 30),
      );
    };

    // Act
    await subject.materialize(request());

    // Assert
    should(await files.snapshot(`${POOL}/history.jsonl`, { readText: true })).match({
      text: [
        '{"display":"one","timestamp":1}',
        '{"display":"two","timestamp":2}',
        '{"display":"late","timestamp":3}',
        '',
      ].join('\n'),
    });
  });

  it('should roll every completed rename back when a later link cannot be created', async () => {
    // Arrange
    const { files, subject } = seededMigration();
    // Fail after the prompt-history merge so its same-inode rewrite must be undone too.
    files.failures.set(`createSymbolicLink:${HOME_B}/history.jsonl`, new Error('link refused'));

    // Act
    const promise = subject.materialize(request());

    // Assert
    await should(promise).be.rejectedWith(SharedHistoryMigrationError);
    should(await files.snapshot(`${HOME_A}/projects/project/session.jsonl`, { readText: true })).match({
      text: 'older\n',
    });
    should(await files.snapshot(`${HOME_B}/projects/project/session.jsonl`, { readText: true })).match({
      text: 'newer\n',
    });
    should(await files.snapshot(`${HOME_A}/projects`)).match({ kind: 'directory' });
    should(await files.snapshot(`${HOME_B}/projects`)).match({ kind: 'directory' });
    should(files.has(JOURNAL)).be.false();
    should(files.has(PROGRESS)).be.false();
  });

  it('should report rollback failures in the progress record without deleting either surviving copy', async () => {
    // Arrange
    const files = new MemorySharedHistoryFileSystem();
    files.seed(`${HOME_A}/projects`, directory({ session: file('history', 1) }));
    files.failures.set(`createSymbolicLink:${HOME_A}/sessions`, new Error('later link refused'));
    files.failures.set(`move:${POOL}/projects->${HOME_A}/projects`, new Error('restore refused'));
    const subject = new SharedHistoryMigration(files);

    // Act
    const error = await subject.materialize(onlyA()).catch(caught => caught);

    // Assert
    should(error).be.instanceOf(SharedHistoryMigrationError);
    should((error as SharedHistoryMigrationError).rollbackFailures).deepEqual(['restore refused']);
    should(files.has(`${POOL}/projects/session`)).be.true();
    should(files.has(JOURNAL)).be.true();
    should(await files.snapshot(PROGRESS, { readText: true })).match({
      kind: 'file',
      text: /"state":"rollback-incomplete"/u,
    });
  });

  it('should say a stuck crash record was fully reversed, never that it should be undone', async () => {
    // Arrange
    const files = new MemorySharedHistoryFileSystem();
    files.seed(`${HOME_A}/projects`, directory({ session: file('history', 1) }));
    files.failures.set(`createSymbolicLink:${HOME_A}/sessions`, new Error('later link refused'));
    files.failures.set(`removeFile:${JOURNAL}`, new Error('journal is read only'));
    const subject = new SharedHistoryMigration(files);

    // Act
    const error = await subject.materialize(onlyA()).catch(caught => caught);
    const evidence = await subject.inspectRecovery(onlyA());
    const nextPreview = await subject.preview(onlyA()).catch(caught => caught);

    // Assert — the rollback itself was clean, so the failure is only about the record.
    should((error as SharedHistoryMigrationError).rollbackFailures).deepEqual([
      'could not remove the migration crash record after rollback: journal is read only',
    ]);
    should(files.has(JOURNAL)).be.true();
    should(await files.snapshot(`${HOME_A}/projects/session`, { readText: true })).match({ text: 'history' });
    // The record that survived says what is true, so nobody is told to reverse reversed work.
    should(await files.snapshot(PROGRESS, { readText: true })).match({ text: /"state":"rolled-back"/u });
    should(evidence).match({
      state: 'rolled-back',
      recovery: 'none',
      appliedActions: [],
      uncertainAction: undefined,
      pendingActions: [],
    });
    should((nextPreview as SharedHistoryRecoveryRequiredError).message).match(/were all undone, so undo NOTHING/u);
    should((nextPreview as SharedHistoryRecoveryRequiredError).message).not.match(/undo the applied actions/u);
  });

  it('should report a rollback it could not record and delete nothing', async () => {
    // Arrange — if the truth cannot be written down, the stale record is worth more than tidiness.
    const files = new MemorySharedHistoryFileSystem();
    files.seed(`${HOME_A}/projects`, directory({ session: file('history', 1) }));
    files.failures.set(`createSymbolicLink:${HOME_A}/sessions`, new Error('later link refused'));
    const writeAtomic = files.writeTextAtomic.bind(files);
    files.writeTextAtomic = async (target, text) => {
      if (text.includes('rolled-back')) throw new Error('progress is read only');
      await writeAtomic(target, text);
    };
    const subject = new SharedHistoryMigration(files);

    // Act
    const error = await subject.materialize(onlyA()).catch(caught => caught);

    // Assert
    should((error as SharedHistoryMigrationError).rollbackFailures).match([
      /reversed every action but could not record that durably: progress is read only/u,
    ]);
    should(files.has(JOURNAL)).be.true();
    should(files.has(PROGRESS)).be.true();
    should(await files.snapshot(`${HOME_A}/projects/session`, { readText: true })).match({ text: 'history' });
  });

  it('should send an ensured file home on rollback instead of unlinking it', async () => {
    // Arrange — a harness can append through the link this migration just made, and no size check
    // before an unlink closes that window, so the file is moved rather than removed either way.
    const grown = new MemorySharedHistoryFileSystem();
    grown.failures.set(`createSymbolicLink:${HOME_A}/history.jsonl`, new Error('last link refused'));
    const appended = grown.ensureFile.bind(grown);
    grown.ensureFile = async target => {
      await appended(target);
      if (target === `${POOL}/history.jsonl`) grown.seed(target, file('{"display":"live","timestamp":9}\n', 9));
    };
    const empty = new MemorySharedHistoryFileSystem();
    empty.failures.set(`createSymbolicLink:${HOME_A}/history.jsonl`, new Error('last link refused'));

    // Act
    await new SharedHistoryMigration(grown).materialize(onlyA()).catch(() => undefined);
    await new SharedHistoryMigration(empty).materialize(onlyA()).catch(() => undefined);

    // Assert — the bytes that arrived are in the account home, not deleted.
    should(grown.has(`${POOL}/history.jsonl`)).be.false();
    should(await grown.snapshot(`${HOME_A}/history.jsonl`, { readText: true })).match({
      text: '{"display":"live","timestamp":9}\n',
    });
    // An empty one is moved home too rather than unlinked: the rule does not depend on the size.
    should(empty.has(`${POOL}/history.jsonl`)).be.false();
    should(await empty.snapshot(`${HOME_A}/history.jsonl`, { readText: true })).match({ text: '' });
    // Empty directories are still taken back, because rmdir cannot take one that holds anything.
    should(empty.has(`${POOL}/projects`)).be.false();
    should(empty.has(`${HOME_A}/projects`)).be.false();
  });

  it('should record a failure to update the progress record after an incomplete rollback', async () => {
    // Arrange
    const files = new MemorySharedHistoryFileSystem();
    files.seed(`${HOME_A}/projects`, directory({ session: file('history', 1) }));
    files.failures.set(`createSymbolicLink:${HOME_A}/sessions`, new Error('later link refused'));
    files.failures.set(`move:${POOL}/projects->${HOME_A}/projects`, new Error('restore refused'));
    const writeAtomic = files.writeTextAtomic.bind(files);
    files.writeTextAtomic = async (target, text) => {
      if (text.includes('rollback-incomplete')) throw new Error('progress is read only');
      await writeAtomic(target, text);
    };
    const subject = new SharedHistoryMigration(files);

    // Act
    const error = await subject.materialize(onlyA()).catch(caught => caught);

    // Assert
    should((error as SharedHistoryMigrationError).rollbackFailures).deepEqual([
      'restore refused',
      'could not update migration progress record: progress is read only',
    ]);
  });

  it('should reverse a mutation that changed the filesystem and only then reported failure', async () => {
    // Arrange — a rename that succeeded and failed to sync its parent is still a rename, so the
    // undo has to be registered before the mutation rather than after it returns.
    const files = new MemorySharedHistoryFileSystem();
    files.seed(`${HOME_A}/projects`, directory({ session: file('history', 1) }));
    const realMove = files.move.bind(files);
    let sabotaged = false;
    files.move = async (source, destination) => {
      await realMove(source, destination);
      if (sabotaged) return;
      sabotaged = true;
      throw new Error('rename landed but its directory sync failed');
    };
    const subject = new SharedHistoryMigration(files);

    // Act
    const error = await subject.materialize(onlyA()).catch(caught => caught);

    // Assert — the half-applied rename was found and reversed, so no crash record has to survive.
    should(error).be.instanceOf(SharedHistoryMigrationError);
    should((error as SharedHistoryMigrationError).rollbackFailures).deepEqual([]);
    should(await files.snapshot(`${HOME_A}/projects/session`, { readText: true })).match({ text: 'history' });
    should(files.has(`${POOL}/projects`)).be.false();
    should(files.has(JOURNAL)).be.false();
    should(files.has(PROGRESS)).be.false();
  });

  it('should keep the crash record when an append never reported success', async () => {
    // Arrange — a partial append can leave half a JSONL line, and nothing may erase the evidence.
    const files = new MemorySharedHistoryFileSystem();
    files.seed(`${POOL}/history.jsonl`, file('{"display":"pooled","timestamp":1}\n', 1));
    files.seed(`${HOME_A}/history.jsonl`, file('{"display":"account","timestamp":2}\n', 2));
    const realAppend = files.appendTextIfPrefix.bind(files);
    files.appendTextIfPrefix = async (target, expected, addition) => {
      await realAppend(target, expected, addition);
      throw new Error('append landed but its sync failed');
    };
    const subject = new SharedHistoryMigration(files);

    // Act
    const error = await subject.materialize(onlyA()).catch(caught => caught);

    // Assert — the account's file is back and its pooled lines are deliberately kept, but the
    // rollback is reported as incomplete so the journal survives for a person to check.
    should((error as SharedHistoryMigrationError).rollbackFailures).match([
      /cannot undo a partial append to .*history\.jsonl/u,
    ]);
    should(files.has(JOURNAL)).be.true();
    should(await files.snapshot(PROGRESS, { readText: true })).match({ text: /"state":"rollback-incomplete"/u });
    should(await files.snapshot(`${HOME_A}/history.jsonl`, { readText: true })).match({
      text: '{"display":"account","timestamp":2}\n',
    });
    should(await files.snapshot(`${POOL}/history.jsonl`, { readText: true })).match({
      text: '{"display":"pooled","timestamp":1}\n{"display":"account","timestamp":2}\n',
    });
  });

  it('should replan when the pooled history stopped starting with what the plan observed', async () => {
    // Arrange — a refused append proves nothing was written, so a clean rollback may simply retry.
    const files = new MemorySharedHistoryFileSystem();
    files.seed(`${POOL}/history.jsonl`, file('{"display":"pooled","timestamp":1}\n', 1));
    files.seed(`${HOME_A}/history.jsonl`, file('{"display":"account","timestamp":2}\n', 2));
    const realMove = files.move.bind(files);
    let rewritten = false;
    files.move = async (source, destination) => {
      await realMove(source, destination);
      if (rewritten || !source.endsWith('history.jsonl')) return;
      rewritten = true;
      files.seed(`${POOL}/history.jsonl`, file('{"display":"rewritten","timestamp":9}\n', 9));
    };
    const subject = new SharedHistoryMigration(files);

    // Act
    await subject.materialize(onlyA());

    // Assert — the retry planned against what is actually pooled and appended onto it.
    should(rewritten).be.true();
    should(await files.snapshot(`${POOL}/history.jsonl`, { readText: true })).match({
      text: '{"display":"rewritten","timestamp":9}\n{"display":"account","timestamp":2}\n',
    });
    should(files.has(JOURNAL)).be.false();
  });

  it('should skip the undo of an entry that was never created and remove the ones that were', async () => {
    // Arrange
    const failedCreate = new MemorySharedHistoryFileSystem();
    failedCreate.seed(`${HOME_A}/projects`, directory({ session: file('history', 1) }));
    failedCreate.failures.set(`ensureDirectory:${POOL}/sessions`, new Error('cannot create'));
    const lastLink = new MemorySharedHistoryFileSystem();
    lastLink.failures.set(`createSymbolicLink:${HOME_A}/history.jsonl`, new Error('last link refused'));

    // Act
    const failedCreateError = await new SharedHistoryMigration(failedCreate)
      .materialize(onlyA())
      .catch(caught => caught);
    const lastLinkError = await new SharedHistoryMigration(lastLink).materialize(onlyA()).catch(caught => caught);

    // Assert — a pre-registered undo for an entry that never appeared reverses nothing and reports
    // nothing, while every entry that did appear, file or directory, is taken back out.
    should((failedCreateError as SharedHistoryMigrationError).rollbackFailures).deepEqual([]);
    should(await failedCreate.snapshot(`${HOME_A}/projects/session`, { readText: true })).match({ text: 'history' });
    should(failedCreate.has(`${POOL}/sessions`)).be.false();
    should((lastLinkError as SharedHistoryMigrationError).rollbackFailures).deepEqual([]);
    should(lastLink.has(`${POOL}/history.jsonl`)).be.false();
    should(lastLink.has(`${POOL}/projects`)).be.false();
  });

  it('should refuse unsafe, duplicate, relative, and overlapping requests before observation', async () => {
    // Arrange
    const subject = new SharedHistoryMigration(new MemorySharedHistoryFileSystem());
    const cases: readonly SharedHistoryRequest[] = [
      request({ poolRoot: 'relative' }),
      request({ homes: [{ account: '../escape', path: HOME_A }] }),
      // A leading dot would let an account claim the reserved pooled-loser directory.
      request({ homes: [{ account: '.pooled', path: HOME_A }] }),
      request({
        homes: [
          { account: 'same', path: HOME_A },
          { account: 'same', path: HOME_B },
        ],
      }),
      request({
        homes: [
          { account: 'one', path: HOME_A },
          { account: 'two', path: HOME_A },
        ],
      }),
      request({ homes: [{ account: 'pool', path: `${ROOT}/claude/nested` }] }),
    ];

    // Act
    const promises = cases.map(async input => await subject.preview(input));

    // Assert
    for (const promise of promises) await should(promise).be.rejected();
  });
});
