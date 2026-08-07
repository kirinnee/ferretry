/**
 * The vocabulary of changing what a RUNNING session is running.
 *
 * The refusal taxonomy lives here rather than beside the HTTP routes because it is a domain fact:
 * "the harness cannot express this" and "the same request id already happened" are true whether the
 * caller arrived over HTTP, over a relay, or from a future CLI. The mount keeps the one thing that
 * genuinely is its own — which status and code each refusal answers with.
 *
 * Every port below is narrow on purpose. The composition root holds a session storage adapter, a
 * tmux controller, a pane delivery adapter and a picker transport; none of those belong in a domain
 * decision, and a service that took them could not be unit tested without dragging the adapters
 * tier into the unit coverage ledger.
 */

import type { RuntimeControlRequest, RuntimeModelCatalog, SessionView } from '@ferretry/protocol';
import type { InjectionOutcome } from '../../tmux/delivery.ts';
import type { SessionId } from '../../session-id.ts';
import type { CodexPickerDrivePort } from '../harness/picker-drive.ts';

/** Why a runtime read or control could not be served. */
export type SessionRuntimeFailure =
  /** The path or the request names something unusable. */
  | 'invalid'
  /** No such session. */
  | 'not_found'
  /** The session's own condition refuses it: the wrong lifecycle window, a busy pane, a picker quarantine. */
  | 'refused'
  /** The harness cannot express what was asked — a level it has no command for, a model it does not
   *  advertise. A different request could succeed, which is what separates it from `refused`. */
  | 'unsupported'
  /** The live catalog could not be read, so no targeted switch can be planned against it. */
  | 'catalog_unavailable'
  /** The same request id was already spent on a DIFFERENT control. */
  | 'conflict'
  /**
   * The same request id was durably begun, and whether it reached the harness or how that attempt
   * ended was never recorded.
   *
   * DISTINCT FROM `conflict`, because the caller did nothing wrong and there is nothing to correct in
   * the request. Repeating it is the danger — the first `/compact` may already have discarded
   * context — so the honest answer is "the pane may have been touched; go and look" rather than a
   * replayed success the daemon cannot vouch for or a retry it must not perform.
   */
  | 'unsettled'
  /** It was attempted, and the attempt failed. */
  | 'failed';

/** A refusal raised by the runtime control service, in a taxonomy the mount can map to HTTP. */
export class SessionRuntimeError extends Error {
  constructor(
    readonly failure: SessionRuntimeFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SessionRuntimeError';
  }
}

/** Reading and changing one running session's runtime settings. */
export interface SessionRuntimeSubsystem {
  /** What this session's account advertises it may be switched to, read live. */
  models(sessionId: string): Promise<RuntimeModelCatalog>;
  /**
   * Apply one control, and answer with the session as it stands afterwards.
   *
   * IDEMPOTENT ON `requestId`, which matters more here than on most mutations: a retried picker
   * drive would open a second modal on a pane the first one may still be inside. The same id
   * carrying a DIFFERENT control is a `conflict` rather than a replay — answering it with the first
   * control's session view would tell a caller its model switch succeeded when what actually
   * happened was somebody else's effort change.
   */
  control(sessionId: string, request: RuntimeControlRequest, requestId: string): Promise<SessionView>;
}

/**
 * The daemon-private startup half of the runtime service.
 *
 * The caller already owns the process-wide mutation fence for this session. Keeping that fact in a
 * separate capability instead of a boolean on the mounted subsystem makes a nested, non-reentrant
 * queue acquisition impossible to request through the public API.
 */
export interface SessionRuntimeStartupHeldPort {
  startupWhileHeld(sessionId: string, request: RuntimeControlRequest, requestId: string): Promise<void>;
}

/** The launch record a control needs: which pane to type into, and whose executable answers for it. */
export interface RuntimeLaunchTarget {
  readonly tmuxSession: string;
  /** The account executable, which is also what the Codex catalog probe must run. */
  readonly agent: string;
  readonly cwd: string;
}

/** One pane, as a runtime control reads it. */
export interface RuntimePaneObservation {
  readonly alive: boolean;
  /** The pane exists but its process is gone — a shell that outlived its harness. */
  readonly dead: boolean;
  /** The harness is at a prompt and will accept a native command. */
  readonly promptReady: boolean;
}

/**
 * What a failed picker drive writes into the session document before anything else happens.
 *
 * The whole transition is stated here, by the domain, rather than assembled by whatever implements
 * the port: "a drive we could not recover means failed, crashed, not prompt-ready, finished now" is a
 * decision about sessions, and a storage adapter that chose it would be a second place this row's
 * safety lives.
 */
export interface RuntimeQuarantinePatch {
  readonly status: 'failed';
  readonly health: 'crashed';
  readonly promptReady: false;
  readonly finishedAt: string;
  readonly reason: string;
  /** The instruction a human sees on the session — a sentence, not a flag. */
  readonly needsHuman: string;
  readonly needsHumanKind: string;
}

/**
 * What a reference off the wire turned out to be.
 *
 * THREE OUTCOMES, NOT TWO, and the third is the reason this is a union rather than
 * `SessionId | undefined`. A string that is not a session id at all is a client bug and answers
 * `400 invalid_request`; a well-formed id this daemon does not hold is `404 not-found`. Collapsing
 * them would report a caller's malformed input as somebody's deleted session — and would silently
 * change what these two routes already answer.
 */
export type RuntimeReference =
  | { readonly kind: 'session'; readonly id: SessionId }
  /** Not a usable session id in the first place. */
  | { readonly kind: 'invalid' }
  /** Well formed, and no session of this daemon's carries it. */
  | { readonly kind: 'missing' };

/**
 * The durable boundary: reading the session, journalling, and recording a quarantine.
 *
 * `find` is separate from `view` because a reference off the wire is not yet an id, and answering
 * `not_found` for something that was never a usable id at all would hide a client bug as a missing
 * session.
 */
export interface RuntimeRepository {
  /** Parse the reference and say whether this daemon holds it. */
  find(reference: string): RuntimeReference;
  /** The session as every other surface reads it, or nothing when its documents do not parse. */
  view(id: SessionId): Promise<SessionView | undefined>;
  launch(id: SessionId): Promise<RuntimeLaunchTarget | undefined>;
  journal(id: SessionId, event: string, data: Readonly<Record<string, unknown>>): Promise<void>;
  quarantine(id: SessionId, patch: RuntimeQuarantinePatch): Promise<void>;
}

/** The pane a control types into, and the stop a failed drive falls back on. */
export interface RuntimePane {
  state(tmuxSession: string): Promise<RuntimePaneObservation>;
  stop(tmuxSession: string): Promise<void>;
}

/** Types one native command into a live composer and says how the harness took it. */
export interface RuntimeInjector {
  deliver(tmuxSession: string, command: string): Promise<InjectionOutcome>;
}

/** Binds a picker transport to one tmux session. The driver itself is built from it in the domain. */
export type RuntimePickerTransport = (tmuxSession: string) => CodexPickerDrivePort;
