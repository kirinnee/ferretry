import { describe, it } from 'bun:test';
import type { AgendaAsk, AgendaCardAnswer, AgendaId, AgendaItem, AgendaResponse } from '@ferretry/protocol';
import { AgendaItemSchema, MAX_AGENDA_PER_SESSION, MAX_AGENDA_REVISIONS } from '@ferretry/protocol';
import should from 'should';
import {
  type AgendaActor,
  type AgendaCommand,
  type AgendaEntry,
  type AgendaLedger,
  type AgendaMutation,
  applyAgendaCommand,
  applyAgendaCommandToSession,
  agendaSnapshot,
  canDismissAgenda,
  type EditAgendaPatch,
  emptyAgendaLedger,
  isActiveAgenda,
  isWardenEscalationAgenda,
  MAX_AGENT_AGENDA_PER_SESSION,
  parseAgendaLedger,
  type RaiseAgendaRequest,
} from '../../../src/lib/agenda/state-machine.ts';

const SESSION_ID = 'session-1';
const OTHER_SESSION_ID = 'session-2';
const FIRST = '2026-07-30T10:00:00Z';
const SECOND = '2026-07-30T11:00:00Z';
const THIRD = '2026-07-30T12:00:00Z';

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
      applyAgendaCommand(own.ledger, { action: 'resolve', actor: AGENT, id: 'A1', at: SECOND }),
    );
    const wrongDaemon = failed(
      applyAgendaCommand(plainOwn.ledger, { action: 'resolve', actor: AGENT, id: 'A1', at: SECOND }),
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

  it.each(['source-reconciliation', 'warden-escalation', 'system', 'harness-prompt'] as const)(
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
    const first = raised(AGENT, { steps: STEPS, body: '## Why\nBecause.' });
    const stable = raised(DAEMON, { source: 'task', sourceRef: 'F1', steps: STEPS });

    // Act
    const same = succeeded(
      applyAgendaCommand(first.ledger, raiseCommand(AGENT, { steps: STEPS, body: '## Why\nBecause.' }, SECOND)),
    );
    const other = succeeded(
      applyAgendaCommand(same.ledger, raiseCommand(AGENT, { steps: [...STEPS, 'Done'], body: undefined }, THIRD)),
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
    const created = raised(AGENT, { steps: STEPS });

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
    const created = raised(AGENT, { steps: STEPS });
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
    const created = raised(AGENT, { steps: STEPS });
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
    const created = raised(AGENT, { steps: ['One'] });
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
      applyAgendaCommand(asked.ledger, { action: 'resolve', actor: AGENT, id: 'A1', note: null, at: THIRD }),
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
      applyAgendaCommand(born().ledger, { action: 'resolve', actor: AGENT, id: 'A1', at: SECOND }),
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

  it('should close the item as replied, keeping the words in its history, and leave every open list', () => {
    // Arrange
    const created = raised();

    // Act
    const replied = succeeded(reply(created.ledger, HUMAN, SECOND, 'A1', '  Use eu-west-1  '));

    // Assert
    const snapshot = agendaSnapshot(replied.ledger);
    should(replied.change).equal('replied');
    should(replied.changed).be.true();
    should(snapshot.items).have.length(0);
    should(snapshot.count).equal(0);
    should(snapshot.resolved).have.length(1);
    should(replied.addressed).containDeep({
      disposition: 'replied',
      resolvedAt: SECOND,
      resolvedBy: 'human',
      resolutionNote: 'Use eu-west-1',
    });
    should(replied.addressed?.history).deepEqual([{ at: SECOND, kind: 'replied', note: 'Use eu-west-1' }]);
    should(replied.addressed?.waitingOn).be.undefined();
    should(replied.addressed?.infoRequests).be.undefined();
    should(replied.addressed?.response).be.undefined();
  });

  it('should close an item the ferret was asked for information on, and drop that wait', () => {
    // Arrange
    const asked = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'needs-info', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act
    const replied = succeeded(reply(asked.ledger, HUMAN, THIRD));

    // Assert
    should(replied.addressed).containDeep({ disposition: 'replied', infoRequests: 1 });
    should(replied.addressed?.waitingOn).be.undefined();
    should(replied.addressed?.waitingFor).be.undefined();
    should(replied.addressed?.askedAt).be.undefined();
    should(replied.addressed?.history?.map(entry => entry.kind)).deepEqual(['needs-info', 'replied']);
    should(agendaSnapshot(replied.ledger).items).have.length(0);
  });

  it('should keep no note when the owner sent no words', () => {
    // Act
    const blank = succeeded(reply(raised().ledger, HUMAN, SECOND, 'A1', '   '));
    const none = succeeded(reply(raised().ledger));

    // Assert
    should(blank.addressed?.resolutionNote).be.null();
    should(blank.addressed?.history).deepEqual([{ at: SECOND, kind: 'replied' }]);
    should(none.addressed?.history).deepEqual([{ at: SECOND, kind: 'replied' }]);
  });

  it('should be idempotent: a reply to an item already replied to is no change', () => {
    // Arrange
    const once = succeeded(reply(raised().ledger));

    // Act
    const again = succeeded(reply(once.ledger, HUMAN, THIRD));

    // Assert
    should(again.changed).be.false();
    should(again.change).equal('unchanged');
    should(again.ledger).deepEqual(once.ledger);
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
      applyAgendaCommand(created.ledger, { action: 'resolve', actor: AGENT, id: 'A1', at: SECOND }),
    );
    const notice = raised(AGENT, { notice: true, kind: 'info', ask: undefined });

    // Act + Assert
    should(failed(reply(created.ledger, HUMAN, SECOND, 'A9')).error.code).equal('not-found');
    should(succeeded(reply(closed.ledger)).changed).be.false();
    should(failed(reply(notice.ledger)).error.code).equal('invalid');
  });

  it('should reply to an item nobody in particular raised: the owner may close any open item', () => {
    // Act
    const replied = succeeded(reply(raised(HUMAN).ledger));

    // Assert
    should(replied.addressed?.disposition).equal('replied');
  });

  it('should close a daemon-raised Warden item the same way', () => {
    // Arrange
    const created = raised(WARDEN, { sourceRef: null });

    // Act
    const replied = succeeded(reply(created.ledger));

    // Assert
    should(replied.addressed?.disposition).equal('replied');
    should(agendaSnapshot(replied.ledger).items).have.length(0);
  });

  it('should come back on the owner’s turn when the ferret surfaces it, keeping its id and history', () => {
    // Arrange
    const replied = succeeded(reply(raised().ledger, HUMAN, SECOND, 'A1', 'Why us?'));

    // Act
    const back = succeeded(surfacing(replied.ledger, AGENT, 'Still need the region'));

    // Assert
    const snapshot = agendaSnapshot(back.ledger);
    should(back.change).equal('reopened');
    should(snapshot.items.map(item => item.id)).deepEqual(['A1']);
    should(snapshot.resolved).have.length(0);
    should(back.item?.waitingOn).be.undefined();
    should(back.item?.history).deepEqual([
      { at: SECOND, kind: 'replied', note: 'Why us?' },
      { at: THIRD, kind: 'surfaced', note: 'Still need the region' },
    ]);
  });

  it('should come back with the new wording when the ferret edits it', () => {
    // Arrange
    const replied = succeeded(reply(raised().ledger));

    // Act
    const back = succeeded(
      applyAgendaCommand(replied.ledger, {
        action: 'edit',
        actor: AGENT,
        id: 'A1',
        patch: { stillOpen: 'Which region?' },
        at: THIRD,
      }),
    );

    // Assert
    should(agendaSnapshot(back.ledger).items.map(item => item.id)).deepEqual(['A1']);
    should(back.item?.stillOpen).equal('Which region?');
    should(back.item?.waitingOn).be.undefined();
    should(back.item?.history?.map(entry => entry.kind)).deepEqual(['replied', 'updated']);
  });

  it('should let the resurface timer bring it back, and refuse another ferret and the Warden', () => {
    // Arrange
    const replied = succeeded(reply(raised().ledger));

    // Act + Assert
    should(failed(surfacing(replied.ledger, OTHER_AGENT)).error.code).equal('forbidden');
    should(failed(surfacing(replied.ledger, WARDEN)).error.code).equal('forbidden');
    should(succeeded(surfacing(replied.ledger, { kind: 'daemon', cause: 'system' })).change).equal('reopened');
  });

  it('should not reopen into a full board', () => {
    // Arrange
    let ledger = succeeded(reply(raised().ledger)).ledger;
    for (let index = 0; index < MAX_AGENDA_PER_SESSION; index += 1) {
      const next = applyAgendaCommand(ledger, raiseCommand(HUMAN, { subject: `Filler ${index}` }));
      if (!next.ok) break;
      ledger = next.ledger;
    }

    // Act
    const result = surfacing(ledger);

    // Assert
    should(failed(result).error.code).equal('full');
  });

  it('should not be brought back by a surface of an item that was answered for real', () => {
    // Arrange
    const closed = succeeded(
      applyAgendaCommand(raised().ledger, { action: 'resolve', actor: AGENT, id: 'A1', at: SECOND }),
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

  it('should close it as replied at the instant of the reply when the board is read', () => {
    // Act
    const parsed = parseAgendaLedger(JSON.parse(JSON.stringify(legacyReply())), SESSION_ID);

    // Assert
    const snapshot = agendaSnapshot(parsed as AgendaLedger);
    should(snapshot.items).have.length(0);
    should(snapshot.resolved).have.length(1);
    should(snapshot.resolved[0]).containDeep({
      id: 'A1',
      disposition: 'replied',
      resolvedAt: SECOND,
      resolvedBy: 'human',
    });
    should(snapshot.resolved[0]?.history?.map(entry => entry.kind)).deepEqual(['replied']);
    should(snapshot.resolved[0]?.waitingOn).be.undefined();
  });

  it('should close only the replied item on a board that also holds an ordinary open one', () => {
    // Arrange
    const withSecond = succeeded(
      applyAgendaCommand(legacyReply(), raiseCommand(AGENT, { subject: 'Rotate the signing key?' }, SECOND)),
    );

    // Act
    const parsed = parseAgendaLedger(JSON.parse(JSON.stringify(withSecond.ledger)), SESSION_ID);

    // Assert
    const snapshot = agendaSnapshot(parsed as AgendaLedger);
    should(snapshot.items.map(item => item.id)).deepEqual(['A2']);
    should(snapshot.resolved.map(item => item.id)).deepEqual(['A1']);
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
      succeeded(applyAgendaCommand(ledger, { action: 'resolve', actor: AGENT, id: 'A1', at: SECOND })).change,
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
    // Arrange
    const { ledger } = raised(AGENT, { ask: CHOICE, confirms: CONFIRMS });

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
