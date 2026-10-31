import { describe, it } from 'bun:test';
import type { AgendaAsk, AgendaCardAnswer, AgendaId, AgendaItem, AgendaResponse } from '@ferretry/protocol';
import {
  AGENDA_SHAPE_ERRORS,
  AGENDA_URGENT_WAKE_MS,
  AgendaItemSchema,
  AgendaSnapshotSchema,
  agendaBadgeCount,
  MAX_AGENDA_PER_SESSION,
  MAX_AGENDA_REVISIONS,
} from '@ferretry/protocol';
import should from 'should';
import {
  type AgendaActor,
  type AgendaCommand,
  type AgendaEntry,
  type AgendaLedger,
  type AgendaMutation,
  agendaSnapshot,
  applyAgendaCommand,
  applyAgendaCommandToSession,
  canDismissAgenda,
  DAEMON_AGENDA_CAUSES,
  type EditAgendaPatch,
  emptyAgendaLedger,
  isActiveAgenda,
  isWardenEscalationAgenda,
  MAX_AGENT_AGENDA_PER_SESSION,
  parkOwnerReplies,
  parseAgendaLedger,
  type RaiseAgendaRequest,
} from '../../../src/lib/agenda/state-machine.ts';

const SESSION_ID = 'session-1';
const OTHER_SESSION_ID = 'session-2';
const FIRST = '2026-07-30T10:00:00Z';
const SECOND = '2026-07-30T11:00:00Z';
const THIRD = '2026-07-30T12:00:00Z';
const LATER = '2026-07-31T10:00:00Z';
const REFRESH: EditAgendaPatch = {
  subject: 'Which region do we deploy to?',
  premise: 'You said the deploy is fine; one detail is left.',
  context: 'The release waits on the region.',
};

const HUMAN: AgendaActor = { kind: 'human' };
const AGENT: AgendaActor = { kind: 'agent', sessionId: SESSION_ID, name: 'Ada' };
const OTHER_AGENT: AgendaActor = { kind: 'agent', sessionId: OTHER_SESSION_ID, name: 'Grace' };
const DAEMON: AgendaActor = { kind: 'daemon', cause: 'source-reconciliation' };
const WARDEN: AgendaActor = { kind: 'daemon', cause: 'warden-escalation' };

function request(overrides: Partial<RaiseAgendaRequest> = {}): RaiseAgendaRequest {
  return {
    source: 'agent-raised',
    sourceRef: null,
    subject: 'Approve the deployment?',
    why: 'The release cannot proceed without a human decision.',
    context: 'This deploy changes the public service.',
    premise: 'A release is ready to go out.',
    howToResolve: 'Approve or reject the request.',
    ask: { kind: 'permission' },
    ...overrides,
  };
}

function raiseCommand(
  actor: AgendaActor = AGENT,
  overrides: Partial<RaiseAgendaRequest> = {},
  at = FIRST,
): AgendaCommand {
  return { action: 'raise', actor, request: request(overrides), at };
}

function succeeded(result: AgendaMutation): Extract<AgendaMutation, { ok: true }> {
  should(result.ok).be.true();
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

function failed(result: AgendaMutation): Extract<AgendaMutation, { ok: false }> {
  should(result.ok).be.false();
  if (result.ok) throw new Error('expected agenda mutation to fail');
  return result;
}

function raised(
  actor: AgendaActor = AGENT,
  overrides: Partial<RaiseAgendaRequest> = {},
  at = FIRST,
): Extract<AgendaMutation, { ok: true }> {
  return succeeded(applyAgendaCommandToSession(null, SESSION_ID, raiseCommand(actor, overrides, at)));
}

function activeEntry(ledger: AgendaLedger, id: AgendaId = 'A1'): Extract<AgendaEntry, { lifecycle: 'active' }> {
  const actual = ledger.entries.find(entry => entry.lifecycle === 'active' && entry.item.id === id);
  if (actual === undefined || actual.lifecycle !== 'active') throw new Error(`missing active entry ${id}`);
  return actual;
}

describe('Agenda state machine', () => {
  it('should derive active items and count from lifecycle entries', () => {
    // Arrange
    const initial = emptyAgendaLedger(SESSION_ID, FIRST);

    // Act
    const created = succeeded(applyAgendaCommand(initial, raiseCommand()));
    const actual = agendaSnapshot(created.ledger);

    // Assert
    should(initial.entries).have.length(0);
    should(actual.count).equal(1);
    should(actual.items).have.length(1);
    should(actual.resolved).have.length(0);
    should(isActiveAgenda(activeEntry(created.ledger))).be.true();
    should(created.item).deepEqual(actual.items[0]);
  });

  it('should refuse a ferret’s new item without a premise or a context, and only a ferret’s', () => {
    // Arrange
    const { premise: _premise, context: _context, ...bare } = request();
    const raise = (actor: AgendaActor, overrides: Partial<RaiseAgendaRequest>) =>
      applyAgendaCommandToSession(null, SESSION_ID, {
        action: 'raise',
        actor,
        request: { ...bare, ...overrides },
        at: FIRST,
      });

    // Act
    const neither = failed(raise(AGENT, {})).error;
    const blankContext = failed(raise(AGENT, { premise: 'A release waits', context: ' ' })).error;
    const notice = raise(AGENT, { kind: 'info', notice: true, ask: undefined });
    const others = [HUMAN, DAEMON, WARDEN].map(actor => raise(actor, {}).ok);

    // Assert
    should(neither).deepEqual({
      code: 'invalid',
      message:
        'a new agenda item needs both: premise (--premise) is required: the situation, what is going on; context (--context) is required: the facts around it',
    });
    should(blankContext.message).equal(
      'a new agenda item needs both: context (--context) is required: the facts around it',
    );
    should(notice.ok).be.true();
    should(others).deepEqual([true, true, true]);
  });

  it('should keep an item raised before the rule working: an edit or an answer never asks for them', () => {
    // Arrange: an item with neither, as an older daemon stored it
    const { premise: _premise, context: _context, ...bare } = request();
    const old = succeeded(
      applyAgendaCommandToSession(null, SESSION_ID, { action: 'raise', actor: DAEMON, request: bare, at: FIRST }),
    ).ledger;

    // Act
    const edited = applyAgendaCommand(old, {
      action: 'edit',
      actor: HUMAN,
      id: 'A1',
      patch: { subject: 'Ship it?' },
      at: SECOND,
    });

    // Assert
    should(edited.ok).be.true();
  });

  it('should stamp exact human, agent, daemon, and warden provenance', () => {
    // Arrange
    const cases: Array<{
      actor: AgendaActor;
      expected: { raisedBy: string; raisedBySession: string | null; raisedByName: string | null };
    }> = [
      { actor: HUMAN, expected: { raisedBy: 'human', raisedBySession: null, raisedByName: null } },
      {
        actor: AGENT,
        expected: { raisedBy: 'agent', raisedBySession: SESSION_ID, raisedByName: 'Ada' },
      },
      { actor: DAEMON, expected: { raisedBy: 'daemon', raisedBySession: null, raisedByName: null } },
      { actor: WARDEN, expected: { raisedBy: 'daemon', raisedBySession: null, raisedByName: null } },
    ];

    // Act + Assert
    for (const { actor, expected } of cases) {
      const actual = activeEntry(raised(actor).ledger).item;
      should(actual).containDeep(expected);
    }
    should(isWardenEscalationAgenda(activeEntry(raised(WARDEN).ledger))).be.true();
    should(isWardenEscalationAgenda(activeEntry(raised(DAEMON).ledger))).be.false();
    should(isWardenEscalationAgenda(activeEntry(raised(AGENT).ledger))).be.false();
  });

  it('should reserve automatic sources and stable source keys for trusted daemon producers', () => {
    // Arrange
    const automatic = raiseCommand(AGENT, { source: 'task', sourceRef: null });
    const forgedStableKey = raiseCommand(AGENT, { sourceRef: 'warden:forged' });
    const untyped = raiseCommand(AGENT, { ask: undefined });

    // Act
    const sourceResult = failed(applyAgendaCommandToSession(null, SESSION_ID, automatic));
    const keyResult = failed(applyAgendaCommandToSession(null, SESSION_ID, forgedStableKey));
    const kindResult = failed(applyAgendaCommandToSession(null, SESSION_ID, untyped));

    // Assert
    should(sourceResult.error.code).equal('forbidden');
    should(keyResult.error.code).equal('forbidden');
    should(kindResult.error.code).equal('invalid');
  });

  it('should allow daemon-derived plain requests and reject sourceSeq on the wrong source', () => {
    // Arrange
    const plain = raiseCommand(DAEMON, { source: 'task', sourceRef: 'F12', ask: undefined });
    const wrongSequence = raiseCommand(DAEMON, { source: 'task', sourceRef: 'F12', sourceSeq: 3 });

    // Act
    const accepted = succeeded(applyAgendaCommandToSession(null, SESSION_ID, plain));
    const rejected = failed(applyAgendaCommandToSession(null, SESSION_ID, wrongSequence));

    // Assert
    should(accepted.snapshot.items[0]?.ask).be.undefined();
    should(rejected.error.code).equal('invalid');
  });

  it('should stamp client raises at receipt and honor a trusted source timestamp', () => {
    // Arrange
    const backdated = '2026-07-29T08:00:00Z';
    const agentCommand = raiseCommand(AGENT, { waitingSince: backdated });
    const daemonCommand = raiseCommand(DAEMON, { sourceRef: 'source-1', waitingSince: backdated });

    // Act
    const agentItem = activeEntry(succeeded(applyAgendaCommandToSession(null, SESSION_ID, agentCommand)).ledger).item;
    const daemonItem = activeEntry(succeeded(applyAgendaCommandToSession(null, SESSION_ID, daemonCommand)).ledger).item;

    // Assert
    should(agentItem.waitingSince).equal(FIRST);
    should(daemonItem.waitingSince).equal(backdated);
  });

  it('should deduplicate identical requests only for the same authorized actor', () => {
    // Arrange
    const first = raised();
    const daemonFirst = raised(DAEMON);

    // Act
    const duplicate = succeeded(applyAgendaCommand(first.ledger, raiseCommand(AGENT, {}, SECOND)));
    const otherActor = failed(applyAgendaCommand(duplicate.ledger, raiseCommand(OTHER_AGENT, {}, THIRD)));
    const daemonDuplicate = succeeded(applyAgendaCommand(daemonFirst.ledger, raiseCommand(DAEMON, {}, SECOND)));
    const otherDaemonCause = succeeded(applyAgendaCommand(daemonDuplicate.ledger, raiseCommand(WARDEN, {}, THIRD)));

    // Assert
    should(duplicate.changed).be.false();
    should(duplicate.change).equal('unchanged');
    should(duplicate.snapshot.count).equal(1);
    should(otherActor.error.code).equal('forbidden');
    should(daemonDuplicate.changed).be.false();
    should(otherDaemonCause.snapshot.count).equal(2);
  });

  it('should refresh a stable daemon source without changing its identity, wait, or provenance', () => {
    // Arrange
    const first = raised(DAEMON, { source: 'task', sourceRef: 'F12', ask: undefined, waitingSince: FIRST });
    const nextCommand = raiseCommand(
      DAEMON,
      {
        source: 'task',
        sourceRef: 'F12',
        ask: undefined,
        subject: 'Provide the revised deployment window',
        waitingSince: THIRD,
      },
      SECOND,
    );

    // Act
    const actual = succeeded(applyAgendaCommand(first.ledger, nextCommand));

    // Assert
    should(actual.change).equal('refreshed');
    should(actual.item).deepEqual(actual.snapshot.items[0]);
    should(actual.snapshot.count).equal(1);
    should(actual.snapshot.items[0]).containDeep({
      id: 'A1',
      subject: 'Provide the revised deployment window',
      waitingSince: FIRST,
      raisedBy: 'daemon',
    });
  });

  it('should keep the structured brief, tell briefs apart, and replace it whole on a refresh', () => {
    // Arrange
    const brief: Partial<RaiseAgendaRequest> = {
      ask: { kind: 'multiple-choice', options: [{ label: 'Today' }, { label: 'Tomorrow' }] },
      terms: [{ term: 'OCI', meaning: 'Oracle Cloud Infrastructure, where the work login lives.' }],
      questions: [
        {
          question: 'When should it deploy?',
          options: [{ label: 'Today' }, { label: 'Tomorrow' }],
          recommended: 'Tomorrow',
          why: 'Nobody is on call tonight.',
        },
      ],
      recommendation: { decision: 'Deploy tomorrow morning.' },
      impact: 'The release slips a day.',
      urgency: 'before 17:00',
      links: [{ label: 'Release PR', target: 'https://github.com/kirinnee/ferretry/pull/1' }],
    };
    const first = raised(AGENT, brief);
    const stable = raised(DAEMON, { ...brief, source: 'task', sourceRef: 'F12', ask: undefined });

    // Act
    const same = succeeded(applyAgendaCommand(first.ledger, raiseCommand(AGENT, brief, SECOND)));
    const different = succeeded(
      applyAgendaCommand(same.ledger, raiseCommand(AGENT, { ...brief, urgency: 'no rush' }, THIRD)),
    );
    const refreshed = succeeded(
      applyAgendaCommand(
        stable.ledger,
        raiseCommand(DAEMON, { source: 'task', sourceRef: 'F12', ask: undefined, impact: 'Nothing ships.' }, SECOND),
      ),
    );

    // Assert
    should(first.snapshot.items[0]).containDeep(brief);
    should(same.changed).be.false();
    should(different.snapshot.count).equal(2);
    should(refreshed.change).equal('refreshed');
    should(refreshed.snapshot.items[0]?.impact).equal('Nothing ships.');
    should(refreshed.snapshot.items[0]?.terms).be.undefined();
    should(refreshed.snapshot.items[0]?.questions).be.undefined();
    should(refreshed.snapshot.items[0]?.links).be.undefined();
  });

  it('should restate the premise, what is decided and what is still open on a stable-source refresh, clearing the ones left out', () => {
    // Arrange
    const first = raised(DAEMON, {
      source: 'task',
      sourceRef: 'F12',
      ask: undefined,
      premise: 'The warden saw a stall',
      decided: 'Wait ten minutes',
      stillOpen: 'Restart the ferret?',
    });

    // Act
    const restated = succeeded(
      applyAgendaCommand(
        first.ledger,
        raiseCommand(
          DAEMON,
          {
            source: 'task',
            sourceRef: 'F12',
            ask: undefined,
            premise: 'The stall is over an hour old',
            stillOpen: 'Kill it?',
          },
          SECOND,
        ),
      ),
    );

    // Assert
    should(first.item).containDeep({ waitingSince: FIRST });
    should(first.item?.waitingOn).be.undefined();
    should(restated.change).equal('refreshed');
    should(restated.item?.premise).equal('The stall is over an hour old');
    should(restated.item?.stillOpen).equal('Kill it?');
    should(restated.item?.decided).be.undefined();
  });

  it('should ignore identical and stale stable-source generations', () => {
    // Arrange
    const first = raised(DAEMON, { sourceRef: 'reopen:F12', sourceSeq: 4 });
    const identical = raiseCommand(DAEMON, { sourceRef: 'reopen:F12', sourceSeq: 4 }, SECOND);
    const stale = raiseCommand(DAEMON, { sourceRef: 'reopen:F12', sourceSeq: 3, subject: 'Stale explanation' }, THIRD);

    // Act
    const duplicate = succeeded(applyAgendaCommand(first.ledger, identical));
    const regressed = succeeded(applyAgendaCommand(duplicate.ledger, stale));

    // Assert
    should(duplicate.changed).be.false();
    should(regressed.changed).be.false();
    should(duplicate.item).be.undefined();
    should(regressed.item).be.undefined();
    should(regressed.snapshot.items[0]?.sourceSeq).equal(4);
    should(regressed.snapshot.items[0]?.subject).equal('Approve the deployment?');
  });

  it('should allocate monotonic ids and order active requests oldest first', () => {
    // Arrange
    const first = raised(DAEMON, { sourceRef: 'newer', waitingSince: SECOND }, SECOND);
    const olderCommand = raiseCommand(DAEMON, { sourceRef: 'older', waitingSince: FIRST }, THIRD);

    // Act
    const actual = succeeded(applyAgendaCommand(first.ledger, olderCommand));

    // Assert
    should(actual.snapshot.items.map(item => item.id)).deepEqual(['A2', 'A1']);
    should(actual.ledger.nextId).equal(3);
  });

  it('should cap agent requests at ten while leaving automatic-source capacity', () => {
    // Arrange
    let ledger = emptyAgendaLedger(SESSION_ID, FIRST);
    for (let index = 0; index < MAX_AGENT_AGENDA_PER_SESSION; index += 1) {
      ledger = succeeded(
        applyAgendaCommand(
          ledger,
          raiseCommand(AGENT, { subject: `Decision ${index}`, ask: { kind: 'open-question' } }, FIRST),
        ),
      ).ledger;
    }

    // Act
    const overflow = failed(
      applyAgendaCommand(ledger, raiseCommand(AGENT, { subject: 'One too many', ask: { kind: 'permission' } })),
    );
    const automatic = succeeded(
      applyAgendaCommand(ledger, raiseCommand(DAEMON, { source: 'task', sourceRef: 'F12', ask: undefined }, SECOND)),
    );

    // Assert
    should(overflow.error.code).equal('full');
    should(automatic.snapshot.count).equal(11);
    should(automatic.snapshot.items.filter(item => item.raisedBy === 'agent')).have.length(10);
  });

  it('should refuse total-cap overflow and an exhausted id allocator without evicting', () => {
    // Arrange
    let ledger = emptyAgendaLedger(SESSION_ID, FIRST);
    for (let index = 0; index < 20; index += 1) {
      const actor = index < 10 ? AGENT : HUMAN;
      ledger = succeeded(
        applyAgendaCommand(
          ledger,
          raiseCommand(actor, { subject: `Decision ${index}`, ask: { kind: 'permission' } }, FIRST),
        ),
      ).ledger;
    }
    const exhausted: AgendaLedger = { ...emptyAgendaLedger(SESSION_ID, FIRST), nextId: Number.MAX_SAFE_INTEGER };

    // Act
    const full = failed(
      applyAgendaCommand(
        ledger,
        raiseCommand(DAEMON, { source: 'question', sourceRef: 'question-1', ask: undefined }, SECOND),
      ),
    );
    const noIds = failed(applyAgendaCommand(exhausted, raiseCommand()));

    // Assert
    should(full.error.code).equal('full');
    should(ledger.entries).have.length(20);
    should(noIds.error.code).equal('full');
  });

  it('should answer every tagged ask kind, remove it immediately, and retain the response', () => {
    // Arrange
    const cases: Array<{ ask: AgendaAsk; response: AgendaResponse }> = [
      { ask: { kind: 'permission' }, response: { kind: 'permission', decision: 'approve' } },
      {
        ask: { kind: 'multiple-choice', options: [{ label: 'Blue' }, { label: 'Green' }] },
        response: { kind: 'multiple-choice', choice: 'Green' },
      },
      {
        ask: { kind: 'answer-review' },
        response: { kind: 'answer-review', verdict: 'good' },
      },
      {
        ask: { kind: 'answer-review' },
        response: { kind: 'answer-review', verdict: 'clarify', clarification: 'Which region?' },
      },
      { ask: { kind: 'open-question' }, response: { kind: 'open-question', answer: 'Proceed tomorrow.' } },
    ];

    // Act + Assert
    for (const { ask, response } of cases) {
      const board = raised(AGENT, { ask });
      const actual = succeeded(
        applyAgendaCommand(board.ledger, {
          action: 'answer',
          actor: HUMAN,
          id: 'A1',
          response,
          note: 'Human responded.',
          at: SECOND,
        }),
      );
      should(actual.change).equal('answered');
      should(actual.snapshot.items).have.length(0);
      should(actual.snapshot.count).equal(0);
      should(actual.snapshot.resolved[0]).containDeep({
        response,
        disposition: 'done',
        resolutionNote: 'Human responded.',
      });
    }
  });

  it('should reject a mismatched or unlisted structured answer without hiding the item', () => {
    // Arrange
    const permission = raised();
    const choice = raised(AGENT, {
      ask: { kind: 'multiple-choice', options: [{ label: 'A' }, { label: 'B' }] },
    });
    const plain = raised(DAEMON, { source: 'task', sourceRef: 'F12', ask: undefined });

    // Act
    const mismatch = failed(
      applyAgendaCommand(permission.ledger, {
        action: 'answer',
        actor: HUMAN,
        id: 'A1',
        response: { kind: 'open-question', answer: 'yes' },
        at: SECOND,
      }),
    );
    const outside = failed(
      applyAgendaCommand(choice.ledger, {
        action: 'answer',
        actor: HUMAN,
        id: 'A1',
        response: { kind: 'multiple-choice', choice: 'C' },
        at: SECOND,
      }),
    );
    const noAsk = failed(
      applyAgendaCommand(plain.ledger, {
        action: 'answer',
        actor: HUMAN,
        id: 'A1',
        response: { kind: 'permission', decision: 'approve' },
        at: SECOND,
      }),
    );

    // Assert
    for (const actual of [mismatch, outside, noAsk]) should(actual.error.code).equal('invalid');
    should(permission.snapshot.count).equal(1);
    should(choice.snapshot.count).equal(1);
    should(plain.snapshot.count).equal(1);
  });

  it('should allow human dismissal of any item and agent dismissal only of its own item', () => {
    // Arrange
    const own = raised(AGENT);
    // A current caller cannot create this state (cross-session writes are
    // refused below), but imported/older durable evidence may still name a
    // different raiser. Dismissal must fail closed for that evidence too.
    const otherItem: AgendaItem = {
      ...activeEntry(own.ledger).item,
      raisedBy: 'agent',
      raisedBySession: OTHER_AGENT.sessionId,
      raisedByName: OTHER_AGENT.name,
    };
    const other: AgendaLedger = {
      ...own.ledger,
      entries: [
        {
          lifecycle: 'active',
          origin: OTHER_AGENT,
          item: otherItem,
        },
      ],
    };
    const daemon = raised(DAEMON, { source: 'question', sourceRef: 'q1', ask: undefined });

    // Act
    const ownDismissal = succeeded(
      applyAgendaCommand(own.ledger, { action: 'dismiss', actor: AGENT, id: 'A1', at: SECOND }),
    );
    const crossAgent = failed(applyAgendaCommand(other, { action: 'dismiss', actor: AGENT, id: 'A1', at: SECOND }));
    const daemonByAgent = failed(
      applyAgendaCommand(daemon.ledger, { action: 'dismiss', actor: AGENT, id: 'A1', at: SECOND }),
    );
    const humanDismissal = succeeded(
      applyAgendaCommand(daemon.ledger, {
        action: 'dismiss',
        actor: HUMAN,
        id: 'A1',
        note: 'No longer relevant.',
        at: SECOND,
      }),
    );

    // Assert
    should(ownDismissal.snapshot.count).equal(0);
    should(crossAgent.error.code).equal('forbidden');
    should(daemonByAgent.error.code).equal('forbidden');
    should(humanDismissal.snapshot.resolved[0]).containDeep({
      disposition: 'dismissed',
      resolvedBy: 'human',
      resolutionNote: 'No longer relevant.',
    });
  });

  it('should refuse every cross-session agent command before it reaches an item', () => {
    // Arrange
    const board = raised(AGENT);
    const commands: readonly AgendaCommand[] = [
      raiseCommand(OTHER_AGENT, { subject: 'Forged cross-session ask' }, SECOND),
      {
        action: 'answer',
        actor: OTHER_AGENT,
        id: 'A1',
        response: { kind: 'permission', decision: 'approve' },
        at: SECOND,
      },
      { action: 'resolve', actor: OTHER_AGENT, id: 'A1', at: SECOND },
      { action: 'dismiss', actor: OTHER_AGENT, id: 'A1', at: SECOND },
      {
        action: 'resolve-source',
        actor: OTHER_AGENT,
        source: 'agent-raised',
        sourceRef: 'source-1',
        at: SECOND,
      },
    ];

    // Act + Assert
    for (const command of commands) {
      const actual = failed(applyAgendaCommand(board.ledger, command));
      should(actual.error).containDeep({ code: 'forbidden' });
      should(actual.error.message).match(/own session/u);
    }
    should(board.snapshot.count).equal(1);
  });

  it('should express dismissal authorization as an actor-and-entry predicate', () => {
    // Arrange
    const agentEntry = activeEntry(raised(AGENT).ledger);
    const daemonEntry = activeEntry(raised(DAEMON, { sourceRef: 'source-1' }).ledger);

    // Act + Assert
    should(canDismissAgenda(HUMAN, agentEntry)).be.true();
    should(canDismissAgenda(AGENT, agentEntry)).be.true();
    should(canDismissAgenda(OTHER_AGENT, agentEntry)).be.false();
    should(canDismissAgenda(AGENT, daemonEntry)).be.false();
    should(canDismissAgenda(DAEMON, daemonEntry)).be.true();
    should(canDismissAgenda(WARDEN, daemonEntry)).be.true();
  });

  it('should resolve without a response under the same exact-raiser guard, structured ask or not', () => {
    // Arrange
    const own = raised(AGENT, { ask: { kind: 'permission' } });
    const plainOwn = raised(DAEMON, { source: 'task', sourceRef: 'F12', ask: undefined });

    // Act
    const agentResolveAsked = succeeded(
      applyAgendaCommand(own.ledger, {
        action: 'resolve',
        actor: AGENT,
        id: 'A1',
        note: 'Settled in chat.',
        at: SECOND,
      }),
    );
    const wrongDaemon = failed(
      applyAgendaCommand(plainOwn.ledger, {
        action: 'resolve',
        actor: AGENT,
        id: 'A1',
        note: 'Settled in chat.',
        at: SECOND,
      }),
    );
    const daemonResolve = succeeded(
      applyAgendaCommand(plainOwn.ledger, { action: 'resolve', actor: DAEMON, id: 'A1', at: SECOND }),
    );

    // Assert
    should(agentResolveAsked.snapshot.count).equal(0);
    should(agentResolveAsked.snapshot.resolved[0]).containDeep({ disposition: 'done', resolvedBy: 'agent' });
    should(agentResolveAsked.snapshot.resolved[0]?.response).be.undefined();
    should(wrongDaemon.error.code).equal('forbidden');
    should(daemonResolve.snapshot.count).equal(0);
    should(daemonResolve.snapshot.resolved[0]?.disposition).equal('done');
  });

  it('should make repeated terminal actions idempotent and preserve the original resolver', () => {
    // Arrange
    const board = raised();
    const answered = succeeded(
      applyAgendaCommand(board.ledger, {
        action: 'answer',
        actor: HUMAN,
        id: 'A1',
        response: { kind: 'permission', decision: 'approve' },
        note: 'Approved once.',
        at: SECOND,
      }),
    );

    // Act
    const retry = succeeded(
      applyAgendaCommand(answered.ledger, {
        action: 'dismiss',
        actor: AGENT,
        id: 'A1',
        note: 'Overwrite attempt.',
        at: THIRD,
      }),
    );
    const missing = failed(
      applyAgendaCommand(answered.ledger, { action: 'resolve', actor: HUMAN, id: 'A99', at: THIRD }),
    );

    // Assert
    should(retry.changed).be.false();
    should(retry.snapshot.resolved[0]).containDeep({
      resolvedBy: 'human',
      resolutionNote: 'Approved once.',
      response: { kind: 'permission', decision: 'approve' },
    });
    should(missing.error.code).equal('not-found');
  });

  it('should reserve trusted source reconciliation for the daemon', () => {
    // Arrange
    const board = raised(DAEMON, { source: 'question', sourceRef: 'tool-1', ask: undefined });
    const command: AgendaCommand = {
      action: 'resolve-source',
      actor: DAEMON,
      source: 'question',
      sourceRef: 'tool-1',
      note: 'Question answered by the lead.',
      at: SECOND,
    };

    // Act
    const resolved = succeeded(applyAgendaCommand(board.ledger, command));
    const retry = succeeded(applyAgendaCommand(resolved.ledger, command));
    const forbidden = failed(applyAgendaCommand(board.ledger, { ...command, actor: AGENT, at: THIRD }));

    // Assert
    should(resolved.snapshot.count).equal(0);
    should(resolved.snapshot.resolved[0]).containDeep({
      resolvedBy: 'daemon',
      resolvedBySession: null,
      resolutionNote: 'Question answered by the lead.',
    });
    should(retry.changed).be.false();
    should(forbidden.error.code).equal('forbidden');
    should(forbidden.error.message).match(/only the daemon may reconcile/u);
  });

  it('should decode only durable ledgers whose lifecycle, provenance, and counters agree', () => {
    // Arrange
    const agent = raised();
    const human = succeeded(
      applyAgendaCommand(agent.ledger, raiseCommand(HUMAN, { subject: 'Human request' }, SECOND)),
    );
    const daemon = succeeded(
      applyAgendaCommand(
        human.ledger,
        raiseCommand(DAEMON, { source: 'task', sourceRef: 'F12', ask: undefined }, THIRD),
      ),
    );
    const addressed = succeeded(
      applyAgendaCommand(daemon.ledger, {
        action: 'answer',
        actor: HUMAN,
        id: 'A1',
        response: { kind: 'permission', decision: 'approve' },
        at: THIRD,
      }),
    ).ledger;
    const valid = structuredClone(addressed);
    const duplicate: unknown = { ...addressed, entries: [...addressed.entries, addressed.entries[0]!] };
    const exhausted: unknown = { ...addressed, nextId: 1 };
    const malformedOrigin: unknown = {
      ...addressed,
      entries: [{ ...addressed.entries[0]!, origin: { kind: 'agent' } }, ...addressed.entries.slice(1)],
    };
    const mismatchedAddressedOrigin: unknown = {
      ...addressed,
      entries: addressed.entries.map(entry =>
        entry.lifecycle === 'addressed' ? { ...entry, origin: { kind: 'daemon', cause: 'system' } } : entry,
      ),
    };
    const unknownLifecycle: unknown = {
      ...addressed,
      entries: [{ ...addressed.entries[0]!, lifecycle: 'unknown' }, ...addressed.entries.slice(1)],
    };

    // Act
    const parsed = parseAgendaLedger(valid, SESSION_ID);

    // Assert
    should(parsed).containDeep({ sessionId: SESSION_ID, nextId: 4 });
    should(parsed?.entries.map(entry => entry.lifecycle).sort()).deepEqual(['active', 'active', 'addressed']);
    should(parseAgendaLedger(null, SESSION_ID)).be.null();
    should(parseAgendaLedger({ ...valid, sessionId: OTHER_SESSION_ID }, SESSION_ID)).be.null();
    should(parseAgendaLedger(duplicate, SESSION_ID)).be.null();
    should(parseAgendaLedger(exhausted, SESSION_ID)).be.null();
    should(parseAgendaLedger(malformedOrigin, SESSION_ID)).be.null();
    should(parseAgendaLedger(mismatchedAddressedOrigin, SESSION_ID)).be.null();
    should(parseAgendaLedger(unknownLifecycle, SESSION_ID)).be.null();
  });

  it.each([...DAEMON_AGENDA_CAUSES])(
    'should decode a stored item raised by the %s daemon cause with that cause intact',
    cause => {
      // Arrange
      const origin: AgendaActor = { kind: 'daemon', cause };
      const stored = raised(origin, { source: 'task', sourceRef: 'F12', ask: undefined }).ledger;

      // Act
      const decoded = parseAgendaLedger(JSON.parse(JSON.stringify(stored)), SESSION_ID);

      // Assert
      should(decoded?.entries.map(entry => entry.origin)).deepEqual([origin]);
    },
  );

  it('should refuse a stored item whose daemon cause is one this daemon does not know', () => {
    // Arrange
    const stored = raised(DAEMON, { source: 'task', sourceRef: 'F12', ask: undefined }).ledger;
    const unknownCause = JSON.parse(JSON.stringify(stored)) as { entries: { origin: { cause: string } }[] };
    unknownCause.entries[0]!.origin.cause = 'poltergeist';

    // Act + Assert
    should(parseAgendaLedger(unknownCause, SESSION_ID)).be.null();
  });

  it('should bound newest-first resolution history without reusing ids', () => {
    // Arrange
    let ledger = emptyAgendaLedger(SESSION_ID, FIRST);
    for (let index = 1; index <= 101; index += 1) {
      const at = `2026-07-30T12:${String(index % 60).padStart(2, '0')}:00Z`;
      const created = succeeded(
        applyAgendaCommand(ledger, raiseCommand(DAEMON, { sourceRef: `source-${index}`, ask: undefined }, at)),
      );
      ledger = succeeded(
        applyAgendaCommand(created.ledger, {
          action: 'resolve',
          actor: DAEMON,
          id: `A${index}` as AgendaId,
          at,
        }),
      ).ledger;
    }

    // Act
    const actual = agendaSnapshot(ledger);

    // Assert
    should(actual.resolved).have.length(100);
    should(actual.resolved.some(item => item.id === 'A1')).be.false();
    should(new Set(actual.resolved.map(item => item.id)).size).equal(100);
    should(actual.count).equal(0);
    should(ledger.nextId).equal(102);
  });
});

describe('Agenda state machine edit', () => {
  const questioned = (): Extract<AgendaMutation, { ok: true }> =>
    raised(AGENT, {
      kind: 'choice',
      ask: { kind: 'multiple-choice', options: [{ label: 'A' }, { label: 'B' }] },
      questions: [
        { question: 'Which plan?', options: [{ label: 'A' }, { label: 'B' }], recommended: 'A', why: 'Cheaper.' },
      ],
    });

  it('should reword the summary, context and brief in place without re-announcing the item', () => {
    // Arrange
    const created = raised();

    // Act
    const edited = succeeded(
      applyAgendaCommand(created.ledger, {
        action: 'edit',
        actor: AGENT,
        id: 'A1',
        patch: { subject: 'Approve the deploy?', context: '- one\n- two', impact: '- blocks release' },
        at: SECOND,
      }),
    );

    // Assert
    should(edited.change).equal('refreshed');
    should(edited.item).containDeep({ id: 'A1', subject: 'Approve the deploy?', context: '- one\n- two' });
    should(edited.item?.impact).equal('- blocks release');
    should(edited.item?.waitingSince).equal(FIRST);
    should(edited.snapshot.count).equal(1);
  });

  it('should clear the context with null and report an identical edit as unchanged', () => {
    // Arrange
    const created = raised();
    const same = {
      action: 'edit',
      actor: AGENT,
      id: 'A1',
      patch: { subject: created.item?.subject },
      at: SECOND,
    } as const;

    // Act
    const cleared = succeeded(
      applyAgendaCommand(created.ledger, {
        action: 'edit',
        actor: AGENT,
        id: 'A1',
        patch: { context: null },
        at: SECOND,
      }),
    );
    const unchanged = succeeded(applyAgendaCommand(created.ledger, same));

    // Assert
    should(cleared.item?.context ?? null).be.null();
    should(unchanged.changed).be.false();
  });

  it('should reword questions but refuse to add, drop or re-option them', () => {
    // Arrange
    const created = questioned();
    const edit = (questions: NonNullable<EditAgendaPatch['questions']>) =>
      applyAgendaCommand(created.ledger, {
        action: 'edit',
        actor: AGENT,
        id: 'A1',
        patch: { questions },
        at: SECOND,
      });

    // Act
    const reworded = succeeded(
      edit([
        { question: 'Which login plan?', options: [{ label: 'A' }, { label: 'B' }], recommended: 'A', why: 'Cheaper.' },
      ]),
    );
    const reoptioned = failed(edit([{ question: 'Which plan?', options: [{ label: 'A' }, { label: 'C' }] }]));
    const dropped = failed(edit([]));

    // Assert
    should(reworded.item?.questions?.[0]?.question).equal('Which login plan?');
    should(reoptioned.error.code).equal('invalid');
    should(dropped.error.code).equal('invalid');
  });

  it('should refuse an empty edit, a stranger, a closed item and an unknown item', () => {
    // Arrange
    const created = raised();
    const patch = { subject: 'New words' };
    const resolved = succeeded(
      applyAgendaCommand(created.ledger, { action: 'dismiss', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act
    const empty = failed(
      applyAgendaCommand(created.ledger, { action: 'edit', actor: AGENT, id: 'A1', patch: {}, at: SECOND }),
    );
    const stranger = failed(
      applyAgendaCommand(created.ledger, { action: 'edit', actor: OTHER_AGENT, id: 'A1', patch, at: SECOND }),
    );
    const closed = failed(
      applyAgendaCommand(resolved.ledger, { action: 'edit', actor: AGENT, id: 'A1', patch, at: THIRD }),
    );
    const unknown = failed(
      applyAgendaCommand(created.ledger, { action: 'edit', actor: AGENT, id: 'A9', patch, at: SECOND }),
    );

    const foreign: AgendaLedger = {
      ...created.ledger,
      entries: [
        {
          lifecycle: 'active',
          origin: OTHER_AGENT,
          item: {
            ...activeEntry(created.ledger).item,
            raisedBy: 'agent',
            raisedBySession: OTHER_AGENT.sessionId,
            raisedByName: OTHER_AGENT.name,
          },
        },
      ],
    };
    const notOurs = failed(applyAgendaCommand(foreign, { action: 'edit', actor: AGENT, id: 'A1', patch, at: SECOND }));

    // Assert
    should(empty.error.code).equal('invalid');
    should(stranger.error.code).equal('forbidden');
    should(notOurs.error.code).equal('forbidden');
    should(closed.error.code).equal('not-found');
    should(unknown.error.code).equal('not-found');
  });
});

describe('Agenda state machine steps and progress', () => {
  const STEPS = ['Open `fy config path`', 'Paste the **code** there', 'Press Enter'];
  const progressOf = (actor: AgendaActor, id: AgendaId, step: number, done: boolean, at = SECOND) =>
    ({ action: 'progress', actor, id, step, done, at }) satisfies AgendaCommand;

  it('should store steps and body, dedupe on them, and replace them on a refresh', () => {
    // Arrange
    const first = raised(AGENT, { ask: { kind: 'task' as const }, steps: STEPS, body: '## Why\nBecause.' });
    const stable = raised(DAEMON, { source: 'task', sourceRef: 'F1', steps: STEPS });

    // Act
    const same = succeeded(
      applyAgendaCommand(
        first.ledger,
        raiseCommand(AGENT, { ask: { kind: 'task' as const }, steps: STEPS, body: '## Why\nBecause.' }, SECOND),
      ),
    );
    const other = succeeded(
      applyAgendaCommand(
        same.ledger,
        raiseCommand(AGENT, { ask: { kind: 'task' as const }, steps: [...STEPS, 'Done'], body: undefined }, THIRD),
      ),
    );
    const refreshed = succeeded(
      applyAgendaCommand(
        stable.ledger,
        raiseCommand(DAEMON, { source: 'task', sourceRef: 'F1', steps: ['New step'], impact: 'Changed.' }, SECOND),
      ),
    );

    // Assert
    should(first.item?.steps).deepEqual(STEPS);
    should(first.item?.body).equal('## Why\nBecause.');
    should(same.changed).be.false();
    should(other.snapshot.count).equal(2);
    should(refreshed.change).equal('refreshed');
    should(refreshed.item?.steps).deepEqual(['New step']);
    should(refreshed.item?.body).be.undefined();
  });

  it('should tick and untick steps in order, report no change when already so, and keep the item open', () => {
    // Arrange
    const created = raised(AGENT, { ask: { kind: 'task' as const }, steps: STEPS });

    // Act
    const ticked2 = succeeded(applyAgendaCommand(created.ledger, progressOf(HUMAN, 'A1', 2, true)));
    const ticked0 = succeeded(applyAgendaCommand(ticked2.ledger, progressOf(AGENT, 'A1', 0, true)));
    const again = succeeded(applyAgendaCommand(ticked0.ledger, progressOf(HUMAN, 'A1', 0, true)));
    const unticked = succeeded(applyAgendaCommand(ticked0.ledger, progressOf(HUMAN, 'A1', 2, false)));
    const cleared = succeeded(applyAgendaCommand(unticked.ledger, progressOf(HUMAN, 'A1', 0, false)));
    const never = succeeded(applyAgendaCommand(created.ledger, progressOf(HUMAN, 'A1', 1, false)));

    // Assert
    should(ticked2.change).equal('progressed');
    should(ticked2.item?.stepsDone).deepEqual([2]);
    should(ticked0.item?.stepsDone).deepEqual([0, 2]);
    should(ticked0.snapshot.count).equal(1);
    should(again.changed).be.false();
    should(unticked.item?.stepsDone).deepEqual([0]);
    should(cleared.item?.stepsDone).be.undefined();
    should('stepsDone' in (cleared.item ?? {})).be.false();
    should(never.changed).be.false();
  });

  it('should refuse a step out of range, an item without steps, a stranger, and a closed or unknown item', () => {
    // Arrange
    const created = raised(AGENT, { ask: { kind: 'task' as const }, steps: STEPS });
    const plain = raised(AGENT);
    const closed = succeeded(
      applyAgendaCommand(created.ledger, { action: 'dismiss', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act
    const range = failed(applyAgendaCommand(created.ledger, progressOf(HUMAN, 'A1', 3, true)));
    const none = failed(applyAgendaCommand(plain.ledger, progressOf(HUMAN, 'A1', 0, true)));
    const stranger = failed(applyAgendaCommand(created.ledger, progressOf(OTHER_AGENT, 'A1', 0, true)));
    const resolved = failed(applyAgendaCommand(closed.ledger, progressOf(HUMAN, 'A1', 0, true, THIRD)));
    const unknown = failed(applyAgendaCommand(created.ledger, progressOf(HUMAN, 'A9', 0, true)));

    // Assert
    should(range.error.code).equal('invalid');
    should(range.error.message).containEql('0 to 2');
    should(none.error.message).containEql('no steps');
    should(stranger.error.code).equal('forbidden');
    should(resolved.error.code).equal('not-found');
    should(unknown.error.code).equal('not-found');
  });

  it('should clear progress when an edit changes the steps and keep it when they are the same', () => {
    // Arrange
    const created = raised(AGENT, { ask: { kind: 'task' as const }, steps: STEPS });
    const ticked = succeeded(applyAgendaCommand(created.ledger, progressOf(HUMAN, 'A1', 1, true)));
    const editWith = (patch: EditAgendaPatch): AgendaCommand => ({
      action: 'edit',
      actor: AGENT,
      id: 'A1',
      patch,
      at: THIRD,
    });

    // Act
    const sameSteps = succeeded(applyAgendaCommand(ticked.ledger, editWith({ steps: STEPS, body: 'More.' })));
    const bodyOnly = succeeded(applyAgendaCommand(ticked.ledger, editWith({ body: 'Only a body.' })));
    const newSteps = succeeded(applyAgendaCommand(ticked.ledger, editWith({ steps: ['One', 'Two'] })));

    // Assert
    should(sameSteps.item?.stepsDone).deepEqual([1]);
    should(bodyOnly.item?.stepsDone).deepEqual([1]);
    should(bodyOnly.item?.body).equal('Only a body.');
    should(newSteps.item?.steps).deepEqual(['One', 'Two']);
    should(newSteps.item?.stepsDone).be.undefined();
  });

  it('should keep ticks on a refresh with the same steps and clear them with new ones', () => {
    // Arrange
    const created = raised(DAEMON, { source: 'task', sourceRef: 'F2', steps: STEPS });
    const ticked = succeeded(applyAgendaCommand(created.ledger, progressOf(HUMAN, 'A1', 0, true)));
    const refresh = (steps: string[]): AgendaCommand =>
      raiseCommand(DAEMON, { source: 'task', sourceRef: 'F2', steps, impact: 'Newer.' }, THIRD);

    // Act
    const kept = succeeded(applyAgendaCommand(ticked.ledger, refresh(STEPS)));
    const reset = succeeded(applyAgendaCommand(ticked.ledger, refresh(['Other'])));

    // Assert
    should(kept.item?.stepsDone).deepEqual([0]);
    should(reset.item?.stepsDone).be.undefined();
  });
});

describe('Agenda state machine progress on another agent’s item', () => {
  it('should refuse a tick from an agent on an item a different agent raised', () => {
    // Arrange
    const created = raised(AGENT, { ask: { kind: 'task' as const }, steps: ['One'] });
    const foreign: AgendaLedger = {
      ...created.ledger,
      entries: [
        {
          lifecycle: 'active',
          origin: OTHER_AGENT,
          item: {
            ...activeEntry(created.ledger).item,
            raisedBy: 'agent',
            raisedBySession: OTHER_AGENT.sessionId,
            raisedByName: OTHER_AGENT.name,
          },
        },
      ],
    };

    // Act
    const refused = failed(
      applyAgendaCommand(foreign, { action: 'progress', actor: AGENT, id: 'A1', step: 0, done: true, at: SECOND }),
    );

    // Assert
    should(refused.error.code).equal('forbidden');
  });
});

describe('Agenda state machine needs-info', () => {
  const ask = (ledger: AgendaLedger, note?: string, at = SECOND, actor: AgendaActor = HUMAN) =>
    applyAgendaCommand(ledger, {
      action: 'needs-info',
      actor,
      id: 'A1',
      ...(note === undefined ? {} : { note }),
      at,
    });
  const ferretEdit = (ledger: AgendaLedger, subject: string, at = THIRD) =>
    applyAgendaCommand(ledger, { action: 'edit', actor: AGENT, id: 'A1', patch: { subject }, at });

  it('should keep the item open, mark it waiting on the ferret and count and record the request', () => {
    // Arrange
    const created = raised(AGENT, { ask: { kind: 'task' }, steps: ['Do it'] });

    // Act
    const asked = succeeded(ask(created.ledger, 'Which account?'));

    // Assert
    should(asked.change).equal('needs-info');
    should(asked.item).containDeep({ id: 'A1', waitingOn: 'ferret', askedAt: SECOND, infoRequests: 1 });
    should(asked.item?.history).deepEqual([{ at: SECOND, kind: 'needs-info', note: 'Which account?' }]);
    should(asked.snapshot.count).equal(1);
  });

  it('should treat a second ask while the ferret has not answered as the same request', () => {
    // Arrange
    const asked = succeeded(ask(raised().ledger));

    // Act
    const again = succeeded(ask(asked.ledger, 'again', THIRD));

    // Assert
    should(again.change).equal('unchanged');
    should(again.changed).be.false();
    should(activeEntry(again.ledger).item.infoRequests).equal(1);
  });

  it('should refuse an agent, a missing or closed item, and an item no ferret raised', () => {
    // Arrange
    const created = raised();
    const resolved = succeeded(
      applyAgendaCommand(created.ledger, { action: 'resolve', actor: HUMAN, id: 'A1', note: null, at: SECOND }),
    );
    const human = raised(HUMAN);

    // Act
    const byAgent = failed(ask(created.ledger, undefined, SECOND, AGENT));
    const closed = failed(ask(resolved.ledger));
    const unknown = failed(
      applyAgendaCommand(created.ledger, { action: 'needs-info', actor: HUMAN, id: 'A9', at: SECOND }),
    );
    const unasked = failed(ask(human.ledger));

    // Assert
    should(byAgent.error.code).equal('forbidden');
    should(closed.error.code).equal('not-found');
    should(unknown.error.code).equal('not-found');
    should(unasked.error.code).equal('invalid');
  });

  it('should clear the mark, add the history and report info-added when the ferret edits the item', () => {
    // Arrange
    const asked = succeeded(ask(raised().ledger, 'More?'));

    // Act
    const edited = succeeded(ferretEdit(asked.ledger, 'Approve the deploy now?'));

    // Assert
    should(edited.change).equal('info-added');
    should(edited.item?.waitingOn).be.undefined();
    should(edited.item?.askedAt).be.undefined();
    should(edited.item?.infoRequests).equal(1);
    should(edited.item?.history?.map(entry => entry.kind)).deepEqual(['needs-info', 'updated']);
  });

  it('should hand the item back even when the ferret’s edit changes nothing: answering is the edit', () => {
    // Arrange
    const created = raised();
    const asked = succeeded(ask(created.ledger));

    // Act
    const same = succeeded(ferretEdit(asked.ledger, created.item?.subject ?? '', THIRD));

    // Assert
    should(same.changed).be.true();
    should(same.change).equal('info-added');
    const item = activeEntry(same.ledger).item;
    should(item.waitingOn).be.undefined();
    should(item.askedAt).be.undefined();
    should(item.waitingFor).be.undefined();
    should(item.revisions).be.undefined();
    should(item.history?.map(entry => entry.kind)).deepEqual(['needs-info', 'updated']);
  });

  it('should not clear the mark when the owner edits it, and only report info-added once per request', () => {
    // Arrange
    const asked = succeeded(ask(raised().ledger));

    // Act
    const owner = succeeded(
      applyAgendaCommand(asked.ledger, {
        action: 'edit',
        actor: HUMAN,
        id: 'A1',
        patch: { subject: 'Reworded by the owner' },
        at: THIRD,
      }),
    );
    const answered = succeeded(ferretEdit(owner.ledger, 'Reworded by the ferret'));
    const later = succeeded(ferretEdit(answered.ledger, 'An ordinary later edit', '2026-07-30T13:00:00Z'));

    // Assert
    should(owner.change).equal('refreshed');
    should(activeEntry(owner.ledger).item.waitingOn).equal('ferret');
    should(answered.change).equal('info-added');
    should(later.change).equal('refreshed');
  });

  it('should count a new request after the ferret answered, and bound the history to the newest twenty', () => {
    // Arrange
    let ledger = raised().ledger;
    let at = 0;
    const stamp = () => new Date(Date.UTC(2026, 7, 1, 0, at++)).toISOString();

    // Act
    for (let round = 0; round < 15; round += 1) {
      ledger = succeeded(ask(ledger, `round ${round}`, stamp())).ledger;
      ledger = succeeded(ferretEdit(ledger, `Subject ${round}`, stamp())).ledger;
    }
    const item = activeEntry(ledger).item;

    // Assert
    should(item.infoRequests).equal(15);
    should(item.history).have.length(20);
    should(item.history?.[19]?.kind).equal('updated');
    const times = (item.history ?? []).map(entry => entry.at);
    should(times).deepEqual([...times].sort());
  });

  it('should drop the waiting mark when the item is resolved', () => {
    // Arrange
    const asked = succeeded(ask(raised().ledger));

    // Act
    const resolved = succeeded(
      applyAgendaCommand(asked.ledger, {
        action: 'resolve',
        actor: AGENT,
        id: 'A1',
        note: 'Settled in chat.',
        at: THIRD,
      }),
    );

    // Assert
    should(resolved.addressed?.waitingOn).be.undefined();
    should(resolved.addressed?.askedAt).be.undefined();
  });
});

describe('Agenda state machine discuss', () => {
  const discuss = (ledger: AgendaLedger, note?: string, at = SECOND, actor: AgendaActor = HUMAN) =>
    applyAgendaCommand(ledger, { action: 'discuss', actor, id: 'A1', ...(note === undefined ? {} : { note }), at });

  it('should keep the item open, mark it in discussion and count the request on the shared counter', () => {
    // Arrange
    const created = raised();

    // Act
    const asked = succeeded(discuss(created.ledger, 'The premise is wrong'));

    // Assert
    should(asked.change).equal('discussing');
    should(asked.item).containDeep({ waitingOn: 'ferret', askedAt: SECOND, waitingFor: 'discussion', infoRequests: 1 });
    should(asked.item?.history).deepEqual([{ at: SECOND, kind: 'discuss', note: 'The premise is wrong' }]);
  });

  it('should treat a second ask as the same request, and turn an open request for information into a new one', () => {
    // Arrange
    const asked = succeeded(discuss(raised().ledger));
    const info = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'needs-info', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act
    const again = succeeded(discuss(asked.ledger, 'again', THIRD));
    const turned = succeeded(discuss(info.ledger, undefined, THIRD));

    // Assert
    should(again.change).equal('unchanged');
    should(turned.change).equal('discussing');
    should(turned.item).containDeep({ waitingFor: 'discussion', infoRequests: 2 });
  });

  it('should refuse an agent, a missing item, and an item no ferret raised', () => {
    // Arrange
    const created = raised();

    // Act
    const byAgent = failed(discuss(created.ledger, undefined, SECOND, AGENT));
    const unknown = failed(
      applyAgendaCommand(created.ledger, { action: 'discuss', actor: HUMAN, id: 'A9', at: SECOND }),
    );
    const unraised = failed(discuss(raised(HUMAN).ledger));

    // Assert
    should(byAgent.error.code).equal('forbidden');
    should(unknown.error.code).equal('not-found');
    should(unraised.error.code).equal('invalid');
  });

  it('should hand a discussion back when the ferret edits the item, and also end it on surface or when closed', () => {
    // Arrange
    const asked = succeeded(discuss(raised().ledger));

    // Act
    const edited = succeeded(
      applyAgendaCommand(asked.ledger, {
        action: 'edit',
        actor: AGENT,
        id: 'A1',
        patch: { subject: 'Use SQLite for the board?' },
        at: THIRD,
      }),
    );
    const surfaced = succeeded(
      applyAgendaCommand(asked.ledger, { action: 'surface', actor: AGENT, id: 'A1', at: THIRD }),
    );
    const closed = succeeded(
      applyAgendaCommand(asked.ledger, { action: 'resolve', actor: HUMAN, id: 'A1', note: null, at: THIRD }),
    );

    // Assert — a discussion handed back is a plain refresh, not information added.
    should(edited.change).equal('refreshed');
    should(edited.item?.waitingOn).be.undefined();
    should(edited.item?.askedAt).be.undefined();
    should(edited.item?.waitingFor).be.undefined();
    should(edited.item?.history?.map(entry => entry.kind)).deepEqual(['discuss', 'updated']);
    should(surfaced.change).equal('surfaced');
    should(surfaced.item?.waitingFor).be.undefined();
    should(closed.ledger.entries[0]?.item.waitingFor).be.undefined();
  });
});

describe('Agenda state machine card fields', () => {
  const answers: AgendaCardAnswer[] = [
    { direction: 'left', does: 'reject', label: 'Deny' },
    { direction: 'up', does: 'approve', label: 'Always allow', description: 'for this repo' },
    { direction: 'right', does: 'approve', label: 'Allow' },
  ];
  const card: Partial<RaiseAgendaRequest> = { title: 'Deploy approval', kind: 'permission', answers };

  it('should carry the title, kind and answers onto the raised item, and into its snapshot', () => {
    // Arrange / Act
    const created = raised(AGENT, card);

    // Assert
    should(created.item).containDeep({ title: 'Deploy approval', kind: 'permission', answers });
    should(created.snapshot.items[0]).containDeep({ title: 'Deploy approval', kind: 'permission' });
  });

  it('should treat an identical re-raise as unchanged and a different card as a new item', () => {
    // Arrange
    const first = raised(AGENT, card);

    // Act
    const same = succeeded(applyAgendaCommand(first.ledger, raiseCommand(AGENT, card, SECOND)));
    const retitled = succeeded(
      applyAgendaCommand(first.ledger, raiseCommand(AGENT, { ...card, title: 'Another title' }, SECOND)),
    );
    const reanswered = succeeded(
      applyAgendaCommand(first.ledger, raiseCommand(AGENT, { ...card, answers: answers.slice(0, 2) }, SECOND)),
    );

    // Assert
    should(same.change).equal('unchanged');
    should(same.snapshot.count).equal(1);
    should(retitled.change).equal('created');
    should(retitled.snapshot.count).equal(2);
    should(reanswered.snapshot.count).equal(2);
  });

  it('should let an edit reword the title only, never the kind or the answers', () => {
    // Arrange
    const created = raised(AGENT, card);

    // Act
    const edited = succeeded(
      applyAgendaCommand(created.ledger, {
        action: 'edit',
        actor: AGENT,
        id: 'A1',
        patch: { title: 'Deploy to production' },
        at: SECOND,
      }),
    );
    const same = succeeded(
      applyAgendaCommand(edited.ledger, {
        action: 'edit',
        actor: AGENT,
        id: 'A1',
        patch: { title: 'Deploy to production' },
        at: THIRD,
      }),
    );

    // Assert
    should(edited.change).equal('refreshed');
    should(edited.item).containDeep({ title: 'Deploy to production', kind: 'permission', answers });
    should(edited.item?.waitingSince).equal(FIRST);
    should(same.change).equal('unchanged');
  });

  it('should refresh the title of a stable daemon source with the rest of its words', () => {
    // Arrange
    const source = { source: 'task', sourceRef: 'F12', ask: undefined, kind: 'info', waitingSince: FIRST } as const;
    const first = raised(DAEMON, { ...source, title: 'Task needs you' });

    // Act
    const next = succeeded(
      applyAgendaCommand(
        first.ledger,
        raiseCommand(DAEMON, { ...source, title: 'Task F needs you', waitingSince: THIRD }, SECOND),
      ),
    );

    // Assert
    should(next.change).equal('refreshed');
    should(next.item).containDeep({ id: 'A1', title: 'Task F needs you', kind: 'info' });
  });

  it('should load and answer an item stored before cards, which has no title, kind or answers', () => {
    // Arrange
    const old = raised(AGENT);

    // Act
    const decoded = parseAgendaLedger(JSON.parse(JSON.stringify(old.ledger)), SESSION_ID);
    const answered = succeeded(
      applyAgendaCommand(old.ledger, {
        action: 'answer',
        actor: HUMAN,
        id: 'A1',
        response: { kind: 'permission', decision: 'approve' },
        at: SECOND,
      }),
    );

    // Assert
    should(old.item).not.have.property('title');
    should(old.item).not.have.property('kind');
    should(old.item).not.have.property('answers');
    should(decoded).deepEqual(old.ledger);
    should(answered.change).equal('answered');
  });

  it('should let an agent raise an info item with no ask, and still refuse any other kind without one', () => {
    // Arrange
    const info = { kind: 'info', title: 'Release ready', ask: undefined } as const;

    // Act
    const created = raised(AGENT, info);
    const missing = failed(
      applyAgendaCommandToSession(
        null,
        SESSION_ID,
        raiseCommand(AGENT, { kind: 'permission', title: 'Deploy approval', ask: undefined }),
      ),
    );

    // Assert
    should(created.item).containDeep({ kind: 'info', title: 'Release ready' });
    should(created.item).not.have.property('ask');
    should(missing.error.code).equal('invalid');
  });
});

describe('Agenda state machine undelivered', () => {
  const SYSTEM: AgendaActor = { kind: 'daemon', cause: 'system' };
  const REASON = 'it never appeared in the ferret’s transcript';
  const undelivered = (ledger: AgendaLedger, request?: number, actor: AgendaActor = SYSTEM) =>
    applyAgendaCommand(ledger, {
      action: 'undelivered',
      actor,
      id: 'A1',
      reason: REASON,
      ...(request === undefined ? {} : { request }),
      at: THIRD,
    });

  it('should reopen an answered item as a card, keeping the answer for a retry', () => {
    // Arrange
    const answered = succeeded(
      applyAgendaCommand(raised().ledger, {
        action: 'answer',
        actor: HUMAN,
        id: 'A1',
        response: { kind: 'permission', decision: 'approve' },
        note: 'ship it',
        at: SECOND,
      }),
    );

    // Act
    const reopened = succeeded(undelivered(answered.ledger));
    const snapshot = agendaSnapshot(reopened.ledger);

    // Assert — open again, out of the resolved history, and the retry is the same answer.
    should(reopened.change).equal('reopened');
    should(snapshot.items.map(item => item.id)).deepEqual(['A1']);
    should(snapshot.resolved).be.empty();
    should(snapshot.items[0]).not.have.properties(['resolvedAt', 'disposition', 'response']);
    should(snapshot.items[0]?.undelivered).deepEqual({
      at: THIRD,
      reply: { action: 'resolve', note: 'ship it', response: { kind: 'permission', decision: 'approve' } },
      reason: REASON,
    });
  });

  it('should reopen a dismissed item with a dismiss to retry, and clear the mark when the owner acts again', () => {
    // Arrange
    const dismissed = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'dismiss', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act
    const reopened = succeeded(undelivered(dismissed.ledger));
    const retried = succeeded(
      applyAgendaCommand(reopened.ledger, { action: 'dismiss', actor: HUMAN, id: 'A1', at: THIRD }),
    );

    // Assert
    should(reopened.item?.undelivered?.reply).deepEqual({ action: 'dismiss' });
    should(retried.addressed).not.have.property('undelivered');
  });

  it('should end an undelivered discussion: back to the owner, waiting on nobody, with the discussion to retry', () => {
    // Arrange
    const discussing = succeeded(
      applyAgendaCommand(raised().ledger, {
        action: 'discuss',
        actor: HUMAN,
        id: 'A1',
        note: 'premise is off',
        at: SECOND,
      }),
    );

    // Act
    const reopened = succeeded(undelivered(discussing.ledger, 1));
    const again = succeeded(
      applyAgendaCommand(reopened.ledger, { action: 'discuss', actor: HUMAN, id: 'A1', at: THIRD }),
    );

    // Assert
    should(reopened.change).equal('reopened');
    should(reopened.item).not.have.properties(['waitingOn', 'askedAt', 'waitingFor']);
    should(reopened.item?.undelivered?.reply).deepEqual({ action: 'discuss', note: 'premise is off' });
    should(again.item).containDeep({ waitingFor: 'discussion', infoRequests: 2 });
    should(again.item).not.have.property('undelivered');
  });

  it('should leave an item alone that moved on since: a newer request, the ferret’s update, an item still open', () => {
    // Arrange
    const discussing = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'discuss', actor: HUMAN, id: 'A1', at: SECOND }),
    );
    const updated = succeeded(
      applyAgendaCommand(discussing.ledger, { action: 'surface', actor: AGENT, id: 'A1', at: THIRD }),
    );

    // Act + Assert
    should(succeeded(undelivered(discussing.ledger, 2)).changed).be.false();
    should(succeeded(undelivered(updated.ledger, 1)).changed).be.false();
    should(succeeded(undelivered(raised().ledger)).changed).be.false();
  });

  it('should keep an undelivered answer closed, and say so, when the board has no room to reopen it', () => {
    // Arrange — one answered item, then the board filled to its limit with open ones.
    let ledger = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'resolve', actor: HUMAN, id: 'A1', at: SECOND }),
    ).ledger;
    for (let index = 0; index < MAX_AGENDA_PER_SESSION; index += 1)
      ledger = succeeded(
        applyAgendaCommand(
          ledger,
          raiseCommand(DAEMON, { subject: `Full ${index}?`, sourceRef: `full-${index}` }, SECOND),
        ),
      ).ledger;

    // Act
    const refused = failed(undelivered(ledger));

    // Assert
    should(refused.error.code).equal('full');
    should(refused.error.message).match(/A1 cannot reopen/);
  });

  it('should be the daemon’s word alone, and only about an item a ferret raised', () => {
    // Arrange
    const owners = succeeded(
      applyAgendaCommand(raised(HUMAN).ledger, { action: 'resolve', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act + Assert
    should(failed(undelivered(raised().ledger, undefined, HUMAN)).error.code).equal('forbidden');
    should(succeeded(undelivered(owners.ledger)).changed).be.false();
  });
});

describe('Agenda state machine: a new ask is the owner’s turn', () => {
  const discuss = (ledger: AgendaLedger, actor: AgendaActor = HUMAN, at = SECOND, id: AgendaId = 'A1') =>
    applyAgendaCommand(ledger, { action: 'discuss', actor, id, at });
  /** An item on the ferret's turn: the owner asked to talk it through. */
  const born = (overrides: Partial<RaiseAgendaRequest> = {}) => succeeded(discuss(raised(AGENT, overrides).ledger));
  const surface = (ledger: AgendaLedger, actor: AgendaActor = AGENT, why?: string, at = SECOND): AgendaMutation =>
    applyAgendaCommand(ledger, { action: 'surface', actor, id: 'A1', ...(why === undefined ? {} : { why }), at });

  it('should start every ask on the owner’s turn: nobody is waited on, nothing is counted or recorded', () => {
    // Act
    const created = raised();
    const byEveryone = [WARDEN, DAEMON, HUMAN].map(actor =>
      raised(actor, { sourceRef: actor.kind === 'daemon' ? 'ref' : null }),
    );

    // Assert
    should(created.change).equal('created');
    should(created.item?.waitingOn).be.undefined();
    should(created.item?.waitingFor).be.undefined();
    should(created.item?.askedAt).be.undefined();
    should(created.item?.infoRequests).be.undefined();
    should(created.item?.history).be.undefined();
    for (const each of byEveryone) should(each.item?.waitingOn).be.undefined();
    should(raised(AGENT, { kind: 'info', ask: undefined }).item?.waitingOn).be.undefined();
  });

  it('should move a surfaced ask to the queue: clear the wait, record why, and report surfaced', () => {
    // Arrange
    const created = born();

    // Act
    const surfaced = succeeded(surface(created.ledger, AGENT, 'The owner did not answer'));

    // Assert
    should(surfaced.change).equal('surfaced');
    should(surfaced.changed).be.true();
    should(surfaced.item?.waitingOn).be.undefined();
    should(surfaced.item?.waitingFor).be.undefined();
    should(surfaced.item?.askedAt).be.undefined();
    should(surfaced.item?.history).deepEqual([
      { at: SECOND, kind: 'discuss' },
      { at: SECOND, kind: 'surfaced', note: 'The owner did not answer' },
    ]);
    should(agendaSnapshot(surfaced.ledger).items[0]).deepEqual(surfaced.item);
  });

  it('should record a surfaced entry without a note when no why is given', () => {
    // Act
    const surfaced = succeeded(surface(born().ledger));

    // Assert
    should(surfaced.item?.history).deepEqual([
      { at: SECOND, kind: 'discuss' },
      { at: SECOND, kind: 'surfaced' },
    ]);
  });

  it('should let the owner surface it too', () => {
    // Act
    const surfaced = succeeded(surface(born().ledger, HUMAN));

    // Assert
    should(surfaced.change).equal('surfaced');
  });

  it('should be no change to surface an item that is already the owner’s turn', () => {
    // Arrange
    const once = succeeded(surface(born().ledger));

    // Act
    const again = succeeded(surface(once.ledger, AGENT, 'again', THIRD));
    const never = succeeded(surface(raised().ledger));

    // Assert
    should(again.changed).be.false();
    should(agendaSnapshot(again.ledger).items[0]?.history).have.length(2);
    should(never.changed).be.false();
  });

  it('should refuse another ferret, an item that is not there, and a wait that is for information', () => {
    // Arrange
    const created = born();
    const waiting = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'needs-info', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act + Assert
    should(failed(surface(created.ledger, OTHER_AGENT)).error.code).equal('forbidden');
    should(failed(surface(emptyAgendaLedger(SESSION_ID, FIRST))).error.code).equal('not-found');
    should(failed(surface(waiting.ledger)).error.code).equal('invalid');
  });

  it('should refuse the daemon unless it is the resurface timer', () => {
    // Arrange
    const created = born();

    // Act + Assert
    should(failed(surface(created.ledger, WARDEN)).error.code).equal('forbidden');
    should(succeeded(surface(created.ledger, { kind: 'daemon', cause: 'system' })).change).equal('surfaced');
  });

  it('should leave a closed item alone', () => {
    // Arrange
    const closed = succeeded(
      applyAgendaCommand(born().ledger, {
        action: 'resolve',
        actor: AGENT,
        id: 'A1',
        note: 'Settled in chat.',
        at: SECOND,
      }),
    );

    // Act
    const result = succeeded(surface(closed.ledger));

    // Assert
    should(result.changed).be.false();
  });

  it('should let the owner talk a surfaced ask through again, which a ferret’s edit hands back', () => {
    // Arrange
    const surfaced = succeeded(surface(born().ledger));
    const discussing = succeeded(
      applyAgendaCommand(surfaced.ledger, { action: 'discuss', actor: HUMAN, id: 'A1', at: THIRD }),
    );

    // Act
    const answered = succeeded(
      applyAgendaCommand(discussing.ledger, {
        action: 'edit',
        actor: AGENT,
        id: 'A1',
        patch: { subject: 'Approve it tonight?' },
        at: '2026-07-30T13:00:00Z',
      }),
    );

    // Assert
    should(discussing.item).containDeep({ waitingFor: 'discussion', infoRequests: 2 });
    should(answered.change).equal('refreshed');
    should(answered.item?.waitingOn).be.undefined();
    should(answered.item?.waitingFor).be.undefined();
  });
});

describe('Agenda state machine reply', () => {
  const reply = (
    ledger: AgendaLedger,
    actor: AgendaActor = HUMAN,
    at = SECOND,
    id: AgendaId = 'A1',
    note?: string | null,
  ) => applyAgendaCommand(ledger, { action: 'reply', actor, id, at, ...(note === undefined ? {} : { note }) });
  const surfacing = (ledger: AgendaLedger, actor: AgendaActor = AGENT, why?: string, at = THIRD) =>
    applyAgendaCommand(ledger, { action: 'surface', actor, id: 'A1', ...(why === undefined ? {} : { why }), at });
  const editing = (ledger: AgendaLedger, patch: EditAgendaPatch, actor: AgendaActor = AGENT): AgendaMutation =>
    applyAgendaCommand(ledger, { action: 'edit', actor, id: 'A1', patch, at: THIRD });

  it('should park the item as replied, keeping the words in its history, and leave it open', () => {
    // Arrange
    const created = raised();

    // Act
    const replied = succeeded(reply(created.ledger, HUMAN, SECOND, 'A1', '  Use eu-west-1  '));

    // Assert
    const snapshot = agendaSnapshot(replied.ledger);
    should(replied.change).equal('replied');
    should(replied.changed).be.true();
    should(snapshot.items.map(item => item.id)).deepEqual(['A1']);
    should(snapshot.resolved).have.length(0);
    should(replied.addressed).be.undefined();
    should(replied.item?.parked).deepEqual({ reason: 'replied', at: SECOND });
    should(replied.item?.history).deepEqual([{ at: SECOND, kind: 'replied', note: 'Use eu-west-1' }]);
    should(replied.item).not.have.property('resolvedAt');
    should(replied.item?.infoRequests).be.undefined();
  });

  it('should park an item the ferret was asked for information on, and drop that wait', () => {
    // Arrange
    const asked = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'needs-info', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act
    const replied = succeeded(reply(asked.ledger, HUMAN, THIRD));

    // Assert
    should(replied.item).containDeep({ parked: { reason: 'replied', at: THIRD }, infoRequests: 1 });
    should(replied.item?.waitingOn).be.undefined();
    should(replied.item?.waitingFor).be.undefined();
    should(replied.item?.askedAt).be.undefined();
    should(replied.item?.history?.map(entry => entry.kind)).deepEqual(['needs-info', 'replied']);
  });

  it('should drop the discussion an item was in, and replace a snooze, when the owner replies', () => {
    // Arrange
    const discussing = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'discuss', actor: HUMAN, id: 'A1', at: SECOND }),
    );
    const snoozed = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'snooze', actor: HUMAN, id: 'A1', until: LATER, at: SECOND }),
    );

    // Act
    const fromDiscussion = succeeded(reply(discussing.ledger, HUMAN, THIRD));
    const fromSnooze = succeeded(reply(snoozed.ledger, HUMAN, THIRD));

    // Assert
    should(fromDiscussion.item?.waitingFor).be.undefined();
    should(fromDiscussion.item?.parked).deepEqual({ reason: 'replied', at: THIRD });
    should(fromSnooze.item?.parked).deepEqual({ reason: 'replied', at: THIRD });
    should(fromSnooze.item?.history?.map(entry => entry.kind)).deepEqual(['replied']);
  });

  it('should keep parked items in the snapshot and its count, so it reads back on the wire; a badge leaves them out', () => {
    // Arrange — one snoozed, one replied to, one in play (the live 4.140 board: count 2, items 4, refused)
    const two = succeeded(applyAgendaCommand(raised().ledger, raiseCommand(AGENT, { subject: 'Second ask?' })));
    const three = succeeded(applyAgendaCommand(two.ledger, raiseCommand(AGENT, { subject: 'Third ask?' })));
    const snoozed = succeeded(
      applyAgendaCommand(three.ledger, { action: 'snooze', actor: HUMAN, id: 'A1', until: LATER, at: SECOND }),
    );
    const replied = succeeded(
      applyAgendaCommand(snoozed.ledger, { action: 'reply', actor: HUMAN, id: 'A2', at: SECOND }),
    );

    // Act
    const wire = AgendaSnapshotSchema.safeParse(JSON.parse(JSON.stringify(replied.snapshot)));

    // Assert
    should(wire.success).be.true();
    should(replied.snapshot.count).equal(3);
    should(replied.snapshot.items.map(item => item.parked?.reason ?? 'open')).deepEqual(['snoozed', 'replied', 'open']);
    should(agendaBadgeCount(replied.snapshot)).equal(1);
  });

  it('should keep no note when the owner sent no words', () => {
    // Act
    const blank = succeeded(reply(raised().ledger, HUMAN, SECOND, 'A1', '   '));
    const none = succeeded(reply(raised().ledger));

    // Assert
    should(blank.item?.history).deepEqual([{ at: SECOND, kind: 'replied' }]);
    should(none.item?.history).deepEqual([{ at: SECOND, kind: 'replied' }]);
  });

  it('should park again at the new time when the owner replies to a parked item once more', () => {
    // Arrange
    const once = succeeded(reply(raised().ledger, HUMAN, SECOND, 'A1', 'First'));

    // Act
    const again = succeeded(reply(once.ledger, HUMAN, THIRD, 'A1', 'Second'));

    // Assert
    should(again.change).equal('replied');
    should(again.item?.parked).deepEqual({ reason: 'replied', at: THIRD });
    should(again.item?.history?.map(entry => entry.note)).deepEqual(['First', 'Second']);
  });

  it('should be the owner’s alone: an agent, the ferret that raised it and the daemon are refused', () => {
    // Arrange
    const created = raised();

    // Act + Assert
    should(failed(reply(created.ledger, AGENT)).error.code).equal('forbidden');
    should(failed(reply(created.ledger, DAEMON)).error.code).equal('forbidden');
    should(failed(reply(created.ledger, OTHER_AGENT)).error.code).equal('forbidden');
  });

  it('should be not-found for a missing item, no change for a closed one, and refuse a notice', () => {
    // Arrange
    const created = raised();
    const closed = succeeded(
      applyAgendaCommand(created.ledger, {
        action: 'resolve',
        actor: AGENT,
        id: 'A1',
        note: 'Settled in chat.',
        at: SECOND,
      }),
    );
    const notice = raised(AGENT, { notice: true, kind: 'info', ask: undefined });

    // Act + Assert
    should(failed(reply(created.ledger, HUMAN, SECOND, 'A9')).error.code).equal('not-found');
    should(succeeded(reply(closed.ledger)).changed).be.false();
    should(failed(reply(notice.ledger)).error.code).equal('invalid');
  });

  it('should reply to an item nobody in particular raised: the owner may park any open item', () => {
    // Act
    const replied = succeeded(reply(raised(HUMAN).ledger));

    // Assert
    should(replied.item?.parked?.reason).equal('replied');
  });

  it('should park a daemon-raised Warden item the same way', () => {
    // Arrange
    const created = raised(WARDEN, { sourceRef: null });

    // Act
    const replied = succeeded(reply(created.ledger));

    // Assert
    should(replied.item?.parked?.reason).equal('replied');
    should(agendaSnapshot(replied.ledger).resolved).have.length(0);
  });

  it('should refuse a bare surface of it by the ferret and say to edit the whole card instead', () => {
    // Arrange
    const replied = succeeded(reply(raised().ledger, HUMAN, SECOND, 'A1', 'Why us?'));

    // Act
    const refused = failed(surfacing(replied.ledger, AGENT, 'Still need the region'));

    // Assert
    should(refused.error.code).equal('invalid');
    should(refused.error.message).containEql('fy agenda edit A1 --summary');
    should(refused.error.message).containEql('--premise');
    should(refused.error.message).containEql('--context');
  });

  it('should come back fresh on the owner’s turn when the ferret edits the whole card, keeping its id and history', () => {
    // Arrange
    const replied = succeeded(reply(raised().ledger, HUMAN, SECOND, 'A1', 'Why us?'));

    // Act
    const back = succeeded(editing(replied.ledger, REFRESH));

    // Assert
    const snapshot = agendaSnapshot(back.ledger);
    should(back.change).equal('refreshed');
    should(snapshot.items.map(item => item.id)).deepEqual(['A1']);
    should(snapshot.resolved).have.length(0);
    should(back.item?.parked).be.undefined();
    should(back.item?.waitingOn).be.undefined();
    should(back.item?.waitingSince).equal(THIRD);
    should(back.item?.urgentAt).be.undefined();
    should(back.item?.subject).equal(REFRESH.subject);
    should(back.item?.premise).equal(REFRESH.premise);
    should(back.item?.context).equal(REFRESH.context);
    should(back.item?.history).deepEqual([{ at: SECOND, kind: 'replied', note: 'Why us?' }]);
  });

  it('should come back with the new wording, fresh, when the ferret edits it', () => {
    // Arrange
    const replied = succeeded(reply(raised().ledger));

    // Act
    const back = succeeded(
      applyAgendaCommand(replied.ledger, {
        action: 'edit',
        actor: AGENT,
        id: 'A1',
        patch: { ...REFRESH, stillOpen: 'Which region?' },
        at: THIRD,
      }),
    );

    // Assert
    should(agendaSnapshot(back.ledger).items.map(item => item.id)).deepEqual(['A1']);
    should(back.item?.stillOpen).equal('Which region?');
    should(back.item?.parked).be.undefined();
    should(back.item?.waitingOn).be.undefined();
    should(back.item?.waitingSince).equal(THIRD);
    should(back.change).equal('refreshed');
    should(back.item?.revisions?.map(revision => revision.changed)).deepEqual([
      ['subject', 'context', 'premise', 'stillOpen'],
    ]);
    should(back.item?.history?.map(entry => entry.kind)).deepEqual(['replied']);
  });

  it('should bring it back even when the ferret’s edit changes nothing', () => {
    // Arrange
    const replied = succeeded(reply(raised().ledger));
    const unchangedPatch: EditAgendaPatch = {
      subject: 'Approve the deployment?',
      premise: 'A release is ready to go out.',
      context: 'This deploy changes the public service.',
    };

    // Act
    const back = succeeded(
      applyAgendaCommand(replied.ledger, {
        action: 'edit',
        actor: AGENT,
        id: 'A1',
        patch: unchangedPatch,
        at: THIRD,
      }),
    );

    // Assert
    should(back.change).equal('unparked');
    should(back.item?.parked).be.undefined();
    should(back.item?.waitingSince).equal(THIRD);
  });

  it('should refuse the ferret’s edit of it unless the summary, premise and context are all given', () => {
    // Arrange
    const replied = succeeded(reply(raised().ledger));
    const legacy: AgendaLedger = {
      ...succeeded(applyAgendaCommand(raised().ledger, { action: 'resolve', actor: HUMAN, id: 'A1', at: SECOND }))
        .ledger,
    };
    const closedAsReplied: AgendaLedger = {
      ...legacy,
      entries: legacy.entries.map(entry =>
        entry.lifecycle === 'addressed'
          ? { ...entry, item: { ...entry.item, disposition: 'replied' as const } }
          : entry,
      ),
    };

    // Act
    const noSummary = failed(editing(replied.ledger, { premise: 'p', context: 'c' }));
    const noPremise = failed(editing(replied.ledger, { subject: 's', context: 'c' }));
    const blankContext = failed(editing(replied.ledger, { subject: 's', premise: 'p', context: '  ' }));
    const nullContext = failed(editing(replied.ledger, { subject: 's', premise: 'p', context: null }));
    const nothing = failed(editing(replied.ledger, { stillOpen: 'Which region?' }));
    const legacyRefused = failed(editing(closedAsReplied, { subject: 's' }));

    // Assert
    should(noSummary.error.code).equal('invalid');
    should(noSummary.error.message).equal(
      'bring A1 back with the whole card refreshed: --summary, --premise and --context are required after the owner replied (missing --summary)',
    );
    should(noPremise.error.message).containEql('missing --premise');
    should(blankContext.error.message).containEql('missing --context');
    should(nullContext.error.message).containEql('missing --context');
    should(nothing.error.message).containEql('missing --summary, --premise, --context');
    should(legacyRefused.error.message).containEql('missing --premise, --context');
  });

  it('should let the owner and the daemon edit it without refreshing the whole card', () => {
    // Arrange
    const replied = succeeded(reply(raised().ledger));

    // Act
    const byOwner = succeeded(editing(replied.ledger, { stillOpen: 'x' }, HUMAN));

    // Assert
    should(agendaSnapshot(byOwner.ledger).items[0]?.parked?.reason).equal('replied');
  });

  it('should let the resurface timer bring it back, and refuse another ferret and the Warden', () => {
    // Arrange
    const replied = succeeded(reply(raised().ledger));

    // Act + Assert
    should(failed(surfacing(replied.ledger, OTHER_AGENT)).error.code).equal('forbidden');
    should(failed(surfacing(replied.ledger, WARDEN)).error.code).equal('forbidden');
    should(succeeded(surfacing(replied.ledger, { kind: 'daemon', cause: 'system' })).change).equal('unchanged');
  });

  it('should leave it parked when the owner or another non-agent actor surfaces it', () => {
    // Arrange
    const replied = succeeded(reply(raised().ledger));

    // Act
    const byOwner = succeeded(surfacing(replied.ledger, HUMAN));

    // Assert
    should(byOwner.changed).be.false();
    should(agendaSnapshot(byOwner.ledger).items[0]?.parked?.reason).equal('replied');
  });

  it('should refuse a bare surface of a legacy closed replied item by the ferret', () => {
    // Arrange
    const created = raised();
    const closed = succeeded(
      applyAgendaCommand(created.ledger, { action: 'resolve', actor: HUMAN, id: 'A1', at: SECOND }),
    );
    const legacy: AgendaLedger = {
      ...closed.ledger,
      entries: closed.ledger.entries.map(entry =>
        entry.lifecycle === 'addressed'
          ? { ...entry, item: { ...entry.item, disposition: 'replied' as const } }
          : entry,
      ),
    };

    // Act
    const refused = failed(surfacing(legacy, AGENT, 'Still need it'));
    const byTimer = succeeded(surfacing(legacy, { kind: 'daemon', cause: 'system' }, 'Still need it'));

    // Assert
    should(refused.error.code).equal('invalid');
    should(byTimer.change).equal('reopened');
    should(agendaSnapshot(byTimer.ledger).items.map(item => item.id)).deepEqual(['A1']);
    should(byTimer.item?.history?.at(-1)).deepEqual({ at: THIRD, kind: 'surfaced', note: 'Still need it' });
  });

  it('should reopen a legacy closed replied item into the board when the ferret edits it, and apply the edit', () => {
    // Arrange
    const closed = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'resolve', actor: HUMAN, id: 'A1', at: SECOND }),
    );
    const legacy: AgendaLedger = {
      ...closed.ledger,
      entries: closed.ledger.entries.map(entry =>
        entry.lifecycle === 'addressed'
          ? { ...entry, item: { ...entry.item, disposition: 'replied' as const } }
          : entry,
      ),
    };

    // Act
    const back = succeeded(
      applyAgendaCommand(legacy, {
        action: 'edit',
        actor: AGENT,
        id: 'A1',
        patch: { ...REFRESH, subject: 'Reworded' },
        at: THIRD,
      }),
    );

    // Assert
    should(agendaSnapshot(back.ledger).items.map(item => item.subject)).deepEqual(['Reworded']);
    should(back.item?.history?.map(entry => entry.kind)).containEql('updated');
  });

  it('should refuse the edit of a legacy closed replied item into a full board', () => {
    // Arrange
    const closed = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'resolve', actor: HUMAN, id: 'A1', at: SECOND }),
    );
    let ledger: AgendaLedger = {
      ...closed.ledger,
      entries: closed.ledger.entries.map(entry =>
        entry.lifecycle === 'addressed'
          ? { ...entry, item: { ...entry.item, disposition: 'replied' as const } }
          : entry,
      ),
    };
    for (let index = 0; index < MAX_AGENDA_PER_SESSION; index += 1) {
      const next = applyAgendaCommand(ledger, raiseCommand(HUMAN, { subject: `Filler ${index}` }));
      if (!next.ok) break;
      ledger = next.ledger;
    }

    // Act
    const result = applyAgendaCommand(ledger, {
      action: 'edit',
      actor: AGENT,
      id: 'A1',
      patch: REFRESH,
      at: THIRD,
    });

    // Assert
    should(failed(result).error.code).equal('full');
  });

  it('should not reopen a legacy closed replied item into a full board', () => {
    // Arrange
    const closed = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'resolve', actor: HUMAN, id: 'A1', at: SECOND }),
    );
    let ledger: AgendaLedger = {
      ...closed.ledger,
      entries: closed.ledger.entries.map(entry =>
        entry.lifecycle === 'addressed'
          ? { ...entry, item: { ...entry.item, disposition: 'replied' as const } }
          : entry,
      ),
    };
    for (let index = 0; index < MAX_AGENDA_PER_SESSION; index += 1) {
      const next = applyAgendaCommand(ledger, raiseCommand(HUMAN, { subject: `Filler ${index}` }));
      if (!next.ok) break;
      ledger = next.ledger;
    }

    // Act
    const result = surfacing(ledger, { kind: 'daemon', cause: 'system' });

    // Assert
    should(failed(result).error.code).equal('full');
  });

  it('should not be brought back by a surface of an item that was answered for real', () => {
    // Arrange
    const closed = succeeded(
      applyAgendaCommand(raised().ledger, {
        action: 'resolve',
        actor: AGENT,
        id: 'A1',
        note: 'Settled in chat.',
        at: SECOND,
      }),
    );

    // Act
    const result = succeeded(surfacing(closed.ledger));

    // Assert
    should(result.changed).be.false();
    should(agendaSnapshot(result.ledger).items).have.length(0);
  });

  it('should drop the wait when a discussion is closed', () => {
    // Arrange
    const discussing = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'discuss', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act
    const closed = succeeded(
      applyAgendaCommand(discussing.ledger, { action: 'resolve', actor: HUMAN, id: 'A1', note: null, at: THIRD }),
    );

    // Assert
    should(closed.addressed?.waitingOn).be.undefined();
    should(closed.addressed?.waitingFor).be.undefined();
    should(closed.addressed?.askedAt).be.undefined();
  });
});

describe('Agenda ledger migration: an owner reply an earlier daemon left on the ferret’s turn', () => {
  const legacyReply = (): AgendaLedger => {
    const created = raised();
    const entry = activeEntry(created.ledger);
    return {
      ...created.ledger,
      entries: [{ ...entry, item: { ...entry.item, waitingOn: 'ferret', askedAt: SECOND, waitingFor: 'discussion' } }],
    };
  };

  it('should park it as replied at the instant of the reply when the board is read', () => {
    // Act
    const parsed = parseAgendaLedger(JSON.parse(JSON.stringify(legacyReply())), SESSION_ID);

    // Assert
    const snapshot = agendaSnapshot(parsed as AgendaLedger);
    should(snapshot.resolved).have.length(0);
    should(snapshot.items).have.length(1);
    should(snapshot.items[0]).containDeep({ id: 'A1', parked: { reason: 'replied', at: SECOND } });
    should(snapshot.items[0]?.history?.map(entry => entry.kind)).deepEqual(['replied']);
    should(snapshot.items[0]?.waitingOn).be.undefined();
    should(snapshot.items[0]?.askedAt).be.undefined();
    should(snapshot.items[0]?.waitingFor).be.undefined();
  });

  it('should park only the replied item on a board that also holds an ordinary open one', () => {
    // Arrange
    const withSecond = succeeded(
      applyAgendaCommand(legacyReply(), raiseCommand(AGENT, { subject: 'Rotate the signing key?' }, SECOND)),
    );

    // Act
    const parsed = parseAgendaLedger(JSON.parse(JSON.stringify(withSecond.ledger)), SESSION_ID);

    // Assert
    const snapshot = agendaSnapshot(parsed as AgendaLedger);
    should(snapshot.items.map(item => [item.id, item.parked?.reason])).deepEqual([
      ['A1', 'replied'],
      ['A2', undefined],
    ]);
    should(snapshot.resolved).have.length(0);
  });

  it('should be idempotent: reading it again changes nothing', () => {
    // Arrange
    const once = parseAgendaLedger(JSON.parse(JSON.stringify(legacyReply())), SESSION_ID) as AgendaLedger;

    // Act
    const twice = parseAgendaLedger(JSON.parse(JSON.stringify(once)), SESSION_ID);

    // Assert
    should(twice).deepEqual(once);
  });

  it('should leave a requested discussion and a request for information on the ferret’s turn', () => {
    // Arrange
    const discussing = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'discuss', actor: HUMAN, id: 'A1', at: SECOND }),
    );
    const asked = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'needs-info', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act
    const parsedDiscussion = parseAgendaLedger(JSON.parse(JSON.stringify(discussing.ledger)), SESSION_ID);
    const parsedInfo = parseAgendaLedger(JSON.parse(JSON.stringify(asked.ledger)), SESSION_ID);

    // Assert
    should(agendaSnapshot(parsedDiscussion as AgendaLedger).items[0]).containDeep({ waitingFor: 'discussion' });
    should(agendaSnapshot(parsedInfo as AgendaLedger).items[0]).containDeep({ waitingOn: 'ferret', infoRequests: 1 });
  });

  it('should leave an item born in discussion, with no wait before its first reply, alone', () => {
    // Arrange
    const created = raised();
    const entry = activeEntry(created.ledger);
    const born = {
      ...created.ledger,
      entries: [{ ...entry, item: { ...entry.item, waitingOn: 'ferret', askedAt: FIRST, waitingFor: 'discussion' } }],
    };

    // Act
    const parsed = parseAgendaLedger(JSON.parse(JSON.stringify(born)), SESSION_ID);

    // Assert
    should(agendaSnapshot(parsed as AgendaLedger).items).have.length(1);
  });
});

describe('Agenda state machine: the ferret’s edit hands the item back', () => {
  const reply = (ledger: AgendaLedger) =>
    applyAgendaCommand(ledger, { action: 'discuss', actor: HUMAN, id: 'A1', at: SECOND });
  const needsInfo = (ledger: AgendaLedger) =>
    applyAgendaCommand(ledger, { action: 'needs-info', actor: HUMAN, id: 'A1', note: 'Why?', at: SECOND });
  const editing = (
    ledger: AgendaLedger,
    patch: EditAgendaPatch,
    actor: AgendaActor = AGENT,
    at = THIRD,
  ): AgendaMutation => applyAgendaCommand(ledger, { action: 'edit', actor, id: 'A1', patch, at });

  it('should hand a discussion back: clear the wait and record an update, as a plain refresh', () => {
    // Arrange
    const replied = succeeded(reply(raised().ledger));

    // Act
    const edited = succeeded(editing(replied.ledger, { stillOpen: 'Which region?' }));

    // Assert
    should(edited.change).equal('refreshed');
    should(edited.item?.waitingOn).be.undefined();
    should(edited.item?.askedAt).be.undefined();
    should(edited.item?.waitingFor).be.undefined();
    should(edited.item?.history).deepEqual([
      { at: SECOND, kind: 'discuss' },
      { at: THIRD, kind: 'updated' },
    ]);
    should(edited.item?.stillOpen).equal('Which region?');
    should(edited.item?.revisions).have.length(1);
  });

  it('should hand a request for information back as info-added', () => {
    // Arrange
    const asked = succeeded(needsInfo(raised().ledger));

    // Act
    const edited = succeeded(editing(asked.ledger, { stillOpen: 'Which region?' }));

    // Assert
    should(edited.change).equal('info-added');
    should(edited.item?.waitingOn).be.undefined();
    should(edited.item?.history?.map(entry => entry.kind)).deepEqual(['needs-info', 'updated']);
  });

  it('should hand back even when nothing changed, with no revision for it', () => {
    // Arrange
    const created = raised();
    const replied = succeeded(reply(created.ledger));
    const asked = succeeded(needsInfo(created.ledger));
    const same = { subject: created.item?.subject ?? '' };

    // Act
    const discussion = succeeded(editing(replied.ledger, same));
    const information = succeeded(editing(asked.ledger, same));

    // Assert
    should(discussion.changed).be.true();
    should(discussion.change).equal('refreshed');
    should(discussion.item?.waitingOn).be.undefined();
    should(discussion.item?.revisions).be.undefined();
    should(information.changed).be.true();
    should(information.change).equal('info-added');
    should(information.item?.waitingOn).be.undefined();
  });

  it('should keep waiting when the owner edits: only the ferret answers its turn', () => {
    // Arrange
    const replied = succeeded(reply(raised().ledger));

    // Act
    const edited = succeeded(editing(replied.ledger, { subject: 'Reworded by the owner' }, HUMAN));
    const same = succeeded(editing(replied.ledger, { subject: replied.item?.subject ?? '' }, HUMAN));

    // Assert
    should(edited.change).equal('refreshed');
    should(edited.item).containDeep({ waitingOn: 'ferret', askedAt: SECOND, waitingFor: 'discussion' });
    should(edited.item?.history?.map(entry => entry.kind)).deepEqual(['discuss']);
    should(same.changed).be.false();
  });

  it('should still be no change when the ferret edits an item that is already the owner’s turn', () => {
    // Arrange
    const created = raised();

    // Act
    const same = succeeded(editing(created.ledger, { subject: created.item?.subject ?? '' }));

    // Assert
    should(same.changed).be.false();
    should(same.change).equal('unchanged');
  });
});

describe('Agenda state machine: agenda fields and clearing them', () => {
  const NEEDED = '2026-08-01T09:00:00.000Z';
  const editing = (ledger: AgendaLedger, patch: EditAgendaPatch, at = SECOND): AgendaMutation =>
    applyAgendaCommand(ledger, { action: 'edit', actor: AGENT, id: 'A1', patch, at });
  const agenda = () => raised(AGENT, { blockingNow: true, willBlock: 'the deploy', neededBy: NEEDED });

  it('should carry blockingNow, willBlock and neededBy onto a raised item and keep them in the same-request comparison', () => {
    // Arrange
    const created = agenda();

    // Act
    const same = succeeded(applyAgendaCommand(created.ledger, raiseCommand(AGENT, agendaOf())));
    const other = succeeded(
      applyAgendaCommand(created.ledger, raiseCommand(AGENT, { ...agendaOf(), willBlock: 'the release' })),
    );

    // Assert
    should(created.item).containDeep({ blockingNow: true, willBlock: 'the deploy', neededBy: NEEDED });
    should(same.changed).be.false();
    should(other.item?.id).equal('A2');
  });

  it('should edit them like any other field, remembering what they said before', () => {
    // Arrange
    const created = agenda();

    // Act
    const edited = succeeded(
      editing(created.ledger, { willBlock: 'the release', neededBy: '2026-08-02T09:00:00.000Z' }),
    );
    const same = succeeded(editing(edited.ledger, { willBlock: 'the release' }, THIRD));

    // Assert
    should(edited.change).equal('refreshed');
    should(edited.item).containDeep({ willBlock: 'the release', neededBy: '2026-08-02T09:00:00.000Z' });
    should(edited.item?.revisions).deepEqual([
      {
        at: SECOND,
        by: 'agent',
        changed: ['willBlock', 'neededBy'],
        previous: { willBlock: 'the deploy', neededBy: NEEDED },
      },
    ]);
    should(same.changed).be.false();
  });

  it('should set a field the item did not have, with nothing before it', () => {
    // Act
    const edited = succeeded(editing(raised().ledger, { blockingNow: true }));

    // Assert
    should(edited.item?.blockingNow).be.true();
    should(edited.item?.revisions).deepEqual([{ at: SECOND, by: 'agent', changed: ['blockingNow'], previous: {} }]);
  });

  it('should clear a field it has, and record the clear in the revision with what it said', () => {
    // Arrange
    const created = agenda();

    // Act
    const cleared = succeeded(editing(created.ledger, { clear: ['blockingNow'] }));

    // Assert
    should(cleared.change).equal('refreshed');
    should(cleared.item?.blockingNow).be.undefined();
    should(cleared.item).containDeep({ willBlock: 'the deploy', neededBy: NEEDED });
    should(cleared.item?.revisions).deepEqual([
      { at: SECOND, by: 'agent', changed: ['blockingNow'], previous: { blockingNow: true } },
    ]);
  });

  it('should clear several at once, alongside a wording change, in the order the card lists them', () => {
    // Arrange
    const created = agenda();

    // Act
    const cleared = succeeded(
      editing(created.ledger, { subject: 'Approve it tonight?', clear: ['neededBy', 'willBlock'] }),
    );

    // Assert
    should(cleared.item?.subject).equal('Approve it tonight?');
    should(cleared.item?.willBlock).be.undefined();
    should(cleared.item?.neededBy).be.undefined();
    should(cleared.item?.blockingNow).be.true();
    should(cleared.item?.revisions).deepEqual([
      {
        at: SECOND,
        by: 'agent',
        changed: ['subject', 'willBlock', 'neededBy'],
        previous: { subject: 'Approve the deployment?', willBlock: 'the deploy', neededBy: NEEDED },
      },
    ]);
  });

  it('should treat clearing a field the item does not have as no change', () => {
    // Arrange
    const created = raised();

    // Act
    const cleared = succeeded(editing(created.ledger, { clear: ['blockingNow', 'willBlock', 'neededBy'] }));

    // Assert
    should(cleared.changed).be.false();
    should(cleared.change).equal('unchanged');
    should(cleared.ledger).deepEqual(created.ledger);
  });

  it('should hand a turn back on a clear, even one that cleared nothing', () => {
    // Arrange
    const replied = succeeded(
      applyAgendaCommand(agenda().ledger, { action: 'discuss', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act
    const cleared = succeeded(editing(replied.ledger, { clear: ['blockingNow'] }, THIRD));

    // Assert
    should(cleared.item?.waitingOn).be.undefined();
    should(cleared.item?.blockingNow).be.undefined();
    should(cleared.item?.history?.map(entry => entry.kind)).deepEqual(['discuss', 'updated']);
  });

  it('should say there is nothing to edit when there are neither fields nor a clear', () => {
    // Arrange
    const created = raised();

    // Act
    const none = failed(editing(created.ledger, {}));
    const empty = failed(editing(created.ledger, { clear: [] }));

    // Assert
    should(none.error.code).equal('invalid');
    should(none.error.message).startWith('nothing to edit');
    should(none.error.message).containEql('blockingNow');
    should(empty.error.code).equal('invalid');
  });

  function agendaOf(): Partial<RaiseAgendaRequest> {
    return { blockingNow: true, willBlock: 'the deploy', neededBy: NEEDED };
  }
});

describe('Agenda state machine notices', () => {
  const notice = (overrides: Partial<RaiseAgendaRequest> = {}): Partial<RaiseAgendaRequest> => ({
    notice: true,
    kind: 'info',
    ask: undefined,
    ...overrides,
  });

  it('should store a notice on the item, with its ping, and never make it anyone’s turn', () => {
    // Act
    const plain = raised(AGENT, notice());
    const pinged = raised(AGENT, notice({ ping: true }));

    // Assert
    should(plain.item).containDeep({ notice: true, kind: 'info' });
    should(plain.item?.ping).be.undefined();
    should(plain.item?.ask).be.undefined();
    should(plain.item?.waitingOn).be.undefined();
    should(pinged.item).containDeep({ notice: true, ping: true });
  });

  it('should leave a plain item without the flags', () => {
    // Act
    const created = raised();

    // Assert
    should(created.item?.notice).be.undefined();
    should(created.item?.ping).be.undefined();
  });

  it('should let the daemon send a notice, and refuse a human', () => {
    // Act
    const byDaemon = succeeded(
      applyAgendaCommandToSession(null, SESSION_ID, raiseCommand(DAEMON, notice({ source: 'task', sourceRef: 'ref' }))),
    );
    const byHuman = failed(applyAgendaCommandToSession(null, SESSION_ID, raiseCommand(HUMAN, notice())));

    // Assert
    should(byDaemon.item?.notice).be.true();
    should(byHuman.error.code).equal('forbidden');
  });

  it('should refuse a notice with an ask, answers or steps, or of any kind but info', () => {
    // Arrange
    const run = (overrides: Partial<RaiseAgendaRequest>) =>
      failed(applyAgendaCommandToSession(null, SESSION_ID, raiseCommand(AGENT, notice(overrides))));
    const answers: AgendaCardAnswer[] = [
      { direction: 'left', does: 'reject', label: 'No' },
      { direction: 'right', does: 'approve', label: 'Yes' },
    ];

    // Act
    const withAsk = run({ ask: { kind: 'permission' } });
    const withAnswers = run({ answers });
    const withSteps = run({ steps: ['Do it'] });
    const wrongKind = run({ kind: 'permission' });

    // Assert
    should(withAsk.error).deepEqual({ code: 'invalid', message: 'a notice has no ask' });
    should(withAnswers.error.message).equal('a notice has no answers');
    should(withSteps.error.message).containEql('a notice has no steps');
    should(wrongKind.error.message).equal('a notice is kind info');
  });

  it('should accept a notice that leaves the kind out, since the notice is info', () => {
    // Act
    const created = succeeded(
      applyAgendaCommandToSession(
        null,
        SESSION_ID,
        raiseCommand(AGENT, { notice: true, ask: undefined, kind: undefined }),
      ),
    );

    // Assert
    should(created.item?.notice).be.true();
  });

  it('should refuse a ping that is not on a notice', () => {
    // Act
    const pinged = failed(applyAgendaCommandToSession(null, SESSION_ID, raiseCommand(AGENT, { ping: true })));

    // Assert
    should(pinged.error).deepEqual({ code: 'invalid', message: 'ping is only for a notice' });
  });

  it('should tell a notice from the same words as an ask, and a ping from a plain notice', () => {
    // Arrange
    const first = raised(AGENT, notice());

    // Act
    const same = succeeded(applyAgendaCommand(first.ledger, raiseCommand(AGENT, notice(), SECOND)));
    const pinged = succeeded(applyAgendaCommand(first.ledger, raiseCommand(AGENT, notice({ ping: true }), SECOND)));
    const asked = succeeded(
      applyAgendaCommand(first.ledger, raiseCommand(AGENT, { kind: 'info', ask: undefined }, SECOND)),
    );

    // Assert
    should(same.changed).be.false();
    should(pinged.item?.id).equal('A2');
    should(asked.item?.id).equal('A2');
  });

  it('should restate notice, ping and the agenda fields on a stable-source refresh, clearing the ones left out', () => {
    // Arrange
    const stable = { source: 'task' as const, sourceRef: 'ref-1' };
    const first = raised(
      DAEMON,
      notice({
        ...stable,
        ping: true,
        blockingNow: true,
        willBlock: 'the deploy',
        neededBy: '2026-08-01T09:00:00.000Z',
      }),
    );

    // Act
    const same = succeeded(
      applyAgendaCommand(
        first.ledger,
        raiseCommand(
          DAEMON,
          notice({
            ...stable,
            ping: true,
            blockingNow: true,
            willBlock: 'the deploy',
            neededBy: '2026-08-01T09:00:00.000Z',
          }),
          SECOND,
        ),
      ),
    );
    const restated = succeeded(
      applyAgendaCommand(
        first.ledger,
        raiseCommand(DAEMON, notice({ ...stable, subject: 'A newer subject', willBlock: 'the release' }), SECOND),
      ),
    );
    const asAsk = succeeded(
      applyAgendaCommand(first.ledger, raiseCommand(DAEMON, { ...stable, subject: 'Now an ask' }, SECOND)),
    );

    // Assert
    should(first.item).containDeep({ notice: true, ping: true, blockingNow: true, willBlock: 'the deploy' });
    should(same.changed).be.false();
    should(restated.change).equal('refreshed');
    should(restated.item).containDeep({ notice: true, willBlock: 'the release', subject: 'A newer subject' });
    should(restated.item?.ping).be.undefined();
    should(restated.item?.blockingNow).be.undefined();
    should(restated.item?.neededBy).be.undefined();
    should(asAsk.item?.notice).be.undefined();
  });
});

describe('Agenda state machine: a card is a living summary', () => {
  const born = (overrides: Partial<RaiseAgendaRequest> = {}) => raised(AGENT, overrides);
  const editing = (
    ledger: AgendaLedger,
    patch: Extract<AgendaCommand, { action: 'edit' }>['patch'],
    at = SECOND,
    actor: AgendaActor = AGENT,
  ): AgendaMutation => applyAgendaCommand(ledger, { action: 'edit', actor, id: 'A1', patch, at });

  it('should record one revision naming the fields that changed and what they said before', () => {
    // Arrange
    const created = born({ premise: 'We run two relays', decided: 'Use SQLite' });

    // Act
    const edited = succeeded(
      editing(created.ledger, {
        decided: 'Use SQLite\nKeep the relays',
        stillOpen: 'Which region first?',
        premise: 'We run two relays',
      }),
    );

    // Assert
    should(edited.item?.revisions).deepEqual([
      {
        at: SECOND,
        by: 'agent',
        changed: ['decided', 'stillOpen'],
        previous: { decided: 'Use SQLite' },
      },
    ]);
    should(edited.item?.stillOpen).equal('Which region first?');
  });

  it('should name the actor kind that edited, and keep the revisions oldest first', () => {
    // Arrange
    const created = born();
    const first = succeeded(editing(created.ledger, { stillOpen: 'Which region?' }));

    // Act
    const second = succeeded(editing(first.ledger, { stillOpen: 'Which size?' }, THIRD, HUMAN));

    // Assert
    should(second.item?.revisions?.map(revision => revision.by)).deepEqual(['agent', 'human']);
    should(second.item?.revisions?.[1]?.previous).deepEqual({ stillOpen: 'Which region?' });
  });

  it('should add no revision and change nothing when an edit says what the card already says', () => {
    // Arrange
    const created = born({ premise: 'We run two relays' });

    // Act
    const same = succeeded(editing(created.ledger, { premise: 'We run two relays' }));
    const reworded = succeeded(editing(created.ledger, { context: 'Fresh context' }));
    const again = succeeded(editing(reworded.ledger, { context: 'Fresh context' }, THIRD));

    // Assert
    should(same.changed).be.false();
    should(reworded.item?.revisions).have.length(1);
    should(again.changed).be.false();
    should(again.ledger).deepEqual(reworded.ledger);
  });

  it('should keep only the newest revisions, oldest dropped', () => {
    // Arrange
    let ledger = born().ledger;

    // Act
    for (let index = 1; index <= MAX_AGENDA_REVISIONS + 3; index += 1) {
      ledger = succeeded(editing(ledger, { stillOpen: `Point ${index}` })).ledger;
    }

    // Assert
    const revisions = activeEntry(ledger).item.revisions ?? [];
    should(revisions).have.length(MAX_AGENDA_REVISIONS);
    should(revisions[0]?.previous).deepEqual({ stillOpen: 'Point 3' });
    should(revisions.at(-1)?.previous).deepEqual({ stillOpen: `Point ${MAX_AGENDA_REVISIONS + 2}` });
  });

  it('should not surface the item or give it a wait when it is edited on the owner’s turn', () => {
    // Arrange
    const created = born();

    // Act
    const edited = succeeded(editing(created.ledger, { stillOpen: 'Which region?', decided: 'Use SQLite' }));

    // Assert
    should(edited.change).equal('refreshed');
    should(edited.item?.waitingOn).be.undefined();
    should(edited.item?.askedAt).be.undefined();
    should(edited.item?.history).be.undefined();
  });

  it('should carry the still-open points onto a raised item and keep them in the same-request comparison', () => {
    // Arrange
    const created = born({ stillOpen: 'Which region?' });

    // Act
    const again = succeeded(applyAgendaCommand(created.ledger, raiseCommand(AGENT, { stillOpen: 'Which region?' })));
    const different = succeeded(applyAgendaCommand(created.ledger, raiseCommand(AGENT, { stillOpen: 'Which size?' })));

    // Assert
    should(created.item?.stillOpen).equal('Which region?');
    should(again.changed).be.false();
    should(different.item?.id).not.equal('A1');
  });

  it('should still settle the wait of an item that waits on information when the ferret edits it', () => {
    // Arrange
    const asked = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'needs-info', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act
    const edited = succeeded(editing(asked.ledger, { stillOpen: 'Which branch?' }, THIRD));

    // Assert
    should(edited.change).equal('info-added');
    should(edited.item?.waitingOn).be.undefined();
    should(edited.item?.revisions).have.length(1);
  });
});

describe('an item that confirms a held configuration change', () => {
  const CONFIRMS = {
    path: 'warden.yaml',
    etag: 'a'.repeat(64),
    changes: ['the Warden may now spend on Jev decisions'],
  };
  const NEWER = { path: 'warden.yaml', etag: 'b'.repeat(64), changes: ['the Jev price the cap counts with goes down'] };
  const CHOICE: AgendaAsk = {
    kind: 'multiple-choice',
    options: [{ label: 'Allow' }, { label: 'Deny' }, { label: 'Discard change' }],
  };
  const confirming = (): Extract<AgendaMutation, { ok: true }> =>
    raised(AGENT, { ask: CHOICE, confirms: CONFIRMS, premise: '- before' });
  const restate = (
    ledger: AgendaLedger,
    actor: AgendaActor = { kind: 'daemon', cause: 'system' },
    confirms = NEWER,
    premise = '- after',
    id: AgendaId = 'A1',
  ): AgendaMutation =>
    applyAgendaCommand(ledger, { action: 'restate-confirms', actor, id, confirms, premise, at: SECOND });
  const allow: AgendaResponse = { kind: 'multiple-choice', choice: 'Allow' };

  it('should keep the confirmation the raise recorded', () => {
    // Arrange / Act
    const created = confirming();

    // Assert
    should(created.item?.confirms).deepEqual(CONFIRMS);
  });

  it('should refuse an answer from the ferret, and from the daemon, but take the owner’s', () => {
    // Arrange
    const { ledger } = confirming();
    const answer = (actor: AgendaActor): AgendaMutation =>
      applyAgendaCommand(ledger, { action: 'answer', actor, id: 'A1', response: allow, at: SECOND });

    // Act / Assert
    should(failed(answer(AGENT)).error).deepEqual({
      code: 'forbidden',
      message: 'only the owner answers A1: it decides a change to warden.yaml; close it with dismiss instead',
    });
    should(failed(answer({ kind: 'daemon', cause: 'system' })).error.code).equal('forbidden');
    should(succeeded(answer(HUMAN)).change).equal('answered');
  });

  it('should still let the raising ferret resolve or dismiss it without an answer', () => {
    // Arrange
    const { ledger } = confirming();

    // Act / Assert
    should(
      succeeded(
        applyAgendaCommand(ledger, { action: 'resolve', actor: AGENT, id: 'A1', note: 'Settled in chat.', at: SECOND }),
      ).change,
    ).equal('resolved');
    should(
      succeeded(applyAgendaCommand(ledger, { action: 'dismiss', actor: AGENT, id: 'A1', at: SECOND })).change,
    ).equal('dismissed');
  });

  it('should restate it with the new change, marked restated, its premise kept as a daemon revision', () => {
    // Arrange
    const { ledger } = confirming();

    // Act
    const result = succeeded(restate(ledger));

    // Assert
    should(result.change).equal('refreshed');
    should(result.item?.confirms).deepEqual({ ...NEWER, restated: true });
    should(result.item?.premise).equal('- after');
    should(result.item?.revisions).deepEqual([
      { at: SECOND, by: 'daemon', changed: ['premise'], previous: { premise: '- before' } },
    ]);
  });

  it('should hand a restated item back to the owner when it waited on the ferret', () => {
    // Arrange
    const { ledger } = confirming();
    const waiting = succeeded(applyAgendaCommand(ledger, { action: 'discuss', actor: HUMAN, id: 'A1', at: SECOND }));

    // Act
    const result = succeeded(restate(waiting.ledger));

    // Assert
    should(result.item?.waitingOn).be.undefined();
    should(result.item?.askedAt).be.undefined();
  });

  it('should add no revision when only the digest moved, and be no change when nothing did', () => {
    // Arrange
    const { ledger } = confirming();

    // Act
    const sameWords = succeeded(restate(ledger, undefined, NEWER, '- before'));
    const again = succeeded(restate(sameWords.ledger, undefined, NEWER, '- before'));

    // Assert
    should(sameWords.item?.revisions).be.undefined();
    should(sameWords.item?.confirms?.etag).equal(NEWER.etag);
    should(again.change).equal('unchanged');
  });

  it('should record no previous premise for an item that had none', () => {
    // Arrange: an item from before a ferret had to give a premise — only the daemon raises one without it now
    const { premise: _premise, ...bare } = request({ ask: CHOICE, confirms: CONFIRMS });
    const ledger = succeeded(
      applyAgendaCommandToSession(null, SESSION_ID, { action: 'raise', actor: DAEMON, request: bare, at: FIRST }),
    ).ledger;

    // Act
    const result = succeeded(restate(ledger));

    // Assert
    should(result.item?.revisions?.[0]?.previous).deepEqual({});
  });

  it('should refuse a restatement from anyone but the daemon, of an unknown item, or of another file', () => {
    // Arrange
    const { ledger } = confirming();
    const plain = raised(AGENT).ledger;

    // Act / Assert
    should(failed(restate(ledger, HUMAN)).error.code).equal('forbidden');
    should(failed(restate(ledger, AGENT)).error.code).equal('forbidden');
    should(failed(restate(ledger, undefined, NEWER, '- after', 'A9')).error.code).equal('not-found');
    should(failed(restate(ledger, undefined, { ...NEWER, path: 'pack.yaml' })).error).deepEqual({
      code: 'invalid',
      message: 'A1 does not confirm a change to pack.yaml',
    });
    should(failed(restate(plain)).error.code).equal('invalid');
  });

  it('should read a stored confirmation back from the ledger', () => {
    // Arrange
    const { ledger } = confirming();

    // Act
    const parsed = parseAgendaLedger(JSON.parse(JSON.stringify(ledger)), SESSION_ID);

    // Assert
    should(parsed?.entries[0]?.item.confirms).deepEqual(CONFIRMS);
  });
});

describe('Agenda state machine board cards', () => {
  it('should keep the card an item was raised against, exactly as sent', () => {
    // Arrange
    const task = { id: 'F412' };
    const remote = { machineId: 'mac', id: 'B7' };

    // Act
    const local = raised(AGENT, { task });
    const elsewhere = raised(AGENT, { task: remote });

    // Assert
    should(local.item?.task).deepEqual(task);
    should(elsewhere.item?.task).deepEqual(remote);
    should(AgendaItemSchema.parse(local.item).task).deepEqual(task);
  });

  it('should raise an item that names no card without one', () => {
    // Act
    const created = raised();

    // Assert
    should(created.item?.task).be.undefined();
  });
});

describe('Agenda state machine: option details', () => {
  const choices = (overrides: Partial<RaiseAgendaRequest> = {}) =>
    raised(AGENT, {
      ask: { kind: 'multiple-choice', options: [{ label: 'Go' }, { label: 'Wait' }] },
      optionDetails: [{ label: 'Go', detail: 'Ship it **now**, see `plan.md`.' }],
      ...overrides,
    });
  const editing = (ledger: AgendaLedger, patch: EditAgendaPatch): AgendaMutation =>
    applyAgendaCommand(ledger, { action: 'edit', actor: AGENT, id: 'A1', patch, at: SECOND });

  it('should carry the details onto the raised item', () => {
    // Arrange / Act
    const created = choices();

    // Assert
    should(created.item?.optionDetails).deepEqual([{ label: 'Go', detail: 'Ship it **now**, see `plan.md`.' }]);
  });

  it('should refuse details that name no option', () => {
    // Arrange / Act
    const refused = failed(
      applyAgendaCommandToSession(
        null,
        SESSION_ID,
        raiseCommand(AGENT, {
          ask: { kind: 'multiple-choice', options: [{ label: 'Go' }, { label: 'Wait' }] },
          optionDetails: [{ label: 'Stop', detail: 'x' }],
        }),
      ),
    );

    // Assert
    should(refused.error.code).equal('invalid');
    should(refused.error.message).containEql('"Stop"');
  });

  it('should revise the details, remember the earlier ones, and refuse a label that is not an option', () => {
    // Arrange
    const created = choices();

    // Act
    const edited = succeeded(editing(created.ledger, { optionDetails: [{ label: 'Wait', detail: 'Cheaper.' }] }));
    const refused = failed(editing(created.ledger, { optionDetails: [{ label: 'Nope', detail: 'x' }] }));
    const same = succeeded(editing(created.ledger, { optionDetails: created.item?.optionDetails ?? [] }));

    // Assert
    should(edited.item?.optionDetails).deepEqual([{ label: 'Wait', detail: 'Cheaper.' }]);
    should(edited.item?.revisions?.[0]).containDeep({
      changed: ['optionDetails'],
      previous: { optionDetails: [{ label: 'Go', detail: 'Ship it **now**, see `plan.md`.' }] },
    });
    should(refused.error.code).equal('invalid');
    should(same.changed).be.false();
  });

  it('should replace the details on a stable-source refresh and clear them when the refresh leaves them out', () => {
    // Arrange
    const stable: Partial<RaiseAgendaRequest> = {
      source: 'task',
      sourceRef: 'F12',
      ask: undefined,
      questions: [{ question: 'When?', options: [{ label: 'Go' }, { label: 'Wait' }] }],
    };
    const first = raised(DAEMON, { ...stable, optionDetails: [{ label: 'Go', detail: 'Now.' }] });

    // Act
    const same = succeeded(
      applyAgendaCommand(
        first.ledger,
        raiseCommand(DAEMON, { ...stable, optionDetails: [{ label: 'Go', detail: 'Now.' }] }, SECOND),
      ),
    );
    const replaced = succeeded(
      applyAgendaCommand(
        first.ledger,
        raiseCommand(DAEMON, { ...stable, optionDetails: [{ label: 'Wait', detail: 'Later.' }] }, SECOND),
      ),
    );
    const cleared = succeeded(applyAgendaCommand(replaced.ledger, raiseCommand(DAEMON, stable, THIRD)));

    // Assert
    should(same.changed).be.false();
    should(replaced.item?.optionDetails).deepEqual([{ label: 'Wait', detail: 'Later.' }]);
    should(cleared.item?.optionDetails).be.undefined();
  });
});

describe('Agenda state machine — an input card never keeps free text from the owner', () => {
  const INPUT_DAEMON: AgendaActor = { kind: 'daemon', cause: 'input-request' };
  const inputCard = () => {
    const { ask: _ask, ...plain } = request();
    return succeeded(
      applyAgendaCommandToSession(null, SESSION_ID, {
        action: 'raise',
        actor: INPUT_DAEMON,
        request: {
          ...plain,
          source: 'question',
          sourceRef: 'a'.repeat(32),
          kind: 'input',
          title: 'Needs a secret',
          input: { requestId: 'a'.repeat(32) },
        } as RaiseAgendaRequest,
        at: FIRST,
      }),
    );
  };

  for (const action of ['resolve', 'dismiss'] as const) {
    it(`should drop the note a human sends with ${action}, since the composer may hold a password`, () => {
      // Arrange
      const created = inputCard();

      // Act
      const closed = succeeded(
        applyAgendaCommand(created.ledger, { action, actor: HUMAN, id: 'A1', note: 'hunter2-PASSWORD', at: SECOND }),
      );

      // Assert
      should(JSON.stringify(closed.ledger)).not.containEql('hunter2-PASSWORD');
      should(closed.snapshot.resolved[0]?.resolutionNote ?? null).be.null();
    });
  }

  it('should keep the daemon’s own status words on the card', () => {
    // Arrange
    const created = inputCard();

    // Act
    const closed = succeeded(
      applyAgendaCommand(created.ledger, {
        action: 'resolve',
        actor: INPUT_DAEMON,
        id: 'A1',
        note: 'The owner typed the value.',
        at: SECOND,
      }),
    );

    // Assert
    should(closed.snapshot.resolved[0]?.resolutionNote).equal('The owner typed the value.');
  });

  it('should still keep a human’s note on an ordinary card', () => {
    // Arrange
    const created = raised();

    // Act
    const closed = succeeded(
      applyAgendaCommand(created.ledger, {
        action: 'resolve',
        actor: HUMAN,
        id: 'A1',
        note: 'Done by hand.',
        at: SECOND,
      }),
    );

    // Assert
    should(closed.snapshot.resolved[0]?.resolutionNote).equal('Done by hand.');
  });
});

describe('Agenda state machine: snooze, unsnooze and wake', () => {
  const SYSTEM: AgendaActor = { kind: 'daemon', cause: 'system' };
  const apply = (ledger: AgendaLedger, command: Record<string, unknown>) =>
    applyAgendaCommand(ledger, command as unknown as AgendaCommand);
  const snoozed = (overrides: Partial<RaiseAgendaRequest> = {}, until = LATER) =>
    succeeded(apply(raised(AGENT, overrides).ledger, { action: 'snooze', actor: HUMAN, id: 'A1', until, at: SECOND }));

  it('should park an open item as snoozed until a time, keeping it open', () => {
    // Act
    const result = snoozed();

    // Assert
    should(result.change).equal('parked');
    should(result.changed).be.true();
    should(result.item?.parked).deepEqual({ reason: 'snoozed', at: SECOND, until: LATER });
    should(agendaSnapshot(result.ledger).items.map(item => item.id)).deepEqual(['A1']);
    should(result.ledger.updatedAt).equal(SECOND);
  });

  it('should snooze an item that is in discussion, leaving its wait as it was', () => {
    // Arrange
    const discussing = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'discuss', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act
    const result = succeeded(
      apply(discussing.ledger, { action: 'snooze', actor: HUMAN, id: 'A1', until: LATER, at: THIRD }),
    );

    // Assert
    should(result.item).containDeep({ waitingFor: 'discussion', parked: { reason: 'snoozed' } });
  });

  it('should be the owner’s alone to snooze', () => {
    // Arrange
    const created = raised();

    // Act + Assert
    for (const actor of [AGENT, OTHER_AGENT, DAEMON, WARDEN, SYSTEM]) {
      should(
        failed(apply(created.ledger, { action: 'snooze', actor, id: 'A1', until: LATER, at: SECOND })).error.code,
      ).equal('forbidden');
    }
  });

  it('should refuse to snooze a missing item, a closed one and a notice', () => {
    // Arrange
    const created = raised();
    const closed = succeeded(
      applyAgendaCommand(created.ledger, {
        action: 'resolve',
        actor: AGENT,
        id: 'A1',
        note: 'Settled in chat.',
        at: SECOND,
      }),
    );
    const notice = raised(AGENT, { notice: true, kind: 'info', ask: undefined });

    // Act + Assert
    const snooze = (ledger: AgendaLedger, id: string) =>
      apply(ledger, { action: 'snooze', actor: HUMAN, id, until: LATER, at: SECOND });
    should(failed(snooze(created.ledger, 'A9')).error.code).equal('not-found');
    should(failed(snooze(closed.ledger, 'A1')).error.code).equal('not-found');
    should(failed(snooze(notice.ledger, 'A1')).error.code).equal('invalid');
  });

  it('should refuse a time that is not after now', () => {
    // Arrange
    const created = raised();

    // Act + Assert
    for (const until of [SECOND, FIRST]) {
      should(
        failed(apply(created.ledger, { action: 'snooze', actor: HUMAN, id: 'A1', until, at: SECOND })).error.code,
      ).equal('invalid');
    }
  });

  it('should unsnooze a snoozed item and a replied one, with no other change to the item', () => {
    // Arrange
    const asleep = snoozed();
    const replied = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'reply', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act
    const woken = succeeded(apply(asleep.ledger, { action: 'unsnooze', actor: HUMAN, id: 'A1', at: THIRD }));
    const back = succeeded(apply(replied.ledger, { action: 'unsnooze', actor: HUMAN, id: 'A1', at: THIRD }));

    // Assert
    should(woken.change).equal('unparked');
    should(woken.item?.parked).be.undefined();
    should(woken.item?.waitingSince).equal(FIRST);
    should(back.change).equal('unparked');
    should(back.item?.parked).be.undefined();
    should(back.item?.history?.map(entry => entry.kind)).deepEqual(['replied']);
  });

  it('should leave an item that is not parked as it is when unsnoozed', () => {
    // Act
    const result = succeeded(apply(raised().ledger, { action: 'unsnooze', actor: HUMAN, id: 'A1', at: THIRD }));

    // Assert
    should(result.change).equal('unchanged');
    should(result.changed).be.false();
  });

  it('should refuse to unsnooze for anyone but the owner, and for a missing item', () => {
    // Arrange
    const asleep = snoozed();

    // Act + Assert
    for (const actor of [AGENT, DAEMON, SYSTEM]) {
      should(failed(apply(asleep.ledger, { action: 'unsnooze', actor, id: 'A1', at: THIRD })).error.code).equal(
        'forbidden',
      );
    }
    should(failed(apply(asleep.ledger, { action: 'unsnooze', actor: HUMAN, id: 'A9', at: THIRD })).error.code).equal(
      'not-found',
    );
  });

  it('should wake a snoozed item once its time has come, fresh and unread', () => {
    // Arrange
    const asleep = snoozed();

    // Act
    const woke = succeeded(apply(asleep.ledger, { action: 'wake', actor: SYSTEM, id: 'A1', at: LATER }));

    // Assert
    should(woke.change).equal('woke');
    should(woke.item?.parked).be.undefined();
    should(woke.item?.waitingSince).equal(LATER);
    should(woke.item?.urgentAt).be.undefined();
  });

  it('should wake at the deadline when it is sooner than the snooze', () => {
    // Arrange
    const asleep = snoozed({ neededBy: THIRD });

    // Act
    const early = succeeded(apply(asleep.ledger, { action: 'wake', actor: SYSTEM, id: 'A1', at: SECOND }));
    const due = succeeded(apply(asleep.ledger, { action: 'wake', actor: SYSTEM, id: 'A1', at: THIRD }));

    // Assert
    should(early.change).equal('unchanged');
    should(due.change).equal('woke');
    should(due.item?.waitingSince).equal(THIRD);
  });

  it('should not wake an item early, one that is not snoozed, one that is replied to or one that is missing', () => {
    // Arrange
    const asleep = snoozed();
    const replied = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'reply', actor: HUMAN, id: 'A1', at: SECOND }),
    );
    const wake = (ledger: AgendaLedger, id: string, at: string) =>
      succeeded(apply(ledger, { action: 'wake', actor: SYSTEM, id, at }));

    // Act + Assert
    should(wake(asleep.ledger, 'A1', THIRD).change).equal('unchanged');
    should(wake(raised().ledger, 'A1', LATER).change).equal('unchanged');
    should(wake(replied.ledger, 'A1', LATER).change).equal('unchanged');
    should(wake(asleep.ledger, 'A9', LATER).change).equal('unchanged');
  });

  it('should wake only for the daemon’s own timer', () => {
    // Arrange
    const asleep = snoozed();

    // Act + Assert
    for (const actor of [HUMAN, AGENT, DAEMON, WARDEN]) {
      should(failed(apply(asleep.ledger, { action: 'wake', actor, id: 'A1', at: LATER })).error.code).equal(
        'forbidden',
      );
    }
  });
});

describe('Agenda state machine: a ferret’s edit or surface of a parked item', () => {
  const apply = (ledger: AgendaLedger, command: Record<string, unknown>) =>
    applyAgendaCommand(ledger, command as unknown as AgendaCommand);
  const asleep = (overrides: Partial<RaiseAgendaRequest> = {}) =>
    succeeded(
      apply(raised(AGENT, overrides).ledger, { action: 'snooze', actor: HUMAN, id: 'A1', until: LATER, at: SECOND }),
    );
  const editing = (
    ledger: AgendaLedger,
    patch: EditAgendaPatch,
    at = THIRD,
    extra: Record<string, unknown> = {},
    actor: AgendaActor = AGENT,
  ) => apply(ledger, { action: 'edit', actor, id: 'A1', patch, at, ...extra });
  const surfacing = (
    ledger: AgendaLedger,
    at = THIRD,
    extra: Record<string, unknown> = {},
    actor: AgendaActor = AGENT,
  ) => apply(ledger, { action: 'surface', actor, id: 'A1', at, ...extra });

  it('should apply an edit to a snoozed item without waking it', () => {
    // Act
    const result = succeeded(editing(asleep().ledger, { stillOpen: 'Which region?' }));

    // Assert
    should(result.item?.stillOpen).equal('Which region?');
    should(result.item?.parked).deepEqual({ reason: 'snoozed', at: SECOND, until: LATER });
    should(result.item?.waitingSince).equal(FIRST);
    should(result.item?.urgentAt).be.undefined();
  });

  it('should leave a snoozed item asleep when the ferret surfaces it without now', () => {
    // Act
    const result = succeeded(surfacing(asleep().ledger));

    // Assert
    should(result.change).equal('unchanged');
    should(agendaSnapshot(result.ledger).items[0]?.parked?.reason).equal('snoozed');
  });

  it('should wake a snoozed item on a surface with now, as urgent and fresh', () => {
    // Act
    const result = succeeded(surfacing(asleep().ledger, THIRD, { now: true, why: 'Deploy window closes' }));

    // Assert
    should(result.change).equal('unparked');
    should(result.item?.parked).be.undefined();
    should(result.item?.urgentAt).equal(THIRD);
    should(result.item?.waitingSince).equal(THIRD);
    should(result.item?.history).deepEqual([{ at: THIRD, kind: 'surfaced', note: 'Deploy window closes' }]);
  });

  it('should note no words when a surface with now gives none', () => {
    // Act
    const result = succeeded(surfacing(asleep().ledger, THIRD, { now: true }));

    // Assert
    should(result.item?.history).deepEqual([{ at: THIRD, kind: 'surfaced' }]);
  });

  it('should wake a snoozed item on an edit with now, then apply the edit', () => {
    // Act
    const result = succeeded(editing(asleep().ledger, { stillOpen: 'Which region?' }, THIRD, { now: true }));

    // Assert
    should(result.item?.parked).be.undefined();
    should(result.item?.urgentAt).equal(THIRD);
    should(result.item?.waitingSince).equal(THIRD);
    should(result.item?.stillOpen).equal('Which region?');
  });

  it('should still wake a snoozed item when the edit with now changes nothing', () => {
    // Act
    const result = succeeded(editing(asleep().ledger, { subject: 'Approve the deployment?' }, THIRD, { now: true }));

    // Assert
    should(result.change).equal('unparked');
    should(result.item?.parked).be.undefined();
    should(result.item?.urgentAt).equal(THIRD);
  });

  it('should take a snoozed item out of discussion when it is surfaced with now', () => {
    // Arrange
    const discussing = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'discuss', actor: HUMAN, id: 'A1', at: SECOND }),
    );
    const sleeping = succeeded(
      apply(discussing.ledger, { action: 'snooze', actor: HUMAN, id: 'A1', until: LATER, at: SECOND }),
    );

    // Act
    const result = succeeded(surfacing(sleeping.ledger, THIRD, { now: true }));

    // Assert
    should(result.item?.parked).be.undefined();
    should(result.item?.waitingOn).be.undefined();
    should(result.item?.waitingFor).be.undefined();
    should(result.item?.askedAt).be.undefined();
  });

  it('should keep a snoozed item that waits on more information waiting when it is woken as urgent', () => {
    // Arrange
    const asked = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'needs-info', actor: HUMAN, id: 'A1', at: SECOND }),
    );
    const sleeping = succeeded(
      apply(asked.ledger, { action: 'snooze', actor: HUMAN, id: 'A1', until: LATER, at: SECOND }),
    );

    // Act
    const result = succeeded(surfacing(sleeping.ledger, THIRD, { now: true }));

    // Assert
    should(result.item?.parked).be.undefined();
    should(result.item?.waitingOn).equal('ferret');
  });

  it('should refuse a second urgent wake within an hour and allow it after', () => {
    // Arrange
    const woken = succeeded(surfacing(asleep().ledger, THIRD, { now: true }));
    const again = succeeded(
      apply(woken.ledger, { action: 'snooze', actor: HUMAN, id: 'A1', until: LATER, at: '2026-07-30T12:10:00Z' }),
    );
    const soon = new Date(Date.parse(THIRD) + AGENDA_URGENT_WAKE_MS - 1).toISOString();
    const later = new Date(Date.parse(THIRD) + AGENDA_URGENT_WAKE_MS).toISOString();

    // Act
    const tooSoonSurface = failed(surfacing(again.ledger, soon, { now: true }));
    const tooSoonEdit = failed(editing(again.ledger, { stillOpen: 'Again?' }, soon, { now: true }));
    const allowed = succeeded(surfacing(again.ledger, later, { now: true }));

    // Assert
    should(tooSoonSurface.error.code).equal('rate-limited');
    should(tooSoonEdit.error.code).equal('rate-limited');
    should(allowed.item?.urgentAt).equal(later);
    should(allowed.item?.parked).be.undefined();
  });

  it('should never unpark a parked item for the owner, the daemon or another ferret', () => {
    // Arrange
    const sleeping = asleep();
    const replied = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'reply', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act + Assert
    for (const actor of [HUMAN, { kind: 'daemon', cause: 'system' } as AgendaActor]) {
      should(succeeded(surfacing(sleeping.ledger, THIRD, { now: true }, actor)).changed).be.false();
      should(succeeded(surfacing(replied.ledger, THIRD, {}, actor)).changed).be.false();
    }
    const humanEdit = succeeded(editing(sleeping.ledger, { stillOpen: 'x' }, THIRD, { now: true }, HUMAN));
    should(agendaSnapshot(humanEdit.ledger).items[0]?.parked?.reason).equal('snoozed');
    const humanEditReplied = succeeded(editing(replied.ledger, { stillOpen: 'x' }, THIRD, {}, HUMAN));
    should(agendaSnapshot(humanEditReplied.ledger).items[0]?.parked?.reason).equal('replied');
    should(failed(surfacing(sleeping.ledger, THIRD, { now: true }, OTHER_AGENT)).error.code).equal('forbidden');
    should(failed(editing(sleeping.ledger, { stillOpen: 'x' }, THIRD, { now: true }, OTHER_AGENT)).error.code).equal(
      'forbidden',
    );
  });

  it('should surface a parked item for its Warden by the Warden’s own item only', () => {
    // Arrange
    const created = raised(WARDEN, { sourceRef: null });
    const parked = succeeded(
      apply(created.ledger, { action: 'snooze', actor: HUMAN, id: 'A1', until: LATER, at: SECOND }),
    );

    // Act
    const result = succeeded(surfacing(parked.ledger, THIRD, { now: true }, WARDEN));

    // Assert
    should(result.item?.parked).be.undefined();
  });
});

describe('Agenda ledger migration: the replies earlier daemons left open or closed', () => {
  const template = (id: AgendaId, origin: 'agent' | 'human') => {
    const entry = activeEntry(raised(origin === 'agent' ? AGENT : HUMAN).ledger);
    return { origin: entry.origin, item: { ...entry.item, id, subject: `Item ${id}` } };
  };
  const open = (id: AgendaId, origin: 'agent' | 'human' = 'human'): AgendaEntry => ({
    lifecycle: 'active',
    ...template(id, origin),
  });
  const closedReply = (id: AgendaId, resolvedAt: string, origin: 'agent' | 'human' = 'human'): AgendaEntry => {
    const { origin: entryOrigin, item } = template(id, origin);
    return {
      lifecycle: 'addressed',
      origin: entryOrigin,
      item: {
        ...item,
        resolvedAt,
        resolutionNote: 'Use eu-west-1',
        disposition: 'replied',
        resolvedBy: 'human',
        resolvedBySession: null,
        resolvedByName: null,
        history: [{ at: resolvedAt, kind: 'replied', note: 'Use eu-west-1' }],
      },
    } as AgendaEntry;
  };
  const board = (entries: AgendaEntry[]): AgendaLedger => ({
    sessionId: SESSION_ID,
    nextId: 100,
    entries,
    updatedAt: THIRD,
  });
  const parse = (ledger: AgendaLedger) =>
    parseAgendaLedger(JSON.parse(JSON.stringify(ledger)), SESSION_ID) as AgendaLedger;
  const ids = (entries: readonly AgendaEntry[]) => entries.map(entry => entry.item.id);

  it('should reopen an item closed as replied, parked as replied at its close, with its history kept', () => {
    // Act
    const parsed = parse(board([closedReply('A1', SECOND)]));

    // Assert
    const snapshot = agendaSnapshot(parsed);
    should(snapshot.resolved).have.length(0);
    should(snapshot.items).have.length(1);
    should(snapshot.items[0]).containDeep({ id: 'A1', parked: { reason: 'replied', at: SECOND } });
    should(snapshot.items[0]?.history).deepEqual([{ at: SECOND, kind: 'replied', note: 'Use eu-west-1' }]);
    should(snapshot.items[0]).not.have.property('resolvedAt');
    should(snapshot.items[0]).not.have.property('disposition');
  });

  it('should leave items closed any other way closed', () => {
    // Arrange
    const done = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'resolve', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act
    const parsed = parse(done.ledger);

    // Assert
    should(agendaSnapshot(parsed).items).have.length(0);
    should(agendaSnapshot(parsed).resolved.map(item => item.id)).deepEqual(['A1']);
  });

  it('should reopen the newest first and only while the board has room', () => {
    // Arrange
    const filled = Array.from({ length: MAX_AGENDA_PER_SESSION - 1 }, (_, index) => open(`A${index + 1}` as AgendaId));
    const entries = [...filled, closedReply('A20', FIRST), closedReply('A22', THIRD), closedReply('A21', SECOND)];

    // Act
    const parsed = parse(board(entries));

    // Assert
    should(ids(parsed.entries.filter(isActiveAgenda))).containEql('A22');
    should(parsed.entries.filter(isActiveAgenda)).have.length(MAX_AGENDA_PER_SESSION);
    should(ids(parsed.entries.filter(entry => entry.lifecycle === 'addressed')))
      .containDeep(['A20', 'A21'])
      .and.have.length(2);
  });

  it('should keep a closed reply of a ferret closed once the agent cap is reached, but reopen a person’s', () => {
    // Arrange
    const agents = Array.from({ length: MAX_AGENT_AGENDA_PER_SESSION }, (_, index) =>
      open(`A${index + 1}` as AgendaId, 'agent'),
    );
    const entries = [...agents, closedReply('A30', THIRD, 'agent'), closedReply('A31', SECOND, 'human')];

    // Act
    const parsed = parse(board(entries));

    // Assert
    should(ids(parsed.entries.filter(entry => entry.lifecycle === 'addressed'))).deepEqual(['A30']);
    should(ids(parsed.entries.filter(isActiveAgenda))).containEql('A31');
  });

  it('should count a reopened ferret item towards the agent cap', () => {
    // Arrange
    const agents = Array.from({ length: MAX_AGENT_AGENDA_PER_SESSION - 1 }, (_, index) =>
      open(`A${index + 1}` as AgendaId, 'agent'),
    );
    const entries = [...agents, closedReply('A30', THIRD, 'agent'), closedReply('A31', SECOND, 'agent')];

    // Act
    const parsed = parse(board(entries));

    // Assert
    should(ids(parsed.entries.filter(entry => entry.lifecycle === 'addressed'))).deepEqual(['A31']);
    should(ids(parsed.entries.filter(isActiveAgenda))).containEql('A30');
  });

  it('should park a reply left on the ferret’s turn and reopen a closed one in the same read', () => {
    // Arrange
    const stranded = open('A1', 'agent');
    if (stranded.lifecycle !== 'active') throw new Error('expected an open entry');
    const left: AgendaEntry = {
      ...stranded,
      item: { ...stranded.item, waitingOn: 'ferret', askedAt: SECOND, waitingFor: 'discussion' },
    };

    // Act
    const parsed = parse(board([left, closedReply('A2', THIRD)]));

    // Assert
    const items = agendaSnapshot(parsed).items;
    should(items.map(item => [item.id, item.parked])).deepEqual([
      ['A1', { reason: 'replied', at: SECOND }],
      ['A2', { reason: 'replied', at: THIRD }],
    ]);
  });

  it('should be idempotent, and return a board with nothing to move as it came', () => {
    // Arrange
    const once = parse(board([closedReply('A1', SECOND), open('A2')]));
    const plain = board([open('A1')]);

    // Act + Assert
    should(parse(once)).deepEqual(once);
    should(parkOwnerReplies(plain)).equal(plain);
  });

  it('should leave a closed reply closed when it no longer reads as an item', () => {
    // Arrange
    const reply = closedReply('A1', SECOND);
    if (reply.lifecycle !== 'addressed') throw new Error('expected a closed entry');
    const broken: AgendaEntry = { ...reply, item: { ...reply.item, subject: '' } };

    // Act
    const parked = parkOwnerReplies(board([broken]));

    // Assert
    should(parked.entries.map(entry => entry.lifecycle)).deepEqual(['addressed']);
  });
});

describe('Agenda state machine offer to close', () => {
  it('should store the offer on an item that names a card', () => {
    // Act
    const result = raised(AGENT, { task: { id: 'F12' }, offerClose: true });

    // Assert
    should(activeEntry(result.ledger).item).containDeep({ task: { id: 'F12' }, offerClose: true });
  });

  it('should leave the offer off an item that did not ask for it', () => {
    // Act
    const result = raised(AGENT, { task: { id: 'F12' } });

    // Assert
    should(activeEntry(result.ledger).item.offerClose).be.undefined();
  });

  it('should refuse an offer with no card to close', () => {
    // Act
    const result = failed(applyAgendaCommandToSession(null, SESSION_ID, raiseCommand(AGENT, { offerClose: true })));

    // Assert
    should(result.error).containDeep({ code: 'invalid' });
    should(result.error.message).containEql('--task');
  });

  it('should refuse an offer to close on a notice', () => {
    // Act
    const result = failed(
      applyAgendaCommandToSession(
        null,
        SESSION_ID,
        raiseCommand(AGENT, { kind: 'info', notice: true, ask: undefined, task: { id: 'F12' }, offerClose: true }),
      ),
    );

    // Assert
    should(result.error).containDeep({ code: 'invalid' });
    should(result.error.message).containEql('notice');
  });
});

describe('Agenda state machine answer shapes', () => {
  const raiseAs = (actor: AgendaActor, overrides: Partial<RaiseAgendaRequest>) =>
    applyAgendaCommandToSession(null, SESSION_ID, raiseCommand(actor, overrides));
  const several = [{ question: 'Which region?' }, { question: 'OK to restart?' }, { question: 'Your work email?' }];

  it('should refuse a ferret raise that mixes shapes, naming the shape to write instead', () => {
    // Act
    const optioned = failed(
      raiseAs(AGENT, {
        kind: 'reply',
        ask: { kind: 'open-question' },
        questions: [{ question: 'Which region?', options: [{ label: 'EU' }, { label: 'US' }] }, ...several],
      }),
    );
    const severalChoice = failed(
      raiseAs(AGENT, {
        kind: 'choice',
        ask: { kind: 'multiple-choice', options: [{ label: 'EU' }, { label: 'US' }] },
        questions: several,
      }),
    );
    const steppedPermission = failed(raiseAs(AGENT, { steps: ['Open it'] }));
    const optionedReply = failed(
      raiseAs(AGENT, { kind: 'reply', ask: { kind: 'multiple-choice', options: [{ label: 'A' }, { label: 'B' }] } }),
    );

    // Assert
    should(optioned.error).deepEqual({ code: 'invalid', message: AGENDA_SHAPE_ERRORS.severalQuestions });
    should(severalChoice.error.message).equal(AGENDA_SHAPE_ERRORS.severalQuestions);
    should(steppedPermission.error.message).equal(AGENDA_SHAPE_ERRORS.stepsOnlyTodo);
    should(optionedReply.error.message).equal(AGENDA_SHAPE_ERRORS.optionsOnlyChoice);
  });

  it('should take several plain questions as one reply, and leave the daemon its own raises', () => {
    // Act
    const reply = succeeded(raiseAs(AGENT, { kind: 'reply', ask: { kind: 'open-question' }, questions: several }));
    const daemon = succeeded(raiseAs(DAEMON, { source: 'task', sourceRef: 'F9', steps: ['Open it'] }));

    // Assert
    should(reply.item?.questions).have.length(3);
    should(daemon.item?.steps).deepEqual(['Open it']);
  });

  it('should refuse a ferret edit that gives steps to a card that is not a to-do', () => {
    // Arrange
    const permission = raised(AGENT);
    const todo = raised(AGENT, { ask: { kind: 'task' }, kind: 'task', steps: ['One'] });
    const editSteps = (ledger: AgendaLedger) =>
      applyAgendaCommand(ledger, { action: 'edit', actor: AGENT, id: 'A1', patch: { steps: ['Two'] }, at: SECOND });

    // Act
    const refused = failed(editSteps(permission.ledger));
    const edited = succeeded(editSteps(todo.ledger));

    // Assert
    should(refused.error).deepEqual({ code: 'invalid', message: AGENDA_SHAPE_ERRORS.stepsOnlyTodo });
    should(edited.item?.steps).deepEqual(['Two']);
  });

  describe('a form card', () => {
    const FIELDS: NonNullable<RaiseAgendaRequest['fields']> = [
      { id: '1', type: 'one', label: 'Which region?', options: [{ label: 'EU' }, { label: 'US' }] },
      { id: '2', type: 'yesno', label: 'OK to restart?' },
      { id: '3', type: 'text', label: 'Anything else?' },
    ];
    const form = () => raised(AGENT, { ask: { kind: 'open-question' }, kind: 'form', fields: FIELDS });
    const answer = (board: ReturnType<typeof form>, response: AgendaResponse) =>
      applyAgendaCommand(board.ledger, {
        action: 'answer',
        actor: HUMAN,
        id: 'A1',
        response,
        note: 'Ship at 6pm',
        at: SECOND,
      });

    it('should be raised with its fields, and kept on the item', () => {
      const board = form();

      should(board.snapshot.items[0]?.kind).equal('form');
      should(board.snapshot.items[0]?.fields).deepEqual(FIELDS);
    });

    it('should refuse a form raised without fields', () => {
      const refused = failed(
        applyAgendaCommandToSession(
          null,
          SESSION_ID,
          raiseCommand(AGENT, { ask: { kind: 'open-question' }, kind: 'form' }),
        ),
      );

      should(refused.error.code).equal('invalid');
    });

    it('should record the answer by field id and close the card', () => {
      const response: AgendaResponse = {
        kind: 'form',
        answers: [
          { id: '1', value: 'EU' },
          { id: '2', value: 'Yes' },
        ],
      };

      const actual = succeeded(answer(form(), response));

      should(actual.snapshot.items).have.length(0);
      should(actual.snapshot.resolved[0]).containDeep({ response, resolutionNote: 'Ship at 6pm' });
    });

    it('should refuse an answer to a field the form does not have, or a value that is not an option', () => {
      const board = form();

      for (const answers of [[{ id: '9', value: 'x' }], [{ id: '1', value: 'Asia' }]]) {
        should(failed(answer(board, { kind: 'form', answers })).error.code).equal('invalid');
      }
    });

    it('should refuse a form answer to any other kind of card', () => {
      const permission = raised();

      should(failed(answer(permission, { kind: 'form', answers: [{ id: '1', value: 'EU' }] })).error.code).equal(
        'invalid',
      );
    });
  });
});

describe('Agenda state machine: a question item is never lost to a Got it (the owner asks, the ferret answers)', () => {
  const REGION: Partial<RaiseAgendaRequest> = {
    subject: 'Which region should the deploy use?',
    kind: 'choice',
    ask: { kind: 'multiple-choice', options: [{ label: 'EU', description: 'data stays in Europe' }, { label: 'US' }] },
  };
  const replying = (ledger: AgendaLedger, at = SECOND, note = 'what is EU?') =>
    applyAgendaCommand(ledger, { action: 'reply', actor: HUMAN, id: 'A1', note, at });
  const editing = (ledger: AgendaLedger, patch: EditAgendaPatch, actor: AgendaActor = AGENT) =>
    applyAgendaCommand(ledger, { action: 'edit', actor, id: 'A1', patch, at: THIRD });
  const shapeOf = (item: AgendaItem | undefined) => ({ kind: item?.kind, ask: item?.ask, answers: item?.answers });

  it('should keep its kind, ask and answers through every owner reply: a re-reply never turns it into Got it', () => {
    // Arrange
    const created = raised(AGENT, REGION);

    // Act
    const once = succeeded(replying(created.ledger));
    const twice = succeeded(replying(once.ledger, THIRD, 'still do not follow'));

    // Assert
    should(shapeOf(once.item)).deepEqual(shapeOf(created.item));
    should(shapeOf(twice.item)).deepEqual(shapeOf(created.item));
    should(twice.item?.kind).equal('choice');
    should(twice.item?.notice).be.undefined();
  });

  it('should take the ferret’s answer to the owner’s question onto the SAME item, with the options unchanged and live again', () => {
    // Arrange
    const replied = succeeded(replying(raised(AGENT, REGION).ledger));

    // Act
    const answered = succeeded(editing(replied.ledger, { questionAnswer: 'EU keeps the data in Frankfurt.' }));

    // Assert
    should(answered.item?.questionAnswer).equal('EU keeps the data in Frankfurt.');
    should(answered.item?.parked).be.undefined();
    should(answered.item?.waitingOn).be.undefined();
    should(answered.item?.waitingSince).equal(THIRD);
    should(shapeOf(answered.item)).deepEqual(shapeOf(replied.item));
    should(agendaSnapshot(answered.ledger).items.map(item => item.id)).deepEqual(['A1']);
    should(answered.item?.revisions?.map(revision => revision.changed)).deepEqual([['questionAnswer']]);
  });

  it('should still make a refresh of the whole card the way back when no answer to a question comes with it', () => {
    // Arrange
    const replied = succeeded(replying(raised(AGENT, REGION).ledger));

    // Act
    const refused = failed(editing(replied.ledger, { stillOpen: 'Which region?' }));

    // Assert
    should(refused.error.message).containEql('missing --summary, --premise, --context');
  });

  it('should leave an owner’s answer to the original options the only thing that closes it, even while parked as replied', () => {
    // Arrange
    const replied = succeeded(replying(raised(AGENT, REGION).ledger));

    // Act
    const answered = succeeded(
      applyAgendaCommand(replied.ledger, {
        action: 'answer',
        actor: HUMAN,
        id: 'A1',
        response: { kind: 'multiple-choice', choice: 'EU' },
        at: THIRD,
      }),
    );

    // Assert
    should(answered.addressed?.response).deepEqual({ kind: 'multiple-choice', choice: 'EU' });
    should(agendaSnapshot(answered.ledger).items).have.length(0);
  });

  it('should never let Got it on an info item resolve a question item, however the two relate', () => {
    // Arrange: the question, replied to; the ferret’s answer given as a separate info item
    const asked = succeeded(replying(raised(AGENT, REGION).ledger));
    const info = succeeded(
      applyAgendaCommand(asked.ledger, {
        action: 'raise',
        actor: AGENT,
        request: request({ kind: 'info', ask: undefined, subject: 'EU means Frankfurt' }),
        at: THIRD,
      }),
    );

    // Act
    const gotIt = succeeded(applyAgendaCommand(info.ledger, { action: 'resolve', actor: HUMAN, id: 'A2', at: LATER }));

    // Assert
    const left = agendaSnapshot(gotIt.ledger).items;
    should(left.map(item => item.id)).deepEqual(['A1']);
    should(left[0]?.parked).deepEqual({ reason: 'replied', at: SECOND });
    should(left[0]?.kind).equal('choice');
  });

  it('should ask a ferret for its reason when it closes a question the owner has not answered', () => {
    // Arrange
    const created = raised(AGENT, REGION);
    const resolve = (actor: AgendaActor, note?: string) =>
      applyAgendaCommand(created.ledger, {
        action: 'resolve',
        actor,
        id: 'A1',
        ...(note === undefined ? {} : { note }),
        at: SECOND,
      });

    // Act
    const bare = failed(resolve(AGENT));
    const blank = failed(resolve(AGENT, '   '));
    const withReason = succeeded(resolve(AGENT, 'The owner answered in chat: EU'));
    const byOwner = succeeded(resolve(HUMAN));

    // Assert
    should(bare.error.code).equal('invalid');
    should(bare.error.message).containEql('--reason');
    should(bare.error.message).containEql('withdrawn');
    should(blank.error.code).equal('invalid');
    should(withReason.addressed?.resolutionNote).equal('The owner answered in chat: EU');
    should(withReason.addressed?.response).be.undefined();
    should(byOwner.addressed?.resolvedBy).equal('human');
  });

  it('should ask for the reason on every other question shape too, and let an info item or a notice close with no words', () => {
    // Arrange
    const closeBy = (overrides: Partial<RaiseAgendaRequest>) =>
      applyAgendaCommand(raised(AGENT, overrides).ledger, { action: 'resolve', actor: AGENT, id: 'A1', at: SECOND });

    // Act
    const info = succeeded(closeBy({ kind: 'info', ask: undefined }));
    const notice = succeeded(closeBy({ kind: 'info', notice: true, ask: undefined }));
    const todo = failed(closeBy({ kind: 'task', ask: { kind: 'task' } }));
    const permission = failed(closeBy({}));
    const reply = failed(closeBy({ kind: 'reply', ask: { kind: 'open-question' } }));

    // Assert
    should(info.addressed?.disposition).equal('done');
    should(notice.addressed?.disposition).equal('done');
    for (const refused of [todo, permission, reply]) should(refused.error.message).containEql('--reason');
  });
});
