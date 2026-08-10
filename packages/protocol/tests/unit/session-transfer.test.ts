import { describe, it } from 'bun:test';
import should from 'should';
import * as transfer from '../../src/lib/session-transfer.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const AT = '2026-08-06T07:00:00.000Z';
const point = { v: 1 as const, byteOffset: 128, blockIndex: 1 };
const transcript = {
  v: 1 as const,
  home: '/home/agent/.claude',
  harnessSessionId: '11111111-2222-3333-4444-555555555555',
  identity: 'minted' as const,
  file: '/home/agent/.claude/projects/repo/11111111-2222-3333-4444-555555555555.jsonl',
  resolvedAt: AT,
};
const conversation = {
  messages: [
    { point, role: 'assistant' as const, text: 'Keep :agent and @src/index.ts byte-for-byte.', timestamp: AT },
  ],
};
const attachments = {
  attachments: [
    {
      id: `att_${'a'.repeat(64)}`,
      filename: 'evidence.pdf',
      mime: 'application/pdf',
      size: 42,
      sha256: 'a'.repeat(64),
      createdAt: AT,
      encrypted: { kind: 'pdf' as const, locked: true as const },
    },
  ],
};
const references = {
  counts: { agent: 1, file: 1, task: 0, attention: 0, skill: 0, terminal: 0, browser: 0 },
};
const workspace = {
  cwd: '/work/repo',
  head: '0123456789abcdef0123456789abcdef01234567',
  status: {
    staged: false,
    unstaged: true,
    untracked: false,
    ignored: false,
    conflicted: false,
    dirtySubmodule: false,
    truncated: false,
  },
  repositorySnapshot: null,
};
const lineage = { wardenLineage: true, warden: 'warden-1' };
const omission = {
  facet: 'workspace' as const,
  subject: '/work/repo',
  reason: 'not_implemented' as const,
  detail: 'Conversation time was rewound but filesystem state was not.',
};
const edge = {
  v: 1 as const,
  kind: 'fork' as const,
  sourceSessionId: 'session-1',
  sourceIncarnation: 'session-1-3',
  sourceHarness: 'claude' as const,
  cutMessagePoint: point,
  planId: 'transfer-plan-1',
  at: AT,
};
const plan = {
  v: 1 as const,
  planId: 'transfer-plan-1',
  preparedAt: AT,
  source: {
    sessionId: 'session-1',
    incarnation: 'session-1-3',
    runtimeGeneration: 3,
    harness: 'claude' as const,
    agent: 'claude-auto',
    model: 'opus',
    teammate: 'molli',
    name: 'Conversation',
    label: null,
    transcriptProvenance: transcript,
    cutMessagePoint: point,
  },
  target: {
    accountId: 'account-2',
    agent: 'codex-auto',
    harness: 'codex' as const,
    model: 'gpt-5',
    effort: 'high',
    contextWindow: 200_000,
  },
  durable: {
    cwd: '/work/repo',
    mode: 'auto' as const,
    parentSessionId: null,
    boardAccess: 'none' as const,
    label: null,
    harnessFlags: [],
    remoteControl: true,
    intervalSeconds: 5,
    timeoutSeconds: 600,
    nudgeAfterSeconds: 60,
    killAfterSeconds: 120,
    directSendMaxChars: 4_096,
    resumeMenuChoice: 'summary' as const,
    maxSnapshots: 10,
    retry: { transientAttempts: 2, stalledAttempts: 1, waitForQuotaReset: true, allowAccountFailover: false },
  },
  facets: { conversation, attachments, references, workspace, lineage },
  notCarried: [omission],
};

const cases: SchemaCase[] = [
  { name: 'message point', schema: transfer.ConversationMessagePointSchema, value: point },
  { name: 'conversation facet', schema: transfer.ConversationFacetSchema, value: conversation },
  { name: 'attachment facet', schema: transfer.AttachmentFacetSchema, value: attachments },
  { name: 'reference facet', schema: transfer.ReferenceFacetSchema, value: references },
  { name: 'workspace facet', schema: transfer.WorkspaceFacetSchema, value: workspace },
  { name: 'lineage facet', schema: transfer.LineageFacetSchema, value: lineage },
  { name: 'omission reason', schema: transfer.TransferOmissionReasonSchema, value: 'session_scoped' },
  { name: 'omission', schema: transfer.TransferOmissionSchema, value: omission },
  { name: 'transfer edge', schema: transfer.SessionTransferEdgeSchema, value: edge },
  { name: 'transfer plan', schema: transfer.SessionTransferPlanSchema, value: plan },
];

describe('session transfer protocol', () => {
  it('should round-trip every exported schema through strict durable values', () => {
    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(transfer, cases);
  });

  it('should keep blockIndex optional without accepting another point spelling', () => {
    // Act
    const actual = transfer.ConversationMessagePointSchema.parse({ v: 1, byteOffset: 0 });

    // Assert
    should(actual).deepEqual({ v: 1, byteOffset: 0 });
    assertRejects([
      { name: 'missing version', schema: transfer.ConversationMessagePointSchema, value: { byteOffset: 0 } },
      {
        name: 'string coordinate',
        schema: transfer.ConversationMessagePointSchema,
        value: { v: 1, byteOffset: '0:1' },
      },
      {
        name: 'UI identity',
        schema: transfer.ConversationMessagePointSchema,
        value: { v: 1, byteOffset: 0, blockId: 'record|message|uuid|0' },
      },
    ]);
  });

  it('should require every facet and the single omission inventory', () => {
    // Arrange
    const { references: _references, ...incompleteFacets } = plan.facets;
    const { notCarried: _notCarried, ...silentPlan } = plan;

    // Act + Assert
    assertRejects([
      {
        name: 'missing facet',
        schema: transfer.SessionTransferPlanSchema,
        value: { ...plan, facets: incompleteFacets },
      },
      { name: 'missing omission inventory', schema: transfer.SessionTransferPlanSchema, value: silentPlan },
      {
        name: 'unknown plan field',
        schema: transfer.SessionTransferPlanSchema,
        value: { ...plan, boardId: 'board-1' },
      },
    ]);
  });

  it('should bind a conversation cut to its source transcript and reject conversation on handover', () => {
    // Arrange
    const handover = {
      ...plan,
      source: { ...plan.source, cutMessagePoint: null, transcriptProvenance: null },
      facets: { ...plan.facets, conversation: null },
    };

    // Act + Assert
    should(transfer.SessionTransferPlanSchema.safeParse(handover).success).be.true();
    assertRejects([
      {
        name: 'unbound cut',
        schema: transfer.SessionTransferPlanSchema,
        value: { ...plan, source: { ...plan.source, transcriptProvenance: null } },
      },
      {
        name: 'conversation without cut',
        schema: transfer.SessionTransferPlanSchema,
        value: { ...handover, facets: plan.facets },
      },
      {
        name: 'handover edge with cut',
        schema: transfer.SessionTransferEdgeSchema,
        value: { ...edge, kind: 'handover' },
      },
    ]);
  });

  it('should make warden lineage name the warden it traces back to, in both directions', () => {
    // The lineage facet is the safety-critical fact a transfer carries forward, and the flag and the name
    // are one statement rather than two fields: a descent that claims a warden but names none cannot be
    // audited, and a name with the flag off would let a warden's descent be carried while reading as
    // absent. Both halves are refused so neither spelling can enter a plan.
    // Act + Assert
    should(transfer.LineageFacetSchema.safeParse({ wardenLineage: false, warden: null }).success).be.true();
    assertRejects([
      {
        name: 'lineage claimed with no warden named',
        schema: transfer.LineageFacetSchema,
        value: { wardenLineage: true, warden: null },
      },
      {
        name: 'a warden named with no lineage claimed',
        schema: transfer.LineageFacetSchema,
        value: { wardenLineage: false, warden: 'warden-1' },
      },
    ]);
  });
});
