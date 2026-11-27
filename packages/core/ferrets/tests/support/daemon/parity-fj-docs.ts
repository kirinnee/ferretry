/**
 * Documents the parity proofs of the stored-file (F) and job (J) rows need: a handover receipt a predecessor holds, as
 * its durable schema demands it (the plan id is the one the handover derives from the source and the request).
 */
import type { SessionHandoverReceipt } from '../../../contract/index.ts';
import { handoverPlanId } from '../../../daemon/lib/moves/handover/policy.ts';
import type { SessionTransferPlan } from '../../../contract/transfer.ts';

const AT = '2026-08-06T07:00:00.000Z';

/** A complete, schema-valid transfer plan (a handover receipt carries one), every id its caller names. */
function plan(overrides: { sourceSessionId: string; requestId: string; planId: string }): SessionTransferPlan {
  return {
    v: 1,
    planId: overrides.planId,
    preparedAt: AT,
    source: {
      sessionId: overrides.sourceSessionId,
      incarnation: 'inc-1',
      runtimeGeneration: 3,
      harness: 'claude',
      agent: 'account-a',
      model: 'opus',
      teammate: null,
      name: 'zelda',
      label: 'teammate',
      transcriptProvenance: {
        v: 1,
        home: '/home/agent/.claude',
        identity: 'minted',
        harnessSessionId: 'harness-1',
        file: '/home/agent/.claude/projects/x/harness-1.jsonl',
      },
      cutMessagePoint: { v: 1, byteOffset: 512, blockIndex: 0 },
    },
    target: {
      accountId: 'account-b',
      agent: 'account-b',
      harness: 'codex',
      model: 'gpt',
      effort: 'high',
      contextWindow: 200_000,
    },
    durable: {
      cwd: '/work/repo',
      mode: 'auto',
      parentSessionId: null,
      label: 'teammate',
      harnessFlags: [],
      remoteControl: true,
      intervalSeconds: 30,
      timeoutSeconds: 600,
      nudgeAfterSeconds: 120,
      killAfterSeconds: 900,
      directSendMaxChars: 4000,
      resumeMenuChoice: 'full',
      maxSnapshots: 5,
      retry: { transientAttempts: 2, stalledAttempts: 1, waitForQuotaReset: true, allowAccountFailover: false },
    },
    facets: {
      conversation: {
        messages: [{ point: { v: 1, byteOffset: 512, blockIndex: 0 }, role: 'user', text: 'ship it', timestamp: AT }],
      },
      attachments: { attachments: [] },
      references: { counts: { agent: 0, file: 0, task: 0, attention: 0, skill: 0, terminal: 0, browser: 0 } },
      workspace: { cwd: '/work/repo', head: 'abc123', status: null, repositorySnapshot: null },
      lineage: { wardenLineage: false, warden: null },
    },
    notCarried: [],
  };
}

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
