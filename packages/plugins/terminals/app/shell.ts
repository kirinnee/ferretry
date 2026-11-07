/**
 * THE ONE FILE THAT NAMES WHAT THE TERMINALS HALF TAKES FROM THE APP SHELL (§5, §9.6).
 *
 * Today's views took a `DaemonConnection` (a paired daemon's address and device), a `DaemonSessionScope` and a fetch
 * function from the PWA's store. In 5.0 a half is built once per daemon with that daemon's own client
 * (`implementApp`), so the views only need to NAME the daemon they draw for — to key their state and to refuse a scope
 * that belongs to another one. Nothing here reaches a daemon: every call goes through the client in `lib/plugin-client.ts`.
 *
 * Also here: the sentence for a grant refusal. Access owns the full copy (its `lib/grants.ts`), and a half
 * never imports another plugin's app files, so the terminals half words the one case it meets — a terminal call the
 * operator or a missing passkey refused. The refusal codes are Gate's (`grantRefusalCode`, `STEP_UP_REQUIRED_CODE`); this
 * half declares no use of Gate's contract, so they are written out here and a test pins them to Gate's.
 */

/** A daemon's durable paired id, as the shell keys it. */
export type DaemonId = string;

/** The daemon a view draws for. The client is already that daemon's, so this only names it for keys and guards. */
export interface DaemonConnection {
  readonly daemonId: DaemonId;
}

export const daemonConnection = (daemonId: DaemonId): DaemonConnection => ({ daemonId });

/** A ferret on a daemon: the identity a terminal deck is scoped to (`ferret.side` panels get `subject` = the ferret). */
export interface DaemonSessionScope {
  readonly daemonId: DaemonId;
  readonly sessionId: string;
}

export const daemonSessionScope = (daemon: DaemonConnection, sessionId: string): DaemonSessionScope => {
  if (sessionId.trim() === '') throw new Error('sessionId must not be empty');
  return { daemonId: daemon.daemonId, sessionId };
};

/** A collision-safe key for in-memory session state: the same session id on two daemons are two sessions. */
export const daemonSessionKey = (scope: DaemonSessionScope): string =>
  JSON.stringify([scope.daemonId, scope.sessionId]);

/** A call addressed to another daemon's scope is a programming error, never a request. */
export function assertScopeDaemon(daemon: DaemonConnection, scope: DaemonSessionScope): void {
  if (daemon.daemonId !== scope.daemonId) throw new Error('terminal scope must belong to the requested daemon');
}

// ── Grant refusals ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Why a governed call is refused (Gate's `GrantRefusal`, less the case where nothing was refused). */
export type GrantRefusal = 'not-granted' | 'device-not-granted' | 'step-up-required' | 'undetermined';

/** What a refused governed call is worded as: one explanation, then the daemon's own sentence. */
export interface GrantRefusalNotice {
  readonly refusal: GrantRefusal;
  readonly detail: string;
  readonly guidance: { readonly explanation: string };
}

const EXPLANATION: Readonly<Record<GrantRefusal, string>> = {
  'not-granted': 'The operator of this machine switched this off. It is turned back on on the host.',
  'device-not-granted':
    'The machine allows this, but this device has not been given it. Widen this device at the machine, or from a device that holds it and can configure pairing.',
  'step-up-required': 'This needs your passkey. Confirm on this device and it goes ahead.',
  undetermined:
    'This daemon could not read its own grant document, so it is refusing everything governed by it. Nothing is broken about this browser; the document on the host needs repairing.',
};

/** The `grant_*` code a refused route answers with, and what it means. */
export const REFUSAL_BY_CODE: Readonly<Record<string, GrantRefusal>> = {
  grant_not_granted: 'not-granted',
  grant_step_up_required: 'step-up-required',
  grant_device_not_granted: 'device-not-granted',
  grant_undetermined: 'undetermined',
  grants_undetermined: 'undetermined',
  grant_forbidden: 'not-granted',
};

/**
 * A refusal an ordinary route answered with, or `null` when this failure is about something else. A grant
 * refusal is a 403, or a 503 when the daemon cannot read its own grant document; `detail` is the daemon's own
 * sentence, kept whole because it already names the command a person runs.
 */
export function grantRefusalNotice(error: unknown): GrantRefusalNotice | null {
  if (error === null || typeof error !== 'object') return null;
  const failure = error as { readonly status?: unknown; readonly code?: unknown; readonly message?: unknown };
  if (typeof failure.code !== 'string') return null;
  const refusal = REFUSAL_BY_CODE[failure.code];
  if (refusal === undefined) return null;
  if (failure.status !== 403 && failure.status !== 503) return null;
  const detail = typeof failure.message === 'string' ? failure.message : '';
  return { refusal, detail, guidance: { explanation: EXPLANATION[refusal] } };
}
