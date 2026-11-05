import { describe, it } from 'bun:test';
import { AGENDA_REST_NUDGE_MS, type AgendaItem } from '@ferretry/protocol';
import should from 'should';
import {
  AGENDA_REST_NUDGE_MAX_MS,
  AgendaRestNudger,
  type AgendaRestNudgePorts,
  REST_NUDGE_SWEEP_MS,
  restNudgeDueAt,
  restNudgeMessage,
  restNudgeSendId,
  restNudgesDue,
} from '../../../src/lib/agenda/rest-nudge.ts';
import { AgendaService, type AgendaLedgerRepository } from '../../../src/lib/agenda/service.ts';
import type { AgendaActor, AgendaLedger, AgendaMutation } from '../../../src/lib/agenda/state-machine.ts';
import { AGENDA_NUDGE_MARK } from '../../../src/lib/agenda/turn-nudge.ts';

const SESSION = 'ms8kkfyd-95b7037e';
const REPLIED = '2026-11-03T09:00:00.000Z';
const at = (minutes: number): string => new Date(Date.parse(REPLIED) + minutes * 60_000).toISOString();
const AGENT: AgendaActor = { kind: 'agent', sessionId: SESSION, name: 'Ada' };
const HUMAN: AgendaActor = { kind: 'human' };

const resting = (id: string, rest: Partial<NonNullable<AgendaItem['resting']>> = {}): AgendaItem =>
  ({
    id,
    source: 'agent-raised',
    sourceRef: null,
    subject: `Ask ${id}?`,
    title: `Ask ${id}`,
    why: 'w',
    howToResolve: 'h',
    waitingSince: '2026-11-03T08:00:00.000Z',
    raisedBy: 'agent',
    raisedBySession: SESSION,
    raisedByName: 'Ada',
    parked: { reason: 'replied', at: REPLIED },
    resting: { sub: 'waiting-on-ferret', at: REPLIED, ...rest },
  }) as AgendaItem;

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

describe('when a resting item’s nudge is due', () => {
  it('should be 30 minutes after the owner replied, then double after each nudge, up to a day', () => {
    // Assert
    should(restNudgeDueAt(resting('A1'))).equal(Date.parse(REPLIED) + AGENDA_REST_NUDGE_MS);
    should(restNudgeDueAt(resting('A1', { nudgedAt: at(30), nudges: 1 }))).equal(Date.parse(at(90)));
    should(restNudgeDueAt(resting('A1', { nudgedAt: at(90), nudges: 2 }))).equal(Date.parse(at(210)));
    should(restNudgeDueAt(resting('A1', { nudgedAt: at(0), nudges: 9 }))).equal(
      Date.parse(at(0)) + AGENDA_REST_NUDGE_MAX_MS,
    );
  });

  it('should never nudge an item the ferret works on, a snoozed one, or a migrated one twice', () => {
    // Assert
    should(restNudgeDueAt(resting('A1', { sub: 'working', why: 'rebasing' }))).be.undefined();
    should(
      restNudgeDueAt({ ...resting('A1'), parked: { reason: 'snoozed', at: REPLIED, until: at(600) } }),
    ).be.undefined();
    should(restNudgeDueAt(resting('A1', { migrated: true }))).equal(Date.parse(at(30)));
    should(restNudgeDueAt(resting('A1', { migrated: true, nudgedAt: at(30), nudges: 1 }))).be.undefined();
  });

  it('should pick only the ferret’s own items that are due, oldest first', () => {
    // Arrange
    const daemonCard = {
      ...resting('A3'),
      raisedBy: 'daemon',
      raisedBySession: null,
      raisedByName: null,
    } as AgendaItem;
    const items = [resting('A2', { at: at(10) }), resting('A1'), daemonCard, resting('A4', { at: at(25) })];

    // Act
    const due = restNudgesDue(items, Date.parse(at(45)));

    // Assert
    should(due.map(item => item.id)).deepEqual(['A1', 'A2']);
  });

  it('should say every item in one short message, and name each nudge in its send id', () => {
    // Arrange
    const items = [resting('A1'), resting('A2', { nudges: 1, nudgedAt: at(30) })];

    // Act
    const message = restNudgeMessage(items, 'fy');

    // Assert
    should(message.startsWith(AGENDA_NUDGE_MARK)).be.true();
    should(message).containEql('!A1 «Ask A1», !A2 «Ask A2»');
    should(message).containEql('fy agenda answer A1');
    should(message).containEql('fy agenda rest A1 --why');
    should(message).containEql('fy agenda done A1');
    should(restNudgeSendId(SESSION, items)).equal(`agenda-rest-nudge-${SESSION}-A1.${Date.parse(REPLIED)}.1`);
  });
});

describe('the silence nudge sweep', () => {
  const world = async (now: { value: string }, enabled = true) => {
    const repository = new MemoryRepository();
    const agenda = new AgendaService(
      repository,
      { now: () => now.value },
      { has: async () => true },
      { raised: async () => undefined },
    );
    const sent: Array<{ sessionId: string; sendId: string; message: string }> = [];
    const recorded: Array<{ sessionId: string; asks: readonly string[] }> = [];
    const nudger = new AgendaRestNudger(
      repository,
      agenda,
      {
        enabled: async () => enabled,
        send: async (sessionId, sendId, message) => {
          sent.push({ sessionId, sendId, message });
        },
        record: async (sessionId, asks) => {
          recorded.push({ sessionId, asks });
        },
      },
      () => [SESSION],
      { schedule: () => undefined, cancel: () => undefined },
      () => now.value,
      'fy',
    );
    const ask = {
      source: 'agent-raised' as const,
      sourceRef: null,
      title: 'Region',
      subject: 'Which region?',
      why: 'w',
      premise: 'p',
      context: 'c',
      howToResolve: 'h',
      kind: 'reply' as const,
      ask: { kind: 'open-question' as const },
    };
    now.value = at(-60);
    await agenda.raise(SESSION, ask, AGENT);
    await agenda.raise(SESSION, { ...ask, subject: 'Which cluster?', title: 'Cluster' }, AGENT);
    now.value = REPLIED;
    await agenda.reply(SESSION, 'A1', HUMAN, 'what is EU?');
    await agenda.answer(SESSION, 'A2', { kind: 'open-question', answer: 'the big one' }, HUMAN);
    return { repository, agenda, nudger, sent, recorded };
  };

  it('should nudge the ferret once for both items after 30 minutes, record it, and not again until the backoff', async () => {
    // Arrange
    const now = { value: REPLIED };
    const { repository, nudger, sent, recorded } = await world(now);

    // Act
    now.value = at(29);
    const early = await nudger.sweep();
    now.value = at(31);
    const due = await nudger.sweep();
    now.value = at(60);
    const tooSoon = await nudger.sweep();
    now.value = at(92);
    const backoff = await nudger.sweep();

    // Assert
    should([early, due, tooSoon, backoff]).deepEqual([0, 1, 0, 1]);
    should(sent).have.length(2);
    should(sent[0]?.sendId).equal(`agenda-rest-nudge-${SESSION}-A1.${Date.parse(REPLIED)}.1`);
    should(sent[1]?.sendId).equal(`agenda-rest-nudge-${SESSION}-A1.${Date.parse(REPLIED)}.2`);
    should(recorded[0]?.asks).deepEqual(['waiting on you !A1', 'waiting on you !A2']);
    const board = await repository.read(SESSION);
    const items = board?.entries.map(entry => entry.item) ?? [];
    should(items.map(item => item.resting?.nudges)).deepEqual([2, 2]);
  });

  it('should stop nudging once the ferret answers, takes the item on, or marks it done', async () => {
    // Arrange
    const now = { value: REPLIED };
    const { agenda, nudger, sent } = await world(now);
    now.value = at(10);
    await agenda.edit(SESSION, 'A1', { questionAnswer: 'EU is Frankfurt.' }, AGENT);
    await agenda.rest(SESSION, 'A2', 'checking the big one', AGENT);

    // Act
    now.value = at(120);
    const swept = await nudger.sweep();

    // Assert
    should(swept).equal(0);
    should(sent).be.empty();
  });

  it('should say nothing while the machine has the agenda nudge off', async () => {
    // Arrange
    const now = { value: REPLIED };
    const { nudger, sent } = await world(now, false);

    // Act
    now.value = at(120);
    const swept = await nudger.sweep();

    // Assert
    should(swept).equal(0);
    should(sent).be.empty();
  });

  it('should record nothing for a nudge that did not go, so the next sweep tries again', async () => {
    // Arrange
    const now = { value: REPLIED };
    const { repository, agenda } = await world(now);
    const nudger = new AgendaRestNudger(
      repository,
      agenda,
      {
        enabled: async () => true,
        send: async () => {
          throw new Error('the ferret is gone');
        },
        record: async () => undefined,
      },
      () => [SESSION],
      { schedule: () => undefined, cancel: () => undefined },
      () => now.value,
      'fy',
    );

    // Act
    now.value = at(45);
    const swept = await nudger.sweep();

    // Assert
    should(swept).equal(0);
    const board = await repository.read(SESSION);
    should(board?.entries.map(entry => entry.item.resting?.nudges)).deepEqual([undefined, undefined]);
  });
});

describe('the silence nudge across reply cycles, restarts and replies during a send', () => {
  /** A send port the way the durable paths behave: the same id twice is one message. */
  const dedupingPorts = (delivered: string[], hold?: { gate: Promise<void>; entered: () => void }) => ({
    enabled: async () => true,
    send: async (_sessionId: string, sendId: string) => {
      hold?.entered();
      await hold?.gate;
      if (!delivered.includes(sendId)) delivered.push(sendId);
    },
    record: async () => undefined,
  });

  const rig = async (now: { value: string }) => {
    const repository = new MemoryRepository();
    const agenda = new AgendaService(
      repository,
      { now: () => now.value },
      { has: async () => true },
      { raised: async () => undefined },
    );
    const ask = {
      source: 'agent-raised' as const,
      sourceRef: null,
      title: 'Region',
      subject: 'Which region?',
      why: 'w',
      premise: 'p',
      context: 'c',
      howToResolve: 'h',
      kind: 'reply' as const,
      ask: { kind: 'open-question' as const },
    };
    now.value = at(-60);
    await agenda.raise(SESSION, ask, AGENT);
    await agenda.raise(SESSION, { ...ask, subject: 'Which cluster?', title: 'Cluster' }, AGENT);
    now.value = REPLIED;
    await agenda.reply(SESSION, 'A1', HUMAN, 'what is EU?');
    await agenda.reply(SESSION, 'A2', HUMAN, 'and the cluster?');
    const nudgerOver = (service: Pick<AgendaService, 'nudging' | 'nudged'>, ports: AgendaRestNudgePorts) =>
      new AgendaRestNudger(
        repository,
        service,
        ports,
        () => [SESSION],
        { schedule: () => undefined, cancel: () => undefined },
        () => now.value,
        'fy',
      );
    const restingOf = async (id: string) =>
      (await repository.read(SESSION))?.entries.find(entry => entry.item.id === id)?.item.resting;
    return { agenda, nudgerOver, restingOf };
  };

  it('should send a later reply cycle’s nudge under its own id, so a deduplicating send port still delivers it', async () => {
    // Arrange — A1 is nudged once, the ferret answers, the owner replies again
    const now = { value: REPLIED };
    const { agenda, nudgerOver, restingOf } = await rig(now);
    const delivered: string[] = [];
    const nudger = nudgerOver(agenda, dedupingPorts(delivered));
    now.value = at(31);
    await nudger.sweep();
    now.value = at(35);
    await agenda.edit(SESSION, 'A1', { questionAnswer: 'EU is Frankfurt.' }, AGENT);
    await agenda.edit(SESSION, 'A2', { questionAnswer: 'The big one.' }, AGENT);
    now.value = at(100);
    await agenda.reply(SESSION, 'A1', HUMAN, 'and Asia?');

    // Act
    now.value = at(131);
    const swept = await nudger.sweep();

    // Assert
    should(swept).equal(1);
    should(delivered).have.length(2);
    should(new Set(delivered).size).equal(2);
    should((await restingOf('A1'))?.nudges).equal(1);
  });

  it('should resume a half-recorded two-item nudge under its first id after a restart, and never nudge twice', async () => {
    // Arrange — the send went out, A1 was recorded, and the daemon died before A2 was
    const now = { value: REPLIED };
    const { agenda, nudgerOver, restingOf } = await rig(now);
    const delivered: string[] = [];
    const dying = nudgerOver(
      {
        nudging: (sessionId, items, sendId) => agenda.nudging(sessionId, items, sendId),
        nudged: async (sessionId, target) => {
          if (target.id === 'A2') throw new Error('the daemon stopped');
          return await agenda.nudged(sessionId, target);
        },
      },
      dedupingPorts(delivered),
    );
    now.value = at(31);
    await dying.sweep();

    // Act — a restarted daemon sweeps again
    now.value = at(32);
    const restarted = nudgerOver(agenda, dedupingPorts(delivered));
    const swept = await restarted.sweep();

    // Assert
    should(swept).equal(1);
    should(delivered).have.length(1);
    should((await restingOf('A1'))?.nudges).equal(1);
    should((await restingOf('A2'))?.nudges).equal(1);
    should((await restingOf('A2'))?.nudgeSend).be.undefined();
  });

  it('should leave a newer reply’s clock alone when a held nudge completes after the owner replied again', async () => {
    // Arrange — A1's nudge is in flight (the send waits) when the owner replies on it again
    const now = { value: REPLIED };
    const { agenda, nudgerOver, restingOf } = await rig(now);
    const delivered: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const sending = new Promise<void>(resolve => {
      entered = resolve;
    });
    const nudger = nudgerOver(agenda, dedupingPorts(delivered, { gate, entered }));
    now.value = at(31);
    const pending = nudger.sweep();
    await sending;
    now.value = at(33);
    await agenda.reply(SESSION, 'A1', HUMAN, 'one more thing');

    // Act
    release();
    await pending;

    // Assert — the new rest has no nudge recorded, so its first one is still 30 minutes after the reply
    const fresh = await restingOf('A1');
    should(fresh?.at).equal(at(33));
    should(fresh?.nudges).be.undefined();
    should(fresh?.nudgedAt).be.undefined();
    now.value = at(64);
    should(await nudgerOver(agenda, dedupingPorts(delivered)).sweep()).equal(1);
  });
});

describe('the silence nudge timer', () => {
  it('should sweep at once, then every minute, and cancel its timer on stop', async () => {
    // Arrange
    const scheduled: Array<{ key: string; delayMs: number }> = [];
    const callbacks: Array<() => void> = [];
    const cancelled: string[] = [];
    let sweeps = 0;
    const nudger = new AgendaRestNudger(
      new MemoryRepository(),
      {
        nudging: async () => ({ ok: false, error: { code: 'invalid', message: 'unused' } }),
        nudged: async () => ({ ok: false, error: { code: 'invalid', message: 'unused' } }),
      },
      {
        enabled: async () => {
          sweeps += 1;
          return false;
        },
        send: async () => undefined,
        record: async () => undefined,
      },
      () => [SESSION],
      {
        schedule: (key, delayMs, run) => {
          scheduled.push({ key, delayMs });
          callbacks.push(run);
        },
        cancel: key => {
          cancelled.push(key);
        },
      },
      () => REPLIED,
      'fy',
    );
    const settle = async () => await new Promise(resolve => setTimeout(resolve, 0));

    // Act
    nudger.start();
    await settle();
    callbacks[0]?.();
    await settle();
    nudger.stop();

    // Assert
    should(sweeps).equal(2);
    should(scheduled).deepEqual([
      { key: 'agenda-rest-nudge', delayMs: REST_NUDGE_SWEEP_MS },
      { key: 'agenda-rest-nudge', delayMs: REST_NUDGE_SWEEP_MS },
    ]);
    should(cancelled).deepEqual(['agenda-rest-nudge']);
  });
});
