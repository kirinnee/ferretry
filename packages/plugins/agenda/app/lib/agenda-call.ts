/**
 * HOW THIS HALF REACHES ITS DAEMON: the generated per-daemon client the shell builds it with (§9.6), by route key.
 * No code here holds a base URL, a credential or a fetch; a test hands a scripted `call`.
 *
 * A refusal is read structurally (the shell's `DaemonCallError` carries `status` and `code`) and re-thrown as this
 * half's {@link DaemonResponseError}, so every reader keeps today's one error shape.
 *
 * THE AGENDA CHANNEL HEADER SEAM (GAP(agenda-channel-header)). Today every agenda list read sent
 * `x-fy-agenda-channel: 2` so the daemon answered resolved records as headers (`projection: 'header'`) instead of
 * whole. `PluginClient.call` carries only the allow-listed `x-fy-request-id` (lead decision 7), so that header cannot
 * travel: list reads get whole records, which the list schema accepts (a resolved record is a header OR a whole
 * record) — the same screens, a heavier answer. {@link AGENDA_READ_HEADERS} is the one place that changes when the
 * kernel lets a half send the channel header.
 */

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

/** The headers an agenda read sends: none the client could carry (see the channel header seam above). */
export const AGENDA_READ_HEADERS: PluginCallHeaders = {};

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
  const message = typeof fields.message === 'string' && fields.message !== '' ? fields.message : `HTTP ${status}`;
  return new DaemonResponseError(status, message, typeof fields.code === 'string' ? fields.code : undefined);
};

export type AgendaCallInit = NonNullable<Parameters<PluginClient['call']>[1]>;

/**
 * One call by route key; every failure that says anything surfaces as a {@link DaemonResponseError}. A failure that
 * carries nothing at all (not even an object) is passed on as it came, so a reader shows its own plain words for it.
 */
export const agendaCall = async (client: AgendaCall, route: string, init: AgendaCallInit = {}): Promise<unknown> => {
  try {
    return await client.call(route, init);
  } catch (failure) {
    if (typeof failure !== 'object' || failure === null) throw failure;
    throw responseError(failure);
  }
};
