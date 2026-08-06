import { z } from 'zod';
import { InstantSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';
import { HarnessSchema, InteractionModeSchema, TranscriptProvenanceSchema } from './session.ts';

/**
 * One durable message inside a provenance-bound harness transcript.
 *
 * A record id is not usable here: every harness may omit it, while the JSONL
 * reader assigns a byte offset to every record. A block index distinguishes
 * multiple normalized messages emitted by the same record.
 */
export const ConversationMessagePointSchema = z.strictObject({
  v: z.literal(1),
  byteOffset: NonNegativeIntegerSchema,
  blockIndex: NonNegativeIntegerSchema.optional(),
});
export type ConversationMessagePoint = z.infer<typeof ConversationMessagePointSchema>;

const ConversationTransferMessageSchema = z.strictObject({
  point: ConversationMessagePointSchema,
  role: z.enum(['user', 'assistant', 'developer', 'system']),
  text: z.string(),
  timestamp: InstantSchema.optional(),
});

/** Portable normalized content. The source transcript provenance is pinned on the plan source. */
export const ConversationFacetSchema = z.strictObject({
  messages: z.array(ConversationTransferMessageSchema).readonly(),
});
export type ConversationFacet = z.infer<typeof ConversationFacetSchema>;

const PlannedAttachmentSchema = z.strictObject({
  id: z.string().regex(/^att_[0-9a-f]{64}$/u),
  filename: z.string().min(1),
  mime: z.string().min(1),
  size: NonNegativeIntegerSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  createdAt: InstantSchema,
  encrypted: z.strictObject({ kind: z.literal('pdf'), locked: z.literal(true) }).nullable(),
});

/** Attachment identities and manifests. Original bytes remain daemon-local and are copied by id. */
export const AttachmentFacetSchema = z.strictObject({
  attachments: z.array(PlannedAttachmentSchema).readonly(),
});
export type AttachmentFacet = z.infer<typeof AttachmentFacetSchema>;

const ReferenceCountsSchema = z.strictObject({
  agent: NonNegativeIntegerSchema,
  file: NonNegativeIntegerSchema,
  task: NonNegativeIntegerSchema,
  attention: NonNegativeIntegerSchema,
  skill: NonNegativeIntegerSchema,
  terminal: NonNegativeIntegerSchema,
  browser: NonNegativeIntegerSchema,
});

/** References are copied as message bytes and re-proved; this inventory exists only for reporting. */
export const ReferenceFacetSchema = z.strictObject({
  counts: ReferenceCountsSchema,
});
export type ReferenceFacet = z.infer<typeof ReferenceFacetSchema>;

const WorkspaceStatusSchema = z.strictObject({
  staged: z.boolean(),
  unstaged: z.boolean(),
  untracked: z.boolean(),
  ignored: z.boolean(),
  conflicted: z.boolean(),
  dirtySubmodule: z.boolean(),
  truncated: z.boolean(),
});

/**
 * Workspace evidence, not a restoration claim. Repository snapshots do not
 * exist in this build, so the field is deliberately and visibly hard-null.
 */
export const WorkspaceFacetSchema = z.strictObject({
  cwd: z.string().min(1),
  head: z.string().min(1).nullable(),
  status: WorkspaceStatusSchema.nullable(),
  repositorySnapshot: z.null(),
});
export type WorkspaceFacet = z.infer<typeof WorkspaceFacetSchema>;

/** The safety-critical warden descent fact carried monotonically into the new session. */
export const LineageFacetSchema = z
  .strictObject({
    wardenLineage: z.boolean(),
    warden: z.string().min(1).nullable(),
  })
  .superRefine((value, context) => {
    if (value.wardenLineage !== (value.warden !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'warden lineage must name the warden it traces back to',
        path: ['warden'],
      });
    }
  });
export type LineageFacet = z.infer<typeof LineageFacetSchema>;

export const TransferOmissionReasonSchema = z.enum([
  'harness_incompatible',
  'session_scoped',
  'credential',
  'unavailable',
  'not_implemented',
]);
export type TransferOmissionReason = z.infer<typeof TransferOmissionReasonSchema>;

export const TransferOmissionSchema = z.strictObject({
  facet: z.enum(['conversation', 'attachments', 'references', 'workspace', 'lineage', 'runtime']),
  subject: z.string().min(1),
  reason: TransferOmissionReasonSchema,
  detail: z.string().min(1),
});
export type TransferOmission = z.infer<typeof TransferOmissionSchema>;

export const SessionTransferEdgeSchema = z
  .strictObject({
    v: z.literal(1),
    kind: z.enum(['handover', 'fork']),
    sourceSessionId: z.string().min(1),
    sourceIncarnation: z.string().min(1),
    sourceHarness: HarnessSchema,
    cutMessagePoint: ConversationMessagePointSchema.nullable(),
    planId: z.string().min(1),
    at: InstantSchema,
  })
  .superRefine((value, context) => {
    const shouldCarryConversation = value.kind === 'fork';
    if (shouldCarryConversation !== (value.cutMessagePoint !== null)) {
      context.addIssue({
        code: 'custom',
        message:
          value.kind === 'fork' ? 'a fork must name its exact message cut' : 'a handover has no conversation cut',
        path: ['cutMessagePoint'],
      });
    }
  });
export type SessionTransferEdge = z.infer<typeof SessionTransferEdgeSchema>;

const TransferRetryPolicySchema = z.strictObject({
  transientAttempts: NonNegativeIntegerSchema,
  stalledAttempts: NonNegativeIntegerSchema,
  waitForQuotaReset: z.boolean(),
  allowAccountFailover: z.boolean(),
});

const SessionTransferSourceSchema = z.strictObject({
  sessionId: z.string().min(1),
  incarnation: z.string().min(1),
  runtimeGeneration: PositiveIntegerSchema,
  harness: HarnessSchema,
  agent: z.string().min(1),
  model: z.string().min(1).nullable(),
  teammate: z.string().min(1).nullable(),
  name: z.string().min(1),
  label: z.string().min(1).nullable(),
  transcriptProvenance: TranscriptProvenanceSchema.nullable(),
  cutMessagePoint: ConversationMessagePointSchema.nullable(),
});

const SessionTransferTargetSchema = z.strictObject({
  accountId: z.string().min(1),
  agent: z.string().min(1),
  harness: HarnessSchema,
  model: z.string().min(1).nullable(),
  effort: z.string().min(1).nullable(),
  contextWindow: PositiveIntegerSchema,
});

const SessionTransferDurableConfigSchema = z.strictObject({
  cwd: z.string().min(1),
  mode: InteractionModeSchema,
  parentSessionId: z.null(),
  boardAccess: z.literal('none'),
  label: z.string().min(1).nullable(),
  harnessFlags: z.array(z.string()).readonly(),
  remoteControl: z.boolean(),
  intervalSeconds: PositiveIntegerSchema,
  timeoutSeconds: NonNegativeIntegerSchema,
  nudgeAfterSeconds: NonNegativeIntegerSchema,
  killAfterSeconds: NonNegativeIntegerSchema,
  directSendMaxChars: NonNegativeIntegerSchema,
  resumeMenuChoice: z.enum(['full', 'summary']),
  maxSnapshots: PositiveIntegerSchema,
  retry: TransferRetryPolicySchema,
});

const SessionTransferFacetsSchema = z.strictObject({
  conversation: ConversationFacetSchema.nullable(),
  attachments: AttachmentFacetSchema,
  references: ReferenceFacetSchema,
  workspace: WorkspaceFacetSchema,
  lineage: LineageFacetSchema,
});

/** A complete, serializable decision that can be persisted and replayed without re-reading its source. */
export const SessionTransferPlanSchema = z
  .strictObject({
    v: z.literal(1),
    planId: z.string().min(1),
    preparedAt: InstantSchema,
    source: SessionTransferSourceSchema,
    target: SessionTransferTargetSchema,
    durable: SessionTransferDurableConfigSchema,
    facets: SessionTransferFacetsSchema,
    notCarried: z.array(TransferOmissionSchema).readonly(),
  })
  .superRefine((value, context) => {
    const carriesConversation = value.source.cutMessagePoint !== null;
    if (carriesConversation !== (value.facets.conversation !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'cutMessagePoint null is the sole representation of a transfer with no conversation',
        path: ['facets', 'conversation'],
      });
    }
    if (carriesConversation && value.source.transcriptProvenance === null) {
      context.addIssue({
        code: 'custom',
        message: 'a conversation cut must be bound to the source transcript provenance',
        path: ['source', 'transcriptProvenance'],
      });
    }
  });
export type SessionTransferPlan = z.infer<typeof SessionTransferPlanSchema>;
