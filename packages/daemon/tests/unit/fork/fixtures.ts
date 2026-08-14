import type { SessionTransferPlan, TranscriptProvenance } from '@ferretry/protocol';
import type { SessionForkCommand } from '../../../src/lib/fork/identity.ts';
import type { SessionForkImportReport } from '../../../src/lib/fork/receipt.ts';
import { deriveTransferPlanId } from '../../../src/lib/transfer/prepare.ts';
import type { TransferTargetChoice } from '../../../src/lib/transfer/types.ts';

export const AT = '2026-08-06T07:00:00.000Z';

const PROVENANCE: TranscriptProvenance = {
  v: 1,
  home: '/home/agent/.claude',
  identity: 'minted',
  harnessSessionId: 'harness-1',
  file: '/home/agent/.claude/projects/x/harness-1.jsonl',
};

export function target(overrides: Partial<TransferTargetChoice> = {}): TransferTargetChoice {
  return {
    accountId: 'account-b',
    agent: 'account-b',
    harness: 'codex',
    model: 'gpt',
    effort: 'high',
    contextWindow: 200_000,
    ...overrides,
  };
}

export function command(overrides: Partial<SessionForkCommand> = {}): SessionForkCommand {
  return {
    through: { v: 1, byteOffset: 512, blockIndex: 0 },
    selectionBinding: 'selection-binding-1',
    agent: 'account-b',
    model: 'gpt',
    effort: 'high',
    ...overrides,
  };
}

/** A complete, schema-valid plan, so a receipt built from it is one preparation could have produced. */
export function plan(
  overrides: { sourceSessionId?: string; requestId?: string; planId?: string; preparedAt?: string } = {},
): SessionTransferPlan {
  const sourceSessionId = overrides.sourceSessionId ?? 'source-a';
  const requestId = overrides.requestId ?? 'req-1';
  return {
    v: 1,
    planId: overrides.planId ?? deriveTransferPlanId(sourceSessionId, requestId),
    preparedAt: overrides.preparedAt ?? AT,
    source: {
      sessionId: sourceSessionId,
      incarnation: 'inc-1',
      runtimeGeneration: 3,
      harness: 'claude',
      agent: 'account-a',
      model: 'opus',
      teammate: null,
      name: 'zelda',
      label: 'teammate',
      transcriptProvenance: PROVENANCE,
      cutMessagePoint: { v: 1, byteOffset: 512, blockIndex: 0 },
    },
    target: target(),
    durable: {
      cwd: '/work/repo',
      mode: 'auto',
      parentSessionId: null,
      boardAccess: 'none',
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

/** A plan that carries no conversation at all — what a fork must never be built from. */
export function conversationlessPlan(): SessionTransferPlan {
  const base = plan();
  return {
    ...base,
    source: { ...base.source, cutMessagePoint: null },
    facets: { ...base.facets, conversation: null },
  };
}

export function report(overrides: Partial<SessionForkImportReport> = {}): SessionForkImportReport {
  return {
    briefPath: '/state/sessions/target-1/turns/turn-001.md',
    copiedAttachmentIds: [`att_${'a'.repeat(64)}`],
    ...overrides,
  };
}
