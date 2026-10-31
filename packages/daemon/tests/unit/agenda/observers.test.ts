import { describe, it } from 'bun:test';
import type { AgendaItem, ResolvedAgendaItem, SessionAgendaSummary } from '@ferretry/protocol';
import should from 'should';
import {
  type AgendaBoardChange,
  AgendaBoardUndelivered,
  AgendaChangeFanout,
  type AgendaChangeObserver,
  AgendaConversation,
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaReplyDelivery,
  AgendaService,
  SessionAgendaProjection,
  type SessionAgendaState,
} from '../../../src/lib/agenda/index.ts';

const SESSION = 'session-1';
const NOW = '2026-10-23T10:00:00.000Z';
const AGENT = { kind: 'agent' as const, sessionId: SESSION, name: 'Ada' };
const HUMAN = { kind: 'human' as const };

class MemoryRepository implements AgendaLedgerRepository {
  readonly ledgers = new Map<string, AgendaLedger>();

  async read(sessionId: string): Promise<AgendaLedger | null> {
    return this.ledgers.get(sessionId) ?? null;
  }

  async transact(sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    const mutation = apply(await this.read(sessionId));
    if (mutation.ok && mutation.changed) this.ledgers.set(sessionId, mutation.ledger);
    return mutation;
  }
}

class RecordingChanges implements AgendaChangeObserver {
  readonly seen: Array<{ sessionId: string; change: AgendaBoardChange }> = [];

  async changed(sessionId: string, change: AgendaBoardChange): Promise<void> {
    this.seen.push({ sessionId, change });
  }
}

class RecordingState implements SessionAgendaState {
  readonly writes: Array<{ sessionId: string; summary: SessionAgendaSummary | undefined; reconciled: boolean }> = [];

  async write(
    sessionId: string,
    summary: SessionAgendaSummary | undefined,
    change: AgendaBoardChange | undefined,
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

function service(repository: MemoryRepository, changes: AgendaChangeObserver): AgendaService {
  return new AgendaService(
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
  premise: 'A ferret needs the owner.',
  howToResolve: 'Pick one.',
  ask: { kind: 'multiple-choice' as const, options: [{ label: 'Rebase now' }, { label: 'Wait' }] },
};

describe('Agenda board observers', () => {
  it('should tell change observers about every committed change, with its source, and never an unchanged one', async () => {
    // Arrange
    const changes = new RecordingChanges();
    const agenda = service(new MemoryRepository(), changes);

    // Act
    await agenda.raise(SESSION, ASK, AGENT);
    await agenda.raise(SESSION, ASK, AGENT);
    await agenda.answer(SESSION, 'A1', { kind: 'multiple-choice', choice: 'Wait' }, HUMAN);
    await agenda.raise(SESSION, { ...ASK, subject: 'Second?' }, AGENT);
    await agenda.resolve(SESSION, 'A2', HUMAN, 'later', 'conversation');

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
    const agenda = service(repository, {
      changed: async () => {
        throw new Error('projection down');
      },
    });

    // Act
    const raised = await agenda.raise(SESSION, ASK, AGENT);

    // Assert
    should(raised).containDeep({ ok: true, change: 'created' });
    should(repository.ledgers.get(SESSION)?.entries).have.length(1);
  });

  it('should tell every observer even when one before it fails', async () => {
    // Arrange
    const after = new RecordingChanges();
    const fanout = new AgendaChangeFanout([
      {
        changed: async () => {
          throw new Error('first fails');
        },
      },
      after,
    ]);
    const changes = new RecordingChanges();
    await service(new MemoryRepository(), changes).raise(SESSION, ASK, AGENT);
    const change = changes.seen[0]?.change as AgendaBoardChange;

    // Act
    await fanout.changed(SESSION, change);

    // Assert
    should(after.seen).have.length(1);
  });

  it('should project the board as it is NOW, not as the change described it', async () => {
    // Arrange
    const repository = new MemoryRepository();
    const changes = new RecordingChanges();
    const agenda = service(repository, changes);
    await agenda.raise(SESSION, ASK, AGENT);
    const stale = changes.seen[0]?.change as AgendaBoardChange;
    await agenda.answer(SESSION, 'A1', { kind: 'multiple-choice', choice: 'Wait' }, HUMAN);
    const state = new RecordingState();
    const projection = new SessionAgendaProjection(repository, state, inline, () => NOW);

    // Act — the creation notice arrives after the answer committed.
    await projection.changed(SESSION, stale);

    // Assert
    should(state.writes).deepEqual([{ sessionId: SESSION, summary: undefined, reconciled: false }]);
  });

  it('should say a ferret works in agenda mode, and is stopped only while idle with an item on the owner', async () => {
    // Arrange
    const repository = new MemoryRepository();
    await service(repository, new RecordingChanges()).raise(SESSION, ASK, AGENT);
    const idle = { current: async () => NOW };
    const state = new RecordingState();
    const working = new SessionAgendaProjection(repository, state, inline, () => NOW, { enabled: async () => true });
    const stopped = new SessionAgendaProjection(
      repository,
      state,
      inline,
      () => NOW,
      { enabled: async () => true },
      idle,
    );

    // Act
    await working.refresh(SESSION);
    await stopped.refresh(SESSION);

    // Assert
    should(state.writes[0]?.summary).have.property('agendaMode', true);
    should(state.writes[0]?.summary).not.have.property('stopped');
    should(state.writes[1]?.summary).have.properties({ agendaMode: true, stopped: true });
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
    const projection = new SessionAgendaProjection(boards, state, inline, () => NOW);

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
    const agenda = service(new MemoryRepository(), changes);
    await agenda.raise(SESSION, ASK, AGENT);
    await agenda.raise(SESSION, { ...ASK, subject: 'Second?', why: 'Second.', ask: { kind: 'open-question' } }, AGENT);
    await agenda.raise(SESSION, { ...ASK, subject: 'Third?', why: 'Third.', ask: { kind: 'open-question' } }, AGENT);
    await agenda.raise(SESSION, { ...ASK, subject: 'Fourth?', why: 'Fourth.', ask: { kind: 'open-question' } }, AGENT);
    await agenda.answer(SESSION, 'A1', { kind: 'multiple-choice', choice: 'Rebase now' }, HUMAN);
    await agenda.resolve(SESSION, 'A2', AGENT, 'sorted it myself');
    await agenda.resolve(SESSION, 'A3', HUMAN, 'answered in chat', 'conversation');
    should((await agenda.dismiss(SESSION, 'A4', HUMAN)).ok).be.true();
    const messenger = new RecordingMessenger();
    const delivery = new AgendaReplyDelivery(messenger, 'fy');

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

  describe('an info item the owner closes', () => {
    const INFO = {
      source: 'agent-raised' as const,
      sourceRef: null,
      subject: 'Deploy finished',
      why: 'The release went out.',
      context: 'Finishing the relay PR.',
      premise: 'A ferret has news for the owner.',
      howToResolve: 'Read it.',
      kind: 'info' as const,
    };

    async function raised(): Promise<{ agenda: AgendaService; changes: RecordingChanges }> {
      const changes = new RecordingChanges();
      const agenda = service(new MemoryRepository(), changes);
      should((await agenda.raise(SESSION, INFO, AGENT)).ok).be.true();
      return { agenda, changes };
    }

    async function told(changes: RecordingChanges): Promise<RecordingMessenger> {
      const messenger = new RecordingMessenger();
      const delivery = new AgendaReplyDelivery(messenger, 'fy');
      for (const { sessionId, change } of changes.seen) await delivery.changed(sessionId, change);
      return messenger;
    }

    it('should resolve a bare Got it quietly: on the board, told to no one', async () => {
      // Arrange
      const { agenda, changes } = await raised();

      // Act
      const done = await agenda.resolve(SESSION, 'A1', HUMAN);
      const messenger = await told(changes);

      // Assert
      should(done.ok).be.true();
      const listed = await agenda.list(SESSION);
      should(listed.ok ? listed.value.resolved.map(each => each.id) : []).deepEqual(['A1']);
      should(messenger.sent).deepEqual([]);
    });

    it('should still tell the ferret words the owner typed with it', async () => {
      // Arrange
      const { agenda, changes } = await raised();

      // Act
      await agenda.resolve(SESSION, 'A1', HUMAN, 'thanks, but rerun the smoke test');
      const messenger = await told(changes);

      // Assert
      should(messenger.sent.map(each => each.id)).deepEqual(['A1']);
      should(messenger.sent[0]?.message).containEql('thanks, but rerun the smoke test');
    });

    it('should still tell the ferret a dismissal', async () => {
      // Arrange
      const { agenda, changes } = await raised();

      // Act
      await agenda.dismiss(SESSION, 'A1', HUMAN);
      const messenger = await told(changes);

      // Assert
      should(messenger.sent.map(each => each.id)).deepEqual(['A1']);
    });
  });

  it('should still tell a ferret a bare done on any other kind of item', async () => {
    // Arrange
    const changes = new RecordingChanges();
    const agenda = service(new MemoryRepository(), changes);
    await agenda.raise(SESSION, { ...ASK, kind: 'task', ask: { kind: 'task' } }, AGENT);
    const messenger = new RecordingMessenger();
    const delivery = new AgendaReplyDelivery(messenger, 'fy');

    // Act
    await agenda.resolve(SESSION, 'A1', HUMAN);
    for (const { sessionId, change } of changes.seen) await delivery.changed(sessionId, change);

    // Assert
    should(messenger.sent.map(each => each.id)).deepEqual(['A1']);
  });

  it('should not tell a ferret about an item another session or the daemon raised', async () => {
    // Arrange
    const messenger = new RecordingMessenger();
    const delivery = new AgendaReplyDelivery(messenger, 'fy');
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
    const change = (addressed: unknown): AgendaBoardChange => ({
      change: 'resolved',
      actor: HUMAN,
      via: 'board',
      snapshot: { v: 1, sessionId: SESSION, items: [], resolved: [], count: 0, parseErrors: 0, updatedAt: NOW },
      addressed: addressed as ResolvedAgendaItem,
    });

    // Act
    await delivery.changed(SESSION, change(elsewhere));
    await delivery.changed(SESSION, change(daemon));

    // Assert
    should(messenger.sent).deepEqual([]);
  });

  it('should park the items a person’s message references as replied only after it is accepted, keeping their words', async () => {
    // Arrange
    const repository = new MemoryRepository();
    const changes = new RecordingChanges();
    const agenda = service(repository, changes);
    await agenda.raise(SESSION, ASK, AGENT);
    await agenda.raise(SESSION, { ...ASK, subject: 'Region?', ask: { kind: 'open-question' } }, AGENT);
    await agenda.raise(SESSION, { ...ASK, subject: 'Deploy?', ask: { kind: 'permission' } }, AGENT);
    const conversation = new AgendaConversation(agenda);
    const message = '!A1 wait, !A2 eu-west-1';

    // Act
    const turn = await conversation.prepare(SESSION, message);
    const before = await agenda.list(SESSION);
    await conversation.settle(SESSION, turn, message);
    const after = await agenda.list(SESSION);

    // Assert
    should(turn.message).equal(`[re !A1 «Rebase onto main now?», !A2 «Region?»] ${message}`);
    should(turn.referenced.map(each => each.id)).deepEqual(['A1', 'A2']);
    if (!before.ok || !after.ok) throw new Error('board unreadable');
    should(before.value.items.map(each => each.waitingOn ?? null)).deepEqual([null, null, null]);
    should(before.value.items.map(each => each.parked ?? null)).deepEqual([null, null, null]);
    should(after.value.resolved).have.length(0);
    should(after.value.items.map(each => [each.id, each.parked?.reason ?? null]).sort()).deepEqual([
      ['A1', 'replied'],
      ['A2', 'replied'],
      ['A3', null],
    ]);
    should(after.value.items.find(each => each.id === 'A1')?.history?.at(-1)).containDeep({
      kind: 'replied',
      note: message,
    });
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
    const agenda = service(new MemoryRepository(), changes);
    const messenger = new RecordingMessenger();
    const delivery = new AgendaReplyDelivery(messenger, 'fy');
    await agenda.raise(SESSION, ASK, AGENT);

    // Act
    await agenda.reply(SESSION, 'A1', HUMAN);
    for (const { sessionId, change } of changes.seen) await delivery.changed(sessionId, change);

    // Assert
    should(changes.seen.map(each => each.change.change)).deepEqual(['created', 'replied']);
    should(messenger.sent).deepEqual([]);
  });

  it('should reply in the person’s name, each item on its own, and swallow a failure', async () => {
    // Arrange
    const replied: Array<[string, string, unknown]> = [];
    const conversation = new AgendaConversation({
      list: async () => ({ ok: false, error: { code: 'corrupt', message: 'x' } }),
      reply: async (sessionId, id, actor) => {
        replied.push([sessionId, id, actor]);
        if (id === 'A1') throw new Error('disk gone');
        return { ok: false, error: { code: 'not-found', message: 'gone' } };
      },
    });
    const items = [{ id: 'A1' }, { id: 'A2' }, { id: 'A3' }] as AgendaItem[];

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
    const agenda = service(new MemoryRepository(), new RecordingChanges());
    await agenda.raise(SESSION, ASK, AGENT);
    const conversation = new AgendaConversation(agenda);

    // Act
    const turn = await conversation.prepare(SESSION, 'how is it going?');
    await conversation.settle(SESSION, turn);
    const board = await agenda.list(SESSION);

    // Assert
    should(turn).deepEqual({ message: 'how is it going?', referenced: [] });
    should(board).containDeep({ ok: true, value: { items: [{ id: 'A1' }] } });
    should(board.ok ? board.value.items[0]?.waitingOn : 'unreadable').be.undefined();
  });

  it('should leave a person’s message exactly as written when the board cannot be read', async () => {
    // Arrange
    const conversation = new AgendaConversation({
      list: async () => {
        throw new Error('disk gone');
      },
      reply: async () => ({ ok: false, error: { code: 'corrupt', message: 'x' } }),
    });
    const refused = new AgendaConversation({
      list: async () => ({ ok: false, error: { code: 'not-found', message: 'gone' } }),
      reply: async () => {
        throw new Error('cannot reply');
      },
    });

    // Act
    const unreadable = await conversation.prepare(SESSION, 'hello !A1');
    const missing = await refused.prepare(SESSION, 'hello !A1');
    const item = { id: 'A1', subject: 'Ask?' } as AgendaItem;
    await refused.settle(SESSION, { message: 'x', referenced: [item] });

    // Assert
    should(unreadable).deepEqual({ message: 'hello !A1', referenced: [] });
    should(missing).deepEqual({ message: 'hello !A1', referenced: [] });
  });
});

describe('Agenda board progress observers', () => {
  it('should tell change observers about a tick, but tell the ferret nothing', async () => {
    // Arrange
    const changes = new RecordingChanges();
    const agenda = service(new MemoryRepository(), changes);
    await agenda.raise(SESSION, { ...ASK, ask: { kind: 'task' }, steps: ['Do it'] }, AGENT);
    await agenda.progress(SESSION, 'A1', 0, true, HUMAN);
    const messenger = new RecordingMessenger();
    const delivery = new AgendaReplyDelivery(messenger, 'fy');

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
    const agenda = service(new MemoryRepository(), changes);
    const messenger = new RecordingMessenger();
    const delivery = new AgendaReplyDelivery(messenger, 'fy');
    await agenda.raise(SESSION, TASK, AGENT);

    // Act
    await agenda.needsInfo(SESSION, 'A1', HUMAN, 'Which account?');
    await agenda.edit(SESSION, 'A1', { subject: 'Rebase onto main, which account?' }, AGENT);
    await agenda.needsInfo(SESSION, 'A1', HUMAN);
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
    const delivery = new AgendaReplyDelivery(messenger, 'fy');
    const item = (session: string): AgendaItem =>
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
      }) as AgendaItem;
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

describe('Attention discuss delivery', () => {
  it('should tell the raising ferret once per discussion, under the same counter as a request for information', async () => {
    // Arrange
    const changes = new RecordingChanges();
    const agenda = service(new MemoryRepository(), changes);
    const messenger = new RecordingMessenger();
    const delivery = new AgendaReplyDelivery(messenger, 'fy');
    await agenda.raise(SESSION, ASK, AGENT);

    // Act
    await agenda.discuss(SESSION, 'A1', HUMAN, 'I do not follow the premise');
    await agenda.discuss(SESSION, 'A1', HUMAN, 'asked again');
    await agenda.edit(SESSION, 'A1', { subject: 'Rebase onto main after the freeze?' }, AGENT);
    await agenda.surface(SESSION, 'A1', AGENT);
    await agenda.needsInfo(SESSION, 'A1', HUMAN, 'Which branch?');
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
    const agenda = service(new MemoryRepository(), changes);
    const messenger = new RecordingMessenger();
    const delivery = new AgendaReplyDelivery(messenger, 'fy');
    await agenda.raise(SESSION, ASK, AGENT);
    await agenda.discuss(SESSION, 'A1', HUMAN);
    const seen = changes.seen.at(-1)?.change as AgendaBoardChange;

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
    const agenda = service(new MemoryRepository(), changes);
    const sink = new AgendaBoardUndelivered(agenda);
    await agenda.raise(SESSION, ASK, AGENT);
    await agenda.raise(SESSION, { ...ASK, subject: 'Second ask?' }, AGENT);
    await agenda.answer(SESSION, 'A1', { kind: 'multiple-choice', choice: 'Rebase now' }, HUMAN);
    await agenda.discuss(SESSION, 'A2', HUMAN, 'why?');

    // Act
    await sink.undelivered(SESSION, 'A1', 'it never appeared in the ferret’s transcript');
    await sink.undelivered(SESSION, 'A2~1', 'the ferret was removed');
    await sink.undelivered(SESSION, 'instructions~0123456789abcd', 'ignored');
    const board = await agenda.list(SESSION);

    // Assert
    if (!board.ok) throw new Error(board.error.message);
    should(board.value.items.map(each => [each.id, each.undelivered?.reply.action, each.waitingOn ?? null])).deepEqual([
      ['A1', 'resolve', null],
      ['A2', 'discuss', null],
    ]);
    should(changes.seen.filter(each => each.change.change === 'reopened')).have.length(2);
  });
});
