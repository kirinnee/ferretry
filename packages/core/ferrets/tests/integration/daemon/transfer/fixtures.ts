/**
 * One complete frozen plan, and the ids and instant the transfer adapters' tests share.
 *
 * Kept beside the transfer tests so they do not depend on the fork's fixtures.
 */

import type { SessionTransferPlan } from '../../../../contract/transfer.ts';

export const AT = '2026-08-06T09:00:00.000Z';
export const SOURCE_ID = '20260806-source';
export const TARGET_ID = '20260806-target';

/**
 * A complete, schema-valid plan a preparation could have produced.
 *
 * The working directory is a REAL one, because the lifecycle canonicalises it and refuses a
 * directory an agent could not have started in.
 */
export function plan(cwd: string, overrides: Partial<SessionTransferPlan> = {}): SessionTransferPlan {
  return {
    v: 1,
    planId: 'plan-fork-1',
    preparedAt: AT,
    source: {
      sessionId: SOURCE_ID,
      incarnation: `${SOURCE_ID}-1`,
      runtimeGeneration: 1,
      harness: 'claude',
      agent: 'claude-auto-source',
      model: 'claude-opus-5',
      teammate: 'alistair',
      name: 'Port The Transfer Seam',
      label: 'f117',
      transcriptProvenance: {
        v: 1,
        home: '/fleet/homes/source',
        harnessSessionId: 'harness-source',
        identity: 'minted',
        file: '/fleet/homes/source/projects/source.jsonl',
        resolvedAt: AT,
      },
      cutMessagePoint: { v: 1, byteOffset: 512, blockIndex: 0 },
    },
    target: {
      accountId: 'acct-target',
      agent: 'claude-auto-zelda',
      harness: 'claude',
      model: 'claude-opus-5',
      effort: 'high',
      contextWindow: 1_000_000,
    },
    durable: {
      cwd,
      mode: 'auto',
      parentSessionId: null,
      label: 'f117',
      harnessFlags: ['--dangerously-skip-permissions'],
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
        messages: [
          { point: { v: 1, byteOffset: 0, blockIndex: 0 }, role: 'user', text: 'carry this', timestamp: AT },
          { point: { v: 1, byteOffset: 512, blockIndex: 0 }, role: 'assistant', text: 'and this', timestamp: AT },
        ],
      },
      attachments: { attachments: [] },
      references: { counts: { agent: 0, file: 0, task: 0, attention: 0, skill: 0, terminal: 0, browser: 0 } },
      workspace: { cwd, head: null, status: null, repositorySnapshot: null },
      lineage: { wardenLineage: true, warden: '20260806-warden' },
    },
    notCarried: [
      {
        facet: 'workspace',
        subject: cwd,
        reason: 'not_implemented',
        detail: 'conversation time was rewound but filesystem state was not',
      },
    ],
    ...overrides,
  };
}
