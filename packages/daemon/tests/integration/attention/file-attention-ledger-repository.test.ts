import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import should from 'should';
import {
  FileAttentionLedgerRepository,
  InvalidAttentionLedgerError,
} from '../../../src/adapters/attention/file-attention-ledger-repository.ts';
import type { AttentionMutation } from '../../../src/lib/attention/index.ts';
import { AttentionService } from '../../../src/lib/attention/service.ts';

const homes: string[] = [];

async function createRepository(): Promise<{
  readonly home: string;
  readonly repository: FileAttentionLedgerRepository;
}> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-attention-'));
  homes.push(home);
  return {
    home,
    repository: new FileAttentionLedgerRepository(sessionId => join(home, 'sessions', sessionId)),
  };
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map(async home => await rm(home, { recursive: true, force: true })));
});

const request = {
  source: 'agent-raised' as const,
  sourceRef: null,
  subject: 'Choose deployment region',
  why: 'The rollout is blocked.',
  howToResolve: 'Choose a region.',
  ask: {
    kind: 'multiple-choice' as const,
    options: [{ label: 'eu' }, { label: 'us' }],
  },
};

describe('FileAttentionLedgerRepository', () => {
  it('should atomically persist and reload lifecycle state below the injected session directory', async () => {
    // Arrange
    const { repository } = await createRepository();
    const service = new AttentionService(
      repository,
      { now: () => '2026-07-31T10:00:00Z' },
      { has: async sessionId => sessionId === 'session-1' },
      { raised: async () => undefined },
    );

    // Act
    const created = await service.raise('session-1', request, {
      kind: 'agent',
      sessionId: 'session-1',
      name: 'Ada',
    });
    const listed = await service.list('session-1');
    const text = await readFile(repository.file('session-1'), 'utf8');

    // Assert
    should(created).containDeep({
      ok: true,
      change: 'created',
      snapshot: { count: 1 },
    });
    should(listed).containDeep({
      ok: true,
      value: { count: 1, items: [{ id: 'A1', subject: request.subject }] },
    });
    should(JSON.parse(text)).containDeep({ sessionId: 'session-1', nextId: 2 });
  });

  it('should serialize concurrent mutations so no attention item is lost', async () => {
    // Arrange
    const { repository } = await createRepository();
    const service = new AttentionService(
      repository,
      { now: () => '2026-07-31T10:00:00Z' },
      { has: async sessionId => sessionId === 'session-1' },
      { raised: async () => undefined },
    );

    // Act
    await Promise.all(
      Array.from(
        { length: 5 },
        async (_, index) =>
          await service.raise(
            'session-1',
            { ...request, subject: `Choose deployment region ${index}` },
            { kind: 'agent', sessionId: 'session-1', name: 'Ada' },
          ),
      ),
    );
    const listed = await service.list('session-1');

    // Assert
    should(listed).containDeep({ ok: true, value: { count: 5 } });
    if (!listed.ok) throw new Error(listed.error.message);
    should(listed.value.items.map(item => item.id)).deepEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
  });

  it('should refuse malformed durable state instead of overwriting it as an empty board', async () => {
    // Arrange
    const { repository } = await createRepository();
    const file = repository.file('session-1');
    await mkdir(dirname(file), { recursive: true });
    await Bun.write(file, '{not json');

    // Act + Assert
    await repository.read('session-1').then(
      () => {
        throw new Error('expected corrupt ledger to reject');
      },
      error => should(error instanceof InvalidAttentionLedgerError).be.true(),
    );
  });

  it('should reject invalid session paths before touching the filesystem', async () => {
    // Arrange
    const { home, repository } = await createRepository();

    // Act + Assert
    should(() => repository.file('../session')).throw(/not a valid agenda session id/u);
    await writeFile(join(home, 'sentinel'), 'safe');
    should(await Bun.file(join(home, 'sentinel')).text()).equal('safe');
  });

  it('should surface a read failure that is not a missing file instead of treating the board as empty', async () => {
    // Arrange — the board's place is taken by a directory, so reading it fails with something other than ENOENT.
    const { repository } = await createRepository();
    await mkdir(repository.file('session-1'), { recursive: true });

    // Act
    const failure = await repository.read('session-1').then(
      () => undefined,
      error => error as NodeJS.ErrnoException,
    );

    // Assert
    should(failure).not.be.undefined();
    should(failure instanceof InvalidAttentionLedgerError).be.false();
    should(failure?.code).equal('EISDIR');
  });

  it('should remove its temporary file and rethrow when the write fails', async () => {
    // Arrange — the temporary name is already taken, so the exclusive create fails.
    const home = await mkdtemp(join(tmpdir(), 'ferretry-attention-'));
    homes.push(home);
    const repository = new FileAttentionLedgerRepository(
      sessionId => join(home, 'sessions', sessionId),
      () => 'fixed',
    );
    const directory = dirname(repository.file('session-1'));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, '.attention-fixed.tmp'), 'squatter');
    const service = new AttentionService(
      repository,
      { now: () => '2026-07-31T10:00:00Z' },
      { has: async sessionId => sessionId === 'session-1' },
      { raised: async () => undefined },
    );

    // Act
    const failure = await service
      .raise('session-1', request, {
        kind: 'agent',
        sessionId: 'session-1',
        name: 'Ada',
      })
      .then(
        () => undefined,
        error => error as NodeJS.ErrnoException,
      );

    // Assert
    should(failure?.code).equal('EEXIST');
    should(await readdir(directory)).deepEqual([]);
  });

  it('should let the next mutation proceed after one that throws', async () => {
    // Arrange
    const { repository } = await createRepository();
    const failing = repository.transact('session-1', () => {
      throw new Error('apply refused');
    });

    // Act
    const failure = await failing.then(
      () => undefined,
      error => error as Error,
    );
    const next = await repository.transact('session-1', current => {
      should(current).be.null();
      return {
        ok: false,
        error: { code: 'not_found', message: 'nothing here' },
      } as unknown as AttentionMutation;
    });

    // Assert
    should(failure?.message).equal('apply refused');
    should(next.ok).be.false();
  });
});
