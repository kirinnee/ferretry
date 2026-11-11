import { z } from 'zod';
import {
  ConversationMessagePointSchema,
  IsoInstantSchema,
  RecordedHarnessSchema,
  TranscriptProvenanceSchema,
} from './records.ts';

/**
 * Today's transfer plan (`protocol/src/lib/session-transfer.ts`) and fork receipt (`daemon/src/lib/fork/receipt.ts`),
 * the body of each `state/ferrets/forks/<planId>.json` (the contract's `ForkFiles`). Forks are ferrets-c's; the file's
 * schema lives here so the file has one owner. Copied unchanged except: a `boardAccess` key is no longer dropped
 * before the strict durable config parses, and the two sha256 cross-checks (the plan id derived from the source and
 * request, and the decision fingerprint) stay with the daemon, which can hash.
 */

const NonNegativeIntegerSchema = z.number().int().nonnegative();
const PositiveIntegerSchema = z.number().int().positive();
const InteractionModeSchema = z.enum(['auto', 'interactive']);

/**
 * One portable message row, and the DURABLE spelling of it.
 *
 * This is the row a frozen {@link SessionTransferPlanSchema} persists, so its bytes are a
 * compatibility surface: a plan written before this export existed must still parse afterwards. It
 * therefore carries NO selection-integrity binding. A binding is evidence about a request that is
 * being made now — it is checked once, before anything is claimed — and a value stored inside a plan
 * that replays after a restart would be evidence of nothing by the time anything read it.
 *
 * It is exported so the point-bearing READ row can extend it rather than respell it. Extending is
 * what keeps one message shape in the repository: a second literal would be a copy that drifts, and
 * the half that drifted would describe a message the other half cannot build a plan from. The
 * extension direction is one-way on purpose — this module must never import the read row back, or
 * the durable plan would inherit a field no stored plan has.
 */
export const ConversationTransferMessageSchema = z.strictObject({
  point: ConversationMessagePointSchema,
  role: z.enum(['user', 'assistant', 'developer', 'system']),
  text: z.string(),
  timestamp: IsoInstantSchema.optional(),
});
export type ConversationTransferMessage = z.infer<typeof ConversationTransferMessageSchema>;

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
  createdAt: IsoInstantSchema,
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
  /** The later spelling of `attention`. Accepted now, written only from the agenda removal release: this object is strict, so an older reader refuses a key it does not know. */
  agenda: NonNegativeIntegerSchema.optional(),
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
  harness: RecordedHarnessSchema,
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
  harness: RecordedHarnessSchema,
  model: z.string().min(1).nullable(),
  effort: z.string().min(1).nullable(),
  contextWindow: PositiveIntegerSchema,
  /**
   * Whether the person CHOSE `model` or it is the account's default, frozen with it. A transfer's
   * binder records this on the new session, so a later move can tell a pick from a default; it is never
   * inferred from re-planning. Absent on a plan written before this field, which records nothing.
   */
  modelSource: z.enum(['requested', 'account-default']).optional(),
});

const SessionTransferDurableConfigShapeSchema = z.strictObject({
  cwd: z.string().min(1),
  mode: InteractionModeSchema,
  parentSessionId: z.null(),
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

// Today a preprocess dropped a `boardAccess` key nothing honours any more before this strict parse; the contract refuses it.
const SessionTransferDurableConfigSchema = SessionTransferDurableConfigShapeSchema;

const SessionTransferFacetsSchema = z.strictObject({
  conversation: ConversationFacetSchema.nullable(),
  attachments: AttachmentFacetSchema,
  references: ReferenceFacetSchema,
  workspace: WorkspaceFacetSchema,
  lineage: LineageFacetSchema,
});

/** A complete, serializable decision replayed without re-deriving its source decisions. */
export const SessionTransferPlanSchema = z
  .strictObject({
    v: z.literal(1),
    planId: z.string().min(1),
    preparedAt: IsoInstantSchema,
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
    if (carriesConversation && value.facets.conversation?.messages.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'a fork cut must carry the message it names',
        path: ['facets', 'conversation', 'messages'],
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

/**
 * The phases, in the only order a fork may pass through them.
 *
 * The array IS the ordering: rank is its index, so a phase cannot be added without deciding where
 * in the sequence it belongs, and no second table can drift from it.
 */
export const SESSION_FORK_PHASES = [
  /** Prepared, and this exact plan and target id are durably reserved. Nothing is created yet. */
  'claimed',
  /** The fresh target session record exists, under the reserved id. */
  'target_created',
  /** The parsed plan is persisted beneath the target, so the import replays it rather than a new one. */
  'plan_persisted',
  /** The target-bound import applied the plan and produced its report. */
  'imported',
  /** The target's OWN transcript provenance has been captured — never the source's, copied. */
  'provenance_captured',
  /** The target is started and the fork is durably done. */
  'completed',
] as const;

export const SessionForkPhaseSchema = z.enum(SESSION_FORK_PHASES);
export type SessionForkPhase = z.infer<typeof SessionForkPhaseSchema>;

/** Where a phase sits in the sequence. Higher is later; equality is not progress. */
export function sessionForkPhaseRank(phase: SessionForkPhase): number {
  return SESSION_FORK_PHASES.indexOf(phase);
}

/**
 * The operational facts the import materialised, in the shape the receipt stores them.
 *
 * Structurally the transfer seam's own import outcome. It is re-declared as a SCHEMA here because
 * this value comes back off disk after a restart and an interface cannot parse anything; the unit
 * tests assert the two agree in both directions so the copy cannot drift into a second definition.
 * Omissions are deliberately absent: `receipt.plan.notCarried` is their sole durable fact owner.
 */
export const SessionForkImportReportSchema = z.strictObject({
  briefPath: z.string().min(1),
  copiedAttachmentIds: z.array(z.string().min(1)).readonly(),
});
export type SessionForkImportReport = z.infer<typeof SessionForkImportReportSchema>;

const SessionForkPhaseStampSchema = z.strictObject({
  phase: SessionForkPhaseSchema,
  at: IsoInstantSchema,
});

const SessionForkFingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * The whole durable value, parsed rather than asserted.
 *
 * Every cross-field rule below is a property a replay depends on, which is why they are refinements
 * on the schema and not comments: a receipt that violates one is refused on the way IN, before it
 * can be used to decide whether a session has already been created.
 */
export const SessionForkReceiptSchema = z
  .strictObject({
    v: z.literal(1),
    /** The outer storage anchor; it must equal both the nested plan id and the derived key id. */
    planId: z.string().min(1),
    sourceSessionId: z.string().min(1),
    requestId: z.string().min(1),
    /** Lets replay reject a changed caller payload without re-reading a moving source. */
    requestFingerprint: SessionForkFingerprintSchema,
    /** Recomputed identity of the explicit target and complete parsed plan. */
    fingerprint: SessionForkFingerprintSchema,
    /** Reserved before creation and reused by every replay, so one fork has one target forever. */
    targetSessionId: z.string().min(1),
    /** The exact decision preparation made. Replayed, never re-derived. */
    plan: SessionTransferPlanSchema,
    phase: SessionForkPhaseSchema,
    /** Append-only, so a restart can see which boundaries were crossed and when. */
    phaseHistory: z.array(SessionForkPhaseStampSchema).min(1).readonly(),
    report: SessionForkImportReportSchema.nullable(),
    createdAt: IsoInstantSchema,
    updatedAt: IsoInstantSchema,
  })
  .superRefine((value, context) => {
    // The plan id derived from (source, request) and the decision fingerprint are sha256 checks: the daemon's
    // `parseSessionForkReceipt` adds them, because a contract imports no hashing.
    if (value.plan.planId !== value.planId)
      context.addIssue({
        code: 'custom',
        message: 'the nested transfer plan id must equal the receipt plan id',
        path: ['plan', 'planId'],
      });

    if (value.plan.source.sessionId !== value.sourceSessionId)
      context.addIssue({
        code: 'custom',
        message: 'the receipt must name the source its own transfer plan was prepared from',
        path: ['sourceSessionId'],
      });

    if (value.plan.source.cutMessagePoint === null)
      context.addIssue({
        code: 'custom',
        message: 'a fork carries a conversation, so its plan must name the exact message it was cut at',
        path: ['plan', 'source', 'cutMessagePoint'],
      });

    if (value.targetSessionId === value.sourceSessionId)
      context.addIssue({
        code: 'custom',
        message: 'a fork always creates a fresh session and never writes into the one it read',
        path: ['targetSessionId'],
      });

    const ranks = value.phaseHistory.map(stamp => sessionForkPhaseRank(stamp.phase));
    if (value.phaseHistory.at(0)?.phase !== 'claimed')
      context.addIssue({
        code: 'custom',
        message: 'a fork begins by claiming its receipt: nothing precedes the claim',
        path: ['phaseHistory', 0],
      });
    if (!ranks.every((rank, index) => index === 0 || rank === (ranks[index - 1] ?? -1) + 1))
      context.addIssue({
        code: 'custom',
        message: 'the phase history records every boundary exactly once and in order',
        path: ['phaseHistory'],
      });
    if (value.phaseHistory.at(-1)?.phase !== value.phase)
      context.addIssue({
        code: 'custom',
        message: 'the current phase is the last one the history recorded',
        path: ['phase'],
      });

    if (value.phaseHistory.at(0)?.at !== value.createdAt)
      context.addIssue({
        code: 'custom',
        message: 'the claim stamp and receipt creation time must agree',
        path: ['createdAt'],
      });
    if (value.phaseHistory.at(-1)?.at !== value.updatedAt)
      context.addIssue({
        code: 'custom',
        message: 'the last phase stamp and receipt update time must agree',
        path: ['updatedAt'],
      });
    if (value.plan.preparedAt !== value.createdAt)
      context.addIssue({
        code: 'custom',
        message: 'the frozen plan and the claim that owns it must share one decision time',
        path: ['plan', 'preparedAt'],
      });

    const imported = sessionForkPhaseRank(value.phase) >= sessionForkPhaseRank('imported');
    if (imported !== (value.report !== null))
      context.addIssue({
        code: 'custom',
        message: 'the import report exists exactly once the import has run, and never before it',
        path: ['report'],
      });
  });
export type SessionForkReceipt = z.infer<typeof SessionForkReceiptSchema>;
