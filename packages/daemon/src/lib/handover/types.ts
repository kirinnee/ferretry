/**
 * Cross-harness handover — the daemon's vocabulary and its narrow ports.
 *
 * A HANDOVER IS NOT A MIGRATION, and the two words must never become synonyms here. A migration
 * keeps one session id and restamps its identity document so one conversation continues under
 * another account of the SAME family. A handover crosses families, and the conversation is exactly
 * the thing that cannot cross: the transcript, the turn counter, the open-tool ids and the resume
 * arguments are all the source harness's, and the target harness cannot read any of them. So a
 * handover starts a NEW top-level session, carries every durable coordination fact into it, proves
 * the replacement can act, and only then retires the predecessor.
 *
 * THE WIRE VOCABULARY IS NOT OWNED HERE. The phase set, the failure set, the request and the durable
 * receipt are `@ferretry/protocol`'s, because the daemon, the command-line client and the browser all
 * read the same document — and a fact two independently deployable programs must agree on is defined
 * once, above every consumer. This module aliases them and adds only what never leaves this daemon:
 * the ports, the world snapshot, and the resolved target.
 *
 * WHY THE PORTS ARE THIS NARROW. Three legs meet in one operation and only one of them may touch
 * each surface, so the separation is expressed as types rather than as review discipline:
 *
 *   - the PREPARATION leg reads the source and produces a plan; it holds no board port and no stop.
 *   - the BOARD leg invites, approves, accepts, re-seats the coordinator and relinquishes — and it
 *     structurally CANNOT verify, because a proof the orchestrator can produce proves nothing.
 *   - the LIFECYCLE leg creates, starts and stops sessions and knows no board at all.
 */

import type {
  SessionHandoverFailure,
  SessionHandoverResolvedAccount,
  SessionHandoverResolvedTarget,
  SessionHandoverPhase,
  SessionHandoverReceipt,
  SessionHandoverRequest,
  SessionStatus,
  SessionTransferPlan,
} from '@ferretry/protocol';

/** The protocol's phase set, under the daemon's shorter name. There is no second enumeration. */
export type HandoverPhase = SessionHandoverPhase;

/** The protocol's actionable refusal causes. The terminal PHASE is the coarse category, not a cause. */
export type HandoverFailure = SessionHandoverFailure;

/** The durable document, owned by the predecessor at `state/sessions/<sourceSessionId>/handover.json`. */
export type HandoverReceipt = SessionHandoverReceipt;

/** What the caller asked for, exactly as the route parsed it. */
export type HandoverRequestBody = SessionHandoverRequest;

/**
 * One resolved fleet account, carrying every fact the transfer seam needs to build a launch.
 *
 * COMPLETE ON PURPOSE. The seam's target choice needs an account id, a family, a model, an effort and
 * a context window, and if this shape carried only `agent` then the preparer's adapter would have to
 * look the account up a second time — a second resolution of one fact, which is the shape of every
 * time-of-check/time-of-use bug in this repository. The resolution happens once, here, before
 * anything durable is written.
 */
export type HandoverResolvedAccount = SessionHandoverResolvedAccount;

/**
 * The replacement and, for a board root, the coordinator descendant it will be seated with.
 *
 * `coordinator` is nullable because the protocol's request is: a boardless root runs no coordinator
 * leg, and inventing a coordinator for it would create a session nothing ever seats. A BOARD root
 * that names no coordinator is refused, because relinquish revokes every grant beneath the retiring
 * root — the old coordinator's included — and a board with no coordinator can never approve anything
 * again.
 */
export type HandoverResolvedTarget = SessionHandoverResolvedTarget;

/** Turns the `agent` a caller named into the account facts the operation will actually launch. */
export interface HandoverAccountResolverPort {
  resolve(agent: string, model: string | null): Promise<HandoverResolvedAccount>;
}

/** The facts about a session this domain reads. Deliberately narrower than the wire schema. */
export interface HandoverSessionView {
  readonly sessionId: string;
  readonly incarnation: string;
  readonly runtimeGeneration: number;
  readonly parentSessionId: string | null;
  readonly mode: 'auto' | 'interactive';
  readonly status: SessionStatus;
  /**
   * The family recorded on the session's own document, as a raw string.
   *
   * NOT narrowed to the protocol's family union, deliberately: a document written by a future daemon
   * may name a family this build has never heard of, and that is precisely the case the
   * `harness_unknown` refusal exists for. A type that could not express it would force this daemon to
   * guess at the one question it must refuse to guess at.
   */
  readonly harness: string;
  readonly agent: string;
  readonly teammate: string | null;
  readonly cwd: string;
  readonly label: string | null;
}

/** What a board says about itself while a handover is walking it. */
export interface HandoverBoardObservation {
  readonly boardId: string;
  /** The board creator and the instant it was created — half of the anchor compared on every advance. */
  readonly creatorSessionId: string;
  readonly createdAt: string;
  /**
   * The session the board records as canonical.
   *
   * It is compared against the ANCHOR the receipt captured at begin, never against the handover's
   * current source: it is stamped once at creation and never restamped, so on the second handover of
   * one board it names neither the retiring root nor the arriving one. Anchor drift means the board
   * moved; a source that differs from it is just a board that has been handed over before.
   */
  readonly canonicalSessionId: string;
  readonly coordinatorSessionId: string;
  /** True when the seated coordinator's session is live; without one, nothing can be approved. */
  readonly coordinatorAlive: boolean;
  readonly activeRootSessionIds: readonly string[];
  readonly outstandingInvitation: boolean;
  /** The invitation this handover created, once it has one. */
  readonly invitation: HandoverInvitationObservation | null;
}

export interface HandoverInvitationObservation {
  readonly requestId: string;
  readonly targetSessionId: string;
  readonly grantId?: string;
  readonly verifiedAt?: string;
  readonly verifiedBySessionId?: string;
}

/** The board membership of a root, read before anything is created. */
export interface HandoverBoardMembership {
  readonly boardId: string;
  /**
   * The immutable anchor, captured at begin and never re-derived.
   *
   * A board document is never re-created across a handover, so these four values together are what
   * "the board never moved" means mechanically. They are compared as a TUPLE on every advance rather
   * than one at a time, because any single one of them changing under a half-finished handover means
   * the replacement is being seated on something other than the board the operator named.
   */
  readonly creatorSessionId: string;
  readonly canonicalSessionId: string;
  readonly createdAt: string;
  readonly coordinatorAlive: boolean;
  readonly outstandingInvitation: boolean;
  /**
   * Every live membership root of this board.
   *
   * NOT redundant with `outstandingInvitation`, and the case that proves it is the one this feature
   * creates: an accepted-but-unverified handover has NO pending invitation — it was consumed by the
   * acceptance — and already has TWO active roots. Without this, a second handover of the same root
   * would pass the pre-create check, mint an identity and create a session before the board reducer
   * refused it, leaving an orphan behind every refusal.
   */
  readonly activeRootSessionIds: readonly string[];
}

/**
 * Every board write a handover may make — and, conspicuously, no `verify`.
 *
 * THE OMISSION IS THE POINT. The whole operation turns on one proof: that the replacement received
 * a working board capability and used it. A verification receipt the orchestrator could produce
 * would prove that the orchestrator can write to a document, which nobody doubted. So the daemon
 * drives every step up to the launch, and then WAITS for an inbound verification made by the
 * replacement's own pane with the capability delivered into its environment.
 *
 * `HANDOVER_BOARD_PORT_METHODS` pins this key set at compile time and a unit test pins it at run
 * time, so growing a `verify` here is a visible, deliberate act rather than a slip.
 */
export interface HandoverBoardPort {
  requestInvitation(input: HandoverInviteCommand): Promise<{ readonly invitationRequestId: string }>;
  approveInvitation(input: HandoverInvitationStepCommand): Promise<void>;
  acceptInvitation(input: HandoverInvitationStepCommand): Promise<{ readonly grantId: string }>;
  requestChildGrant(input: HandoverChildGrantCommand): Promise<{ readonly grantRequestId: string }>;
  approveChildGrant(input: HandoverChildGrantApproval): Promise<{ readonly grantId: string }>;
  replaceCoordinator(input: HandoverCoordinatorReplacement): Promise<void>;
  relinquish(input: HandoverRelinquishCommand): Promise<void>;
}

/**
 * The port's key set, as a value.
 *
 * The mapped type makes a MISSING key a compile error and `satisfies` makes an EXTRA one a compile
 * error, which is the pair — soundness and completeness — that a bare `satisfies readonly K[]` does
 * not give. The run-time assertion in `tests/unit/handover/ports.test.ts` then catches the case
 * neither type can: somebody widening the interface and this table in the same commit.
 */
export const HANDOVER_BOARD_PORT_METHODS = {
  requestInvitation: true,
  approveInvitation: true,
  acceptInvitation: true,
  requestChildGrant: true,
  approveChildGrant: true,
  replaceCoordinator: true,
  relinquish: true,
} as const satisfies { readonly [K in keyof HandoverBoardPort]: true };

export interface HandoverInviteCommand {
  readonly boardId: string;
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly requestId: string;
}

export interface HandoverInvitationStepCommand {
  readonly boardId: string;
  readonly invitationRequestId: string;
  readonly targetSessionId: string;
  readonly requestId: string;
}

export interface HandoverChildGrantCommand {
  readonly boardId: string;
  readonly rootSessionId: string;
  readonly targetSessionId: string;
  readonly requestId: string;
}

export interface HandoverChildGrantApproval {
  readonly boardId: string;
  readonly grantRequestId: string;
  readonly requestId: string;
}

export interface HandoverCoordinatorReplacement {
  readonly boardId: string;
  readonly coordinatorSessionId: string;
  readonly requestId: string;
}

export interface HandoverRelinquishCommand {
  readonly boardId: string;
  readonly memberSessionId: string;
  readonly requestId: string;
}

/** Reading a board is a different capability from writing one, so it is a different port. */
export interface HandoverBoardReader {
  membership(sessionId: string): Promise<HandoverBoardMembership | null>;
  /** `null` when no board carries this id — which is the whole of the "the board never moved" check. */
  observe(boardId: string, invitationRequestId: string | undefined): Promise<HandoverBoardObservation | null>;
}

/** The lifecycle leg. It knows no board, and it is the only port that can stop anything. */
export interface HandoverSessionPort {
  read(sessionId: string): Promise<HandoverSessionView | null>;
  /** Creates the record under an id decided by the caller, so the create replays after a crash. */
  create(input: HandoverCreateCommand): Promise<void>;
  start(sessionId: string): Promise<void>;
  stop(sessionId: string, reason: string): Promise<void>;
}

export interface HandoverCreateCommand {
  readonly sessionId: string;
  readonly account: HandoverResolvedAccount;
  /** `null` for the replacement root; the replacement's id for its coordinator descendant. */
  readonly parentSessionId: string | null;
  readonly cwd: string;
  readonly mode: 'auto' | 'interactive';
  readonly label: string | null;
}

/** Mints the identity a replacement is created under, written ahead of the create. */
export interface HandoverIdentityPort {
  sessionId(): string;
}

/** The preparation half of the shared transfer seam. It reads the source and writes nothing. */
export interface HandoverTransferPreparePort {
  prepare(input: HandoverPrepareCommand): Promise<SessionTransferPlan>;
}

export interface HandoverPrepareCommand {
  readonly sourceSessionId: string;
  readonly requestId: string;
  /** The already-resolved account, so no second lookup can hide inside the adapter. */
  readonly target: HandoverResolvedAccount;
  /**
   * Typed as the `null` literal, not as a nullable point.
   *
   * A handover carries no conversation, so it has nothing to cut, and a type that could express a
   * cut here would let a future edit quietly transplant a rollout the target harness will
   * mis-attribute as its own history.
   */
  readonly cutMessagePoint: null;
}

/** The import half. A DISTINCT port, so no caller can reach preparation and import as one thing. */
export interface HandoverTransferImportPort {
  importPlan(plan: SessionTransferPlan, newSessionId: string): Promise<void>;
}

/** The destructive gate, run advisory at `requested` and binding immediately before the retirement. */
export interface HandoverPreflightPort {
  evaluate(sessionId: string): Promise<HandoverPreflightVerdict>;
}

export interface HandoverPreflightVerdict {
  readonly proceed: boolean;
  readonly reason: string;
  /** Where the forensic in-flight report was written, when one was. */
  readonly reportPath: string | null;
}

/** Raising the one item a human must act on when a handover strands. */
export interface HandoverAttentionPort {
  raise(input: HandoverAttentionRequest): Promise<void>;
}

export interface HandoverAttentionRequest {
  readonly sessionId: string;
  /** Stable across retries, so the ledger refreshes one item instead of growing a pile. */
  readonly sourceRef: string;
  readonly subject: string;
  readonly why: string;
  readonly howToResolve: string;
}

/**
 * Appending the completion fact to a session's own journal, AT MOST ONCE.
 *
 * `operationId` is not decoration. Completion appends to two journals in a fixed order, and a crash
 * between them replays the step — so a port with a plain `append` would write the predecessor's
 * completion event twice and leave the fleet's own history claiming a session was handed over twice.
 * The id is derived from the receipt and the side, so the second attempt is recognisably the first.
 */
export interface HandoverJournalPort {
  appendOnce(input: HandoverJournalAppend): Promise<void>;
}

export interface HandoverJournalAppend {
  readonly sessionId: string;
  readonly operationId: string;
  readonly type: string;
  readonly data: Readonly<Record<string, string | null>>;
}

export interface HandoverClock {
  now(): string;
}

/**
 * The durable document's store.
 *
 * `read` REFUSES a damaged document rather than answering "empty": a handover receipt that cannot be
 * parsed is the record of an operation that may be half-applied, and treating it as absence would
 * let a second handover start on top of the first.
 */
export interface HandoverReceiptStore {
  read(sourceSessionId: string): Promise<HandoverReceipt | null>;
  write(receipt: HandoverReceipt): Promise<void>;
  /** Every source session whose receipt is not yet in a terminal phase — the reconciler's roster. */
  pendingSourceSessionIds(): Promise<readonly string[]>;
}

export interface HandoverPorts {
  readonly receipts: HandoverReceiptStore;
  readonly sessions: HandoverSessionPort;
  readonly board: HandoverBoardPort;
  readonly boardReader: HandoverBoardReader;
  readonly accounts: HandoverAccountResolverPort;
  readonly preparer: HandoverTransferPreparePort;
  readonly importer: HandoverTransferImportPort;
  readonly preflight: HandoverPreflightPort;
  readonly attention: HandoverAttentionPort;
  readonly journal: HandoverJournalPort;
  readonly identity: HandoverIdentityPort;
  readonly clock: HandoverClock;
}

/**
 * How long the wait for the replacement's verification may last.
 *
 * IT GOVERNS EXACTLY ONE WAIT, and that narrowness is the design rather than an omission. Every other
 * post-acceptance step is a deterministic effect with a derived id: it either replays or reports its
 * own error, and elapsed wall time is not evidence that it failed. Only the verification is a wait on
 * something outside this daemon — a pane that may never call — so only the verification has a clock.
 *
 * Generous on purpose: stranding destroys nothing, but it does need a human, and a deadline tight
 * enough to strand a slow launch would manufacture the incident it exists to report.
 */
export const DEFAULT_HANDOVER_VERIFICATION_DEADLINE_MINUTES = 30;

export interface HandoverSettings {
  readonly verificationDeadlineMinutes: number;
}

export const DEFAULT_HANDOVER_SETTINGS: HandoverSettings = {
  verificationDeadlineMinutes: DEFAULT_HANDOVER_VERIFICATION_DEADLINE_MINUTES,
};

/**
 * A refusal that must not clobber a receipt already on disk, so it travels as a throw.
 *
 * Every eligibility refusal is one of these and writes NOTHING: the subject is untouched, running and
 * still a member, and the same request id may be presented again once the operator has fixed what the
 * cause names. The runtime and drift causes take the other road — they are written onto a terminal
 * receipt by the reconciler, because by then there is a durable operation to answer for.
 */
export class HandoverError extends Error {
  constructor(
    readonly failure: HandoverFailure,
    message: string,
  ) {
    super(message);
    this.name = 'HandoverError';
  }
}

/** A receipt document that exists and cannot be understood. Never collapsed into "no receipt". */
export class HandoverReceiptDamagedError extends Error {
  constructor(
    readonly file: string,
    readonly detail: string,
  ) {
    super(`the handover receipt at ${file} could not be read as one: ${detail}`);
    this.name = 'HandoverReceiptDamagedError';
  }
}
