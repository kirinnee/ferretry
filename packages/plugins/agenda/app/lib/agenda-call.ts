/**
 * HOW THIS HALF REACHES ITS DAEMON: the generated per-daemon client the shell builds it with (§9.6), by route key.
 * No code here holds a base URL, a credential or a fetch; a test hands a scripted `call`.
 *
 * A refusal is read structurally (the shell's `DaemonCallError` carries `status` and `code`) and re-thrown as this
 * half's {@link DaemonResponseError}, so every reader keeps today's one error shape.
 *
 * THE AGENDA CHANNEL. Every agenda read sends `x-fy-agenda-channel: 2` ({@link AGENDA_READ_HEADERS}), so the daemon
 * answers resolved records as headers (`projection: 'header'`) instead of whole. The shell's client carries it
 * because it is on its closed list of headers (`PluginCallHeaders`).
 */

import { AGENDA_CHANNEL_HEADER, AGENDA_CHANNEL_VERSION } from '@ferretry/core-asks/contract';
import type { PluginCallHeaders, PluginClient } from '@ferretry/kernel/manifest';

/** The slice of the client this half calls through. */
export type AgendaCall = Pick<PluginClient, 'call'>;

/** A refusal the daemon gave (or a call that never got an answer: status 0). */
export class DaemonResponseError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    /** The Ferretry version the answering daemon said it runs, when the caller read it. */
    readonly daemonVersion?: string,
  ) {
    super(message);
    this.name = 'DaemonResponseError';
  }
}

/** Today's name for the same refusal, read by the paged readers. */
export { DaemonResponseError as FyHttpError };

/** The headers an agenda read sends: the channel that asks for resolved records as headers. */
export const AGENDA_READ_HEADERS: PluginCallHeaders = { [AGENDA_CHANNEL_HEADER]: AGENDA_CHANNEL_VERSION };

/** A fresh idempotency id for one write: a retry of the same click is answered with the first answer. */
export const requestIdHeaders = (): PluginCallHeaders => ({ 'x-fy-request-id': crypto.randomUUID() });

interface CallFailure {
  readonly status?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
}

/** Any failure of a call, as this half's refusal. */
export const responseError = (failure: unknown): DaemonResponseError => {
  if (failure instanceof DaemonResponseError) return failure;
  const fields = typeof failure === 'object' && failure !== null ? (failure as CallFailure) : {};
  const status = typeof fields.status === 'number' ? fields.status : 0;
  // The shell words an answer with no body of its own `The daemon answered N.` under `http_N`; this half says `HTTP N`.
  const bare = fields.code === `http_${status}` && fields.message === `The daemon answered ${status}.`;
  const message =
    !bare && typeof fields.message === 'string' && fields.message !== '' ? fields.message : `HTTP ${status}`;
  return new DaemonResponseError(status, message, !bare && typeof fields.code === 'string' ? fields.code : undefined);
};

export type AgendaCallInit = NonNullable<Parameters<PluginClient['call']>[1]>;

/**
 * One call by route key; every ANSWER the daemon gave (a failure with a numeric `status`) surfaces as a
 * {@link DaemonResponseError}. A failure that carries no status is no answer — a dropped session, a timeout, a thrown
 * non-object — so it is passed on as it came, and a reader tells "timed out" and "no answer" from a refusal.
 */
export const agendaCall = async (client: AgendaCall, route: string, init: AgendaCallInit = {}): Promise<unknown> => {
  try {
    return await client.call(route, init);
  } catch (failure) {
    if (typeof failure !== 'object' || failure === null) throw failure;
    if (!(failure instanceof DaemonResponseError) && typeof (failure as CallFailure).status !== 'number') throw failure;
    throw responseError(failure);
  }
};
