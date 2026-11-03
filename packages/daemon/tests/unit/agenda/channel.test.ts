import { describe, it } from 'bun:test';
import { type AgendaItem, AGENDA_URGENT_WAKE_MS, agendaState, needsYouQueue, restingQueue } from '@ferretry/protocol';
import should from 'should';
import {
  AGENDA_LEDGER_VERSION,
  type AgendaActor,
  type AgendaCommand,
  type AgendaLedger,
  type AgendaMutation,
  type RaiseAgendaRequest,
  agendaSnapshot,
  applyAgendaCommand,
  applyAgendaCommandToSession,
  parseAgendaLedger,
  restsOnAnswer,
  toChannel,
} from '../../../src/lib/agenda/state-machine.ts';

/**
 * THE AGENDA AS A CHANNEL (docs/agenda.md § States), the owner's rules on !A304: any reply or answer rests an item,
 * waiting on its ferret; the ferret's answer brings it back to its old place; only the ferret's done (or the owner's
 * explicit done or dismiss) closes it; a new ask re-enters fresh; a blocker wakes a snooze.
 */

const SESSION_ID = 'session-1';
const T0 = '2026-11-03T08:00:00.000Z';
const T1 = '2026-11-03T09:00:00.000Z';
const T2 = '2026-11-03T10:00:00.000Z';
const T3 = '2026-11-03T11:00:00.000Z';
const T4 = '2026-11-03T12:00:00.000Z';

const HUMAN: AgendaActor = { kind: 'human' };
const AGENT: AgendaActor = { kind: 'agent', sessionId: SESSION_ID, name: 'Ada' };
const SYSTEM: AgendaActor = { kind: 'daemon', cause: 'system' };

const REGION: RaiseAgendaRequest = {
  source: 'agent-raised',
  sourceRef: null,
  title: 'Deploy region',
  subject: 'Which region should the deploy use?',
  why: 'The deploy needs one.',
  premise: 'A release is ready.',
  context: 'Two regions are set up.',
  howToResolve: 'Pick one.',
  kind: 'choice',
  ask: { kind: 'multiple-choice', options: [{ label: 'EU' }, { label: 'US' }] },
};

function ok(result: AgendaMutation): Extract<AgendaMutation, { ok: true }> {
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

function refused(result: AgendaMutation): Extract<AgendaMutation, { ok: false }> {
  if (result.ok) throw new Error('expected the agenda to refuse');
  return result;
}

const apply = (ledger: AgendaLedger, command: AgendaCommand) => applyAgendaCommand(ledger, command);

/** A board with the ferret's asks A1 (at T0) and A2 (at T1), in that order. */
function board(overrides: Partial<RaiseAgendaRequest> = {}): AgendaLedger {
  const first = ok(
    applyAgendaCommandToSession(null, SESSION_ID, {
      action: 'raise',
      actor: AGENT,
      request: { ...REGION, ...overrides },
      at: T0,
    }),
  );
  return ok(
    apply(first.ledger, {
      action: 'raise',
      actor: AGENT,
      request: { ...REGION, ...overrides, subject: 'Which cluster?', title: 'Cluster' },
      at: T1,
    }),
  ).ledger;
}

const item = (ledger: AgendaLedger, id = 'A1'): AgendaItem => {
  const found = agendaSnapshot(ledger).items.find(each => each.id === id);
  if (found === undefined) throw new Error(`no open ${id}`);
  return found;
};

const queue = (ledger: AgendaLedger): string[] => needsYouQueue(agendaSnapshot(ledger).items).map(each => each.id);

const reply = (ledger: AgendaLedger, at = T2) =>
  ok(apply(ledger, { action: 'reply', actor: HUMAN, id: 'A1', note: 'what is EU?', at })).ledger;

const answerOwner = (ledger: AgendaLedger, choice = 'EU', at = T2, askVersion?: number) =>
  apply(ledger, {
    action: 'answer',
    actor: HUMAN,
    id: 'A1',
    response: { kind: 'multiple-choice', choice },
    note: 'keep it near',
    at,
    ...(askVersion === undefined ? {} : { askVersion }),
  });

const answerFerret = (ledger: AgendaLedger, at = T3) =>
  ok(
    apply(ledger, {
      action: 'edit',
      actor: AGENT,
      id: 'A1',
      patch: { questionAnswer: 'EU keeps the data in Frankfurt.' },
      at,
    }),
  );

describe('the agenda as a channel', () => {
  it('should rest an item on the owner’s reply: waiting on the ferret, out of the Needs-you queue', () => {
    // Act
    const replied = reply(board());

    // Assert
    should(agendaState(item(replied))).deepEqual({ state: 'resting', sub: 'waiting-on-ferret', since: T2 });
    should(item(replied).parked).deepEqual({ reason: 'replied', at: T2 });
    should(queue(replied)).deepEqual(['A2']);
  });

  it('should never make an item done on the owner’s answer: it rests, carrying the answer', () => {
    // Act
    const answered = ok(answerOwner(board()));

    // Assert
    should(answered.change).equal('answered');
    should(answered.addressed).be.undefined();
    should(agendaSnapshot(answered.ledger).resolved).be.empty();
    should(answered.item?.ownerAnswer).containDeep({
      response: { kind: 'multiple-choice', choice: 'EU' },
      note: 'keep it near',
      request: 1,
    });
    should(agendaState(item(answered.ledger))).containDeep({ state: 'resting', sub: 'waiting-on-ferret' });
  });

  it('should close it only on the ferret’s done, or the owner’s explicit done or dismiss', () => {
    // Arrange
    const answered = ok(answerOwner(board())).ledger;

    // Act
    const ferretDone = ok(apply(answered, { action: 'resolve', actor: AGENT, id: 'A1', at: T3 }));
    const ownerDone = ok(apply(board(), { action: 'resolve', actor: HUMAN, id: 'A1', at: T3 }));
    const dismissed = ok(apply(board(), { action: 'dismiss', actor: HUMAN, id: 'A1', at: T3 }));

    // Assert
    should(ferretDone.addressed).containDeep({ disposition: 'done', stage: 'done' });
    should(ferretDone.addressed?.ownerAnswer?.response).deepEqual({ kind: 'multiple-choice', choice: 'EU' });
    should(ownerDone.addressed?.disposition).equal('done');
    should(dismissed.addressed?.disposition).equal('dismissed');
  });

  it('should bring the item back to its OLD place in the queue on the ferret’s answer', () => {
    // Arrange — A1 rests on the reply while A2 waits; the owner has seen A1 since T0
    const replied = reply(board());

    // Act
    const answered = answerFerret(replied);

    // Assert — A1 is ahead of A2 again, as it was before the reply
    should(answered.item?.waitingSince).equal(T0);
    should(answered.item?.parked).be.undefined();
    should(answered.item?.resting).be.undefined();
    should(queue(answered.ledger)).deepEqual(['A1', 'A2']);
  });

  it('should re-enter FRESH when the ferret answers on an item it took on (working): it is a new need', () => {
    // Arrange
    const working = ok(apply(board(), { action: 'rest', actor: AGENT, id: 'A1', why: 'checking the regions', at: T2 }));

    // Act
    const answered = answerFerret(working.ledger);

    // Assert
    should(working.change).equal('rested');
    should(agendaState(working.item ?? item(working.ledger))).containDeep({ state: 'resting', sub: 'working' });
    should(working.item?.resting?.why).equal('checking the regions');
    should(answered.item?.waitingSince).equal(T3);
    should(queue(answered.ledger)).deepEqual(['A2', 'A1']);
  });

  it('should take an item on only for its ferret, never through the owner’s snooze', () => {
    // Arrange
    const snoozed = ok(apply(board(), { action: 'snooze', actor: HUMAN, id: 'A1', until: T4, at: T1 })).ledger;

    // Act
    const byOwner = refused(apply(board(), { action: 'rest', actor: HUMAN, id: 'A1', why: 'x', at: T2 }));
    const throughSnooze = refused(apply(snoozed, { action: 'rest', actor: AGENT, id: 'A1', why: 'x', at: T2 }));

    // Assert
    should(byOwner.error.code).equal('forbidden');
    should(throughSnooze.error.message).match(/snoozed by the owner/u);
  });

  it('should list a resting item waiting on its ferret before one it works on, in the Resting list', () => {
    // Arrange
    const working = ok(apply(board(), { action: 'rest', actor: AGENT, id: 'A1', why: 'checking', at: T1 })).ledger;
    const both = ok(apply(working, { action: 'reply', actor: HUMAN, id: 'A2', note: 'hm', at: T2 })).ledger;

    // Act
    const resting = restingQueue(agendaSnapshot(both).items).map(each => each.id);

    // Assert
    should(resting).deepEqual(['A2', 'A1']);
  });

  it('should keep a plain rewrite of a resting item resting: nothing reaches the owner', () => {
    // Act
    const edited = ok(
      apply(reply(board()), { action: 'edit', actor: AGENT, id: 'A1', patch: { stillOpen: 'Which one?' }, at: T3 }),
    );

    // Assert
    should(agendaState(edited.item ?? item(edited.ledger)).state).equal('resting');
  });
});

describe('a replaced ask', () => {
  const replace = (ledger: AgendaLedger, at = T3) =>
    apply(ledger, {
      action: 'edit',
      actor: AGENT,
      id: 'A1',
      patch: { kind: 'yesno', ask: { kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'No' }] } },
      at,
    });

  it('should re-enter fresh as its one queue entry, under the next ask version, with the old answers gone', () => {
    // Arrange — the owner answered, the ferret answered their question, and the ask moves on
    const answered = ok(answerOwner(board())).ledger;
    const withAnswer = ok(
      apply(answered, {
        action: 'edit',
        actor: AGENT,
        id: 'A1',
        patch: { questionAnswer: 'EU is Frankfurt.' },
        at: T2,
      }),
    ).ledger;

    // Act
    const replaced = ok(replace(withAnswer));

    // Assert
    should(replaced.item).containDeep({ askVersion: 2, waitingSince: T3, kind: 'yesno', stage: 'question' });
    should(replaced.item?.ownerAnswer).be.undefined();
    should(replaced.item?.questionAnswer).be.undefined();
    should(replaced.item?.revisions?.at(-1)?.changed).containDeep(['ask', 'kind', 'questionAnswer']);
    should(queue(replaced.ledger)).deepEqual(['A2', 'A1']);
  });

  it('should refuse an answer to the old ask 409 ask_changed, and take one to the new ask', () => {
    // Arrange
    const replaced = ok(replace(board())).ledger;

    // Act
    const stale = refused(answerOwner(replaced, 'EU', T4, 1));
    const current = ok(answerOwner(replaced, 'Yes', T4, 2));

    // Assert
    should(stale.error.code).equal('ask_changed');
    should(current.item?.ownerAnswer?.response).deepEqual({ kind: 'multiple-choice', choice: 'Yes' });
  });

  it('should keep a new answer the replacing edit gives, and move the stage with the kind', () => {
    // Act
    const replaced = ok(
      apply(board(), {
        action: 'edit',
        actor: AGENT,
        id: 'A1',
        patch: { kind: 'info', questionAnswer: 'We went with EU.' },
        at: T3,
      }),
    );

    // Assert
    should(replaced.item?.questionAnswer).equal('We went with EU.');
    should(replaced.item?.stage).equal('explainer');
    should(replaced.item?.stages?.map(each => each.stage)).deepEqual(['question', 'explainer']);
  });

  it('should clear a stale answer to the owner’s question on --clear-question-answer, and keep the ask', () => {
    // Arrange
    const withAnswer = answerFerret(board(), T2).ledger;

    // Act
    const cleared = ok(
      apply(withAnswer, { action: 'edit', actor: AGENT, id: 'A1', patch: { clear: ['questionAnswer'] }, at: T3 }),
    );

    // Assert
    should(cleared.item?.questionAnswer).be.undefined();
    should(cleared.item?.askVersion).be.undefined();
  });

  it('should refuse a new kind with no ask, and an ask on a card that has none to replace', () => {
    // Arrange — a notice is read, not answered: it has no ask a ferret could replace
    const notice = ok(
      applyAgendaCommandToSession(null, SESSION_ID, {
        action: 'raise',
        actor: AGENT,
        request: { ...REGION, kind: 'info', ask: undefined, notice: true, premise: undefined, context: undefined },
        at: T0,
      }),
    ).ledger;

    // Act
    const askless = refused(
      apply(board(), { action: 'edit', actor: AGENT, id: 'A1', patch: { kind: 'reply' }, at: T3 }),
    );
    const onNotice = refused(
      apply(notice, { action: 'edit', actor: AGENT, id: 'A1', patch: { kind: 'yesno' }, at: T3 }),
    );

    // Assert
    should(askless.error.message).match(/a new reply needs its ask/u);
    should(onNotice.error.message).match(/has no ask to replace/u);
  });

  it('should refuse to replace the fixed ask of a configuration change', () => {
    // Arrange
    const confirms = ok(
      applyAgendaCommandToSession(null, SESSION_ID, {
        action: 'raise',
        actor: AGENT,
        request: {
          ...REGION,
          kind: undefined,
          ask: { kind: 'multiple-choice', options: [{ label: 'Allow' }, { label: 'Deny' }] },
          confirms: { path: 'machine.yaml', etag: 'e1', changes: ['loosens a limit'] },
        },
        at: T0,
      }),
    ).ledger;

    // Act
    const refusal = refused(replace(confirms));

    // Assert
    should(refusal.error.message).match(/answers are fixed/u);
  });
});

describe('a blocker and a snooze', () => {
  const snoozed = () => ok(apply(board(), { action: 'snooze', actor: HUMAN, id: 'A1', until: T4, at: T1 })).ledger;
  const block = (ledger: AgendaLedger, at = T2) =>
    ok(apply(ledger, { action: 'edit', actor: AGENT, id: 'A1', patch: { blockingNow: true }, at }));

  it('should wake a snoozed item the ferret newly marks blocking, fresh, at the head of the queue', () => {
    // Act
    const woken = block(snoozed());

    // Assert
    should(woken.item?.parked).be.undefined();
    should(woken.item).containDeep({ blockingNow: true, waitingSince: T2, urgentAt: T2 });
    should(queue(woken.ledger)).deepEqual(['A1', 'A2']);
  });

  it('should wake it for a new blocker even when it already woke as urgent within the hour', () => {
    // Arrange — woken by a blocker, cleared, snoozed again, and marked blocking again a minute later
    const woken = block(snoozed()).ledger;
    const cleared = ok(
      apply(woken, { action: 'edit', actor: AGENT, id: 'A1', patch: { clear: ['blockingNow'] }, at: T2 }),
    ).ledger;
    const again = ok(apply(cleared, { action: 'snooze', actor: HUMAN, id: 'A1', until: T4, at: T2 })).ledger;
    const soon = new Date(Date.parse(T2) + AGENDA_URGENT_WAKE_MS / 2).toISOString();

    // Act
    const awake = block(again, soon);

    // Assert
    should(awake.item?.parked).be.undefined();
    should(awake.item).containDeep({ blockingNow: true, waitingSince: soon });
    should(queue(awake.ledger)).deepEqual(['A1', 'A2']);
  });

  it('should still throttle the optional --now urgency to once an hour', () => {
    // Arrange
    const woken = block(snoozed()).ledger;
    const again = ok(apply(woken, { action: 'snooze', actor: HUMAN, id: 'A1', until: T4, at: T2 })).ledger;
    const soon = new Date(Date.parse(T2) + AGENDA_URGENT_WAKE_MS / 2).toISOString();

    // Act
    const result = refused(
      apply(again, { action: 'edit', actor: AGENT, id: 'A1', patch: { stillOpen: 'x' }, now: true, at: soon }),
    );

    // Assert
    should(result.error.code).equal('rate-limited');
  });
});

describe('the gate exemption', () => {
  it('should keep closing a card’s gate item on the owner’s answer, as before', () => {
    // Arrange
    const gate = ok(
      applyAgendaCommandToSession(null, SESSION_ID, {
        action: 'raise',
        actor: SYSTEM,
        request: {
          source: 'task',
          sourceRef: 'gate:F7:tested:1',
          subject: 'Try it',
          why: 'It shipped.',
          howToResolve: 'Choose.',
          kind: 'choice',
          ask: { kind: 'multiple-choice', options: [{ label: 'Done' }, { label: 'Not good' }] },
          gate: {
            cardId: 'F7',
            laneId: 'tested',
            laneName: 'Released · to test',
            entry: 1,
            projectId: 'p-1',
            options: [
              { id: 'done', label: 'Done', outcome: 'close' },
              { id: 'not-good', label: 'Not good', outcome: 'reopen-with-agenda' },
            ],
          },
        },
        at: T0,
      }),
    );

    // Act
    const answered = ok(
      apply(gate.ledger, {
        action: 'answer',
        actor: HUMAN,
        id: 'A1',
        response: { kind: 'multiple-choice', choice: 'Done' },
        at: T1,
      }),
    );

    // Assert
    should(restsOnAnswer(gate.ledger.entries[0] as Parameters<typeof restsOnAnswer>[0])).be.false();
    should(answered.addressed?.disposition).equal('done');
    should(agendaSnapshot(answered.ledger).items).be.empty();
  });
});

describe('the migration to the channel (ledger v2)', () => {
  /** A file as an older daemon wrote it: no version, an item parked as replied with no rest and no stage. */
  const legacyFile = (): unknown => {
    const raised = board();
    const replied = reply(raised);
    const strip = (entry: AgendaLedger['entries'][number]) => {
      const { resting: _r, stage: _s, stages: _ss, ...old } = entry.item as AgendaItem;
      return { ...entry, item: old };
    };
    const { version: _v, ...file } = replied;
    return JSON.parse(JSON.stringify({ ...file, entries: replied.entries.map(strip) }));
  };

  it('should read an old reply as resting on the ferret, nudged once, its reply time the clock, and lose nothing', () => {
    // Act
    const read = parseAgendaLedger(legacyFile(), SESSION_ID);

    // Assert
    if (read === null) throw new Error('the old ledger did not read');
    should(read.version).equal(AGENDA_LEDGER_VERSION);
    const rested = item(read);
    should(rested.resting).deepEqual({ sub: 'waiting-on-ferret', at: T2, migrated: true });
    should(rested.parked).deepEqual({ reason: 'replied', at: T2 });
    should(rested.stage).equal('question');
    should(rested.history?.map(each => each.kind)).deepEqual(['replied']);
    should(item(read, 'A2').resting).be.undefined();
  });

  it('should be idempotent: a ledger already in the shape comes back as the same object', () => {
    // Arrange
    const once = parseAgendaLedger(legacyFile(), SESSION_ID);
    if (once === null) throw new Error('the old ledger did not read');

    // Act
    const twice = toChannel(once, false);
    const reread = parseAgendaLedger(JSON.parse(JSON.stringify(once)), SESSION_ID);

    // Assert
    should(twice).equal(once);
    should(reread).deepEqual(once);
  });

  it('should rest an unmarked reply in a current ledger without the once-only mark', () => {
    // Arrange — a v2 file whose reply carries no rest (written by a path that parked without saying how)
    const file = legacyFile() as Record<string, unknown>;

    // Act
    const read = parseAgendaLedger({ ...file, version: AGENDA_LEDGER_VERSION }, SESSION_ID);

    // Assert
    if (read === null) throw new Error('the ledger did not read');
    should(item(read).resting).deepEqual({ sub: 'waiting-on-ferret', at: T2 });
  });

  it('should give a closed item the done stage', () => {
    // Arrange
    const closed = ok(apply(board(), { action: 'dismiss', actor: HUMAN, id: 'A2', at: T2 })).ledger;
    const { version: _v, ...file } = closed;
    const old = JSON.parse(
      JSON.stringify({
        ...file,
        entries: closed.entries.map(entry => {
          const { stage: _s, stages: _ss, ...rest } = entry.item as AgendaItem;
          return { ...entry, item: rest };
        }),
      }),
    );

    // Act
    const read = parseAgendaLedger(old, SESSION_ID);

    // Assert
    should(read === null ? undefined : agendaSnapshot(read).resolved[0]?.stage).equal('done');
  });
});

describe('a late delivery failure', () => {
  const failed = (ledger: AgendaLedger, request: number, at = T4) =>
    ok(apply(ledger, { action: 'undelivered', actor: SYSTEM, id: 'A1', request, reason: 'no receipt', at }));

  it('should put an answer back for a retry while the item still rests from that very answer', () => {
    // Arrange
    const answered = ok(answerOwner(board())).ledger;

    // Act
    const result = failed(answered, 1);

    // Assert
    should(result.change).equal('reopened');
    should(agendaState(result.item ?? item(result.ledger)).state).equal('needs-you');
    should(result.item?.undelivered).containDeep({ reason: 'no receipt' });
  });

  it('should leave the ferret’s newer Resting state alone when the old answer’s receipt fails after rest --why', () => {
    // Arrange
    const answered = ok(answerOwner(board())).ledger;
    const working = ok(apply(answered, { action: 'rest', actor: AGENT, id: 'A1', why: 'deploying', at: T3 })).ledger;

    // Act
    const result = failed(working, 1);

    // Assert
    should(result.change).equal('unchanged');
    should(agendaState(item(result.ledger))).containDeep({ state: 'resting', sub: 'working' });
    should(item(result.ledger).undelivered).be.undefined();
  });

  it('should leave a newer owner reply alone when the earlier answer’s receipt fails', () => {
    // Arrange
    const answered = ok(answerOwner(board())).ledger;
    const answeredAgain = ok(
      apply(answerFerret(answered).ledger, {
        action: 'reply',
        actor: HUMAN,
        id: 'A1',
        note: 'and what about US?',
        at: T4,
      }),
    ).ledger;

    // Act
    const result = failed(answeredAgain, 1, new Date(Date.parse(T4) + 60_000).toISOString());

    // Assert
    should(result.change).equal('unchanged');
    should(agendaState(item(result.ledger)).state).equal('resting');
  });
});

describe('the owner’s earlier answers', () => {
  it('should keep every answer’s response beside its note in the history, across a serialize and parse', () => {
    // Arrange
    const first = ok(answerOwner(board(), 'EU', T1)).ledger;
    const returned = answerFerret(first, T2).ledger;

    // Act
    const second = ok(answerOwner(returned, 'US', T3)).ledger;
    const reread = parseAgendaLedger(JSON.parse(JSON.stringify(second)), SESSION_ID);

    // Assert
    should(reread).not.be.null();
    const answers = (reread ? item(reread) : item(second)).history?.filter(entry => entry.kind === 'replied');
    should(answers?.map(entry => entry.response)).deepEqual([
      { kind: 'multiple-choice', choice: 'EU' },
      { kind: 'multiple-choice', choice: 'US' },
    ]);
    should(answers?.map(entry => entry.note)).deepEqual(['keep it near', 'keep it near']);
    should(item(second).ownerAnswer?.response).deepEqual({ kind: 'multiple-choice', choice: 'US' });
  });
});
