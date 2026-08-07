import { describe, expect, it } from 'bun:test';
import type { ConversationMessagePoint, SessionTransferPlan } from '@ferretry/protocol';
import {
  SessionForkError,
  type SessionForkFailure,
  SessionForkPhaseRegressionError,
  SessionForkReceiptInvalidError,
  SessionForkRequestConflictError,
} from '../../../src/lib/fork/failures.ts';
import {
  canonicalSessionForkDecision,
  canonicalSessionForkPayload,
  type SessionForkKey,
  sessionForkDecisionFingerprint,
  sessionForkFingerprint,
  sessionForkKey,
} from '../../../src/lib/fork/identity.ts';
import {
  advanceSessionForkReceipt,
  claimSessionForkReceipt,
  parseSessionForkReceipt,
  SESSION_FORK_PHASES,
  type SessionForkPhase,
  type SessionForkReceipt,
  sessionForkPhaseRank,
  sessionForkReport,
} from '../../../src/lib/fork/receipt.ts';
import { AT, command, conversationlessPlan, plan, report } from './fixtures.ts';

const KEY: SessionForkKey = { sourceSessionId: 'source-a', requestId: 'req-1' };

const REQUEST_FINGERPRINT = sessionForkFingerprint(command());

function claimed(overrides: Partial<SessionForkKey> = {}): SessionForkReceipt {
  const key = { ...KEY, ...overrides };
  return claimSessionForkReceipt({
    key,
    requestFingerprint: REQUEST_FINGERPRINT,
    targetSessionId: 'target-1',
    plan: plan({ sourceSessionId: key.sourceSessionId, requestId: key.requestId }),
    at: AT,
  });
}

/** Drives a receipt forward the way the service does, so a test can start from any phase. */
function at(phase: SessionForkPhase): SessionForkReceipt {
  let receipt = claimed();
  for (const next of SESSION_FORK_PHASES.slice(1, sessionForkPhaseRank(phase) + 1))
    receipt = advanceSessionForkReceipt(receipt, {
      phase: next,
      at: AT,
      report: next === 'imported' ? report() : undefined,
    });
  return receipt;
}

/** The refusal a doctored document produces, so a test can assert on the reason it gives. */
function refusal(document: unknown, key: SessionForkKey = KEY): SessionForkReceiptInvalidError {
  try {
    parseSessionForkReceipt(document, key);
  } catch (error) {
    if (error instanceof SessionForkReceiptInvalidError) return error;
    throw error;
  }
  throw new Error('the document was accepted as a receipt');
}

describe('sessionForkKey', () => {
  it('separates one caller-minted request id across two sources', () => {
    expect(sessionForkKey({ sourceSessionId: 'source-a', requestId: 'req-1' })).not.toBe(
      sessionForkKey({ sourceSessionId: 'source-b', requestId: 'req-1' }),
    );
    expect(sessionForkKey(KEY)).toBe(sessionForkKey({ sourceSessionId: 'source-a', requestId: 'req-1' }));
  });
});

describe('canonicalSessionForkPayload', () => {
  it('carries every field the caller decided, in a fixed order', () => {
    expect(canonicalSessionForkPayload(command())).toBe(
      JSON.stringify(['session-fork', 2, 1, 512, 0, 'selection-binding-1', 'account-b', 'gpt', 'high']),
    );
  });

  it('records an unstated model and effort as null rather than dropping them', () => {
    expect(canonicalSessionForkPayload(command({ model: null, effort: null }))).toBe(
      JSON.stringify(['session-fork', 2, 1, 512, 0, 'selection-binding-1', 'account-b', null, null]),
    );
  });

  it('distinguishes two normalized messages emitted by one transcript record', () => {
    expect(canonicalSessionForkPayload(command({ through: { v: 1, byteOffset: 512, blockIndex: 1 } }))).not.toBe(
      canonicalSessionForkPayload(command({ through: { v: 1, byteOffset: 512, blockIndex: 2 } })),
    );
  });

  /**
   * The cast anticipates a `v: 2` point the protocol has not minted yet: the schema pins `v: 1`
   * today, so the only way to prove the version participates in identity is to hand the
   * canonicaliser the shape a later version would have. Without it, a `v: 2` point at the same
   * offset would replay a `v: 1` fork and silently cut somewhere else.
   */
  it('treats a later point version as a different message', () => {
    const later = { v: 2, byteOffset: 512, blockIndex: 0 } as unknown as ConversationMessagePoint;
    expect(canonicalSessionForkPayload(command({ through: later }))).not.toBe(canonicalSessionForkPayload(command()));
  });
});

describe('sessionForkFingerprint', () => {
  it('is stable for one payload and different for another', () => {
    expect(sessionForkFingerprint(command())).toBe(sessionForkFingerprint(command()));
    expect(sessionForkFingerprint(command({ agent: 'account-c' }))).not.toBe(sessionForkFingerprint(command()));
    expect(sessionForkFingerprint(command({ through: { v: 1, byteOffset: 513, blockIndex: 0 } }))).not.toBe(
      sessionForkFingerprint(command()),
    );
    expect(sessionForkFingerprint(command({ selectionBinding: 'selection-binding-2' }))).not.toBe(
      sessionForkFingerprint(command()),
    );
  });
});

describe('sessionForkDecisionFingerprint', () => {
  const identity = (frozenPlan = plan(), targetSessionId = 'target-1') => ({
    key: KEY,
    requestFingerprint: REQUEST_FINGERPRINT,
    targetSessionId,
    plan: frozenPlan,
  });

  it('is stable across object insertion order and binds the explicit target', () => {
    const frozen = plan();
    const reordered = {
      notCarried: frozen.notCarried,
      facets: frozen.facets,
      durable: frozen.durable,
      target: frozen.target,
      source: frozen.source,
      preparedAt: frozen.preparedAt,
      planId: frozen.planId,
      v: frozen.v,
    };

    expect(canonicalSessionForkDecision(identity(reordered))).toBe(canonicalSessionForkDecision(identity(frozen)));
    expect(sessionForkDecisionFingerprint(identity(frozen, 'target-2'))).not.toBe(
      sessionForkDecisionFingerprint(identity(frozen)),
    );
  });

  /**
   * The casts below are the point of these three tests, not a shortcut around a type. A
   * `SessionTransferPlan` has fixed keys, so it cannot exhibit the ordering hazards the
   * canonicaliser exists to remove; handing the canonicaliser the shapes that CAN is the only way to
   * pin its contract. It takes `unknown` and walks whatever it is given, so these exercise exactly
   * the code a real plan runs through.
   */
  it('orders nested keys by code unit rather than by the host locale', () => {
    const collationTrap = { B: 1, a: 2, Z: 3, b: 4 } as unknown as SessionTransferPlan;

    // Code units: 'B'(0x42) < 'Z'(0x5a) < 'a'(0x61) < 'b'(0x62). A collation-based comparison
    // interleaves case and answers a, B, b, Z instead — a different on-disk spelling, and therefore
    // a different durable fingerprint, on a host whose ICU data or locale differs from this one.
    expect(canonicalSessionForkDecision(identity(collationTrap))).toContain('{"B":1,"Z":3,"a":2,"b":4}');
  });

  it('spells a nested value one way however deeply its insertion order differs', () => {
    const one = { outer: { b: 1, a: { d: 2, c: 3 } }, top: 0 } as unknown as SessionTransferPlan;
    const two = { top: 0, outer: { a: { c: 3, d: 2 }, b: 1 } } as unknown as SessionTransferPlan;

    expect(sessionForkDecisionFingerprint(identity(one))).toBe(sessionForkDecisionFingerprint(identity(two)));
  });

  it('preserves array order, because a reordered list is a different decision', () => {
    const forward = { steps: ['one', 'two'] } as unknown as SessionTransferPlan;
    const backward = { steps: ['two', 'one'] } as unknown as SessionTransferPlan;

    expect(sessionForkDecisionFingerprint(identity(forward))).not.toBe(
      sessionForkDecisionFingerprint(identity(backward)),
    );
  });

  it('fingerprints every resolved target decision and every full-plan facet', () => {
    const frozen = plan();
    const frozenMessage = frozen.facets.conversation?.messages[0];
    if (frozenMessage === undefined) throw new Error('the fork fixture must carry one message');
    const changed: readonly SessionTransferPlan[] = [
      { ...frozen, target: { ...frozen.target, accountId: 'account-z' } },
      { ...frozen, target: { ...frozen.target, model: 'gpt-mini' } },
      { ...frozen, target: { ...frozen.target, effort: 'xhigh' } },
      { ...frozen, durable: { ...frozen.durable, timeoutSeconds: frozen.durable.timeoutSeconds + 1 } },
      {
        ...frozen,
        facets: {
          ...frozen.facets,
          conversation: { messages: [{ ...frozenMessage, text: 'source changed' }] },
        },
      },
      {
        ...frozen,
        facets: {
          ...frozen.facets,
          attachments: {
            attachments: [
              {
                id: `att_${'a'.repeat(64)}`,
                filename: 'a.txt',
                mime: 'text/plain',
                size: 1,
                sha256: 'a'.repeat(64),
                createdAt: AT,
                encrypted: null,
              },
            ],
          },
        },
      },
      {
        ...frozen,
        facets: {
          ...frozen.facets,
          references: { counts: { ...frozen.facets.references.counts, file: 1 } },
        },
      },
      { ...frozen, facets: { ...frozen.facets, workspace: { ...frozen.facets.workspace, head: 'def456' } } },
      {
        ...frozen,
        facets: { ...frozen.facets, lineage: { wardenLineage: true, warden: 'warden-1' } },
      },
      {
        ...frozen,
        notCarried: [
          { facet: 'workspace', subject: '/work/repo', reason: 'not_implemented', detail: 'snapshot absent' },
        ],
      },
    ];
    const original = sessionForkDecisionFingerprint(identity(frozen));

    for (const candidate of changed) expect(sessionForkDecisionFingerprint(identity(candidate))).not.toBe(original);
  });
});

describe('SESSION_FORK_PHASES', () => {
  it('ranks every phase by where it sits in the sequence', () => {
    expect(sessionForkPhaseRank('claimed')).toBe(0);
    expect(sessionForkPhaseRank('completed')).toBe(SESSION_FORK_PHASES.length - 1);
    expect(sessionForkPhaseRank('imported')).toBeGreaterThan(sessionForkPhaseRank('plan_persisted'));
    expect(sessionForkPhaseRank('provenance_captured')).toBeLessThan(sessionForkPhaseRank('completed'));
  });
});

describe('claimSessionForkReceipt', () => {
  it('reserves a target and an exact plan with no work recorded against it', () => {
    const receipt = claimed();
    expect(receipt.phase).toBe('claimed');
    expect(receipt.phaseHistory).toEqual([{ phase: 'claimed', at: AT }]);
    expect(receipt.targetSessionId).toBe('target-1');
    expect(receipt.planId).toBe(plan().planId);
    expect(receipt.requestFingerprint).toBe(REQUEST_FINGERPRINT);
    expect(receipt.fingerprint).toBe(
      sessionForkDecisionFingerprint({
        key: KEY,
        requestFingerprint: REQUEST_FINGERPRINT,
        targetSessionId: 'target-1',
        plan: plan(),
      }),
    );
    expect(receipt.report).toBeNull();
    expect(receipt.plan.source.cutMessagePoint).toEqual({ v: 1, byteOffset: 512, blockIndex: 0 });
  });

  it('refuses a target that is the source it was prepared from', () => {
    expect(() =>
      claimSessionForkReceipt({
        key: KEY,
        requestFingerprint: REQUEST_FINGERPRINT,
        targetSessionId: 'source-a',
        plan: plan(),
        at: AT,
      }),
    ).toThrow(/fresh session/u);
  });

  it('refuses a plan prepared from a different source', () => {
    expect(() =>
      claimSessionForkReceipt({
        key: KEY,
        requestFingerprint: REQUEST_FINGERPRINT,
        targetSessionId: 'target-1',
        plan: plan({ sourceSessionId: 'source-z' }),
        at: AT,
      }),
    ).toThrow(/its own transfer plan/u);
  });

  it('refuses a plan that carries no conversation, because a fork always carries one', () => {
    expect(() =>
      claimSessionForkReceipt({
        key: KEY,
        requestFingerprint: REQUEST_FINGERPRINT,
        targetSessionId: 'target-1',
        plan: conversationlessPlan(),
        at: AT,
      }),
    ).toThrow(/exact message/u);
  });
});

describe('parseSessionForkReceipt', () => {
  it('refuses a document that is not a receipt at all', () => {
    expect(refusal({ v: 1 }).failure).toBe('receipt_invalid');
  });

  it('refuses a receipt the store answered with for another pair', () => {
    const error = refusal(claimed({ requestId: 'req-2' }));
    expect(error.detail).toContain('req-2');
    expect(error.message).toContain('req-1');
  });

  it('refuses a corrupt outer or nested plan anchor', () => {
    expect(refusal({ ...claimed(), planId: 'plan-b' }).detail).toContain('outer plan id');
    expect(refusal({ ...claimed(), plan: { ...claimed().plan, planId: 'plan-b' } }).detail).toContain(
      'nested transfer plan id',
    );
  });

  it('refuses a nested source, target, or fingerprint that no longer matches the frozen decision', () => {
    const receipt = claimed();
    expect(
      refusal({ ...receipt, plan: { ...receipt.plan, source: { ...receipt.plan.source, sessionId: 'source-z' } } })
        .detail,
    ).toContain('source its own transfer plan');
    expect(refusal({ ...receipt, targetSessionId: 'target-z' }).detail).toContain('complete parsed plan');
    expect(refusal({ ...receipt, fingerprint: '0'.repeat(64) }).detail).toContain('complete parsed plan');
    expect(refusal({ ...receipt, requestFingerprint: 'not-a-digest' }).detail).toContain('Invalid string');
  });

  it('strictly parses every history entry and refuses a skipped boundary', () => {
    const receipt = claimed();
    expect(
      refusal({
        ...receipt,
        phaseHistory: [{ ...receipt.phaseHistory[0], unexpected: true }],
      }).detail,
    ).toContain('Unrecognized key');
    expect(
      refusal({
        ...receipt,
        phase: 'plan_persisted',
        phaseHistory: [receipt.phaseHistory[0], { phase: 'plan_persisted', at: AT }],
      }).detail,
    ).toContain('every boundary exactly once and in order');
  });

  it('refuses a history that does not begin at the claim', () => {
    const receipt = { ...claimed(), phase: 'target_created', phaseHistory: [{ phase: 'target_created', at: AT }] };
    expect(refusal(receipt).detail).toContain('nothing precedes the claim');
  });

  it('refuses a history that moves backwards', () => {
    const receipt = {
      ...claimed(),
      phase: 'plan_persisted',
      phaseHistory: [
        { phase: 'claimed', at: AT },
        { phase: 'imported', at: AT },
        { phase: 'plan_persisted', at: AT },
      ],
    };
    expect(refusal(receipt).detail).toContain('every boundary exactly once and in order');
  });

  it('refuses a current phase the history did not record', () => {
    const receipt = {
      ...claimed(),
      phase: 'claimed',
      phaseHistory: [
        { phase: 'claimed', at: AT },
        { phase: 'target_created', at: AT },
      ],
    };
    expect(refusal(receipt).detail).toContain('the last one the history recorded');
  });

  it('refuses a report recorded before the import ran', () => {
    expect(refusal({ ...claimed(), report: report() }).detail).toContain('once the import has run');
  });

  it('refuses a completed fork carrying no report', () => {
    expect(refusal({ ...at('completed'), report: null }).detail).toContain('once the import has run');
  });

  it('accepts a receipt it produced itself', () => {
    expect(parseSessionForkReceipt(at('completed'), KEY)).toEqual(at('completed'));
  });
});

describe('advanceSessionForkReceipt', () => {
  it('appends each crossed boundary and re-stamps the update time', () => {
    const later = '2026-08-06T08:00:00.000Z';
    const receipt = advanceSessionForkReceipt(claimed(), { phase: 'target_created', at: later });
    expect(receipt.phase).toBe('target_created');
    expect(receipt.phaseHistory.map(stamp => stamp.phase)).toEqual(['claimed', 'target_created']);
    expect(receipt.createdAt).toBe(AT);
    expect(receipt.updatedAt).toBe(later);
  });

  it('carries the import report forward once it exists', () => {
    const imported = at('imported');
    expect(imported.report).toEqual(report());
    expect(advanceSessionForkReceipt(imported, { phase: 'provenance_captured', at: AT }).report).toEqual(report());
  });

  it('refuses to repeat the phase it is already at', () => {
    expect(() => advanceSessionForkReceipt(at('imported'), { phase: 'imported', at: AT })).toThrow(
      SessionForkPhaseRegressionError,
    );
  });

  it('refuses to move backwards', () => {
    const error = (() => {
      try {
        advanceSessionForkReceipt(at('completed'), { phase: 'imported', at: AT });
      } catch (thrown) {
        return thrown as SessionForkPhaseRegressionError;
      }
      throw new Error('the regression was accepted');
    })();
    expect(error.failure).toBe('phase_regression');
    expect(error.from).toBe('completed');
    expect(error.to).toBe('imported');
  });

  it('may skip no boundary it has not crossed, because the schema re-proves every rule', () => {
    // A jump straight to `completed` never reaches the import, so the report the last phase demands
    // does not exist and the advance is refused rather than written down.
    expect(() => advanceSessionForkReceipt(claimed(), { phase: 'completed', at: AT })).toThrow(
      SessionForkReceiptInvalidError,
    );
  });
});

describe('sessionForkReport', () => {
  it('answers the durable report a completed fork produced', () => {
    expect(sessionForkReport(at('completed'))).toEqual(report());
  });

  it('refuses a receipt that reached its end carrying none', () => {
    // Reachable only from a receipt this daemon wrote wrong: the schema already ties the report to
    // the phase, so the accessor refuses rather than reporting a confident "nothing was omitted".
    expect(() => sessionForkReport({ ...at('completed'), report: null })).toThrow(SessionForkReceiptInvalidError);
    expect(() => sessionForkReport({ ...at('completed'), report: null })).toThrow(/carrying no import report/u);
  });
});

describe('SessionForkRequestConflictError', () => {
  it('names the pair the id is spent on', () => {
    const error = new SessionForkRequestConflictError(KEY);
    expect(error.failure).toBe('request_conflict');
    expect(error.message).toContain('source-a');
    expect(error.message).toContain('req-1');
  });
});

describe('SessionForkError', () => {
  /**
   * The mount maps these codes onto the protocol's own fork taxonomy, so every refusal has to be
   * catchable as one type and carry a code from a closed set. A refusal reachable only as a bare
   * `Error` would arrive at the route as an unclassified failure.
   */
  it('gives every refusal one catchable base and a code from the closed set', () => {
    const codes: SessionForkFailure[] = ['request_conflict', 'receipt_invalid', 'phase_regression'];
    const refusals: readonly SessionForkError[] = [
      new SessionForkRequestConflictError(KEY),
      new SessionForkReceiptInvalidError(KEY, 'a doctored document'),
      new SessionForkPhaseRegressionError('completed', 'imported'),
    ];

    for (const error of refusals) expect(error).toBeInstanceOf(SessionForkError);
    expect(refusals.map(error => error.failure)).toEqual(codes);
    expect(refusals.map(error => error.name)).toEqual([
      'SessionForkRequestConflictError',
      'SessionForkReceiptInvalidError',
      'SessionForkPhaseRegressionError',
    ]);
  });
});
