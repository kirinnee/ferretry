import { z } from 'zod';
import { InstantSchema, PositiveIntegerSchema } from './common.ts';
import { ConversationMessagePointSchema } from './session-transfer-edge.ts';
import { TransferOmissionSchema } from './session-transfer.ts';
import { HarnessSchema, SessionStatusSchema } from './session.ts';

/**
 * Forking a conversation from one durable message into a fresh, independent session.
 *
 * THE BODY CARRIES ONLY WHAT THE CALLER CHOOSES. The source session is named by the route path, and
 * the durable identity of one fork is the `x-fy-request-id` HEADER rather than a field — that is what
 * makes the route safe to retry, and it is the same shape `migrate` already uses. A request id spelled
 * in the body would be a second owner of the same fact and could disagree with the header the
 * transport actually retried under.
 *
 * `through` is the protocol-owned {@link ConversationMessagePointSchema}, imported rather than
 * respelled. A fork and the transfer plan it produces address the SAME message, so a second point
 * shape here would be two coordinates for one cut, and the one that drifted would silently address a
 * different message than the one the caller clicked.
 *
 * `selectionBinding` TRAVELS WITH `through` AND IS REQUIRED. A coordinate alone says where the cut
 * is, and says nothing about whether the message there is still the message the caller read. A
 * source that was rewritten between listing and forking would present the same offset holding
 * different words, and a fork of the replacement is indistinguishable to every surface from the fork
 * that was asked for. The binding is the daemon's own evidence about that exact raw row, handed out
 * with the row and handed back unchanged; preparation verifies it before it claims a receipt,
 * reserves a target or persists a plan, and answers `selection_stale` when it does not hold. It is
 * OPAQUE in both directions — the caller stores bytes and echoes bytes, and no client parses,
 * derives, normalizes, hashes or re-signs them. Being request evidence, it stops at the request: it
 * is not a second point in the transfer plan, not a field on the lineage edge, and not projected in
 * the outcome below.
 *
 * THE CALLER NEVER SPELLS `harness`. It is resolved server-side from the agent, the only place that
 * knows which family a wrapper belongs to, so a cross-harness fork is requested exactly the way a
 * same-harness one is — and a caller cannot assert a family the agent does not have.
 *
 * `model` and `effort` are opaque strings owned by the existing runtime decision makers; no second
 * effort enum and no model-compatibility rule is invented here. There is deliberately no board,
 * parent, prompt, attachment or dry-run field: a fork never inherits shared-board access, its parent
 * is always null, and its conversation comes from the source rather than from a prompt this request
 * could carry.
 */
export const ForkSessionRequestSchema = z.strictObject({
  /** The exact durable message the new session's conversation is cut through. */
  through: ConversationMessagePointSchema,
  /**
   * The opaque evidence the read surface issued FOR that exact message, echoed byte-for-byte.
   *
   * Not trimmed and not normalized: a schema that rewrote this value would present the daemon with
   * evidence it never issued, and the honest refusal would read as tampering.
   */
  selectionBinding: z.string().min(1),
  /** The agent wrapper the fresh session runs; it also resolves the account and the harness family. */
  agent: z.string().min(1),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
});
export type ForkSessionRequest = z.infer<typeof ForkSessionRequestSchema>;

/**
 * The remote-safe projection of the fresh session.
 *
 * A normal session view is intentionally NOT reused here. It carries the daemon directory, working
 * directory and transcript provenance because the ordinary session surfaces run against that
 * daemon. A fork response also crosses relays to remote surfaces, where those host paths and the
 * transcript correlation proof are neither useful nor safe to publish. The fresh id and the fields
 * needed to label it are the whole public fact.
 */
export const ForkedSessionSummarySchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  agent: z.string().min(1),
  harness: HarnessSchema,
  model: z.string().min(1).nullable(),
  status: SessionStatusSchema,
});
export type ForkedSessionSummary = z.infer<typeof ForkedSessionSummarySchema>;

const ForkSessionSourceCutSchema = z.strictObject({
  sessionId: z.string().min(1),
  cutMessagePoint: ConversationMessagePointSchema,
});

const ForkSessionTargetSummarySchema = z.strictObject({
  agent: z.string().min(1),
  harness: HarnessSchema,
  model: z.string().min(1).nullable(),
  effort: z.string().min(1).nullable(),
  contextWindow: PositiveIntegerSchema,
});

/**
 * The part of the frozen transfer decision a remote caller can act on.
 *
 * This is a projection, never the durable {@code SessionTransferPlan}. The daemon keeps the source
 * transcript provenance, target account id, portable conversation, attachment manifest, working
 * directory and launch configuration in that internal document so a restart can replay it. None of
 * those implementation facts is needed to identify this decision, show its exact cut and target, or
 * render what did not cross.
 */
export const ForkSessionPlanSummarySchema = z.strictObject({
  v: z.literal(1),
  planId: z.string().min(1),
  preparedAt: InstantSchema,
  source: ForkSessionSourceCutSchema,
  target: ForkSessionTargetSummarySchema,
  notCarried: z.array(TransferOmissionSchema).readonly(),
});
export type ForkSessionPlanSummary = z.infer<typeof ForkSessionPlanSummarySchema>;

/**
 * What a caller gets back from a fork that happened.
 *
 * TWO VALUES, AND THE SECOND IS NOT A COURTESY. `session` is the fresh remote-safe identity, and
 * `plan` is the public projection of the durable decision the daemon persisted before importing
 * anything. `plan.notCarried` remains the SINGLE public owner of every omission the fork made. A
 * second `omissions` or `report` field here would be a copy that can disagree with that projection.
 *
 * Nothing daemon-local appears: no session directory, cwd, transcript provenance, target account id,
 * transfer facet payload, or import step report. A caller can be a phone on the other side of a
 * relay, and a path on the daemon's host is not a fact it can act on.
 *
 * A fork that could not happen is NOT an arm of this type. It is an HTTP refusal whose code is a
 * {@link ForkSessionFailureSchema} value, because a fork — unlike a migration — destroys nothing on
 * the way to failing, so there is never a half-performed fork whose structure a caller must inspect.
 */
export const ForkSessionOutcomeSchema = z.strictObject({
  /** The freshly created session, without daemon-local configuration or transcript evidence. */
  session: ForkedSessionSummarySchema,
  /** The public plan identity, exact source cut, target summary and omission report. */
  plan: ForkSessionPlanSummarySchema,
});
export type ForkSessionOutcome = z.infer<typeof ForkSessionOutcomeSchema>;

/**
 * Why a fork was refused, as a stable closed set a surface can render.
 *
 * EACH VALUE IS THE WIRE `code` ITSELF, not a name that some table maps onto one. The mount answers
 * with the failure as the error code, so the string a client branches on and the string this list
 * declares are one fact with one owner; a renaming that reached only one of them is impossible.
 *
 * AND EACH VALUE IS ITS PRODUCER'S OWN WORD. The prepare and import refusals below are spelled
 * exactly as the daemon layer that raises them spells them, so no wrapper sits between the code that
 * decides and the code a caller reads. A translating layer would be a second owner of this set, and
 * the arm it forgot would reach a client as a defect rather than as the refusal it is.
 *
 * THERE IS NO `harness_mismatch`. Crossing harness families is ALLOWED for a fork and merely lossy,
 * so the honest answer is a committed outcome whose `plan.notCarried` names what could not cross —
 * not a refusal. That is the single largest difference from a migration, whose taxonomy this must
 * never be mistaken for.
 *
 * The array is the single owner and the schema derives from it, so adding a code is one edit and the
 * enum can never drift from the list a reader iterates.
 */
export const FORK_SESSION_FAILURE_CODES = [
  /** The source id is not one the state-home layout would accept, so it must never become a path. */
  'invalid_session_id',
  /** No such source session. */
  'source_not_found',
  /**
   * The selection evidence no longer holds for the addressed message.
   *
   * The point still parses and may still name a readable row; what changed is the RAW content at or
   * before it, so the message the caller chose is not the message that would be forked. Every
   * well-formed refusal of this kind is this ONE code — a tampered token, a cross-session or
   * cross-incarnation replay, a token issued under different transcript provenance, and a genuine
   * rewrite are deliberately indistinguishable, because a taxonomy here would answer questions
   * about the transcript that the caller was refused permission to ask.
   *
   * Nothing has been claimed, reserved or written when this is answered. The remedy is to list the
   * conversation again and choose from the rows as they now read — the fresh listing carries fresh
   * evidence. It is NOT `cut_rewritten`: that arm belongs to a plan already frozen, whose pinned
   * point moved between preparation and import.
   */
  'selection_stale',
  /** The transcript is incomplete, so an honest digest through the chosen point is impossible. */
  'incomplete_transcript',
  /** The transcript does not contain the addressed message point. */
  'target_not_found',
  /** The addressed point is not a portable conversation message — a tool call, or another kind. */
  'target_not_message',
  /** A cut was asked for on a session whose transcript this daemon cannot bind to a provenance. */
  'conversation_unavailable',
  /** The source's warden descent could not be traced, so the safety fact could not be carried. */
  'lineage_untraceable',
  /** The daemon assembled a plan its own schema rejects. A defect here, never a caller error. */
  'plan_invalid',
  /** The daemon assembled a lineage edge its own schema rejects. A defect here, never a caller error. */
  'edge_invalid',
  /** The plan claims a cut its conversation does not reach. A defect here, never a caller error. */
  'cut_not_carried',
  /**
   * The pinned point could not be re-read at import: the transcript is unreadable now, the record is
   * no longer a message, or the block index is out of range. The plan was honest when it was frozen.
   */
  'cut_unreadable',
  /**
   * The source transcript was compacted or rewritten under the frozen plan, so the pinned offset now
   * addresses a different conversation. Nothing is written, and the caller re-picks a message.
   */
  'cut_rewritten',
  /** No account in the fleet manifest is published under the requested agent. */
  'unknown_agent',
  /** The account cannot serve a session right now, or this host cannot run its wrapper. */
  'agent_unavailable',
  /** This request id already names a different fork payload; the caller must decide which it meant. */
  'request_id_reused',
  /** The fork could not be carried out. Nothing was destroyed, so the same request may be presented again. */
  'session_fork_failed',
] as const satisfies readonly string[];

export const ForkSessionFailureSchema = z.enum(FORK_SESSION_FAILURE_CODES);
export type ForkSessionFailure = z.infer<typeof ForkSessionFailureSchema>;
