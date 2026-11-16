/**
 * Documents the parity proofs of the stored-file (F) and job (J) rows need: a handover receipt a predecessor holds, as
 * its durable schema demands it (the plan id is the one the handover derives from the source and the request).
 */
import type { SessionHandoverReceipt } from '../../../contract/index.ts';
import { handoverPlanId } from '../../../daemon/lib/moves/handover/policy.ts';
import { AT, plan } from '../../unit/daemon/forks/fixtures.ts';

export function handoverReceiptFor(source: string, requestId: string): SessionHandoverReceipt {
  const planId = handoverPlanId(source, requestId);
  const base = plan({ sourceSessionId: source, requestId, planId });
  return {
    requestId,
    fingerprint: 'fp',
    sourceSessionId: source,
    sourceHarness: 'claude',
    sourceAgent: 'claude-main',
    reason: 'the claude account is out of quota',
    resolvedTarget: {
      replacement: {
        accountId: 'acct-codex',
        agent: 'codex-main',
        harness: 'codex',
        model: null,
        effort: null,
        contextWindow: 400_000,
      },
      coordinator: null,
    },
    planId,
    plan: {
      ...base,
      source: { ...base.source, agent: 'claude-main', cutMessagePoint: null },
      target: {
        ...base.target,
        accountId: 'acct-codex',
        agent: 'codex-main',
        harness: 'codex',
        model: null,
        effort: null,
        contextWindow: 400_000,
      },
      facets: { ...base.facets, conversation: null },
    },
    board: null,
    phase: 'requested',
    phaseHistory: [{ phase: 'requested', at: AT }],
    createdAt: AT,
    updatedAt: AT,
  };
}
