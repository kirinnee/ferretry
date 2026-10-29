import { describe, it } from 'bun:test';
import type { AttentionItem, ResolvedAttentionItem, SessionAttentionSummary } from '@ferretry/protocol';
import should from 'should';
import {
  type AttentionBoardChange,
  AttentionBoardUndelivered,
  AttentionChangeFanout,
  type AttentionChangeObserver,
  AttentionConversation,
  type AttentionLedger,
  type AttentionLedgerRepository,
  AttentionMoreInfoPush,
  type AttentionMutation,
  AttentionReplyDelivery,
  AttentionService,
  AttentionSurfacedPush,
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
  readonly sent: Array<{ sessionId: string; message: string; id: string }> = [];

  async add(sessionId: string, id: string, message: string): Promise<void> {
    this.sent.push({ sessionId, message, id });
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

describe('Attention surfaced push', () => {
  it('should announce an ask once it leaves discussion for the owner, whoever surfaced it, and nothing else', async () => {
    // Arrange
    const announced: Array<{ sessionId: string; id: string }> = [];
    const push = new AttentionSurfacedPush({
      surfaced: async (sessionId, item) => {
        announced.push({ sessionId, id: item.id });
      },
    });
    const changes = new AttentionChangeFanout([push]);
    const attention = service(new MemoryRepository(), changes);

    // Act — a new ask is the owner's turn already; only a reply puts it in discussion to be surfaced.
    await attention.raise(SESSION, ASK, AGENT);
    await attention.raise(SESSION, { ...ASK, subject: 'Already on the queue?' }, AGENT);
    await attention.reply(SESSION, 'A1', HUMAN);
    const before = announced.length;
    await attention.surface(SESSION, 'A1', AGENT, 'Still open');
    await attention.surface(SESSION, 'A1', AGENT);
    await attention.surface(SESSION, 'A2', AGENT);

    // Assert
    should(before).equal(0);
    should(announced).deepEqual([{ sessionId: SESSION, id: 'A1' }]);
  });
});

describe('Attention edit on the owner’s turn and on the ferret’s', () => {
  it('should announce nothing to the owner when a ferret updates the card of an ask, or hands a discussion back', async () => {
    // Arrange
    const announced: string[] = [];
    const surfacedPush = new AttentionSurfacedPush({
      surfaced: async (_session, item) => void announced.push(`surfaced ${item.id}`),
    });
    const moreInfoPush = new AttentionMoreInfoPush({
      moreInfoAdded: async (_session, item) => void announced.push(`info ${item.id}`),
    });
    const changes = new RecordingChanges();
    const attention = service(new MemoryRepository(), changes);
    await attention.raise(SESSION, ASK, AGENT);

    // Act
    await attention.edit(SESSION, 'A1', { stillOpen: 'Which region?' }, AGENT);
    await attention.edit(SESSION, 'A1', { decided: 'Use SQLite', stillOpen: 'Which size?' }, AGENT);
    await attention.reply(SESSION, 'A1', HUMAN);
    await attention.edit(SESSION, 'A1', { stillOpen: 'Which cluster?' }, AGENT);
    for (const { sessionId, change } of changes.seen) {
      await surfacedPush.changed(sessionId, change);
      await moreInfoPush.changed(sessionId, change);
    }

    // Assert
    should(changes.seen.map(each => each.change.change)).deepEqual([
      'created',
      'refreshed',
      'refreshed',
      'replied',
      'refreshed',
    ]);
    should(announced).deepEqual([]);
  });
});

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
    const delivery = new AttentionReplyDelivery(messenger, 'fy');

    // Act
    for (const { sessionId, change } of changes.seen) await delivery.changed(sessionId, change);
    for (const { sessionId, change } of changes.seen) await delivery.changed(sessionId, change);

    // Assert
    should(messenger.sent).deepEqual([
      // The ferret's own done (A2) and the chat answer (A3, already in the owner's words) are not echoed;
      // a bare dismiss (A4) is told. Told twice, each goes to the outbox twice — the outbox keeps it once.
      {
        sessionId: SESSION,
        message: '[answer to !A1 «Rebase onto main now?»] Rebase now',
        id: 'A1',
      },
      {
        sessionId: SESSION,
        message: '[dismissed !A4 «Fourth?»] Not needed — the owner dismissed this without a reason.',
        id: 'A4',
      },
      {
        sessionId: SESSION,
        message: '[answer to !A1 «Rebase onto main now?»] Rebase now',
        id: 'A1',
      },
      {
        sessionId: SESSION,
        message: '[dismissed !A4 «Fourth?»] Not needed — the owner dismissed this without a reason.',
        id: 'A4',
      },
    ]);
  });

  it('should not tell a ferret about an item another session or the daemon raised', async () => {
    // Arrange
    const messenger = new RecordingMessenger();
    const delivery = new AttentionReplyDelivery(messenger, 'fy');
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

  it('should make the items a person’s message references the ferret’s turn only after it is accepted, and resolve nothing', async () => {
    // Arrange
    const repository = new MemoryRepository();
    const changes = new RecordingChanges();
    const attention = service(repository, changes);
    await attention.raise(SESSION, ASK, AGENT);
    await attention.raise(SESSION, { ...ASK, subject: 'Region?', ask: { kind: 'open-question' } }, AGENT);
    await attention.raise(SESSION, { ...ASK, subject: 'Deploy?', ask: { kind: 'permission' } }, AGENT);
    const conversation = new AttentionConversation(attention);
    const message = '!A1 wait, !A2 eu-west-1';

    // Act
    const turn = await conversation.prepare(SESSION, message);
    const before = await attention.list(SESSION);
    await conversation.settle(SESSION, turn);
    const after = await attention.list(SESSION);

    // Assert
    should(turn.message).equal(`[re !A1 «Rebase onto main now?», !A2 «Region?»] ${message}`);
    should(turn.referenced.map(each => each.id)).deepEqual(['A1', 'A2']);
    if (!before.ok || !after.ok) throw new Error('board unreadable');
    should(before.value.items.map(each => each.waitingOn ?? null)).deepEqual([null, null, null]);
    should(after.value.count).equal(3);
    should(after.value.resolved).have.length(0);
    should(after.value.items.map(each => [each.id, each.waitingOn ?? null, each.waitingFor ?? null])).deepEqual([
      ['A1', 'ferret', 'discussion'],
      ['A2', 'ferret', 'discussion'],
      ['A3', null, null],
    ]);
    should(changes.seen.slice(-2).map(each => [each.change.change, each.change.via, each.change.actor.kind])).deepEqual(
      [
        ['replied', 'conversation', 'human'],
        ['replied', 'conversation', 'human'],
      ],
    );
  });

  it('should tell the ferret nothing of a reply: the person’s own message is the delivery', async () => {
    // Arrange
    const changes = new RecordingChanges();
    const attention = service(new MemoryRepository(), changes);
    const messenger = new RecordingMessenger();
    const delivery = new AttentionReplyDelivery(messenger, 'fy');
    await attention.raise(SESSION, ASK, AGENT);

    // Act
    await attention.reply(SESSION, 'A1', HUMAN);
    for (const { sessionId, change } of changes.seen) await delivery.changed(sessionId, change);

    // Assert
    should(changes.seen.map(each => each.change.change)).deepEqual(['created', 'replied']);
    should(messenger.sent).deepEqual([]);
  });

  it('should reply in the person’s name, each item on its own, and swallow a failure', async () => {
    // Arrange
    const replied: Array<[string, string, unknown]> = [];
    const conversation = new AttentionConversation({
      list: async () => ({ ok: false, error: { code: 'corrupt', message: 'x' } }),
      reply: async (sessionId, id, actor) => {
        replied.push([sessionId, id, actor]);
        if (id === 'A1') throw new Error('disk gone');
        return { ok: false, error: { code: 'not-found', message: 'gone' } };
      },
    });
    const items = [{ id: 'A1' }, { id: 'A2' }, { id: 'A3' }] as AttentionItem[];

    // Act
    await conversation.settle(SESSION, { message: 'x', referenced: items });

    // Assert
    should(replied).deepEqual([
      [SESSION, 'A1', { kind: 'human' }],
      [SESSION, 'A2', { kind: 'human' }],
      [SESSION, 'A3', { kind: 'human' }],
    ]);
  });

  it('should reply to nothing for a message that references nothing', async () => {
    // Arrange
    const attention = service(new MemoryRepository(), new RecordingChanges());
    await attention.raise(SESSION, ASK, AGENT);
    const conversation = new AttentionConversation(attention);

    // Act
    const turn = await conversation.prepare(SESSION, 'how is it going?');
    await conversation.settle(SESSION, turn);
    const board = await attention.list(SESSION);

    // Assert
    should(turn).deepEqual({ message: 'how is it going?', referenced: [] });
    should(board).containDeep({ ok: true, value: { items: [{ id: 'A1' }] } });
    should(board.ok ? board.value.items[0]?.waitingOn : 'unreadable').be.undefined();
  });

  it('should leave a person’s message exactly as written when the board cannot be read', async () => {
    // Arrange
    const conversation = new AttentionConversation({
      list: async () => {
        throw new Error('disk gone');
      },
      reply: async () => ({ ok: false, error: { code: 'corrupt', message: 'x' } }),
    });
    const refused = new AttentionConversation({
      list: async () => ({ ok: false, error: { code: 'not-found', message: 'gone' } }),
      reply: async () => {
        throw new Error('cannot reply');
      },
    });

    // Act
    const unreadable = await conversation.prepare(SESSION, 'hello !A1');
    const missing = await refused.prepare(SESSION, 'hello !A1');
    const item = { id: 'A1', subject: 'Ask?' } as AttentionItem;
    await refused.settle(SESSION, { message: 'x', referenced: [item] });

    // Assert
    should(unreadable).deepEqual({ message: 'hello !A1', referenced: [] });
    should(missing).deepEqual({ message: 'hello !A1', referenced: [] });
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
    const delivery = new AttentionReplyDelivery(messenger, 'fy');

    // Act
    for (const { sessionId, change } of changes.seen) await delivery.changed(sessionId, change);

    // Assert
    should(changes.seen.map(each => each.change.change)).deepEqual(['created', 'progressed']);
    should(changes.seen[1]?.change.item).containDeep({ id: 'A1', stepsDone: [0] });
    should(messenger.sent).deepEqual([]);
  });
});

describe('Attention needs-info delivery', () => {
  const TASK = { ...ASK, ask: { kind: 'task' as const }, steps: ['Do it'] };

  it('should tell the raising ferret once per request, and again for a new request after it answered', async () => {
    // Arrange
    const changes = new RecordingChanges();
    const attention = service(new MemoryRepository(), changes);
    const messenger = new RecordingMessenger();
    const delivery = new AttentionReplyDelivery(messenger, 'fy');
    await attention.raise(SESSION, TASK, AGENT);

    // Act
    await attention.needsInfo(SESSION, 'A1', HUMAN, 'Which account?');
    await attention.edit(SESSION, 'A1', { subject: 'Rebase onto main, which account?' }, AGENT);
    await attention.needsInfo(SESSION, 'A1', HUMAN);
    for (const { sessionId, change } of changes.seen) await delivery.changed(sessionId, change);

    // Assert
    should(messenger.sent).deepEqual([
      {
        sessionId: SESSION,
        message: '[needs more info !A1 «Rebase onto main now?»] Which account?',
        id: 'A1~1',
      },
      {
        sessionId: SESSION,
        message: '[needs more info !A1 «Rebase onto main, which account?»] The owner needs more information.',
        id: 'A1~2',
      },
    ]);
  });

  it('should never tell a ferret about a request by an agent, or on an item another session raised', async () => {
    // Arrange
    const messenger = new RecordingMessenger();
    const delivery = new AttentionReplyDelivery(messenger, 'fy');
    const item = (session: string): AttentionItem =>
      ({
        id: 'A1',
        source: 'agent-raised',
        sourceRef: null,
        subject: 'Ask?',
        why: 'why',
        waitingSince: NOW,
        howToResolve: 'how',
        raisedBy: 'agent',
        raisedBySession: session,
        raisedByName: null,
        waitingOn: 'ferret',
        askedAt: NOW,
        infoRequests: 1,
      }) as AttentionItem;
    const snapshot = {
      v: 1 as const,
      sessionId: SESSION,
      items: [],
      resolved: [],
      count: 0,
      parseErrors: 0,
      updatedAt: NOW,
    };

    // Act
    await delivery.changed(SESSION, {
      change: 'needs-info',
      actor: HUMAN,
      via: 'board',
      snapshot,
      item: item('session-2'),
    });
    await delivery.changed(SESSION, {
      change: 'needs-info',
      actor: AGENT,
      via: 'board',
      snapshot,
      item: item(SESSION),
    });
    await delivery.changed(SESSION, { change: 'needs-info', actor: HUMAN, via: 'board', snapshot });

    // Assert
    should(messenger.sent).deepEqual([]);
  });
});

describe('Attention more-info push', () => {
  it('should announce an edit that answered a request, once, and nothing for an ordinary edit', async () => {
    // Arrange
    const changes = new RecordingChanges();
    const attention = service(new MemoryRepository(), changes);
    const pushed: string[] = [];
    const observer = new AttentionMoreInfoPush({
      moreInfoAdded: async (_session, item, _snapshot, discussion) => {
        pushed.push(`${item.id}~${item.infoRequests}${discussion ? ' discussion' : ''}`);
      },
    });
    await attention.raise(SESSION, ASK, AGENT);
    await attention.edit(SESSION, 'A1', { subject: 'An ordinary edit?' }, AGENT);
    await attention.needsInfo(SESSION, 'A1', HUMAN);
    await attention.edit(SESSION, 'A1', { subject: 'More info added?' }, AGENT);
    await attention.edit(SESSION, 'A1', { subject: 'More info added?' }, AGENT);

    // Act
    for (const { sessionId, change } of changes.seen) await observer.changed(sessionId, change);

    // Assert
    should(pushed).deepEqual(['A1~1']);
  });

  it('should push nothing when an edit hands a discussion back: only an answered request for information pushes', async () => {
    // Arrange
    const changes = new RecordingChanges();
    const attention = service(new MemoryRepository(), changes);
    const pushed: string[] = [];
    const observer = new AttentionMoreInfoPush({
      moreInfoAdded: async (_session, item) => {
        pushed.push(item.id);
      },
    });
    await attention.raise(SESSION, ASK, AGENT);
    await attention.discuss(SESSION, 'A1', HUMAN, 'Why now?');
    await attention.edit(SESSION, 'A1', { subject: 'Rebase after the freeze?' }, AGENT);
    await attention.edit(SESSION, 'A1', { stillOpen: 'Which branch?' }, AGENT);

    // Act
    for (const { sessionId, change } of changes.seen) await observer.changed(sessionId, change);

    // Assert
    should(pushed).deepEqual([]);
  });
});

describe('Attention discuss delivery', () => {
  it('should tell the raising ferret once per discussion, under the same counter as a request for information', async () => {
    // Arrange
    const changes = new RecordingChanges();
    const attention = service(new MemoryRepository(), changes);
    const messenger = new RecordingMessenger();
    const delivery = new AttentionReplyDelivery(messenger, 'fy');
    await attention.raise(SESSION, ASK, AGENT);

    // Act
    await attention.discuss(SESSION, 'A1', HUMAN, 'I do not follow the premise');
    await attention.discuss(SESSION, 'A1', HUMAN, 'asked again');
    await attention.edit(SESSION, 'A1', { subject: 'Rebase onto main after the freeze?' }, AGENT);
    await attention.surface(SESSION, 'A1', AGENT);
    await attention.needsInfo(SESSION, 'A1', HUMAN, 'Which branch?');
    for (const { sessionId, change } of changes.seen) await delivery.changed(sessionId, change);

    // Assert
    should(messenger.sent.map(each => each.id)).deepEqual(['A1~1', 'A1~2']);
    should(messenger.sent[0]?.message).equal(
      '[discuss !A1 «Rebase onto main now?»] The owner wants to talk this through before answering: I do not follow the premise. Reply in chat to clear it up; then update the item (`fy agenda edit A1`) or close it if the premise was wrong (`fy agenda done A1`).',
    );
    should(messenger.sent[1]?.message).startWith('[needs more info !A1');
  });

  it('should never tell a ferret about a discussion another session raised, or one an agent asked for', async () => {
    // Arrange
    const changes = new RecordingChanges();
    const attention = service(new MemoryRepository(), changes);
    const messenger = new RecordingMessenger();
    const delivery = new AttentionReplyDelivery(messenger, 'fy');
    await attention.raise(SESSION, ASK, AGENT);
    await attention.discuss(SESSION, 'A1', HUMAN);
    const seen = changes.seen.at(-1)?.change as AttentionBoardChange;

    // Act
    await delivery.changed('session-2', seen);
    await delivery.changed(SESSION, { ...seen, actor: AGENT });

    // Assert
    should(messenger.sent).deepEqual([]);
  });
});

describe('Attention undelivered answers', () => {
  it('should reopen the item a failed answer was about, and end the discussion a failed request was about', async () => {
    // Arrange
    const changes = new RecordingChanges();
    const attention = service(new MemoryRepository(), changes);
    const sink = new AttentionBoardUndelivered(attention);
    await attention.raise(SESSION, ASK, AGENT);
    await attention.raise(SESSION, { ...ASK, subject: 'Second ask?' }, AGENT);
    await attention.answer(SESSION, 'A1', { kind: 'multiple-choice', choice: 'Rebase now' }, HUMAN);
    await attention.discuss(SESSION, 'A2', HUMAN, 'why?');

    // Act
    await sink.undelivered(SESSION, 'A1', 'it never appeared in the ferret’s transcript');
    await sink.undelivered(SESSION, 'A2~1', 'the ferret was removed');
    await sink.undelivered(SESSION, 'instructions~0123456789abcd', 'ignored');
    const board = await attention.list(SESSION);

    // Assert
    if (!board.ok) throw new Error(board.error.message);
    should(board.value.items.map(each => [each.id, each.undelivered?.reply.action, each.waitingOn ?? null])).deepEqual([
      ['A1', 'resolve', null],
      ['A2', 'discuss', null],
    ]);
    should(changes.seen.filter(each => each.change.change === 'reopened')).have.length(2);
  });
});
