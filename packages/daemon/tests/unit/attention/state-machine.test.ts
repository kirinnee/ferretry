import { describe, it } from 'bun:test';
import type { AttentionAsk, AttentionId, AttentionItem, AttentionResponse } from '@ferretry/protocol';
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
    should(actual.snapshot.count).equal(1);
    should(actual.snapshot.items[0]).containDeep({
      id: 'A1',
      subject: 'Provide the revised deployment window',
      waitingSince: FIRST,
      raisedBy: 'daemon',
    });
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

  it('should reject a missing, mismatched, or unlisted structured answer without hiding the item', () => {
    // Arrange
    const permission = raised();
    const choice = raised(AGENT, {
      ask: { kind: 'multiple-choice', options: [{ label: 'A' }, { label: 'B' }] },
    });
    const plain = raised(DAEMON, { source: 'task', sourceRef: 'F12', ask: undefined });

    // Act
    const missing = failed(
      applyAttentionCommand(permission.ledger, { action: 'resolve', actor: HUMAN, id: 'A1', at: SECOND }),
    );
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
    for (const actual of [missing, mismatch, outside, noAsk]) should(actual.error.code).equal('invalid');
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

  it('should resolve a plain item with the same exact-raiser guard', () => {
    // Arrange
    const own = raised(AGENT, { ask: { kind: 'permission' } });
    const plainOwn = raised(DAEMON, { source: 'task', sourceRef: 'F12', ask: undefined });

    // Act
    const agentResolveAsked = failed(
      applyAttentionCommand(own.ledger, { action: 'resolve', actor: AGENT, id: 'A1', at: SECOND }),
    );
    const wrongDaemon = failed(
      applyAttentionCommand(plainOwn.ledger, { action: 'resolve', actor: AGENT, id: 'A1', at: SECOND }),
    );
    const daemonResolve = succeeded(
      applyAttentionCommand(plainOwn.ledger, { action: 'resolve', actor: DAEMON, id: 'A1', at: SECOND }),
    );

    // Assert
    should(agentResolveAsked.error.code).equal('invalid');
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
