/**
 * The harness-neutral transfer seam: what one session may hand to a NEW session, and what it may
 * not.
 *
 * Two halves, and the boundary between them is the whole point:
 *
 * ```
 * prepare(request) ──► SessionTransferPlan ──► importPlan(plan, newSessionId)
 *   reads only          durable, serialisable    writes only under that explicit NEW-session key
 * ```
 *
 * Five invariants hold this seam up, and each one is a CONSTRUCTION property rather than a rule a
 * reviewer has to remember:
 *
 * - I1 preparation cannot mutate its source, because it is handed readers and nothing else.
 * - I2 preparation cannot stop anything, because it has no lifecycle port at all.
 * - I3 an import can never inherit board access, because the importer has no board port and no
 *   child-grant requester to reach one with.
 * - I4 an import can only write into the new session, because `importPlan` requires its fresh id,
 *   refuses the source id, and passes that same key to every writer port. No caller-closed writer
 *   can silently aim the import elsewhere.
 * - I5 a plan is a parsed, durable value, so a crash between "the record exists" and "the context
 *   is in it" replays the same decision instead of re-deriving one against a source that has since
 *   moved on.
 *
 * The seam is deliberately smaller than either caller: it knows nothing about boards, nothing about
 * stopping anything, and nothing about WHY it was asked. A fork leaves its source running; a
 * handover stops its source afterwards, in a separate leg this code cannot reach.
 */

import type {
  AttachmentFacet,
  AttachmentView,
  ConversationFacet,
  ConversationMessagePoint,
  Harness,
  InteractionMode,
  LineageFacet,
  ReferenceFacet,
  SessionTransferEdge,
  SessionTransferPlan,
  TranscriptProvenance,
  TransferOmission,
  WorkspaceFacet,
} from '@ferretry/protocol';
import type { SessionProvenance } from '../session/provenance/types.ts';
import type { ConversationDigest } from '../session/transcript/digest.ts';

/**
 * The source session as preparation is allowed to see it.
 *
 * Narrower than the persisted configuration document on purpose: a reader that cannot see a field
 * cannot carry it by accident, and the fields absent here are absent because §12.3 of the transfer
 * design ruled they are not durable across the boundary — the harness, the argv, the transcript
 * identity, the turn counter and the board access are all decided fresh for the new session.
 */
export interface TransferSourceSession {
  readonly sessionId: string;
  readonly incarnation: string;
  readonly runtimeGeneration: number;
  readonly harness: Harness;
  readonly agent: string;
  readonly model: string | null;
  readonly teammate: string | null;
  readonly name: string;
  readonly label: string | null;
  readonly cwd: string;
  readonly mode: InteractionMode;
  readonly remoteControl: boolean;
  /** Operator-supplied argv for the SOURCE harness. Carried only within one family (§12.4). */
  readonly harnessFlags: readonly string[];
  readonly intervalSeconds: number;
  readonly timeoutSeconds: number;
  readonly nudgeAfterSeconds: number;
  readonly killAfterSeconds: number;
  readonly directSendMaxChars: number;
  readonly resumeMenuChoice: 'full' | 'summary';
  readonly maxSnapshots: number;
  readonly retry: SessionTransferPlan['durable']['retry'];
  /**
   * Pins the exact file a `cutMessagePoint` addresses. Never copied into the new session: it names
   * a harness home, a foreign session id and a correlation token this daemon injected into that
   * session and no other, so a copy would point the new session's parser at somebody else's file.
   */
  readonly transcriptProvenance: TranscriptProvenance | null;
  /** The spawn-side stamp, read for warden descent only. `undefined` when the source has none. */
  readonly provenance: SessionProvenance | undefined;
}

/** What the caller asked for, already resolved against the catalogue that owns those facts. */
export interface TransferTargetChoice {
  readonly accountId: string;
  readonly agent: string;
  readonly harness: Harness;
  readonly model: string | null;
  readonly effort: string | null;
  readonly contextWindow: number;
}

/** One preparation, in the caller's terms. */
export interface TransferPrepareRequest {
  readonly sourceSessionId: string;
  /**
   * The caller's idempotency key. The plan id is derived from it, so the same request always
   * produces the same plan id and a replay recognises its own earlier attempt (I5).
   */
  readonly requestId: string;
  readonly target: TransferTargetChoice;
  /**
   * The exact durable message the conversation is cut at, or `null` for a transfer that carries no
   * conversation at all. `null` is the total, explicit record of that — never an absent field.
   */
  readonly cutMessagePoint: ConversationMessagePoint | null;
  /**
   * Opaque read-surface evidence for the exact raw prefix ending at `cutMessagePoint`.
   * Null is the sole spelling for a transfer that carries no conversation.
   */
  readonly selectionBinding: string | null;
  /** Supplied by the caller: this layer decides, it does not read a clock. */
  readonly preparedAt: string;
}

/** What every facet contributor is given. */
export interface TransferPrepareInput {
  readonly request: TransferPrepareRequest;
  readonly source: TransferSourceSession;
}

/**
 * The input for a contributor that must see the conversation the plan has already decided to carry.
 *
 * References are the only one today: they are counted over the text that actually crosses, and
 * counting them over the whole source transcript would report tokens the new session never receives.
 */
export interface TransferFacetInput extends TransferPrepareInput {
  readonly conversation: ConversationFacet | null;
}

/** A facet's decision, and everything it refused to carry, together. A refusal is data. */
export interface TransferFacetContribution<F> {
  readonly value: F;
  readonly omissions: readonly TransferOmission[];
}

/** Verification-only evidence returned beside, never inside, the durable conversation facet. */
export interface TransferConversationSelectionEvidence {
  /** The raw physical-record prefix commitment at the requested cut. */
  readonly rawPrefix: Uint8Array;
}

/** The one conversation read's durable decision and its private request evidence. */
export interface TransferConversationContribution extends TransferFacetContribution<ConversationFacet | null> {
  /** Null exactly when the request carries no conversation. */
  readonly selectionEvidence: TransferConversationSelectionEvidence | null;
}

/**
 * One facet's population, separable from the seam's shape.
 *
 * `prepare` takes the set by injection, so a facet can be strengthened — or a new one added — with
 * no edit to preparation itself.
 */
export interface TransferFacetContributor<F, I extends TransferPrepareInput = TransferPrepareInput> {
  readonly facet: TransferOmission['facet'];
  contribute(input: I): Promise<TransferFacetContribution<F>>;
}

/** The conversation contributor has a stronger result: its same read also carries the cut commitment. */
export interface TransferConversationContributor {
  readonly facet: 'conversation';
  contribute(input: TransferPrepareInput): Promise<TransferConversationContribution>;
}

/** The five facets, each owning its own boundary. */
export interface TransferContributorSet {
  readonly conversation: TransferConversationContributor;
  readonly attachments: TransferFacetContributor<AttachmentFacet>;
  readonly references: TransferFacetContributor<ReferenceFacet, TransferFacetInput>;
  readonly workspace: TransferFacetContributor<WorkspaceFacet>;
  readonly lineage: TransferFacetContributor<LineageFacet>;
}

// ─── read-only ports (I1, I2) ─────────────────────────────────────────────────────────────────

/** Answers `undefined` for a session that does not exist, so preparation refuses rather than guesses. */
export interface TransferSourceReader {
  read(sessionId: string): Promise<TransferSourceSession | undefined>;
}

/**
 * The transcript identity one digest must read.
 *
 * Preparation builds this from the source snapshot it already read; import builds the same shape
 * from the persisted plan. In both cases the file and parser are inputs, never facts the digest
 * adapter may rediscover from mutable current-session configuration.
 */
export interface TransferConversationReadInput {
  readonly sourceSessionId: string;
  readonly sourceHarness: Harness;
  readonly transcriptProvenance: TranscriptProvenance;
  readonly through: ConversationMessagePoint;
}

/**
 * The exact cut, made by the one primitive that owns it.
 *
 * Answers `undefined` when the session has no locatable transcript to cut, and throws
 * `ConversationDigestError` when there IS one and it cannot honestly yield the requested prefix.
 * The two are different answers and the seam maps them differently.
 */
export interface TransferConversationReader {
  digest(input: TransferConversationReadInput): Promise<ConversationDigest | undefined>;
}

/** The exact source identity an import must validate again before its first target write. */
export type TransferConversationValidationInput = TransferConversationReadInput;

/**
 * Validation-only transcript reread for import.
 *
 * An implementation must read the transcript identified by `transcriptProvenance` at `through`.
 * It must never discover a replacement source or re-derive what should cross: the returned digest
 * is used only to prove that the frozen plan still names the same message prefix.
 */
export interface TransferConversationValidator {
  digestPinned(input: TransferConversationValidationInput): Promise<ConversationDigest | undefined>;
}

/** The source's attachment manifests. Bytes are copied at import, never read through here. */
export interface TransferAttachmentReader {
  list(sessionId: string): Promise<readonly AttachmentView[]>;
}

/** Evidence about a working directory. Deliberately not a restoration mechanism. */
export interface TransferWorkspaceEvidence {
  readonly head: string | null;
  readonly status: WorkspaceFacet['status'];
}

export interface TransferWorkspaceProbe {
  probe(cwd: string): Promise<TransferWorkspaceEvidence>;
}

/**
 * Counts reference tokens in the carried text, for the report only.
 *
 * Optional by design: the reference grammar has exactly one owner and this package is not it, so a
 * build with no inventory says so mechanically (a `not_implemented` omission) rather than reporting
 * a confident zero that a second, drifting grammar computed here.
 */
export interface TransferReferenceInventory {
  count(texts: readonly string[]): Promise<ReferenceFacet['counts']>;
}

/** The exact raw conversation evidence one selection binding authenticates. */
export interface TransferSelectionBindingEvidence {
  readonly sourceSessionId: string;
  readonly sourceIncarnation: string;
  readonly transcriptProvenance: TranscriptProvenance;
  readonly through: ConversationMessagePoint;
  /** Produced by the same complete transcript pass that produced the conversation facet. */
  readonly rawPrefix: Uint8Array;
}

/**
 * Verifies request evidence through the daemon's one transcript-token owner.
 *
 * The key is deliberately absent. Preparation receives only the decision operation, and a false
 * answer has exactly one public meaning: the operator must select a row from the current transcript.
 */
export interface TransferSelectionBindingVerifier {
  verifySelection(evidence: TransferSelectionBindingEvidence, binding: string): Promise<boolean>;
}

/** Preparation's whole port set. There is no writer here, and there is no lifecycle (I1, I2). */
export interface SessionTransferPreparePorts {
  readonly source: TransferSourceReader;
  readonly selection: TransferSelectionBindingVerifier;
  readonly contributors: TransferContributorSet;
}

// ─── write ports, explicitly keyed to the NEW session (I3, I4) ───────────────────────────────

/** Everything a transfer writes into the new session's own configuration document. */
export interface SessionTransferEnvelope {
  readonly durable: SessionTransferPlan['durable'];
  readonly transferredFrom: SessionTransferEdge;
  readonly lineage: LineageFacet;
}

/** Replay-safe application of the envelope under the explicit new-session key. */
export interface TransferEnvelopeWriter {
  apply(newSessionId: string, envelope: SessionTransferEnvelope): Promise<void>;
}

/**
 * Atomically writes the new session's first turn document and answers its path.
 *
 * Reapplying identical bytes to one key must be idempotent, and a torn prior write must be safely
 * replaceable. This is the last durable import step and therefore must be safe to re-drive.
 */
export interface TransferBriefWriter {
  write(newSessionId: string, document: string): Promise<string>;
}

export interface TransferAttachmentCopyInput {
  readonly fromSessionId: string;
  readonly newSessionId: string;
  /** The complete manifest pinned by the persisted plan, independent of the mutable source record. */
  readonly expectedManifest: AttachmentFacet['attachments'][number];
}

/**
 * Copies one attachment's original bytes into the new session.
 *
 * The explicit destination key must differ from the source, and the copier must verify the source
 * manifest and bytes against every plan-pinned fact before materialising them there. Attachment ids
 * are content-addressed, so the id is reused rather than re-minted, and nothing is re-encoded.
 */
export interface TransferAttachmentCopier {
  copyOriginal(input: TransferAttachmentCopyInput): Promise<void>;
}

/**
 * The importer's whole port set. No board, no child grant, no lifecycle, no stop (I3).
 *
 * `conversation` is the one read-only port that names the source. Its import-specific request
 * carries the plan's exact provenance/file identity and point so the same digest primitive can
 * validate the frozen prefix before anything is written (§12.5.6). Harness transcripts are
 * append-only in the normal case, so a stored point stays valid while a session keeps talking — but
 * a harness that compacts or rewrites its rollout makes that point silently re-address. Re-reading
 * that pinned source turns the rewrite into a refusal instead of a wrong fork.
 *
 * This does not weaken I5. The plan still decides what crosses; the re-read may only REFUSE, never
 * replace, so a replay after a crash applies the same frozen document it always would have.
 */
export interface SessionTransferImportPorts {
  readonly envelope: TransferEnvelopeWriter;
  readonly brief: TransferBriefWriter;
  readonly attachments: TransferAttachmentCopier;
  readonly conversation: TransferConversationValidator;
}

/**
 * The port names, enumerated by a MAPPED type over the interface itself.
 *
 * A hand-written list `satisfies readonly (keyof T)[]` proves only that every name it contains is
 * real; it stays green when a name is MISSING, which is the direction that matters here. Mapping
 * over `keyof` fails to compile in both directions, so these constants cannot drift from the
 * interfaces, and a test can assert against them that no board, lifecycle or source-writer port was
 * ever added.
 */
export const SESSION_TRANSFER_PREPARE_PORTS: { readonly [K in keyof SessionTransferPreparePorts]: K } = {
  source: 'source',
  selection: 'selection',
  contributors: 'contributors',
};

export const SESSION_TRANSFER_IMPORT_PORTS: { readonly [K in keyof SessionTransferImportPorts]: K } = {
  envelope: 'envelope',
  brief: 'brief',
  attachments: 'attachments',
  conversation: 'conversation',
};

/**
 * Capability names this seam must never hold. Written as a type-level exclusion so the compiler,
 * not a test run, is the thing that fails if one is ever introduced.
 *
 * These are the LEAKS, not "anything that touches the source": board membership, a grant requester,
 * lifecycle control, a stop, and a port named `source` — the shape a source writer would arrive in.
 * A read-only re-read is a different thing and is allowed, which is why the digest port is named
 * `conversation` and typed as a reader with no write method to call.
 */
export type ForbiddenImportPort = 'board' | 'boards' | 'childGrant' | 'lifecycle' | 'stop' | 'source';

export type TransferImportCapabilityLeak = Extract<keyof SessionTransferImportPorts, ForbiddenImportPort>;

// ─── refusals ─────────────────────────────────────────────────────────────────────────────────

/**
 * Why a plan could not be prepared.
 *
 * The three transcript reasons are `ConversationDigestFailure`'s own words, carried through
 * unchanged: the digest primitive already decided what an unmakeable cut is called, and renaming it
 * here would make the route's refusal disagree with the only code that can produce it.
 */
export type TransferPrepareFailure =
  | 'source_not_found'
  | 'selection_stale'
  | 'incomplete_transcript'
  | 'target_not_found'
  | 'target_not_message'
  | 'conversation_unavailable'
  | 'lineage_untraceable'
  | 'plan_invalid';

/** A transfer that cannot be described honestly is refused before anything is created. */
export class TransferPrepareError extends Error {
  constructor(
    readonly failure: TransferPrepareFailure,
    message: string,
  ) {
    super(message);
    this.name = 'TransferPrepareError';
  }
}

export type TransferImportFailure = 'edge_invalid' | 'cut_not_carried' | 'cut_unreadable' | 'cut_rewritten';

/** A plan that cannot be applied to the new session, refused before the session is started. */
export class TransferImportError extends Error {
  constructor(
    readonly failure: TransferImportFailure,
    message: string,
  ) {
    super(message);
    this.name = 'TransferImportError';
  }
}

/** What an import actually materialised. Omissions remain owned exclusively by the persisted plan. */
export interface SessionTransferImportOutcome {
  /** The first-turn document the new session's agent is pointed at. */
  readonly briefPath: string;
  readonly copiedAttachmentIds: readonly string[];
}
