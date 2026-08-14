/**
 * The ports a fork is built from, chosen so that the dangerous things are IMPOSSIBLE rather than
 * merely unwritten.
 *
 * A fork's whole safety claim is "the source is never touched, and the new session is a fresh one".
 * That claim is worth nothing if it rests on nobody adding a source writer later. So it is made
 * structural, in two ways:
 *
 *   SOURCE DECISIONS ARE DERIVED ONCE, BY PREPARATION. Import may validation-only reread the exact
 *   provenance and point persisted in that plan, but it can only refuse: it never re-derives what
 *   crosses. No write port can name the source.
 *
 *   EVERY WRITE IS BOUND TO THE TARGET BEFORE IT EXISTS AS A CALL. {@link SessionForkTargetBinder}
 *   takes the fresh session id ONCE and hands back the whole write surface. Not one method on that
 *   surface accepts a session id, so there is no argument through which a writer could be aimed at
 *   the source, and no code path that could pass one by mistake.
 *
 * WHAT IS NOT HERE IS THE POINT. There is no board port and no child-grant requester, so an
 * imported session cannot inherit board access — it has no way to ask for any. There is no stop, so
 * a fork cannot end the session it read; that is a handover, and it is a different operation in a
 * different module. There is no descendant, waiter or pointer capability, so a fork cannot restamp
 * the tree hanging off its source. {@link SessionForkCapabilityLeak} makes the compiler, rather than
 * a reviewer, the thing that fails if one of them is ever introduced.
 */

import type { SessionTransferPlan, SessionView } from '@ferretry/protocol';
import type { SessionTransferImportOutcome, TransferPrepareRequest, TransferTargetChoice } from '../transfer/types.ts';
import type { SessionForkCommand, SessionForkKey } from './identity.ts';
import type { SessionForkImportReport, SessionForkReceipt } from './receipt.ts';

/**
 * Durable ownership of one `(source, request id)` pair.
 *
 * `claim` is a COMPARE-AND-SET, not a write, and that is the whole reason this interface is not
 * just "read then write". Two daemon-side attempts that both found no receipt must not both mint a
 * target: the store admits exactly one claim per key and answers every other with the document that
 * won, so the loser adopts the winner's target and plan instead of creating a second session.
 *
 * `read` and `claim` answer with an UNPARSED document deliberately. A receipt comes back off disk
 * after a restart, where it is untrusted input like anything else; the store is a durable map and
 * the orchestration is what decides whether a document is a usable receipt.
 */
export interface SessionForkReceiptStore {
  /** `undefined` when this pair has never been claimed. */
  read(key: SessionForkKey): Promise<unknown>;
  /** Writes the receipt only if the pair is unclaimed, and answers whichever claim holds the pair. */
  claim(receipt: SessionForkReceipt): Promise<unknown>;
  /** Replaces the document for an already-claimed pair with its next phase. */
  advance(receipt: SessionForkReceipt): Promise<void>;
}

/**
 * Resolves the caller's account, agent, model and effort against the owners of those facts.
 *
 * Injected rather than implemented, because a fork is not where model compatibility or an effort
 * vocabulary is decided. A second effort enum or a second "does this model accept that harness"
 * rule living here would drift from the catalogue that ships them, and the failure would be a
 * session launched against a target this daemon was wrong about.
 */
export interface SessionForkTargetResolver {
  resolve(command: Pick<SessionForkCommand, 'agent' | 'model' | 'effort'>): Promise<TransferTargetChoice>;
  /**
   * Re-proves the resolved target against the working directory the plan actually froze.
   *
   * WHY THIS IS A SECOND CALL RATHER THAN AN ARGUMENT TO THE FIRST. The Codex catalogue is keyed by
   * `(executable, cwd)` — a project-local configuration can change which models one directory
   * advertises — and the target's working directory is the SOURCE's, which is not known until
   * preparation has read the source. So resolution has to happen first (the plan needs a resolved
   * target) and can only be resolved against a directory the daemon owns, which is a fallback rather
   * than the answer. This closes that gap: once `durable.cwd` is frozen, the same resolver re-asks
   * the same catalogue, through the same cache, in the directory the session will really run in.
   *
   * IT RUNS BEFORE THE CLAIM, and that is the whole value. A target the catalogue rejects becomes a
   * refusal with nothing written down; validated after the claim it would become a durable receipt
   * whose every replay fails identically forever.
   *
   * It VALIDATES and never re-decides: it may only refuse, never answer with a different target,
   * because the plan already froze the one in `plan.target` and a second answer here would mean the
   * receipt and the session disagreed about what was launched.
   */
  validate(target: TransferTargetChoice, cwd: string): Promise<void>;
}

/**
 * The last thing checked before a fork becomes durable: can the target actually be given this brief?
 *
 * A fork's opening turn is the quoted conversation, and a conversation can be larger than the
 * first-turn document a session may be created with. Without this, such a fork claims its receipt,
 * then fails at `lifecycle.create` — and because every post-claim step is idempotent and re-driven,
 * it fails there again on every retry, forever, with a durable receipt saying a fork is in progress.
 * That is the one shape of permanent failure this design otherwise has no answer for.
 *
 * The rendered document is a pure function of the frozen plan, so it is knowable BEFORE the claim,
 * which turns a permanently retrying fork into an ordinary refusal that wrote nothing. The limit and
 * the rendering both belong to the lifecycle and the transfer brief respectively — this port only
 * asks them, so no second copy of either can drift.
 */
export interface SessionForkOpeningTurn {
  /** Throws when the rendered opening turn is one the target's first-turn document cannot hold. */
  assertDeliverable(plan: SessionTransferPlan): void;
}

/** The transfer seam's read-only preparation. The only place source decisions are derived. */
export interface SessionForkPreparer {
  prepare(request: TransferPrepareRequest): Promise<SessionTransferPlan>;
}

/** Creates, observes and starts the TARGET. Bound to it; it is handed no id it could aim elsewhere. */
export interface SessionForkTargetLifecycle {
  /** Creates the session record under the reserved id. Idempotent: the id was written down first. */
  create(plan: SessionTransferPlan): Promise<void>;
  /**
   * Captures and persists the TARGET's own transcript provenance.
   *
   * It takes no provenance argument, and that is the design: the source's provenance names a
   * harness home, a foreign harness session id and a correlation token this daemon injected into
   * that session and no other. Copied across, it would point the new session's transcript reader at
   * somebody else's file. The plan carries the source's provenance only so the cut can be
   * revalidated against the file it was measured in.
   */
  captureTranscriptProvenance(): Promise<void>;
  start(): Promise<SessionView>;
  /** The target's current view, for a replay that has already started it. Never a second start. */
  view(): Promise<SessionView>;
}

/** Persists the parsed plan beneath the target, so a crashed import replays it rather than a new one. */
export interface SessionForkTargetPlanStore {
  persist(plan: SessionTransferPlan): Promise<void>;
}

/**
 * The transfer seam's importer, explicitly keyed to the fresh target (seam invariants I3 and I4).
 *
 * It may REFUSE, and on a real import it does so before it writes anything: the importer re-reads the
 * pinned point and rejects a plan whose cut is unreadable or has been rewritten under it. A replay
 * first proves whether the bound target already holds the exact edge, brief and attachments; that is
 * evidence the earlier import completed and only its receipt stamp was lost, so it reconstructs the
 * deterministic report without consulting a source that may since have been pruned. An incomplete
 * target still takes the ordinary importer path and its source validation. No second validator lives
 * here.
 *
 * A refusal is safe to leave where it falls. The receipt is still at `plan_persisted`, the source was
 * never touched, and the next attempt under the same key either proves the completed target or
 * re-drives THIS import against THIS plan. A cut that is genuinely gone refuses identically while the
 * target is incomplete; one that failed transiently succeeds on the retry.
 */
export interface SessionForkTargetImporter {
  importPlan(plan: SessionTransferPlan, newSessionId: string): Promise<SessionTransferImportOutcome>;
}

/** Everything a fork may write, and every one of them writes into the same one session. */
export interface SessionForkBoundTarget {
  readonly lifecycle: SessionForkTargetLifecycle;
  readonly plans: SessionForkTargetPlanStore;
  readonly importer: SessionForkTargetImporter;
}

/**
 * The single place a session id enters the write surface — and the single place the FROZEN PLAN
 * enters it.
 *
 * BOTH ARGUMENTS ARE ANCHORS, and the second one closes a hole the first cannot. Binding the id
 * alone left the later operations — capturing provenance, starting, reading the view — with nothing
 * to check the target against except the plan installed beside it on disk. That is circular: a valid
 * but DIFFERENT plan written under the same deterministic plan id would be accepted by every later
 * phase, each one self-consistently agreeing with the substitute. Handing the receipt's own P0 in at
 * bind time means every bound operation reconciles against the decision the receipt froze, which is
 * the only copy a replay is entitled to trust.
 *
 * A binder that holds the plan can therefore refuse, before writing or starting anything: an
 * installed plan that is not value-equal to P0, a missing or altered `transferredFrom` edge once the
 * import has run, or a target record that has drifted from the reserved fresh identity.
 */
export interface SessionForkTargetBinder {
  bind(targetSessionId: string, plan: SessionTransferPlan): SessionForkBoundTarget;
}

/** Mints the fresh target id. Called once per fork, before the receipt is claimed. */
export interface SessionForkIdFactory {
  next(): string;
}

/** This layer decides; it does not read a clock. */
export interface SessionForkClock {
  now(): string;
}

/**
 * Serialises one logical fork, keyed by the composite.
 *
 * Two concurrent attempts under one key must not interleave their phase advances — the second would
 * read a receipt the first had already moved past and re-run a boundary. Keying on the composite
 * means forks of two different sources never wait on each other for sharing a caller's request id.
 */
export interface SessionForkSerial {
  run<T>(key: SessionForkKey, work: () => Promise<T>): Promise<T>;
}

export interface SessionForkPorts {
  readonly receipts: SessionForkReceiptStore;
  readonly resolver: SessionForkTargetResolver;
  readonly preparer: SessionForkPreparer;
  readonly opening: SessionForkOpeningTurn;
  readonly binder: SessionForkTargetBinder;
  readonly ids: SessionForkIdFactory;
  readonly clock: SessionForkClock;
  readonly serial: SessionForkSerial;
}

/** What one fork produced, and the single value a route and later the PWA report from. */
export interface SessionForkResult {
  readonly targetSessionId: string;
  readonly session: SessionView;
  /** The exact plan that was applied — the same one on every replay of this fork. */
  readonly plan: SessionTransferPlan;
  /** Operational import facts; omissions remain owned exclusively by `plan.notCarried`. */
  readonly report: SessionForkImportReport;
}

/**
 * The port names, enumerated by a MAPPED type over the interfaces themselves.
 *
 * A hand-written list `satisfies readonly (keyof T)[]` proves only that every name it contains is
 * real, and stays green when a name is MISSING — which is the direction that matters for a list
 * whose job is to be exhaustive. Mapping over `keyof` fails to compile in both directions, so these
 * cannot drift from the interfaces they enumerate.
 */
export const SESSION_FORK_PORTS: { readonly [K in keyof SessionForkPorts]: K } = {
  receipts: 'receipts',
  resolver: 'resolver',
  preparer: 'preparer',
  opening: 'opening',
  binder: 'binder',
  ids: 'ids',
  clock: 'clock',
  serial: 'serial',
};

export const SESSION_FORK_TARGET_PORTS: { readonly [K in keyof SessionForkBoundTarget]: K } = {
  lifecycle: 'lifecycle',
  plans: 'plans',
  importer: 'importer',
};

/**
 * Capabilities a fork must never hold, written as a type-level exclusion.
 *
 * `source` and `sourceWriter` would break "the source is never touched"; `board`, `boards` and
 * `childGrant` would let an imported session inherit coordination authority the design gives it
 * none of; `stop` would make a fork a handover; `descendants`, `waiters` and `pointers` would let
 * it restamp the tree hanging off the session it read.
 */
export type ForbiddenForkCapability =
  | 'board'
  | 'boards'
  | 'childGrant'
  | 'grants'
  | 'stop'
  | 'source'
  | 'sourceWriter'
  | 'descendants'
  | 'waiters'
  | 'pointers';

/** Must be `never`. The compiler, not a reviewer, is what fails when it stops being. */
export type SessionForkCapabilityLeak = Extract<
  | keyof SessionForkPorts
  | keyof SessionForkBoundTarget
  | keyof SessionForkTargetLifecycle
  | keyof SessionForkTargetPlanStore
  | keyof SessionForkTargetImporter,
  ForbiddenForkCapability
>;
