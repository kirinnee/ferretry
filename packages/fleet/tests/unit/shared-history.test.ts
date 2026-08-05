import { describe, it } from 'bun:test';
import path from 'node:path';
import should from 'should';
import {
  mergeSharedHistoryJsonl,
  type SharedHistoryFileSystem,
  SharedHistoryMigration,
  SharedHistoryMigrationError,
  type SharedHistoryNode,
  sharedHistoryEntries,
  type SharedHistoryRequest,
} from '../../src/lib/shared-history.ts';

type FlatNode =
  | { readonly kind: 'file'; readonly modifiedAtMs: number; readonly text: string }
  | { readonly kind: 'directory'; readonly modifiedAtMs: number }
  | { readonly kind: 'symbolic-link'; readonly modifiedAtMs: number; readonly target: string }
  | { readonly kind: 'other'; readonly modifiedAtMs: number };

class MemorySharedHistoryFileSystem implements SharedHistoryFileSystem {
  private readonly nodes = new Map<string, FlatNode>();
  readonly failures = new Map<string, Error>();

  seed(target: string, node: SharedHistoryNode): void {
    if (node.kind === 'directory') {
      this.nodes.set(target, { kind: 'directory', modifiedAtMs: node.modifiedAtMs });
      for (const [name, child] of Object.entries(node.children)) this.seed(path.join(target, name), child);
      return;
    }
    this.nodes.set(
      target,
      node.kind === 'file' ? { kind: 'file', modifiedAtMs: node.modifiedAtMs, text: node.text ?? '' } : { ...node },
    );
  }

  has(target: string): boolean {
    return this.nodes.has(target);
  }

  async snapshot(
    target: string,
    options: { readonly readText?: boolean; readonly recursive?: boolean } = {},
  ): Promise<SharedHistoryNode | undefined> {
    const failure = this.failures.get(`snapshot:${target}`);
    if (failure) throw failure;
    const node = this.nodes.get(target);
    if (!node) return undefined;
    if (node.kind === 'file') {
      return {
        kind: 'file',
        modifiedAtMs: node.modifiedAtMs,
        size: new TextEncoder().encode(node.text).byteLength,
        ...(options.readText ? { text: node.text } : {}),
      };
    }
    if (node.kind !== 'directory') return node;
    const children: Record<string, SharedHistoryNode> = {};
    if (options.recursive === false) return { kind: 'directory', modifiedAtMs: node.modifiedAtMs, children };
    for (const [candidate] of [...this.nodes].sort(([left], [right]) => left.localeCompare(right))) {
      if (path.dirname(candidate) !== target) continue;
      const child = await this.snapshot(candidate);
      if (child) children[path.basename(candidate)] = child;
    }
    return { kind: 'directory', modifiedAtMs: node.modifiedAtMs, children };
  }

  async ensureDirectory(target: string): Promise<boolean> {
    this.throwIfFailed('ensureDirectory', target);
    const existing = this.nodes.get(target);
    if (existing) {
      if (existing.kind !== 'directory') throw new Error(`not a directory: ${target}`);
      return false;
    }
    this.nodes.set(target, { kind: 'directory', modifiedAtMs: 0 });
    return true;
  }

  async ensureFile(target: string): Promise<boolean> {
    this.throwIfFailed('ensureFile', target);
    const existing = this.nodes.get(target);
    if (existing) {
      if (existing.kind !== 'file') throw new Error(`not a file: ${target}`);
      return false;
    }
    this.nodes.set(target, { kind: 'file', modifiedAtMs: 0, text: '' });
    return true;
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
    this.nodes.set(target, { kind: 'file', modifiedAtMs: 1, text });
  }

  async createSymbolicLink(target: string, destination: string): Promise<void> {
    this.throwIfFailed('createSymbolicLink', destination);
    if (this.nodes.has(destination)) throw new Error(`occupied: ${destination}`);
    this.nodes.set(destination, { kind: 'symbolic-link', modifiedAtMs: 0, target });
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
      throw new Error(`not empty: ${target}`);
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
): SharedHistoryNode => ({ kind: 'directory', modifiedAtMs, children });

const file = (text: string, modifiedAtMs: number): SharedHistoryNode => ({
  kind: 'file',
  modifiedAtMs,
  size: new TextEncoder().encode(text).byteLength,
  text,
});

const ROOT = '/state/fleet/shared';
const POOL = `${ROOT}/claude`;
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

  it('should merge prompt history by timestamp, dedupe lines, and retain malformed evidence', () => {
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
});

describe('SharedHistoryMigration', () => {
  it('should preview every existing move, collision winner, preserved loser, and link without writing', async () => {
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
    should(actual.changes).containDeep([
      {
        kind: 'collision',
        incoming: `${HOME_B}/projects/project/session.jsonl`,
        pooled: `${POOL}/projects/project/session.jsonl`,
        winner: `${HOME_B}/projects/project/session.jsonl`,
        loser: `${POOL}/projects/project/session.jsonl`,
        preservedAt: `${POOL}/.migration-conflicts/account-b/projects/project/session.jsonl`,
      },
      {
        kind: 'merge-jsonl',
        source: `${HOME_B}/history.jsonl`,
        destination: `${POOL}/history.jsonl`,
        sourcePreservedAt: `${POOL}/.migration-conflicts/account-b/history.jsonl`,
      },
    ]);
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
    should(
      await files.snapshot(`${POOL}/.migration-conflicts/account-b/projects/project/session.jsonl`, {
        readText: true,
      }),
    ).match({ kind: 'file', text: 'older\n' });
    should(await files.snapshot(`${POOL}/history.jsonl`, { readText: true })).match({
      kind: 'file',
      text: '{"display":"one","timestamp":1}\n{"display":"two","timestamp":2}\n',
    });
    should(await files.snapshot(`${POOL}/.migration-conflicts/account-b/history.jsonl`, { readText: true })).match({
      kind: 'file',
      text: '{"display":"two","timestamp":2}\n{"display":"one","timestamp":1}\n',
    });
  });

  it('should be idempotent and heal a missing target behind an existing pool link', async () => {
    // Arrange
    const files = new MemorySharedHistoryFileSystem();
    files.seed(`${HOME_A}/projects`, { kind: 'symbolic-link', modifiedAtMs: 1, target: `${POOL}/projects` });
    const subject = new SharedHistoryMigration(files);

    // Act
    const first = await subject.materialize(request({ homes: [{ account: 'account-a', path: HOME_A }] }));
    const second = await subject.preview(request({ homes: [{ account: 'account-a', path: HOME_A }] }));

    // Assert
    should(first.changes).containDeep([{ kind: 'create-pooled-entry', path: `${POOL}/projects` }]);
    should(second.migrated).equal(0);
    should(second.conflicts).equal(0);
    should(second.links).equal(0);
    should(await files.snapshot(`${POOL}/projects`)).match({ kind: 'directory' });
  });

  it('should treat an equivalent relative pool link as already shared', async () => {
    // Arrange
    const files = new MemorySharedHistoryFileSystem();
    files.seed(`${POOL}/projects`, directory());
    files.seed(`${HOME_A}/projects`, {
      kind: 'symbolic-link',
      modifiedAtMs: 1,
      target: path.relative(HOME_A, `${POOL}/projects`),
    });
    const subject = new SharedHistoryMigration(files);

    // Act
    const actual = await subject.preview(request({ homes: [{ account: 'account-a', path: HOME_A }] }));

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
      `${POOL}/.migration-conflicts`,
      directory({
        'account-a': directory({ projects: directory({ same: file('previous\n', 1) }) }),
      }),
    );
    const subject = new SharedHistoryMigration(files);

    // Act
    const actual = await subject.materialize(request({ homes: [{ account: 'account-a', path: HOME_A }] }));

    // Assert
    should(actual.changes).containDeep([
      {
        kind: 'collision',
        winner: `${POOL}/projects/same`,
        loser: `${HOME_A}/projects/same`,
        preservedAt: `${POOL}/.migration-conflicts/account-a/projects/same.1`,
      },
    ]);
    should(await files.snapshot(`${POOL}/.migration-conflicts/account-a/projects/same`, { readText: true })).match({
      text: 'previous\n',
    });
    should(await files.snapshot(`${POOL}/.migration-conflicts/account-a/projects/same.1`, { readText: true })).match({
      text: 'incoming\n',
    });
  });

  it('should preserve a foreign link before replacing it with the pool link', async () => {
    // Arrange
    const files = new MemorySharedHistoryFileSystem();
    files.seed(`${HOME_A}/projects`, { kind: 'symbolic-link', modifiedAtMs: 1, target: '/foreign/projects' });
    const subject = new SharedHistoryMigration(files);

    // Act
    const actual = await subject.materialize(request({ homes: [{ account: 'account-a', path: HOME_A }] }));

    // Assert
    should(actual.conflicts).equal(1);
    should(await files.snapshot(`${HOME_A}/projects`)).match({ kind: 'symbolic-link', target: `${POOL}/projects` });
    should(await files.snapshot(`${POOL}/.migration-conflicts/account-a/projects`)).match({
      kind: 'symbolic-link',
      target: '/foreign/projects',
    });
  });

  it('should fail closed on damaged pooled state before moving any home', async () => {
    // Arrange
    const files = new MemorySharedHistoryFileSystem();
    files.seed(`${POOL}/projects`, file('not a directory', 1));
    files.seed(`${HOME_A}/projects`, directory({ session: file('history', 1) }));
    const subject = new SharedHistoryMigration(files);

    // Act
    const promise = subject.materialize(request({ homes: [{ account: 'account-a', path: HOME_A }] }));

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
    const promise = subject.materialize(request({ homes: [{ account: 'account-a', path: HOME_A }] }));

    // Assert
    await should(promise).be.rejectedWith(failure);
    should(files.has(`${HOME_A}/projects`)).be.true();
  });

  it('should reject unsupported entries and a non-directory conflict root as damaged evidence', async () => {
    // Arrange
    const unsupported = new MemorySharedHistoryFileSystem();
    unsupported.seed(`${HOME_A}/projects`, directory({ socket: { kind: 'other', modifiedAtMs: 1 } }));
    const badConflicts = new MemorySharedHistoryFileSystem();
    badConflicts.seed(`${POOL}/.migration-conflicts`, file('bad', 1));

    // Act
    const unsupportedPromise = new SharedHistoryMigration(unsupported).preview(
      request({ homes: [{ account: 'account-a', path: HOME_A }] }),
    );
    const conflictsPromise = new SharedHistoryMigration(badConflicts).preview(
      request({ homes: [{ account: 'account-a', path: HOME_A }] }),
    );

    // Assert
    await should(unsupportedPromise).be.rejectedWith(/unsupported filesystem entry/);
    await should(conflictsPromise).be.rejectedWith(/conflicts path must be a directory/);
  });

  it('should refuse symbolic links at either the account-home or pool boundary', async () => {
    // Arrange
    const linkedHome = new MemorySharedHistoryFileSystem();
    linkedHome.seed(HOME_A, { kind: 'symbolic-link', modifiedAtMs: 1, target: '/foreign/home' });
    const linkedPool = new MemorySharedHistoryFileSystem();
    linkedPool.seed(POOL, { kind: 'symbolic-link', modifiedAtMs: 1, target: '/foreign/pool' });

    // Act
    const homePromise = new SharedHistoryMigration(linkedHome).preview(
      request({ homes: [{ account: 'account-a', path: HOME_A }] }),
    );
    const poolPromise = new SharedHistoryMigration(linkedPool).preview(
      request({ homes: [{ account: 'account-a', path: HOME_A }] }),
    );

    // Assert
    await should(homePromise).be.rejectedWith(/account home must be a directory/);
    await should(poolPromise).be.rejectedWith(/pool must be a directory/);
  });

  it('should roll every completed rename back when a later link cannot be created', async () => {
    // Arrange
    const { files, subject } = seededMigration();
    files.failures.set(`createSymbolicLink:${HOME_B}/projects`, new Error('link refused'));

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
  });

  it('should report rollback failures without deleting either surviving copy', async () => {
    // Arrange
    const files = new MemorySharedHistoryFileSystem();
    files.seed(`${HOME_A}/projects`, directory({ session: file('history', 1) }));
    files.failures.set(`createSymbolicLink:${HOME_A}/sessions`, new Error('later link refused'));
    files.failures.set(`move:${POOL}/projects->${HOME_A}/projects`, new Error('restore refused'));
    const subject = new SharedHistoryMigration(files);

    // Act
    const error = await subject
      .materialize(request({ homes: [{ account: 'account-a', path: HOME_A }] }))
      .catch(caught => caught);

    // Assert
    should(error).be.instanceOf(SharedHistoryMigrationError);
    should((error as SharedHistoryMigrationError).rollbackFailures).deepEqual(['restore refused']);
    should(files.has(`${POOL}/projects/session`)).be.true();
  });

  it('should refuse unsafe, duplicate, relative, and overlapping requests before observation', async () => {
    // Arrange
    const subject = new SharedHistoryMigration(new MemorySharedHistoryFileSystem());
    const cases: readonly SharedHistoryRequest[] = [
      request({ poolRoot: 'relative' }),
      request({ homes: [{ account: '../escape', path: HOME_A }] }),
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
