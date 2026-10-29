import { describe, it } from 'bun:test';
import type {
  AttentionAsk,
  AttentionCardAnswer,
  AttentionId,
  AttentionItem,
  AttentionResponse,
} from '@ferretry/protocol';
import { MAX_ATTENTION_PER_SESSION, MAX_ATTENTION_REVISIONS } from '@ferretry/protocol';
import should from 'should';
import {
  type AttentionActor,
  type AttentionCommand,
  type AttentionEntry,
  type AttentionLedger,
  type AttentionMutation,
  applyAttentionCommand,
  applyAttentionCommandToSession,
  attentionSnapshot,
  canDismissAttention,
  type EditAttentionPatch,
  emptyAttentionLedger,
  isActiveAttention,
  isWardenEscalationAttention,
  MAX_AGENT_ATTENTION_PER_SESSION,
  parseAttentionLedger,
  type RaiseAttentionRequest,
} from '../../../src/lib/attention/state-machine.ts';

const SESSION_ID = 'session-1';
const OTHER_SESSION_ID = 'session-2';
const FIRST = '2026-07-30T10:00:00Z';
const SECOND = '2026-07-30T11:00:00Z';
const THIRD = '2026-07-30T12:00:00Z';

const HUMAN: AttentionActor = { kind: 'human' };
const AGENT: AttentionActor = { kind: 'agent', sessionId: SESSION_ID, name: 'Ada' };
const OTHER_AGENT: AttentionActor = { kind: 'agent', sessionId: OTHER_SESSION_ID, name: 'Grace' };
const DAEMON: AttentionActor = { kind: 'daemon', cause: 'source-reconciliation' };
const WARDEN: AttentionActor = { kind: 'daemon', cause: 'warden-escalation' };

function request(overrides: Partial<RaiseAttentionRequest> = {}): RaiseAttentionRequest {
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
  actor: AttentionActor = AGENT,
  overrides: Partial<RaiseAttentionRequest> = {},
  at = FIRST,
): AttentionCommand {
  return { action: 'raise', actor, request: request(overrides), at };
}

function succeeded(result: AttentionMutation): Extract<AttentionMutation, { ok: true }> {
  should(result.ok).be.true();
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

function failed(result: AttentionMutation): Extract<AttentionMutation, { ok: false }> {
  should(result.ok).be.false();
  if (result.ok) throw new Error('expected attention mutation to fail');
  return result;
}

function raised(
  actor: AttentionActor = AGENT,
  overrides: Partial<RaiseAttentionRequest> = {},
  at = FIRST,
): Extract<AttentionMutation, { ok: true }> {
  return succeeded(applyAttentionCommandToSession(null, SESSION_ID, raiseCommand(actor, overrides, at)));
}

function activeEntry(
  ledger: AttentionLedger,
  id: AttentionId = 'A1',
): Extract<AttentionEntry, { lifecycle: 'active' }> {
  const actual = ledger.entries.find(entry => entry.lifecycle === 'active' && entry.item.id === id);
  if (actual === undefined || actual.lifecycle !== 'active') throw new Error(`missing active entry ${id}`);
  return actual;
}

describe('Attention state machine', () => {
  it('should derive active items and count from lifecycle entries', () => {
    // Arrange
    const initial = emptyAttentionLedger(SESSION_ID, FIRST);

    // Act
    const created = succeeded(applyAttentionCommand(initial, raiseCommand()));
    const actual = attentionSnapshot(created.ledger);

    // Assert
    should(initial.entries).have.length(0);
    should(actual.count).equal(1);
    should(actual.items).have.length(1);
    should(actual.resolved).have.length(0);
    should(isActiveAttention(activeEntry(created.ledger))).be.true();
    should(created.item).deepEqual(actual.items[0]);
  });

  it('should stamp exact human, agent, daemon, and warden provenance', () => {
    // Arrange
    const cases: Array<{
      actor: AttentionActor;
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
    should(isWardenEscalationAttention(activeEntry(raised(WARDEN).ledger))).be.true();
    should(isWardenEscalationAttention(activeEntry(raised(DAEMON).ledger))).be.false();
    should(isWardenEscalationAttention(activeEntry(raised(AGENT).ledger))).be.false();
  });

  it('should reserve automatic sources and stable source keys for trusted daemon producers', () => {
    // Arrange
    const automatic = raiseCommand(AGENT, { source: 'task', sourceRef: null });
    const forgedStableKey = raiseCommand(AGENT, { sourceRef: 'warden:forged' });
    const untyped = raiseCommand(AGENT, { ask: undefined });

    // Act
    const sourceResult = failed(applyAttentionCommandToSession(null, SESSION_ID, automatic));
    const keyResult = failed(applyAttentionCommandToSession(null, SESSION_ID, forgedStableKey));
    const kindResult = failed(applyAttentionCommandToSession(null, SESSION_ID, untyped));

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
    const accepted = succeeded(applyAttentionCommandToSession(null, SESSION_ID, plain));
    const rejected = failed(applyAttentionCommandToSession(null, SESSION_ID, wrongSequence));

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
    const agentItem = activeEntry(
      succeeded(applyAttentionCommandToSession(null, SESSION_ID, agentCommand)).ledger,
    ).item;
    const daemonItem = activeEntry(
      succeeded(applyAttentionCommandToSession(null, SESSION_ID, daemonCommand)).ledger,
    ).item;

    // Assert
    should(agentItem.waitingSince).equal(FIRST);
    should(daemonItem.waitingSince).equal(backdated);
  });

  it('should deduplicate identical requests only for the same authorized actor', () => {
    // Arrange
    const first = raised();
    const daemonFirst = raised(DAEMON);

    // Act
    const duplicate = succeeded(applyAttentionCommand(first.ledger, raiseCommand(AGENT, {}, SECOND)));
    const otherActor = failed(applyAttentionCommand(duplicate.ledger, raiseCommand(OTHER_AGENT, {}, THIRD)));
    const daemonDuplicate = succeeded(applyAttentionCommand(daemonFirst.ledger, raiseCommand(DAEMON, {}, SECOND)));
    const otherDaemonCause = succeeded(applyAttentionCommand(daemonDuplicate.ledger, raiseCommand(WARDEN, {}, THIRD)));

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
    const actual = succeeded(applyAttentionCommand(first.ledger, nextCommand));

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
    const brief: Partial<RaiseAttentionRequest> = {
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
    const same = succeeded(applyAttentionCommand(first.ledger, raiseCommand(AGENT, brief, SECOND)));
    const different = succeeded(
      applyAttentionCommand(same.ledger, raiseCommand(AGENT, { ...brief, urgency: 'no rush' }, THIRD)),
    );
    const refreshed = succeeded(
      applyAttentionCommand(
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
      applyAttentionCommand(
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
    const duplicate = succeeded(applyAttentionCommand(first.ledger, identical));
    const regressed = succeeded(applyAttentionCommand(duplicate.ledger, stale));

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
    const actual = succeeded(applyAttentionCommand(first.ledger, olderCommand));

    // Assert
    should(actual.snapshot.items.map(item => item.id)).deepEqual(['A2', 'A1']);
    should(actual.ledger.nextId).equal(3);
  });

  it('should cap agent requests at ten while leaving automatic-source capacity', () => {
    // Arrange
    let ledger = emptyAttentionLedger(SESSION_ID, FIRST);
    for (let index = 0; index < MAX_AGENT_ATTENTION_PER_SESSION; index += 1) {
      ledger = succeeded(
        applyAttentionCommand(
          ledger,
          raiseCommand(AGENT, { subject: `Decision ${index}`, ask: { kind: 'open-question' } }, FIRST),
        ),
      ).ledger;
    }

    // Act
    const overflow = failed(
      applyAttentionCommand(ledger, raiseCommand(AGENT, { subject: 'One too many', ask: { kind: 'permission' } })),
    );
    const automatic = succeeded(
      applyAttentionCommand(ledger, raiseCommand(DAEMON, { source: 'task', sourceRef: 'F12', ask: undefined }, SECOND)),
    );

    // Assert
    should(overflow.error.code).equal('full');
    should(automatic.snapshot.count).equal(11);
    should(automatic.snapshot.items.filter(item => item.raisedBy === 'agent')).have.length(10);
  });

  it('should refuse total-cap overflow and an exhausted id allocator without evicting', () => {
    // Arrange
    let ledger = emptyAttentionLedger(SESSION_ID, FIRST);
    for (let index = 0; index < 20; index += 1) {
      const actor = index < 10 ? AGENT : HUMAN;
      ledger = succeeded(
        applyAttentionCommand(
          ledger,
          raiseCommand(actor, { subject: `Decision ${index}`, ask: { kind: 'permission' } }, FIRST),
        ),
      ).ledger;
    }
    const exhausted: AttentionLedger = { ...emptyAttentionLedger(SESSION_ID, FIRST), nextId: Number.MAX_SAFE_INTEGER };

    // Act
    const full = failed(
      applyAttentionCommand(
        ledger,
        raiseCommand(DAEMON, { source: 'question', sourceRef: 'question-1', ask: undefined }, SECOND),
      ),
    );
    const noIds = failed(applyAttentionCommand(exhausted, raiseCommand()));

    // Assert
    should(full.error.code).equal('full');
    should(ledger.entries).have.length(20);
    should(noIds.error.code).equal('full');
  });

  it('should answer every tagged ask kind, remove it immediately, and retain the response', () => {
    // Arrange
    const cases: Array<{ ask: AttentionAsk; response: AttentionResponse }> = [
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
        applyAttentionCommand(board.ledger, {
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
      applyAttentionCommand(permission.ledger, {
        action: 'answer',
        actor: HUMAN,
        id: 'A1',
        response: { kind: 'open-question', answer: 'yes' },
        at: SECOND,
      }),
    );
    const outside = failed(
      applyAttentionCommand(choice.ledger, {
        action: 'answer',
        actor: HUMAN,
        id: 'A1',
        response: { kind: 'multiple-choice', choice: 'C' },
        at: SECOND,
      }),
    );
    const noAsk = failed(
      applyAttentionCommand(plain.ledger, {
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
    const otherItem: AttentionItem = {
      ...activeEntry(own.ledger).item,
      raisedBy: 'agent',
      raisedBySession: OTHER_AGENT.sessionId,
      raisedByName: OTHER_AGENT.name,
    };
    const other: AttentionLedger = {
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
      applyAttentionCommand(own.ledger, { action: 'dismiss', actor: AGENT, id: 'A1', at: SECOND }),
    );
    const crossAgent = failed(applyAttentionCommand(other, { action: 'dismiss', actor: AGENT, id: 'A1', at: SECOND }));
    const daemonByAgent = failed(
      applyAttentionCommand(daemon.ledger, { action: 'dismiss', actor: AGENT, id: 'A1', at: SECOND }),
    );
    const humanDismissal = succeeded(
      applyAttentionCommand(daemon.ledger, {
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
    const commands: readonly AttentionCommand[] = [
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
      const actual = failed(applyAttentionCommand(board.ledger, command));
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
    should(canDismissAttention(HUMAN, agentEntry)).be.true();
    should(canDismissAttention(AGENT, agentEntry)).be.true();
    should(canDismissAttention(OTHER_AGENT, agentEntry)).be.false();
    should(canDismissAttention(AGENT, daemonEntry)).be.false();
    should(canDismissAttention(DAEMON, daemonEntry)).be.true();
    should(canDismissAttention(WARDEN, daemonEntry)).be.true();
  });

  it('should resolve without a response under the same exact-raiser guard, structured ask or not', () => {
    // Arrange
    const own = raised(AGENT, { ask: { kind: 'permission' } });
    const plainOwn = raised(DAEMON, { source: 'task', sourceRef: 'F12', ask: undefined });

    // Act
    const agentResolveAsked = succeeded(
      applyAttentionCommand(own.ledger, { action: 'resolve', actor: AGENT, id: 'A1', at: SECOND }),
    );
    const wrongDaemon = failed(
      applyAttentionCommand(plainOwn.ledger, { action: 'resolve', actor: AGENT, id: 'A1', at: SECOND }),
    );
    const daemonResolve = succeeded(
      applyAttentionCommand(plainOwn.ledger, { action: 'resolve', actor: DAEMON, id: 'A1', at: SECOND }),
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
      applyAttentionCommand(board.ledger, {
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
      applyAttentionCommand(answered.ledger, {
        action: 'dismiss',
        actor: AGENT,
        id: 'A1',
        note: 'Overwrite attempt.',
        at: THIRD,
      }),
    );
    const missing = failed(
      applyAttentionCommand(answered.ledger, { action: 'resolve', actor: HUMAN, id: 'A99', at: THIRD }),
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
    const command: AttentionCommand = {
      action: 'resolve-source',
      actor: DAEMON,
      source: 'question',
      sourceRef: 'tool-1',
      note: 'Question answered by the lead.',
      at: SECOND,
    };

    // Act
    const resolved = succeeded(applyAttentionCommand(board.ledger, command));
    const retry = succeeded(applyAttentionCommand(resolved.ledger, command));
    const forbidden = failed(applyAttentionCommand(board.ledger, { ...command, actor: AGENT, at: THIRD }));

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
      applyAttentionCommand(agent.ledger, raiseCommand(HUMAN, { subject: 'Human request' }, SECOND)),
    );
    const daemon = succeeded(
      applyAttentionCommand(
        human.ledger,
        raiseCommand(DAEMON, { source: 'task', sourceRef: 'F12', ask: undefined }, THIRD),
      ),
    );
    const addressed = succeeded(
      applyAttentionCommand(daemon.ledger, {
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
    const parsed = parseAttentionLedger(valid, SESSION_ID);

    // Assert
    should(parsed).containDeep({ sessionId: SESSION_ID, nextId: 4 });
    should(parsed?.entries.map(entry => entry.lifecycle).sort()).deepEqual(['active', 'active', 'addressed']);
    should(parseAttentionLedger(null, SESSION_ID)).be.null();
    should(parseAttentionLedger({ ...valid, sessionId: OTHER_SESSION_ID }, SESSION_ID)).be.null();
    should(parseAttentionLedger(duplicate, SESSION_ID)).be.null();
    should(parseAttentionLedger(exhausted, SESSION_ID)).be.null();
    should(parseAttentionLedger(malformedOrigin, SESSION_ID)).be.null();
    should(parseAttentionLedger(mismatchedAddressedOrigin, SESSION_ID)).be.null();
    should(parseAttentionLedger(unknownLifecycle, SESSION_ID)).be.null();
  });

  it.each(['source-reconciliation', 'warden-escalation', 'system', 'harness-prompt'] as const)(
    'should decode a stored item raised by the %s daemon cause with that cause intact',
    cause => {
      // Arrange
      const origin: AttentionActor = { kind: 'daemon', cause };
      const stored = raised(origin, { source: 'task', sourceRef: 'F12', ask: undefined }).ledger;

      // Act
      const decoded = parseAttentionLedger(JSON.parse(JSON.stringify(stored)), SESSION_ID);

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
    should(parseAttentionLedger(unknownCause, SESSION_ID)).be.null();
  });

  it('should bound newest-first resolution history without reusing ids', () => {
    // Arrange
    let ledger = emptyAttentionLedger(SESSION_ID, FIRST);
    for (let index = 1; index <= 101; index += 1) {
      const at = `2026-07-30T12:${String(index % 60).padStart(2, '0')}:00Z`;
      const created = succeeded(
        applyAttentionCommand(ledger, raiseCommand(DAEMON, { sourceRef: `source-${index}`, ask: undefined }, at)),
      );
      ledger = succeeded(
        applyAttentionCommand(created.ledger, {
          action: 'resolve',
          actor: DAEMON,
          id: `A${index}` as AttentionId,
          at,
        }),
      ).ledger;
    }

    // Act
    const actual = attentionSnapshot(ledger);

    // Assert
    should(actual.resolved).have.length(100);
    should(actual.resolved.some(item => item.id === 'A1')).be.false();
    should(new Set(actual.resolved.map(item => item.id)).size).equal(100);
    should(actual.count).equal(0);
    should(ledger.nextId).equal(102);
  });
});

describe('Attention state machine edit', () => {
  const questioned = (): Extract<AttentionMutation, { ok: true }> =>
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
      applyAttentionCommand(created.ledger, {
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
      applyAttentionCommand(created.ledger, {
        action: 'edit',
        actor: AGENT,
        id: 'A1',
        patch: { context: null },
        at: SECOND,
      }),
    );
    const unchanged = succeeded(applyAttentionCommand(created.ledger, same));

    // Assert
    should(cleared.item?.context ?? null).be.null();
    should(unchanged.changed).be.false();
  });

  it('should reword questions but refuse to add, drop or re-option them', () => {
    // Arrange
    const created = questioned();
    const edit = (questions: NonNullable<EditAttentionPatch['questions']>) =>
      applyAttentionCommand(created.ledger, {
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
      applyAttentionCommand(created.ledger, { action: 'dismiss', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act
    const empty = failed(
      applyAttentionCommand(created.ledger, { action: 'edit', actor: AGENT, id: 'A1', patch: {}, at: SECOND }),
    );
    const stranger = failed(
      applyAttentionCommand(created.ledger, { action: 'edit', actor: OTHER_AGENT, id: 'A1', patch, at: SECOND }),
    );
    const closed = failed(
      applyAttentionCommand(resolved.ledger, { action: 'edit', actor: AGENT, id: 'A1', patch, at: THIRD }),
    );
    const unknown = failed(
      applyAttentionCommand(created.ledger, { action: 'edit', actor: AGENT, id: 'A9', patch, at: SECOND }),
    );

    const foreign: AttentionLedger = {
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
    const notOurs = failed(
      applyAttentionCommand(foreign, { action: 'edit', actor: AGENT, id: 'A1', patch, at: SECOND }),
    );

    // Assert
    should(empty.error.code).equal('invalid');
    should(stranger.error.code).equal('forbidden');
    should(notOurs.error.code).equal('forbidden');
    should(closed.error.code).equal('not-found');
    should(unknown.error.code).equal('not-found');
  });
});

describe('Attention state machine steps and progress', () => {
  const STEPS = ['Open `fy config path`', 'Paste the **code** there', 'Press Enter'];
  const progressOf = (actor: AttentionActor, id: AttentionId, step: number, done: boolean, at = SECOND) =>
    ({ action: 'progress', actor, id, step, done, at }) satisfies AttentionCommand;

  it('should store steps and body, dedupe on them, and replace them on a refresh', () => {
    // Arrange
    const first = raised(AGENT, { steps: STEPS, body: '## Why\nBecause.' });
    const stable = raised(DAEMON, { source: 'task', sourceRef: 'F1', steps: STEPS });

    // Act
    const same = succeeded(
      applyAttentionCommand(first.ledger, raiseCommand(AGENT, { steps: STEPS, body: '## Why\nBecause.' }, SECOND)),
    );
    const other = succeeded(
      applyAttentionCommand(same.ledger, raiseCommand(AGENT, { steps: [...STEPS, 'Done'], body: undefined }, THIRD)),
    );
    const refreshed = succeeded(
      applyAttentionCommand(
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
    const ticked2 = succeeded(applyAttentionCommand(created.ledger, progressOf(HUMAN, 'A1', 2, true)));
    const ticked0 = succeeded(applyAttentionCommand(ticked2.ledger, progressOf(AGENT, 'A1', 0, true)));
    const again = succeeded(applyAttentionCommand(ticked0.ledger, progressOf(HUMAN, 'A1', 0, true)));
    const unticked = succeeded(applyAttentionCommand(ticked0.ledger, progressOf(HUMAN, 'A1', 2, false)));
    const cleared = succeeded(applyAttentionCommand(unticked.ledger, progressOf(HUMAN, 'A1', 0, false)));
    const never = succeeded(applyAttentionCommand(created.ledger, progressOf(HUMAN, 'A1', 1, false)));

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
      applyAttentionCommand(created.ledger, { action: 'dismiss', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act
    const range = failed(applyAttentionCommand(created.ledger, progressOf(HUMAN, 'A1', 3, true)));
    const none = failed(applyAttentionCommand(plain.ledger, progressOf(HUMAN, 'A1', 0, true)));
    const stranger = failed(applyAttentionCommand(created.ledger, progressOf(OTHER_AGENT, 'A1', 0, true)));
    const resolved = failed(applyAttentionCommand(closed.ledger, progressOf(HUMAN, 'A1', 0, true, THIRD)));
    const unknown = failed(applyAttentionCommand(created.ledger, progressOf(HUMAN, 'A9', 0, true)));

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
    const ticked = succeeded(applyAttentionCommand(created.ledger, progressOf(HUMAN, 'A1', 1, true)));
    const editWith = (patch: EditAttentionPatch): AttentionCommand => ({
      action: 'edit',
      actor: AGENT,
      id: 'A1',
      patch,
      at: THIRD,
    });

    // Act
    const sameSteps = succeeded(applyAttentionCommand(ticked.ledger, editWith({ steps: STEPS, body: 'More.' })));
    const bodyOnly = succeeded(applyAttentionCommand(ticked.ledger, editWith({ body: 'Only a body.' })));
    const newSteps = succeeded(applyAttentionCommand(ticked.ledger, editWith({ steps: ['One', 'Two'] })));

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
    const ticked = succeeded(applyAttentionCommand(created.ledger, progressOf(HUMAN, 'A1', 0, true)));
    const refresh = (steps: string[]): AttentionCommand =>
      raiseCommand(DAEMON, { source: 'task', sourceRef: 'F2', steps, impact: 'Newer.' }, THIRD);

    // Act
    const kept = succeeded(applyAttentionCommand(ticked.ledger, refresh(STEPS)));
    const reset = succeeded(applyAttentionCommand(ticked.ledger, refresh(['Other'])));

    // Assert
    should(kept.item?.stepsDone).deepEqual([0]);
    should(reset.item?.stepsDone).be.undefined();
  });
});

describe('Attention state machine progress on another agent’s item', () => {
  it('should refuse a tick from an agent on an item a different agent raised', () => {
    // Arrange
    const created = raised(AGENT, { steps: ['One'] });
    const foreign: AttentionLedger = {
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
      applyAttentionCommand(foreign, { action: 'progress', actor: AGENT, id: 'A1', step: 0, done: true, at: SECOND }),
    );

    // Assert
    should(refused.error.code).equal('forbidden');
  });
});

describe('Attention state machine needs-info', () => {
  const ask = (ledger: AttentionLedger, note?: string, at = SECOND, actor: AttentionActor = HUMAN) =>
    applyAttentionCommand(ledger, {
      action: 'needs-info',
      actor,
      id: 'A1',
      ...(note === undefined ? {} : { note }),
      at,
    });
  const ferretEdit = (ledger: AttentionLedger, subject: string, at = THIRD) =>
    applyAttentionCommand(ledger, { action: 'edit', actor: AGENT, id: 'A1', patch: { subject }, at });

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
      applyAttentionCommand(created.ledger, { action: 'resolve', actor: HUMAN, id: 'A1', note: null, at: SECOND }),
    );
    const human = raised(HUMAN);

    // Act
    const byAgent = failed(ask(created.ledger, undefined, SECOND, AGENT));
    const closed = failed(ask(resolved.ledger));
    const unknown = failed(
      applyAttentionCommand(created.ledger, { action: 'needs-info', actor: HUMAN, id: 'A9', at: SECOND }),
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
      applyAttentionCommand(asked.ledger, {
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
      applyAttentionCommand(asked.ledger, { action: 'resolve', actor: AGENT, id: 'A1', note: null, at: THIRD }),
    );

    // Assert
    should(resolved.addressed?.waitingOn).be.undefined();
    should(resolved.addressed?.askedAt).be.undefined();
  });
});

describe('Attention state machine discuss', () => {
  const discuss = (ledger: AttentionLedger, note?: string, at = SECOND, actor: AttentionActor = HUMAN) =>
    applyAttentionCommand(ledger, { action: 'discuss', actor, id: 'A1', ...(note === undefined ? {} : { note }), at });

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
      applyAttentionCommand(raised().ledger, { action: 'needs-info', actor: HUMAN, id: 'A1', at: SECOND }),
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
      applyAttentionCommand(created.ledger, { action: 'discuss', actor: HUMAN, id: 'A9', at: SECOND }),
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
      applyAttentionCommand(asked.ledger, {
        action: 'edit',
        actor: AGENT,
        id: 'A1',
        patch: { subject: 'Use SQLite for the board?' },
        at: THIRD,
      }),
    );
    const surfaced = succeeded(
      applyAttentionCommand(asked.ledger, { action: 'surface', actor: AGENT, id: 'A1', at: THIRD }),
    );
    const closed = succeeded(
      applyAttentionCommand(asked.ledger, { action: 'resolve', actor: HUMAN, id: 'A1', note: null, at: THIRD }),
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

describe('Attention state machine card fields', () => {
  const answers: AttentionCardAnswer[] = [
    { direction: 'left', does: 'reject', label: 'Deny' },
    { direction: 'up', does: 'approve', label: 'Always allow', description: 'for this repo' },
    { direction: 'right', does: 'approve', label: 'Allow' },
  ];
  const card: Partial<RaiseAttentionRequest> = { title: 'Deploy approval', kind: 'permission', answers };

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
    const same = succeeded(applyAttentionCommand(first.ledger, raiseCommand(AGENT, card, SECOND)));
    const retitled = succeeded(
      applyAttentionCommand(first.ledger, raiseCommand(AGENT, { ...card, title: 'Another title' }, SECOND)),
    );
    const reanswered = succeeded(
      applyAttentionCommand(first.ledger, raiseCommand(AGENT, { ...card, answers: answers.slice(0, 2) }, SECOND)),
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
      applyAttentionCommand(created.ledger, {
        action: 'edit',
        actor: AGENT,
        id: 'A1',
        patch: { title: 'Deploy to production' },
        at: SECOND,
      }),
    );
    const same = succeeded(
      applyAttentionCommand(edited.ledger, {
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
      applyAttentionCommand(
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
    const decoded = parseAttentionLedger(JSON.parse(JSON.stringify(old.ledger)), SESSION_ID);
    const answered = succeeded(
      applyAttentionCommand(old.ledger, {
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
      applyAttentionCommandToSession(
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

describe('Attention state machine undelivered', () => {
  const SYSTEM: AttentionActor = { kind: 'daemon', cause: 'system' };
  const REASON = 'it never appeared in the ferret’s transcript';
  const undelivered = (ledger: AttentionLedger, request?: number, actor: AttentionActor = SYSTEM) =>
    applyAttentionCommand(ledger, {
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
      applyAttentionCommand(raised().ledger, {
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
    const snapshot = attentionSnapshot(reopened.ledger);

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
      applyAttentionCommand(raised().ledger, { action: 'dismiss', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act
    const reopened = succeeded(undelivered(dismissed.ledger));
    const retried = succeeded(
      applyAttentionCommand(reopened.ledger, { action: 'dismiss', actor: HUMAN, id: 'A1', at: THIRD }),
    );

    // Assert
    should(reopened.item?.undelivered?.reply).deepEqual({ action: 'dismiss' });
    should(retried.addressed).not.have.property('undelivered');
  });

  it('should end an undelivered discussion: back to the owner, waiting on nobody, with the discussion to retry', () => {
    // Arrange
    const discussing = succeeded(
      applyAttentionCommand(raised().ledger, {
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
      applyAttentionCommand(reopened.ledger, { action: 'discuss', actor: HUMAN, id: 'A1', at: THIRD }),
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
      applyAttentionCommand(raised().ledger, { action: 'discuss', actor: HUMAN, id: 'A1', at: SECOND }),
    );
    const updated = succeeded(
      applyAttentionCommand(discussing.ledger, { action: 'surface', actor: AGENT, id: 'A1', at: THIRD }),
    );

    // Act + Assert
    should(succeeded(undelivered(discussing.ledger, 2)).changed).be.false();
    should(succeeded(undelivered(updated.ledger, 1)).changed).be.false();
    should(succeeded(undelivered(raised().ledger)).changed).be.false();
  });

  it('should keep an undelivered answer closed, and say so, when the board has no room to reopen it', () => {
    // Arrange — one answered item, then the board filled to its limit with open ones.
    let ledger = succeeded(
      applyAttentionCommand(raised().ledger, { action: 'resolve', actor: HUMAN, id: 'A1', at: SECOND }),
    ).ledger;
    for (let index = 0; index < MAX_ATTENTION_PER_SESSION; index += 1)
      ledger = succeeded(
        applyAttentionCommand(
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
      applyAttentionCommand(raised(HUMAN).ledger, { action: 'resolve', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act + Assert
    should(failed(undelivered(raised().ledger, undefined, HUMAN)).error.code).equal('forbidden');
    should(succeeded(undelivered(owners.ledger)).changed).be.false();
  });
});

describe('Attention state machine: a new ask is the owner’s turn', () => {
  const reply = (ledger: AttentionLedger, actor: AttentionActor = HUMAN, at = SECOND, id: AttentionId = 'A1') =>
    applyAttentionCommand(ledger, { action: 'reply', actor, id, at });
  /** An item on the ferret's turn: the owner has replied to it. */
  const born = (overrides: Partial<RaiseAttentionRequest> = {}) => succeeded(reply(raised(AGENT, overrides).ledger));
  const surface = (
    ledger: AttentionLedger,
    actor: AttentionActor = AGENT,
    why?: string,
    at = SECOND,
  ): AttentionMutation =>
    applyAttentionCommand(ledger, { action: 'surface', actor, id: 'A1', ...(why === undefined ? {} : { why }), at });

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
    should(surfaced.item?.history).deepEqual([{ at: SECOND, kind: 'surfaced', note: 'The owner did not answer' }]);
    should(attentionSnapshot(surfaced.ledger).items[0]).deepEqual(surfaced.item);
  });

  it('should record a surfaced entry without a note when no why is given', () => {
    // Act
    const surfaced = succeeded(surface(born().ledger));

    // Assert
    should(surfaced.item?.history).deepEqual([{ at: SECOND, kind: 'surfaced' }]);
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
    should(attentionSnapshot(again.ledger).items[0]?.history).have.length(1);
    should(never.changed).be.false();
  });

  it('should refuse another ferret, an item that is not there, and a wait that is for information', () => {
    // Arrange
    const created = born();
    const waiting = succeeded(
      applyAttentionCommand(raised().ledger, { action: 'needs-info', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act + Assert
    should(failed(surface(created.ledger, OTHER_AGENT)).error.code).equal('forbidden');
    should(failed(surface(emptyAttentionLedger(SESSION_ID, FIRST))).error.code).equal('not-found');
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
      applyAttentionCommand(born().ledger, { action: 'resolve', actor: AGENT, id: 'A1', at: SECOND }),
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
      applyAttentionCommand(surfaced.ledger, { action: 'discuss', actor: HUMAN, id: 'A1', at: THIRD }),
    );

    // Act
    const answered = succeeded(
      applyAttentionCommand(discussing.ledger, {
        action: 'edit',
        actor: AGENT,
        id: 'A1',
        patch: { subject: 'Approve it tonight?' },
        at: '2026-07-30T13:00:00Z',
      }),
    );

    // Assert
    should(discussing.item).containDeep({ waitingFor: 'discussion', infoRequests: 1 });
    should(answered.change).equal('refreshed');
    should(answered.item?.waitingOn).be.undefined();
    should(answered.item?.waitingFor).be.undefined();
  });
});

describe('Attention state machine reply', () => {
  const reply = (ledger: AttentionLedger, actor: AttentionActor = HUMAN, at = SECOND, id: AttentionId = 'A1') =>
    applyAttentionCommand(ledger, { action: 'reply', actor, id, at });

  it('should make the item the ferret’s turn for a discussion, without counting a request or recording history', () => {
    // Arrange
    const created = raised();

    // Act
    const replied = succeeded(reply(created.ledger));

    // Assert
    should(replied.change).equal('replied');
    should(replied.changed).be.true();
    should(replied.item).containDeep({ waitingOn: 'ferret', askedAt: SECOND, waitingFor: 'discussion' });
    should(replied.item?.infoRequests).be.undefined();
    should(replied.item?.history).be.undefined();
    should(attentionSnapshot(replied.ledger).items[0]).deepEqual(replied.item);
  });

  it('should leave the request counter alone when it turns an open request for information into a discussion', () => {
    // Arrange
    const asked = succeeded(
      applyAttentionCommand(raised().ledger, { action: 'needs-info', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act
    const replied = succeeded(reply(asked.ledger, HUMAN, THIRD));

    // Assert
    should(replied.change).equal('replied');
    should(replied.item).containDeep({
      waitingOn: 'ferret',
      waitingFor: 'discussion',
      infoRequests: 1,
      askedAt: THIRD,
    });
    should(replied.item?.history?.map(entry => entry.kind)).deepEqual(['needs-info']);
  });

  it('should be idempotent: a reply to an item already in discussion is no change', () => {
    // Arrange
    const once = succeeded(reply(raised().ledger));

    // Act
    const again = succeeded(reply(once.ledger, HUMAN, THIRD));

    // Assert
    should(again.changed).be.false();
    should(again.change).equal('unchanged');
    should(again.ledger).deepEqual(once.ledger);
    should(activeEntry(again.ledger).item.askedAt).equal(SECOND);
  });

  it('should be the owner’s alone: an agent, the ferret that raised it and the daemon are refused', () => {
    // Arrange
    const created = raised();

    // Act + Assert
    should(failed(reply(created.ledger, AGENT)).error.code).equal('forbidden');
    should(failed(reply(created.ledger, DAEMON)).error.code).equal('forbidden');
    should(failed(reply(created.ledger, OTHER_AGENT)).error.code).equal('forbidden');
  });

  it('should be not-found for a missing or closed item, and refuse a notice', () => {
    // Arrange
    const created = raised();
    const closed = succeeded(
      applyAttentionCommand(created.ledger, { action: 'resolve', actor: AGENT, id: 'A1', at: SECOND }),
    );
    const notice = raised(AGENT, { notice: true, kind: 'info', ask: undefined });

    // Act + Assert
    should(failed(reply(created.ledger, HUMAN, SECOND, 'A9')).error.code).equal('not-found');
    should(failed(reply(closed.ledger)).error.code).equal('not-found');
    should(failed(reply(notice.ledger)).error.code).equal('invalid');
  });

  it('should reply to an item nobody in particular raised: the owner may talk about any open item', () => {
    // Act
    const replied = succeeded(reply(raised(HUMAN).ledger));

    // Assert
    should(replied.item).containDeep({ waitingOn: 'ferret', waitingFor: 'discussion' });
  });

  it('should drop the wait when the item is closed', () => {
    // Arrange
    const replied = succeeded(reply(raised().ledger));

    // Act
    const closed = succeeded(
      applyAttentionCommand(replied.ledger, { action: 'resolve', actor: HUMAN, id: 'A1', note: null, at: THIRD }),
    );

    // Assert
    should(closed.addressed?.waitingOn).be.undefined();
    should(closed.addressed?.waitingFor).be.undefined();
    should(closed.addressed?.askedAt).be.undefined();
  });
});

describe('Attention state machine: the ferret’s edit hands the item back', () => {
  const reply = (ledger: AttentionLedger) =>
    applyAttentionCommand(ledger, { action: 'reply', actor: HUMAN, id: 'A1', at: SECOND });
  const needsInfo = (ledger: AttentionLedger) =>
    applyAttentionCommand(ledger, { action: 'needs-info', actor: HUMAN, id: 'A1', note: 'Why?', at: SECOND });
  const editing = (
    ledger: AttentionLedger,
    patch: EditAttentionPatch,
    actor: AttentionActor = AGENT,
    at = THIRD,
  ): AttentionMutation => applyAttentionCommand(ledger, { action: 'edit', actor, id: 'A1', patch, at });

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
    should(edited.item?.history).deepEqual([{ at: THIRD, kind: 'updated' }]);
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
    should(edited.item?.history).be.undefined();
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

describe('Attention state machine: agenda fields and clearing them', () => {
  const NEEDED = '2026-08-01T09:00:00.000Z';
  const editing = (ledger: AttentionLedger, patch: EditAttentionPatch, at = SECOND): AttentionMutation =>
    applyAttentionCommand(ledger, { action: 'edit', actor: AGENT, id: 'A1', patch, at });
  const agenda = () => raised(AGENT, { blockingNow: true, willBlock: 'the deploy', neededBy: NEEDED });

  it('should carry blockingNow, willBlock and neededBy onto a raised item and keep them in the same-request comparison', () => {
    // Arrange
    const created = agenda();

    // Act
    const same = succeeded(applyAttentionCommand(created.ledger, raiseCommand(AGENT, agendaOf())));
    const other = succeeded(
      applyAttentionCommand(created.ledger, raiseCommand(AGENT, { ...agendaOf(), willBlock: 'the release' })),
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
      applyAttentionCommand(agenda().ledger, { action: 'reply', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act
    const cleared = succeeded(editing(replied.ledger, { clear: ['blockingNow'] }, THIRD));

    // Assert
    should(cleared.item?.waitingOn).be.undefined();
    should(cleared.item?.blockingNow).be.undefined();
    should(cleared.item?.history?.map(entry => entry.kind)).deepEqual(['updated']);
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

  function agendaOf(): Partial<RaiseAttentionRequest> {
    return { blockingNow: true, willBlock: 'the deploy', neededBy: NEEDED };
  }
});

describe('Attention state machine notices', () => {
  const notice = (overrides: Partial<RaiseAttentionRequest> = {}): Partial<RaiseAttentionRequest> => ({
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
      applyAttentionCommandToSession(
        null,
        SESSION_ID,
        raiseCommand(DAEMON, notice({ source: 'task', sourceRef: 'ref' })),
      ),
    );
    const byHuman = failed(applyAttentionCommandToSession(null, SESSION_ID, raiseCommand(HUMAN, notice())));

    // Assert
    should(byDaemon.item?.notice).be.true();
    should(byHuman.error.code).equal('forbidden');
  });

  it('should refuse a notice with an ask, answers or steps, or of any kind but info', () => {
    // Arrange
    const run = (overrides: Partial<RaiseAttentionRequest>) =>
      failed(applyAttentionCommandToSession(null, SESSION_ID, raiseCommand(AGENT, notice(overrides))));
    const answers: AttentionCardAnswer[] = [
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
      applyAttentionCommandToSession(
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
    const pinged = failed(applyAttentionCommandToSession(null, SESSION_ID, raiseCommand(AGENT, { ping: true })));

    // Assert
    should(pinged.error).deepEqual({ code: 'invalid', message: 'ping is only for a notice' });
  });

  it('should tell a notice from the same words as an ask, and a ping from a plain notice', () => {
    // Arrange
    const first = raised(AGENT, notice());

    // Act
    const same = succeeded(applyAttentionCommand(first.ledger, raiseCommand(AGENT, notice(), SECOND)));
    const pinged = succeeded(applyAttentionCommand(first.ledger, raiseCommand(AGENT, notice({ ping: true }), SECOND)));
    const asked = succeeded(
      applyAttentionCommand(first.ledger, raiseCommand(AGENT, { kind: 'info', ask: undefined }, SECOND)),
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
      applyAttentionCommand(
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
      applyAttentionCommand(
        first.ledger,
        raiseCommand(DAEMON, notice({ ...stable, subject: 'A newer subject', willBlock: 'the release' }), SECOND),
      ),
    );
    const asAsk = succeeded(
      applyAttentionCommand(first.ledger, raiseCommand(DAEMON, { ...stable, subject: 'Now an ask' }, SECOND)),
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

describe('Attention state machine: a card is a living summary', () => {
  const born = (overrides: Partial<RaiseAttentionRequest> = {}) => raised(AGENT, overrides);
  const editing = (
    ledger: AttentionLedger,
    patch: Extract<AttentionCommand, { action: 'edit' }>['patch'],
    at = SECOND,
    actor: AttentionActor = AGENT,
  ): AttentionMutation => applyAttentionCommand(ledger, { action: 'edit', actor, id: 'A1', patch, at });

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
    for (let index = 1; index <= MAX_ATTENTION_REVISIONS + 3; index += 1) {
      ledger = succeeded(editing(ledger, { stillOpen: `Point ${index}` })).ledger;
    }

    // Assert
    const revisions = activeEntry(ledger).item.revisions ?? [];
    should(revisions).have.length(MAX_ATTENTION_REVISIONS);
    should(revisions[0]?.previous).deepEqual({ stillOpen: 'Point 3' });
    should(revisions.at(-1)?.previous).deepEqual({ stillOpen: `Point ${MAX_ATTENTION_REVISIONS + 2}` });
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
    const again = succeeded(applyAttentionCommand(created.ledger, raiseCommand(AGENT, { stillOpen: 'Which region?' })));
    const different = succeeded(
      applyAttentionCommand(created.ledger, raiseCommand(AGENT, { stillOpen: 'Which size?' })),
    );

    // Assert
    should(created.item?.stillOpen).equal('Which region?');
    should(again.changed).be.false();
    should(different.item?.id).not.equal('A1');
  });

  it('should still settle the wait of an item that waits on information when the ferret edits it', () => {
    // Arrange
    const asked = succeeded(
      applyAttentionCommand(raised().ledger, { action: 'needs-info', actor: HUMAN, id: 'A1', at: SECOND }),
    );

    // Act
    const edited = succeeded(editing(asked.ledger, { stillOpen: 'Which branch?' }, THIRD));

    // Assert
    should(edited.change).equal('info-added');
    should(edited.item?.waitingOn).be.undefined();
    should(edited.item?.revisions).have.length(1);
  });
});
