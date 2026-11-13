/**
 * The narrow slice of the per-daemon client (`PluginClient`, §9.6) the logins app uses. Everything here reaches a
 * daemon through `call(routeKey, init)`; no code in this half holds a base URL, a token or a fetch. The shell hands
 * the real client to `implementApp`'s `build`, and a test hands a scripted one.
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import { z } from 'zod';

export type LoginsClient = Pick<PluginClient, 'call'>;

/** The failure fields a shell client puts on what it throws (`DaemonCallError`): read structurally, never by class. */
interface CallFailure {
  readonly status?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
}

const callFailure = (failure: unknown): CallFailure | null =>
  typeof failure === 'object' && failure !== null ? (failure as CallFailure) : null;

const NO_ANSWER = 'This machine didn’t answer. Check it is awake and try again.';

/**
 * Errors whose own message is already the sentence a person needs — a revoked device, an app or a machine that is out
 * of date, a device key this browser cannot use. Matched by name, which each sets, so this module does not import the
 * carrier to recognise its refusals.
 */
const SELF_WORDED: ReadonlySet<string> = new Set([
  'DeviceNotAcceptedError',
  'DaemonOutdatedError',
  'AppOutdatedError',
  'DeviceKeyMissingError',
  'DeviceKeyUnreadableError',
  'DeviceKeyUnsupportedError',
]);

const detail = (value: unknown): string => {
  const text = value instanceof Error ? value.message.trim() : '';
  return text === '' ? '' : ` (${text.replace(/[.\s]+$/u, '')})`;
};

/** A refusal the daemon answered: a numeric status and a code, which the shell's client puts on what it throws. */
const daemonRefusal = (error: unknown): (CallFailure & { readonly status: number }) | null => {
  const failure = callFailure(error);
  return failure !== null && typeof failure.status === 'number' && typeof failure.code === 'string'
    ? (failure as CallFailure & { readonly status: number })
    : null;
};

/** One readable sentence for whatever went wrong, saying WHAT went wrong. */
export const refusalSentence = (error: unknown): string => {
  const refusal = daemonRefusal(error);
  if (refusal !== null) {
    const message = typeof refusal.message === 'string' ? refusal.message.trim() : '';
    return message === '' ? `This machine refused it (${String(refusal.status)}).` : message;
  }
  if (error instanceof z.ZodError)
    return 'This machine answered in a form this copy of the app doesn’t understand, so the two are probably on different versions. Reload the app, and update Ferretry on the machine if it still happens.';
  if (!(error instanceof Error)) return NO_ANSWER;
  if (SELF_WORDED.has(error.name) && error.message.trim() !== '') return error.message;
  if (error.name === 'RelaySessionError')
    return `The connection to this machine broke before it answered${detail(error)}. It may still have done it — check before trying again.`;
  return `This machine didn’t answer${detail(error)}. Check it is awake and try again.`;
};
