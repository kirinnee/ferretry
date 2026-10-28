import { describe, it } from 'bun:test';
import type { AttentionItem, ResolvedAttentionItem, SessionAttentionSummary } from '@ferretry/protocol';
import should from 'should';
import {
  type AttentionBoardChange,
  AttentionChangeFanout,
  type AttentionChangeObserver,
  AttentionConversation,
  type AttentionLedger,
  type AttentionLedgerRepository,
  type AttentionMutation,
  AttentionReplyDelivery,
  AttentionService,
  SessionAttentionProjection,
  type SessionAttentionState,
} from '../../../src/lib/attention/index.ts';

const SESSION = 'session-1';
const NOW = '2026-10-23T10:00:00.000Z';
const AGENT = { kind: 'agent' as const, sessionId: SESSION, name: 'Ada' };
const HUMAN = { kind: 'human' as const };

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

class RecordingChanges implements AttentionChangeObserver {
  readonly seen: Array<{ sessionId: string; change: AttentionBoardChange }> = [];

  async changed(sessionId: string, change: AttentionBoardChange): Promise<void> {
    this.seen.push({ sessionId, change });
  }
}

class RecordingState implements SessionAttentionState {
  readonly writes: Array<{ sessionId: string; summary: SessionAttentionSummary | undefined; reconciled: boolean }> = [];

  async write(
    sessionId: string,
    summary: SessionAttentionSummary | undefined,
    change: AttentionBoardChange | undefined,
  ): Promise<void> {
    this.writes.push({ sessionId, summary, reconciled: change === undefined });
  }
}

class RecordingMessenger {
  readonly sent: Array<{ sessionId: string; message: string; sendId: string }> = [];

  async send(sessionId: string, message: string, sendId: string): Promise<void> {
    this.sent.push({ sessionId, message, sendId });
  }
}

const inline = { run: async <T>(_key: string, task: () => Promise<T>): Promise<T> => await task() };

function service(repository: MemoryRepository, changes: AttentionChangeObserver): AttentionService {
  return new AttentionService(
    repository,
    { now: () => NOW },
    { has: async sessionId => sessionId === SESSION || sessionId === 'session-2' },
    { raised: async () => undefined },
    changes,
  );
}

const ASK = {
  source: 'agent-raised' as const,
  sourceRef: null,
  subject: 'Rebase onto main now?',
  why: 'main moved under the PR.',
  context: 'Finishing the relay PR.',
  howToResolve: 'Pick one.',
  ask: { kind: 'multiple-choice' as const, options: [{ label: 'Rebase now' }, { label: 'Wait' }] },
};

describe('Attention board observers', () => {
  it('should tell change observers about every committed change, with its source, and never an unchanged one', async () => {
    // Arrange
    const changes = new RecordingChanges();
    const attention = service(new MemoryRepository(), changes);

    // Act
    await attention.raise(SESSION, ASK, AGENT);
    await attention.raise(SESSION, ASK, AGENT);
    await attention.answer(SESSION, 'A1', { kind: 'multiple-choice', choice: 'Wait' }, HUMAN);
    await attention.raise(SESSION, { ...ASK, subject: 'Second?' }, AGENT);
    await attention.resolve(SESSION, 'A2', HUMAN, 'later', 'conversation');

    // Assert
    should(changes.seen.map(each => [each.change.change, each.change.via])).deepEqual([
      ['created', 'board'],
      ['answered', 'board'],
      ['created', 'board'],
      ['resolved', 'conversation'],
    ]);
    should(changes.seen[1]?.change.addressed).containDeep({ id: 'A1', response: { choice: 'Wait' } });
    should(changes.seen[2]?.change.item).containDeep({ id: 'A2' });
  });

  it('should keep a board committed when a change observer throws', async () => {
    // Arrange
    const repository = new MemoryRepository();
    const attention = service(repository, {
      changed: async () => {
        throw new Error('projection down');
      },
    });

    // Act
    const raised = await attention.raise(SESSION, ASK, AGENT);

    // Assert
    should(raised).containDeep({ ok: true, change: 'created' });
    should(repository.ledgers.get(SESSION)?.entries).have.length(1);
  });

  it('should tell every observer even when one before it fails', async () => {
    // Arrange
    const after = new RecordingChanges();
    const fanout = new AttentionChangeFanout([
      {
        changed: async () => {
          throw new Error('first fails');
        },
      },
      after,
    ]);
    const changes = new RecordingChanges();
    await service(new MemoryRepository(), changes).raise(SESSION, ASK, AGENT);
    const change = changes.seen[0]?.change as AttentionBoardChange;

    // Act
    await fanout.changed(SESSION, change);

    // Assert
    should(after.seen).have.length(1);
  });

  it('should project the board as it is NOW, not as the change described it', async () => {
    // Arrange
    const repository = new MemoryRepository();
    const changes = new RecordingChanges();
    const attention = service(repository, changes);
    await attention.raise(SESSION, ASK, AGENT);
    const stale = changes.seen[0]?.change as AttentionBoardChange;
    await attention.answer(SESSION, 'A1', { kind: 'multiple-choice', choice: 'Wait' }, HUMAN);
    const state = new RecordingState();
    const projection = new SessionAttentionProjection(repository, state, inline, () => NOW);

    // Act — the creation notice arrives after the answer committed.
    await projection.changed(SESSION, stale);

    // Assert
    should(state.writes).deepEqual([{ sessionId: SESSION, summary: undefined, reconciled: false }]);
  });

  it('should reconcile every named session on its own, past one that cannot be read', async () => {
    // Arrange
    const repository = new MemoryRepository();
    await service(repository, new RecordingChanges()).raise(SESSION, ASK, AGENT);
    const state = new RecordingState();
    const boards = {
      read: async (sessionId: string) => {
        if (sessionId === 'broken') throw new Error('unreadable');
        return await repository.read(sessionId);
      },
    };
    const projection = new SessionAttentionProjection(boards, state, inline, () => NOW);

    // Act
    await projection.reconcile(['broken', SESSION, 'session-2']);

    // Assert
    should(state.writes).deepEqual([
      {
        sessionId: SESSION,
        summary: { open: 1, first: 'A1', ask: 'Rebase onto main now?', latestAt: NOW },
        reconciled: true,
      },
      { sessionId: 'session-2', summary: undefined, reconciled: true },
    ]);
  });

  it('should tell a ferret every closing the owner makes of its own item on the board, under one send id each', async () => {
    // Arrange
    const changes = new RecordingChanges();
    const attention = service(new MemoryRepository(), changes);
    await attention.raise(SESSION, ASK, AGENT);
    await attention.raise(
      SESSION,
      { ...ASK, subject: 'Second?', why: 'Second.', ask: { kind: 'open-question' } },
      AGENT,
    );
    await attention.raise(SESSION, { ...ASK, subject: 'Third?', why: 'Third.', ask: { kind: 'open-question' } }, AGENT);
    await attention.raise(
      SESSION,
      { ...ASK, subject: 'Fourth?', why: 'Fourth.', ask: { kind: 'open-question' } },
      AGENT,
    );
    await attention.answer(SESSION, 'A1', { kind: 'multiple-choice', choice: 'Rebase now' }, HUMAN);
    await attention.resolve(SESSION, 'A2', AGENT, 'sorted it myself');
    await attention.resolve(SESSION, 'A3', HUMAN, 'answered in chat', 'conversation');
    should((await attention.dismiss(SESSION, 'A4', HUMAN)).ok).be.true();
    const messenger = new RecordingMessenger();
    const delivery = new AttentionReplyDelivery(messenger);

    // Act
    for (const { sessionId, change } of changes.seen) await delivery.changed(sessionId, change);
    for (const { sessionId, change } of changes.seen) await delivery.changed(sessionId, change);

    // Assert
    should(messenger.sent).deepEqual([
      // The ferret's own done (A2) and the chat answer (A3, already in the owner's words) are not echoed;
      // a bare dismiss (A4) is told. Told twice, each is one send id — the send ledger keeps one message.
      {
        sessionId: SESSION,
        message: '[answer to !A1 «Rebase onto main now?»] Rebase now',
        sendId: 'attention-session-1-A1',
      },
      {
        sessionId: SESSION,
        message: '[dismissed !A4 «Fourth?»] The owner dismissed this without an answer.',
        sendId: 'attention-session-1-A4',
      },
      {
        sessionId: SESSION,
        message: '[answer to !A1 «Rebase onto main now?»] Rebase now',
        sendId: 'attention-session-1-A1',
      },
      {
        sessionId: SESSION,
        message: '[dismissed !A4 «Fourth?»] The owner dismissed this without an answer.',
        sendId: 'attention-session-1-A4',
      },
    ]);
  });

  it('should not tell a ferret about an item another session or the daemon raised', async () => {
    // Arrange
    const messenger = new RecordingMessenger();
    const delivery = new AttentionReplyDelivery(messenger);
    const base = {
      id: 'A1',
      source: 'agent-raised',
      sourceRef: null,
      subject: 'Ask?',
      why: 'why',
      waitingSince: NOW,
      howToResolve: 'how',
      resolvedAt: NOW,
      resolutionNote: 'a note',
      disposition: 'done',
      resolvedBy: 'human',
      resolvedBySession: null,
      resolvedByName: null,
    };
    const elsewhere = { ...base, raisedBy: 'agent', raisedBySession: 'session-2', raisedByName: null };
    const daemon = { ...base, raisedBy: 'daemon', raisedBySession: null, raisedByName: null };
    const change = (addressed: unknown): AttentionBoardChange => ({
      change: 'resolved',
      actor: HUMAN,
      via: 'board',
      snapshot: { v: 1, sessionId: SESSION, items: [], resolved: [], count: 0, parseErrors: 0, updatedAt: NOW },
      addressed: addressed as ResolvedAttentionItem,
    });

    // Act
    await delivery.changed(SESSION, change(elsewhere));
    await delivery.changed(SESSION, change(daemon));

    // Assert
    should(messenger.sent).deepEqual([]);
  });

  it('should answer the items a person’s message references only after it is accepted, in the person’s name', async () => {
    // Arrange
    const repository = new MemoryRepository();
    const changes = new RecordingChanges();
    const attention = service(repository, changes);
    await attention.raise(SESSION, ASK, AGENT);
    await attention.raise(SESSION, { ...ASK, subject: 'Region?', ask: { kind: 'open-question' } }, AGENT);
    await attention.raise(SESSION, { ...ASK, subject: 'Deploy?', ask: { kind: 'permission' } }, AGENT);
    const conversation = new AttentionConversation(attention, 'fy');
    const message = '!A1 wait, !A2 eu-west-1 !A3';

    // Act
    const turn = await conversation.prepare(SESSION, message);
    const before = (await attention.list(SESSION)) as { ok: true; value: { count: number } };
    await conversation.settle(SESSION, turn, message);
    const after = await attention.list(SESSION);

    // Assert
    should(turn.message.startsWith('[answer to !A1 «Rebase onto main now?», !A2 «Region?», !A3 «Deploy?»] ')).be.true();
    should(before.value.count).equal(3);
    should(after).containDeep({ ok: true, value: { count: 0 } });
    const resolved = after.ok ? after.value.resolved : [];
    const byId = new Map(resolved.map(each => [each.id, each]));
    should(byId.get('A1')).containDeep({ resolvedBy: 'human', resolutionNote: message });
    should(byId.get('A1')?.response).be.undefined();
    should(byId.get('A2')).containDeep({ response: { kind: 'open-question', answer: 'wait, eu-west-1' } });
    should(byId.get('A3')).containDeep({ disposition: 'done', resolutionNote: message });
    should(changes.seen.slice(-3).every(each => each.change.via === 'conversation')).be.true();
  });

  it('should leave a person’s message exactly as written when the board cannot be read', async () => {
    // Arrange
    const conversation = new AttentionConversation(
      {
        list: async () => {
          throw new Error('disk gone');
        },
        answer: async () => ({ ok: false, error: { code: 'corrupt', message: 'x' } }),
        resolve: async () => ({ ok: false, error: { code: 'corrupt', message: 'x' } }),
      },
      'fy',
    );
    const refused = new AttentionConversation(
      {
        list: async () => ({ ok: false, error: { code: 'not-found', message: 'gone' } }),
        answer: async () => ({ ok: false, error: { code: 'corrupt', message: 'x' } }),
        resolve: async () => {
          throw new Error('cannot resolve');
        },
      },
      'fy',
    );

    // Act
    const unreadable = await conversation.prepare(SESSION, 'hello !A1');
    const missing = await refused.prepare(SESSION, 'hello !A1');
    const item = { id: 'A1', subject: 'Ask?' } as AttentionItem;
    await refused.settle(SESSION, { message: 'x', answers: [item] }, 'x');

    // Assert
    should(unreadable).deepEqual({ message: 'hello !A1', answers: [] });
    should(missing).deepEqual({ message: 'hello !A1', answers: [] });
  });
});

describe('Attention board progress observers', () => {
  it('should tell change observers about a tick, but tell the ferret nothing', async () => {
    // Arrange
    const changes = new RecordingChanges();
    const attention = service(new MemoryRepository(), changes);
    await attention.raise(SESSION, { ...ASK, steps: ['Do it'] }, AGENT);
    await attention.progress(SESSION, 'A1', 0, true, HUMAN);
    const messenger = new RecordingMessenger();
    const delivery = new AttentionReplyDelivery(messenger);

    // Act
    for (const { sessionId, change } of changes.seen) await delivery.changed(sessionId, change);

    // Assert
    should(changes.seen.map(each => each.change.change)).deepEqual(['created', 'progressed']);
    should(changes.seen[1]?.change.item).containDeep({ id: 'A1', stepsDone: [0] });
    should(messenger.sent).deepEqual([]);
  });
});
