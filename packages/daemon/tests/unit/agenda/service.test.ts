import { describe, it } from 'bun:test';
import should from 'should';
import type {
  AgendaLedger,
  AgendaLedgerRepository,
  AgendaMutation,
  AgendaRaisedObserver,
} from '../../../src/lib/agenda/index.ts';
import {
  type AgendaFocusSource,
  AgendaService,
  isAgendaSessionId,
  NO_AGENDA_FOCUS,
} from '../../../src/lib/agenda/service.ts';

const SESSION = 'session-1';
const NOW = '2026-07-31T10:00:00Z';
const AGENT = { kind: 'agent' as const, sessionId: SESSION, name: 'Ada' };

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

class Observer implements AgendaRaisedObserver {
  readonly calls: Array<{ sessionId: string; itemId: string; count: number }> = [];

  async raised(sessionId: string, item: { id: string }, snapshot: { count: number }): Promise<void> {
    this.calls.push({ sessionId, itemId: item.id, count: snapshot.count });
  }
}

function createService(
  repository = new MemoryRepository(),
  observer: AgendaRaisedObserver = new Observer(),
): {
  readonly repository: MemoryRepository;
  readonly service: AgendaService;
  readonly observer: AgendaRaisedObserver;
} {
  return {
    repository,
    observer,
    service: new AgendaService(
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
  premise: 'A release is ready to go out.',
  context: 'It changes the public service.',
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

  it('should title an untitled daemon raise by its cause, and leave a worded or human title alone', async () => {
    // Arrange
    const { repository, service } = createService();
    const daemon = (cause: 'warden-escalation' | 'system', ref: string, title?: string) =>
      service.raise(
        SESSION,
        { ...request, source: 'task', sourceRef: ref, ask: undefined, ...(title === undefined ? {} : { title }) },
        { kind: 'daemon', cause },
      );

    // Act
    await daemon('warden-escalation', 'F1');
    await daemon('system', 'F2');
    await daemon('system', 'F3', 'Worded by the daemon');
    await service.raise(SESSION, request, AGENT);

    // Assert
    const items = repository.ledgers.get(SESSION)?.entries.map(entry => entry.item);
    should(items?.map(item => item.title)).deepEqual([
      'A ferret needs a human',
      'Needs you',
      'Worded by the daemon',
      undefined,
    ]);
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
    should(isAgendaSessionId('A_1-session')).be.true();
    should(isAgendaSessionId('')).be.false();
    should(isAgendaSessionId('-bad')).be.false();
    should(isAgendaSessionId('bad/path')).be.false();
    should(isAgendaSessionId('a'.repeat(129))).be.false();
  });
});

describe('Agenda service progress', () => {
  it('should tick a step without announcing the item again, and refuse one that does not exist', async () => {
    // Arrange
    const observer = new Observer();
    const { service } = createService(new MemoryRepository(), observer);
    await service.raise(SESSION, { ...request, ask: { kind: 'task' }, steps: ['One', 'Two'] }, AGENT);

    // Act
    const ticked = await service.progress(SESSION, 'A1', 1, true, { kind: 'human' });
    const again = await service.progress(SESSION, 'A1', 1, true, AGENT);
    const missing = await service.progress(SESSION, 'A1', 2, true, AGENT);

    // Assert
    should(ticked).containDeep({ ok: true, change: 'progressed', item: { stepsDone: [1] } });
    should(again).containDeep({ ok: true, changed: false, change: 'unchanged' });
    should(missing.ok).be.false();
    should(observer.calls).have.length(1);
  });
});

describe('an agenda item belongs to a card', () => {
  const withFocus = (focus: AgendaFocusSource) => {
    const repository = new MemoryRepository();
    const service = new AgendaService(
      repository,
      { now: () => NOW },
      { has: async sessionId => sessionId === SESSION },
      new Observer(),
      undefined,
      focus,
    );
    return { repository, service };
  };
  const taskOf = (mutation: AgendaMutation) => (mutation.ok ? mutation.item?.task : undefined);

  it("should take the raising session's focus card when the add names none", async () => {
    // Arrange
    const asked: string[] = [];
    const { service } = withFocus({
      focusOf: async sessionId => {
        asked.push(sessionId);
        return { id: 'F18' };
      },
    });

    // Act
    const agent = await service.raise(SESSION, request, AGENT);
    const harness = await service.raise(SESSION, request, { kind: 'daemon', cause: 'harness-prompt' });
    const warden = await service.raise(SESSION, request, { kind: 'daemon', cause: 'warden-escalation' });

    // Assert
    should([taskOf(agent), taskOf(harness), taskOf(warden)]).deepEqual([{ id: 'F18' }, { id: 'F18' }, { id: 'F18' }]);
    should(asked).deepEqual([SESSION, SESSION, SESSION]);
  });

  it('should keep the card an add names, and leave an item without one when there is no focus to take', async () => {
    // Arrange
    const focused = withFocus({ focusOf: async () => ({ id: 'F18' }) });
    const unfocused = withFocus({ focusOf: async () => null });
    const broken = withFocus({ focusOf: async () => Promise.reject(new Error('config unreadable')) });

    // Act
    const named = await focused.service.raise(SESSION, { ...request, task: { id: 'F9' } }, AGENT);
    const none = await unfocused.service.raise(SESSION, request, AGENT);
    const failed = await broken.service.raise(SESSION, request, AGENT);

    // Assert
    should(taskOf(named)).deepEqual({ id: 'F9' });
    should(taskOf(none)).be.undefined();
    should(taskOf(failed)).be.undefined();
  });

  it('should not look up a focus for a session id it would refuse', async () => {
    // Arrange
    const asked: string[] = [];
    const { service } = withFocus({
      focusOf: async sessionId => {
        asked.push(sessionId);
        return null;
      },
    });

    // Act
    await service.raise('../escape', request, AGENT);

    // Assert
    should(asked).be.empty();
  });

  it('should take no card at all by default', async () => {
    // Arrange
    const { service } = createService();

    // Act / Assert
    should(taskOf(await service.raise(SESSION, request, AGENT))).be.undefined();
    should(await NO_AGENDA_FOCUS.focusOf(SESSION)).be.null();
  });
});

describe('Agenda service: parking', () => {
  const HUMAN = { kind: 'human' as const };
  const LATER = '2026-08-01T10:00:00Z';
  const board = async (service: AgendaService) => {
    const listed = await service.list(SESSION);
    if (!listed.ok) throw new Error('board unreadable');
    return listed.value;
  };

  it('should snooze an item, bring it back on unsnooze, and park it on a reply', async () => {
    // Arrange
    const { service } = createService();
    await service.raise(SESSION, request, AGENT);

    // Act
    const snoozed = await service.snooze(SESSION, 'A1', LATER, HUMAN);
    const unsnoozed = await service.unsnooze(SESSION, 'A1', HUMAN);
    const replied = await service.reply(SESSION, 'A1', HUMAN, 'Later');

    // Assert
    should(snoozed).containDeep({ ok: true, change: 'parked', item: { parked: { reason: 'snoozed', until: LATER } } });
    should(unsnoozed).containDeep({ ok: true, change: 'unparked' });
    should(replied).containDeep({ ok: true, change: 'replied', item: { parked: { reason: 'replied', at: NOW } } });
  });

  it('should refuse a snooze from a ferret or into the past', async () => {
    // Arrange
    const { service } = createService();
    await service.raise(SESSION, request, AGENT);

    // Act
    const byAgent = await service.snooze(SESSION, 'A1', LATER, AGENT);
    const past = await service.snooze(SESSION, 'A1', NOW, HUMAN);

    // Assert
    should(byAgent).containDeep({ ok: false, error: { code: 'forbidden' } });
    should(past).containDeep({ ok: false, error: { code: 'invalid' } });
  });

  it('should wake a snoozed item only once its time has come, through the daemon’s timer alone', async () => {
    // Arrange
    const repository = new MemoryRepository();
    const clock = { at: NOW };
    const service = new AgendaService(repository, { now: () => clock.at }, { has: async () => true }, new Observer());
    await service.raise(SESSION, request, AGENT);
    await service.snooze(SESSION, 'A1', LATER, HUMAN);

    // Act
    const early = await service.wake(SESSION, 'A1');
    clock.at = LATER;
    const due = await service.wake(SESSION, 'A1');

    // Assert
    should(early).containDeep({ ok: true, change: 'unchanged' });
    should(due).containDeep({ ok: true, change: 'woke', item: { waitingSince: LATER } });
    should(due.ok ? due.item?.parked : 'refused').be.undefined();
  });

  it('should pass now through edit and surface, and leave it out when it is not said', async () => {
    // Arrange
    const { service } = createService();
    await service.raise(SESSION, request, AGENT);
    await service.snooze(SESSION, 'A1', LATER, HUMAN);

    // Act
    const quietEdit = await service.edit(SESSION, 'A1', { stillOpen: 'Which region?' }, AGENT);
    const quietSurface = await service.surface(SESSION, 'A1', AGENT);
    const urgentSurface = await service.surface(SESSION, 'A1', AGENT, 'Closes today', true);
    const afterwards = await board(service);
    await service.snooze(SESSION, 'A1', LATER, HUMAN);
    const tooSoon = await service.edit(SESSION, 'A1', { stillOpen: 'Which cluster?' }, AGENT, true);

    // Assert
    should(quietEdit).containDeep({ ok: true, item: { parked: { reason: 'snoozed' } } });
    should(quietSurface).containDeep({ ok: true, change: 'unchanged' });
    should(urgentSurface).containDeep({ ok: true, change: 'unparked', item: { urgentAt: NOW } });
    should(afterwards.items[0]?.parked).be.undefined();
    should(tooSoon).containDeep({ ok: false, error: { code: 'rate-limited' } });
  });

  it('should wake a snoozed item on an edit with now', async () => {
    // Arrange
    const { service } = createService();
    await service.raise(SESSION, request, AGENT);
    await service.snooze(SESSION, 'A1', LATER, HUMAN);

    // Act
    const urgent = await service.edit(SESSION, 'A1', { stillOpen: 'Which region?' }, AGENT, true);

    // Assert
    should(urgent).containDeep({ ok: true, item: { stillOpen: 'Which region?', urgentAt: NOW } });
    should(urgent.ok ? urgent.item?.parked : 'refused').be.undefined();
  });
});

describe('an agenda item offers to close the card that waits to be tried', () => {
  const taskRequest = { ...request, kind: 'task' as const, ask: { kind: 'task' as const } };
  const withCards = (waiting: readonly string[]) => {
    const asked: string[] = [];
    const repository = new MemoryRepository();
    const service = new AgendaService(
      repository,
      { now: () => NOW },
      { has: async sessionId => sessionId === SESSION },
      new Observer(),
      undefined,
      NO_AGENDA_FOCUS,
      undefined,
      {
        inToTest: async task => {
          asked.push(task.id);
          if (task.id === 'BROKEN') throw new Error('board unreadable');
          return waiting.includes(task.id);
        },
      },
    );
    return { asked, service };
  };
  const offered = (mutation: AgendaMutation) => (mutation.ok ? mutation.item?.offerClose : undefined);

  it('should offer by default for a to-do or a review on a card in the to-test lane', async () => {
    // Arrange
    const { service } = withCards(['F12']);

    // Act
    const todo = await service.raise(SESSION, { ...taskRequest, task: { id: 'F12' } }, AGENT);
    const review = await service.raise(SESSION, { ...request, kind: 'review', task: { id: 'F12' } }, AGENT);

    // Assert
    should([offered(todo), offered(review)]).deepEqual([true, true]);
  });

  it('should not offer for another lane, another kind, a notice, a card-less item or an unreadable board', async () => {
    // Arrange
    const { asked, service } = withCards(['F12']);

    // Act
    const elsewhere = await service.raise(SESSION, { ...taskRequest, task: { id: 'F99' } }, AGENT);
    const permission = await service.raise(SESSION, { ...request, task: { id: 'F12' } }, AGENT);
    const notice = await service.raise(
      SESSION,
      { ...request, kind: 'info', notice: true, ask: undefined, task: { id: 'F12' } },
      AGENT,
    );
    const cardless = await service.raise(SESSION, taskRequest, AGENT);
    const broken = await service.raise(SESSION, { ...taskRequest, task: { id: 'BROKEN' } }, AGENT);

    // Assert
    should([elsewhere, permission, notice, cardless, broken].map(offered)).deepEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    should(asked).deepEqual(['F99', 'BROKEN']);
  });

  it('should keep an offer the add asked for without asking the board', async () => {
    // Arrange
    const { asked, service } = withCards([]);

    // Act
    const raised = await service.raise(SESSION, { ...request, task: { id: 'F12' }, offerClose: true }, AGENT);

    // Assert
    should(offered(raised)).equal(true);
    should(asked).deepEqual([]);
  });

  it('should offer nothing by default when no board is wired', async () => {
    // Arrange
    const { service } = createService();

    // Act
    const raised = await service.raise(SESSION, { ...taskRequest, task: { id: 'F12' } }, AGENT);

    // Assert
    should(offered(raised)).be.undefined();
  });
});
