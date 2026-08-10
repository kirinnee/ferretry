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
const transferMessage = {
  point,
  role: 'assistant' as const,
  text: 'Keep :agent and @src/index.ts byte-for-byte.',
  timestamp: AT,
};
const conversation = { messages: [transferMessage] };
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
  { name: 'exact message point', schema: transfer.ExactConversationMessagePointSchema, value: point },
  // A case of its OWN, never folded into the conversation facet that contains it. The read row
  // extends this base, so two exported schemas describe a message now and one case cannot stand for
  // both: the facet's case would keep passing while this base drifted underneath it.
  { name: 'transfer message', schema: transfer.ConversationTransferMessageSchema, value: transferMessage },
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
      {
        name: 'missing version',
        schema: transfer.ConversationMessagePointSchema,
        value: { byteOffset: 0 },
      },
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

  it('should preserve an empty durable conversation facet for a plan written before a cut was required', () => {
    should(transfer.ConversationFacetSchema.parse({ messages: [] })).deepEqual({ messages: [] });
  });

  it('should keep the durable message row binding-free so a plan stored before bindings still reads', () => {
    // The read row extends THIS base with a required `selectionBinding`. That evidence is about a
    // request being made now — it is verified once, before anything is claimed — so a copy frozen
    // inside a plan that replays after a restart would be evidence of nothing. A plan written before
    // the binding existed must therefore still parse, and the base must refuse to carry one.
    // Arrange — a plan exactly as it was persisted before any binding was on the wire.
    const stored = JSON.parse(JSON.stringify(plan)) as unknown;

    // Act
    const parsed = transfer.SessionTransferPlanSchema.parse(stored);

    // Assert
    should(parsed.facets.conversation?.messages).have.length(1);
    should(JSON.stringify(parsed).includes('"selectionBinding"')).be.false();
    assertRejects([
      {
        name: 'the durable row does not carry request evidence',
        schema: transfer.ConversationTransferMessageSchema,
        value: { ...transferMessage, selectionBinding: 'selection-binding-1' },
      },
      {
        name: 'and neither does the plan that stores it',
        schema: transfer.SessionTransferPlanSchema,
        value: {
          ...plan,
          facets: {
            ...plan.facets,
            conversation: { messages: [{ ...transferMessage, selectionBinding: 'selection-binding-1' }] },
          },
        },
      },
      {
        name: 'an unversioned point is not a durable row coordinate',
        schema: transfer.ConversationTransferMessageSchema,
        value: { ...transferMessage, point: { byteOffset: 128, blockIndex: 1 } },
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

  it('should require warden descent and the named warden to agree in both directions', () => {
    // Act + Assert
    should(transfer.LineageFacetSchema.safeParse(lineage).success).be.true();
    should(transfer.LineageFacetSchema.safeParse({ wardenLineage: false, warden: null }).success).be.true();
    assertRejects([
      {
        name: 'warden descent without the warden it traces to',
        schema: transfer.LineageFacetSchema,
        value: { wardenLineage: true, warden: null },
      },
      {
        name: 'a named warden without warden descent',
        schema: transfer.LineageFacetSchema,
        value: { wardenLineage: false, warden: 'warden-1' },
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
});
