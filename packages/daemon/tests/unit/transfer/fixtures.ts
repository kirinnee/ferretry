import type { SessionTransferPlan, TranscriptProvenance } from '@ferretry/protocol';
import type {
  TransferPrepareRequest,
  TransferSourceSession,
  TransferTargetChoice,
} from '../../../src/lib/transfer/types.ts';

export const AT = '2026-08-06T07:00:00.000Z';

const PROVENANCE: TranscriptProvenance = {
  v: 1,
  home: '/home/agent/.claude',
  identity: 'minted',
  harnessSessionId: 'harness-1',
  file: '/home/agent/.claude/projects/x/harness-1.jsonl',
};

export function sourceSession(overrides: Partial<TransferSourceSession> = {}): TransferSourceSession {
  return {
    sessionId: 'source-a',
    incarnation: 'inc-1',
    runtimeGeneration: 3,
    harness: 'claude',
    agent: 'account-a',
    model: 'opus',
    teammate: null,
    name: 'zelda',
    label: 'teammate',
    cwd: '/work/repo',
    mode: 'auto',
    remoteControl: true,
    harnessFlags: ['--flag-a', '--flag-b'],
    intervalSeconds: 30,
    timeoutSeconds: 600,
    nudgeAfterSeconds: 120,
    killAfterSeconds: 900,
    directSendMaxChars: 4000,
    resumeMenuChoice: 'full',
    maxSnapshots: 5,
    retry: { transientAttempts: 2, stalledAttempts: 1, waitForQuotaReset: true, allowAccountFailover: false },
    transcriptProvenance: PROVENANCE,
    provenance: undefined,
    ...overrides,
  };
}

export function target(overrides: Partial<TransferTargetChoice> = {}): TransferTargetChoice {
  return {
    accountId: 'account-b',
    agent: 'account-b',
    harness: 'claude',
    model: 'opus',
    effort: 'high',
    contextWindow: 200_000,
    ...overrides,
  };
}

export function request(overrides: Partial<TransferPrepareRequest> = {}): TransferPrepareRequest {
  return {
    sourceSessionId: 'source-a',
    requestId: 'req-1',
    target: target(),
    cutMessagePoint: { v: 1, byteOffset: 512, blockIndex: 0 },
    selectionBinding: 'selection-binding-1',
    preparedAt: AT,
    ...overrides,
  };
}

/** A complete, schema-valid plan, so import and brief tests start from a value prepare could have produced. */
export function plan(overrides: Partial<SessionTransferPlan> = {}): SessionTransferPlan {
  return {
    v: 1,
    planId: 'plan-1',
    preparedAt: AT,
    source: {
      sessionId: 'source-a',
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
    ...overrides,
  };
}
