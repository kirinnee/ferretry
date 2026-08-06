import { describe, it } from 'bun:test';
import type {
  AttentionLedger,
  AttentionLedgerRepository,
  AttentionMutation,
  AttentionRaisedObserver,
} from '../../../src/lib/attention/index.ts';
import { AttentionService, isAttentionSessionId } from '../../../src/lib/attention/service.ts';
import should from 'should';

const SESSION = 'session-1';
const NOW = '2026-07-31T10:00:00Z';
const AGENT = { kind: 'agent' as const, sessionId: SESSION, name: 'Ada' };

class MemoryRepository implements AttentionLedgerRepository {
  readonly ledgers = new Map<string, AttentionLedger>();

  async read(sessionId: string): Promise<AttentionLedger | null> {
    return this.ledgers.get(sessionId) ?? null;
  }

  async transact(
    sessionId: string,
    apply: (current: AttentionLedger | null) => AttentionMutation,
  ): Promise<AttentionMutation> {
    const mutation = apply(await this.read(sessionId));
    if (mutation.ok && mutation.changed) this.ledgers.set(sessionId, mutation.ledger);
    return mutation;
  }
}

class Observer implements AttentionRaisedObserver {
  readonly calls: Array<{ sessionId: string; itemId: string; count: number }> = [];

  async raised(sessionId: string, item: { id: string }, snapshot: { count: number }): Promise<void> {
    this.calls.push({ sessionId, itemId: item.id, count: snapshot.count });
  }
}

function createService(
  repository = new MemoryRepository(),
  observer: AttentionRaisedObserver = new Observer(),
): {
  readonly repository: MemoryRepository;
  readonly service: AttentionService;
  readonly observer: AttentionRaisedObserver;
} {
  return {
    repository,
    observer,
    service: new AttentionService(
      repository,
      { now: () => NOW },
      { has: async sessionId => sessionId === SESSION },
      observer,
    ),
  };
}

const request = {
  source: 'agent-raised' as const,
  sourceRef: null,
  subject: 'Approve release?',
  why: 'It is ready to deploy.',
  howToResolve: 'Approve or reject it.',
  ask: { kind: 'permission' as const },
};

describe('Attention service', () => {
  it('should validate session identifiers before reading or mutating storage', async () => {
    // Arrange
    const { repository, service } = createService();

    // Act
    const listed = await service.list('../escape');
    const counted = await service.count('');
    const raised = await service.raise('../escape', request, AGENT);

    // Assert
    should(listed).containDeep({ ok: false, error: { code: 'invalid' } });
    should(counted).containDeep({ ok: false, error: { code: 'invalid' } });
    should(raised).containDeep({ ok: false, error: { code: 'invalid' } });
    should(repository.ledgers.size).equal(0);
  });

  it('should list and count an absent board without creating durable state', async () => {
    // Arrange
    const { repository, service } = createService();

    // Act
    const listed = await service.list(SESSION);
    const counted = await service.count(SESSION);

    // Assert
    should(listed).containDeep({ ok: true, value: { sessionId: SESSION, count: 0, items: [], resolved: [] } });
    should(counted).deepEqual({ ok: true, value: 0 });
    should(repository.ledgers.size).equal(0);
  });

  it('should refuse an unknown session instead of treating its missing ledger as empty', async () => {
    // Arrange
    const { repository, service } = createService();

    // Act
    const listed = await service.list('missing-session');
    const raised = await service.raise('missing-session', request, {
      kind: 'agent',
      sessionId: 'missing-session',
      name: 'Ada',
    });

    // Assert
    should(listed).containDeep({ ok: false, error: { code: 'not-found' } });
    should(raised).containDeep({ ok: false, error: { code: 'not-found' } });
    should(repository.ledgers.size).equal(0);
  });

  it('should refuse a cross-session agent before storage is read or mutated', async () => {
    // Arrange
    const { repository, service } = createService();

    // Act
    const raised = await service.raise(SESSION, request, {
      kind: 'agent',
      sessionId: 'another-session',
      name: 'Mallory',
    });

    // Assert
    should(raised).containDeep({ ok: false, error: { code: 'forbidden' } });
    should(repository.ledgers.size).equal(0);
  });

  it('should delegate lifecycle operations through one serialized repository contract', async () => {
    // Arrange
    const { repository, service } = createService();

    // Act
    const created = await service.raise(SESSION, request, AGENT);
    if (!created.ok) throw new Error(created.error.message);
    const answered = await service.answer(
      SESSION,
      'A1',
      { kind: 'permission', decision: 'approve' },
      { kind: 'human' },
      'Approved.',
    );
    const source = await service.raise(
      SESSION,
      { ...request, source: 'task', sourceRef: 'F12', ask: undefined },
      { kind: 'daemon', cause: 'source-reconciliation' },
    );
    const reconciled = await service.resolveSource(
      SESSION,
      'task',
      'F12',
      { kind: 'daemon', cause: 'source-reconciliation' },
      'Task closed.',
    );
    const dismissed = await service.dismiss(SESSION, 'A2', { kind: 'human' });
    const resolved = await service.resolve(SESSION, 'A2', { kind: 'human' });

    // Assert
    should(created.change).equal('created');
    should(answered).containDeep({ ok: true, change: 'answered', snapshot: { count: 0 } });
    should(source).containDeep({ ok: true, change: 'created', snapshot: { count: 1 } });
    should(reconciled).containDeep({ ok: true, change: 'resolved', snapshot: { count: 0 } });
    should(dismissed).containDeep({ ok: true, changed: false, change: 'unchanged' });
    should(resolved).containDeep({ ok: true, changed: false, change: 'unchanged' });
    should(repository.ledgers.get(SESSION)?.entries).have.length(2);
  });

  it('should observe only a committed creation and never a refresh, answer, or refusal', async () => {
    // Arrange
    const observer = new Observer();
    const { repository, service } = createService(new MemoryRepository(), observer);

    // Act
    const created = await service.raise(SESSION, request, AGENT);
    const duplicate = await service.raise(SESSION, request, AGENT);
    const answered = await service.answer(
      SESSION,
      'A1',
      { kind: 'permission', decision: 'approve' },
      { kind: 'human' },
    );
    const refused = await service.raise(SESSION, request, {
      kind: 'agent',
      sessionId: 'another-session',
      name: 'Mallory',
    });

    // Assert
    should(created).containDeep({ ok: true, change: 'created' });
    should(duplicate).containDeep({ ok: true, change: 'unchanged' });
    should(answered).containDeep({ ok: true, change: 'answered' });
    should(refused).containDeep({ ok: false, error: { code: 'forbidden' } });
    should(observer.calls).deepEqual([{ sessionId: SESSION, itemId: 'A1', count: 1 }]);
    should(repository.ledgers.get(SESSION)?.entries).have.length(1);
  });

  it('should not observe a stable-source refresh', async () => {
    // Arrange
    const observer = new Observer();
    const { service } = createService(new MemoryRepository(), observer);
    const daemon = { kind: 'daemon' as const, cause: 'system' as const };
    const stable = { ...request, source: 'task' as const, sourceRef: 'F12', ask: undefined };

    // Act
    const created = await service.raise(SESSION, stable, daemon);
    const refreshed = await service.raise(SESSION, { ...stable, subject: 'Revised release request' }, daemon);

    // Assert
    should(created).containDeep({ ok: true, change: 'created' });
    should(refreshed).containDeep({ ok: true, change: 'refreshed' });
    should(observer.calls).deepEqual([{ sessionId: SESSION, itemId: 'A1', count: 1 }]);
  });

  it('should return the committed mutation when an observer throws synchronously', async () => {
    // Arrange
    const { repository, service } = createService(new MemoryRepository(), {
      raised: () => {
        throw new Error('presenter unavailable');
      },
    });

    // Act
    const actual = await service.raise(SESSION, request, AGENT);

    // Assert
    should(actual).containDeep({ ok: true, change: 'created', snapshot: { count: 1 } });
    should(repository.ledgers.get(SESSION)?.entries).have.length(1);
  });

  it('should accept only path-safe attention session identifiers', () => {
    // Act + Assert
    should(isAttentionSessionId('A_1-session')).be.true();
    should(isAttentionSessionId('')).be.false();
    should(isAttentionSessionId('-bad')).be.false();
    should(isAttentionSessionId('bad/path')).be.false();
    should(isAttentionSessionId('a'.repeat(129))).be.false();
  });
});
