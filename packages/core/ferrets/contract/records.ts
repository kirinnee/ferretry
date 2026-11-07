import { z } from 'zod';

/**
 * Today's record shapes that Ferrets' files carry (§9.2), moved here so each has ONE owner: the daemon's protocol
 * copies (`daemon/lib/protocol/{common,session-base,session-provenance,session-transfer-edge,session}.ts`) re-export
 * them. Copied from today's `packages/protocol/src/lib`, unchanged except where a comment says so.
 */

/** An ISO-8601 instant with an explicit timezone, kept as written (today's protocol `InstantSchema`). */
export const IsoInstantSchema = z.iso.datetime({ offset: true });

const NonNegativeIntegerSchema = z.number().int().nonnegative();

/**
 * Today's session id as its journal and archive store it (`lib/session-id.ts`): lowercase and path-safe. Narrower than
 * {@link FerretIdSchema}'s grammar on purpose: a journal names the directory it lives in.
 */
export const StoredSessionIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,127}$/, 'session id must be 1-128 lowercase ASCII path-safe characters')
  .brand<'SessionId'>();

/** The harness family today's records name (`claude`, `codex`; today's `HarnessSchema`). */
export const RecordedHarnessSchema = z.enum(['claude', 'codex']);

/** Where a session stands, as today's wire spells it (`SessionStatusSchema`): the fork's summary names one. */
export const SessionStatusSchema = z.enum([
  'created',
  'starting',
  'running',
  'thinking',
  'tool_running',
  'awaiting_question',
  'awaiting_user',
  'interrupted',
  'rate_limited',
  'retrying',
  'kill_failed',
  'waiting',
  'completed',
  'failed',
  'stalled',
  'stopped',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/**
 * The board a ferret works on (today's `BoardProjectIdSchema`): a project's uuid, or `unfiled`. Ferrets is core and
 * cannot import the Board's contract, so the shape is kept here, as the card id is.
 */
export const FERRET_UNFILED_PROJECT_ID = 'unfiled';
export const FerretProjectIdSchema = z.union([z.uuid(), z.literal(FERRET_UNFILED_PROJECT_ID)]);

// ─── spawn provenance (today's `session-provenance.ts`) ───────────────────────────────────────────────────────────

/** What caused a session to be started. */
export const SessionSpawnOriginSchema = z.enum([
  /** A person asked for it. */
  'human',
  /** Another session spawned it as a teammate. */
  'session',
  /** A warden created it — either the warden itself or something it delegated to. */
  'warden',
]);

/**
 * How warden descent was established.
 *
 * Recorded because the three mechanisms are not equally trustworthy, and a shield that turns out to
 * be wrong is only diagnosable if the evidence behind it was kept. `parent_stamp` is the
 * authoritative path; `ancestor_walk` is the backstop that only works while the ancestor still
 * exists.
 */
export const WardenLineageSourceSchema = z.enum(['self_label', 'parent_stamp', 'ancestor_walk', 'none']);

/**
 * Spawn-side provenance for one session: who caused it to exist, and whether it descends from a
 * warden.
 *
 * THIS IS A SAFETY MECHANISM, NOT BOOKKEEPING. The warden detector shields a session from every
 * anomaly class when it can prove warden descent, because a warden that escalates against its own
 * offspring loops forever. The shield is only as good as the record behind it, and a stamp is the
 * only mechanism that survives the thing which breaks the alternative: a warden is ephemeral and is
 * pruned while its children are still running, so walking `parent` to rediscover descent reaches the
 * truth exactly while the ancestor it needs still exists — which for a finished warden is precisely
 * when it does not.
 *
 * So: record descent at spawn, carry it forward across resume and revive, and never let it weaken.
 *
 * WHY IT LIVES IN THE PROTOCOL. The stamp is a field of `SessionConfig`, which means the daemon
 * writes it, the CLI reads it, and every paired browser receives it in a session view. A shape with
 * four readers in three packages has exactly one honest home, and this is it.
 *
 * EVERY REFINEMENT IS LOAD-BEARING. Together they make an inconsistent stamp UNREADABLE rather
 * than half-true, and half-true is the dangerous state: a record claiming descent while naming no
 * warden would shield a session whose ancestry nobody can audit afterwards, while a stray warden
 * or warden origin beside `wardenLineage: false` would preserve only half of the same safety fact.
 */
export const SessionProvenanceSchema = z
  .object({
    v: z.literal(1),
    /** When the stamp was first made. Preserved across resume and revive. */
    at: IsoInstantSchema,
    origin: SessionSpawnOriginSchema,
    /** The resolved parent session, when the spawn had one. */
    parent: z.string().min(1).optional(),
    /**
     * The warden this session traces back to: itself when it IS a warden, the nearest warden
     * ancestor otherwise. This is the traceback that lets a verdict be attributed to the warden that
     * issued it after that warden is gone.
     */
    warden: z.string().min(1).optional(),
    /** Authoritative descent record read by the warden detector. */
    wardenLineage: z.boolean(),
    lineageSource: WardenLineageSourceSchema,
  })
  .refine(value => value.wardenLineage === (value.lineageSource !== 'none'), {
    message: 'wardenLineage disagrees with the recorded lineage source',
    path: ['wardenLineage'],
  })
  .refine(value => value.wardenLineage === (value.warden !== undefined), {
    message: 'wardenLineage disagrees with the recorded warden traceback',
    path: ['warden'],
  })
  .refine(value => value.wardenLineage === (value.origin === 'warden'), {
    message: 'wardenLineage disagrees with the recorded spawn origin',
    path: ['origin'],
  });

// ─── transcript provenance (today's `session.ts`) ─────────────────────────────────────────────────────────────────

/**
 * How this session's harness transcript was IDENTIFIED.
 *
 * `minted` — the daemon chose the harness session id itself and put it on the launch argv, so the
 * transcript's name was decided before the harness ran. Nothing was inferred.
 * `correlated` — the harness named its own session, and the daemon proved which one by finding a
 * string only this session could contain in a rollout that did not exist before the launch.
 * `adopted` — the conversation existed before this session did, and the owner chose to keep it as a
 * ferret (`conversation-import.ts`). Its id is the CLI's own, read from the file the session resumes.
 * `undiscovered` — neither proof is available yet. A session in this state has NO transcript, which
 * is the point: attributing one by working directory or recency silently hands one agent's
 * transcript to another session and the mistake is invisible.
 */
export const TranscriptIdentitySchema = z.enum(['minted', 'correlated', 'adopted', 'undiscovered']);

/**
 * Where this session's transcript lives, recorded as evidence captured at launch.
 *
 * This is a PROVENANCE record, not a cache. Every field is something the daemon observed or decided
 * at the moment the session was created — the harness home the wrapper exports, the session id the
 * daemon minted, the rollouts that already existed before this launch — because after the fact
 * there is no way to tell two concurrent sessions of the same agent in the same directory apart.
 */
export const TranscriptProvenanceSchema = z
  .object({
    v: z.literal(1),
    /** The harness's own private home, as the launched wrapper exports it. */
    home: z.string().min(1),
    /** The harness's identity for this session, once it is known. */
    harnessSessionId: z.string().min(1).optional(),
    identity: TranscriptIdentitySchema,
    /**
     * The harness session ids that already existed when this session launched.
     *
     * Recorded only for a harness that names its own session (Codex). Everything listed here
     * belongs to somebody else by construction, so a later discovery can exclude all of it without
     * having to reason about time.
     */
    baseline: z.array(z.string().min(1)).optional(),
    /**
     * A string this daemon injected into this session and into no other.
     *
     * It is the whole proof behind `correlated`: a rollout containing it was written by this
     * session, and a rollout that does not is not this session's however recent it is.
     */
    correlationToken: z.string().min(1).optional(),
    /** The exact transcript file. Present exactly when the identity is established. */
    file: z.string().min(1).optional(),
    /** When the identity was established. */
    resolvedAt: IsoInstantSchema.optional(),
  })
  .refine(value => (value.identity === 'undiscovered') === (value.harnessSessionId === undefined), {
    message: 'an identified transcript must name the harness session it belongs to',
    path: ['harnessSessionId'],
  })
  .refine(value => (value.identity === 'undiscovered') === (value.file === undefined), {
    message: 'an identified transcript must name its file',
    path: ['file'],
  });

/** Public reads never carry the launch-time rollout exclusion set (today's `SessionViewConfigSchema.transcript`). */
export const TranscriptViewSchema = TranscriptProvenanceSchema.transform(
  ({ baseline: _baseline, ...provenance }) => provenance,
);

// ─── transfer lineage (today's `session-transfer-edge.ts`) ────────────────────────────────────────────────────────

/** One durable message inside a provenance-bound harness transcript. */
export const ConversationMessagePointSchema = z.strictObject({
  v: z.literal(1),
  byteOffset: NonNegativeIntegerSchema,
  // Kept optional for plans written before multi-block transcript records were exported. Forks
  // refine this durable shape to an exact point at their request boundary.
  blockIndex: NonNegativeIntegerSchema.optional(),
});

/** A newly-issued fork cut must address one block, not merely a record offset. */
export const ExactConversationMessagePointSchema = ConversationMessagePointSchema.extend({
  blockIndex: NonNegativeIntegerSchema,
});

/** A target-only edge back to the exact source and transfer decision that created it. */
export const SessionTransferEdgeSchema = z
  .strictObject({
    v: z.literal(1),
    kind: z.enum(['handover', 'fork']),
    sourceSessionId: z.string().min(1),
    sourceIncarnation: z.string().min(1),
    sourceHarness: RecordedHarnessSchema,
    cutMessagePoint: ConversationMessagePointSchema.nullable(),
    planId: z.string().min(1),
    at: IsoInstantSchema,
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
    if (value.kind === 'fork' && value.cutMessagePoint?.blockIndex === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'a fork must name the exact block inside its message record',
        path: ['cutMessagePoint', 'blockIndex'],
      });
    }
  });

export type StoredSessionId = z.infer<typeof StoredSessionIdSchema>;
export type RecordedHarness = z.infer<typeof RecordedHarnessSchema>;
export type FerretProjectId = z.infer<typeof FerretProjectIdSchema>;
export type SessionSpawnOrigin = z.infer<typeof SessionSpawnOriginSchema>;
export type WardenLineageSource = z.infer<typeof WardenLineageSourceSchema>;
export type SessionProvenance = z.infer<typeof SessionProvenanceSchema>;
export type TranscriptProvenance = z.infer<typeof TranscriptProvenanceSchema>;
export type ConversationMessagePoint = z.infer<typeof ConversationMessagePointSchema>;
export type ExactConversationMessagePoint = z.infer<typeof ExactConversationMessagePointSchema>;
export type SessionTransferEdge = z.infer<typeof SessionTransferEdgeSchema>;
