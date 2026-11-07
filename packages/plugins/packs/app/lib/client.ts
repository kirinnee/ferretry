/**
 * The narrow slice of the per-daemon client (`PluginClient`, §9.6) the packs app uses. Everything here reaches a daemon
 * through `call(routeKey, init)`; no code in this half holds a base URL, a token or a fetch. The shell hands the real
 * client to `implementApp`'s `build`, and a test hands a scripted one.
 */

import type { PluginClient } from '@ferretry/kernel/manifest';

export type PacksClient = Pick<PluginClient, 'call'>;

/** The failure fields a shell client puts on what it throws (`DaemonCallError`): read structurally, never by class. */
export interface CallFailure {
  readonly status?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
}

export const callFailure = (failure: unknown): CallFailure | null =>
  typeof failure === 'object' && failure !== null ? (failure as CallFailure) : null;

const NO_ANSWER = 'This machine did not answer.';

/** What a failed call says, as one sentence: the daemon's own words when it gave any. */
export const refusalSentence = (cause: unknown): string => {
  const failure = callFailure(cause);
  const message = typeof failure?.message === 'string' ? failure.message.trim() : '';
  if (typeof failure?.status === 'number')
    return message === '' ? `This machine refused the change (${String(failure.status)}).` : message;
  return message === '' ? NO_ANSWER : message;
};
