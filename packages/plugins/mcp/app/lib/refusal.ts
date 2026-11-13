/**
 * One readable sentence for whatever went wrong with a sign-in act, and it says WHAT went wrong: the daemon's own words
 * when it gave some, a sentence about the app and the machine being on different versions when the answer did not parse,
 * and the transport's own text otherwise (copied from the Machines tabs' `changeRefusalSentence`).
 */
import { z } from 'zod';

const NO_ANSWER = 'This machine didn’t answer, so nothing was changed. Check it is awake and try again.';

/**
 * Errors whose own message is already the sentence a person needs — a revoked device, an app or a machine that is out of
 * date, a device key this browser cannot use. Matched by name, which each sets, so this module does not import the carrier.
 */
const SELF_WORDED: ReadonlySet<string> = new Set([
  'DeviceNotAcceptedError',
  'DaemonOutdatedError',
  'AppOutdatedError',
  'DeviceKeyMissingError',
  'DeviceKeyUnreadableError',
  'DeviceKeyUnsupportedError',
]);

interface CallFailure {
  readonly status?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
}

const detail = (value: unknown): string => {
  const text = value instanceof Error ? value.message.trim() : '';
  return text === '' ? '' : ` (${text.replace(/[.\s]+$/u, '')})`;
};

/** A refusal the daemon answered: a numeric status and a code, which the shell's client puts on what it throws. */
const daemonRefusal = (error: unknown): (CallFailure & { readonly status: number }) | null => {
  if (typeof error !== 'object' || error === null) return null;
  const failure = error as CallFailure;
  return typeof failure.status === 'number' && typeof failure.code === 'string'
    ? (failure as CallFailure & { readonly status: number })
    : null;
};

/** The daemon's machine-readable code on a refusal, when it gave one. */
export const refusalCode = (error: unknown): string | undefined => {
  const code = daemonRefusal(error)?.code;
  return typeof code === 'string' ? code : undefined;
};

export const changeRefusalSentence = (error: unknown): string => {
  const refusal = daemonRefusal(error);
  if (refusal !== null) {
    const message = typeof refusal.message === 'string' ? refusal.message.trim() : '';
    return message === '' ? `This machine refused the change (${String(refusal.status)}).` : message;
  }
  if (error instanceof z.ZodError)
    return 'This machine answered in a form this copy of the app doesn’t understand, so the two are probably on different versions. Reload the app, and update Ferretry on the machine if it still happens.';
  if (!(error instanceof Error)) return NO_ANSWER;
  if (SELF_WORDED.has(error.name) && error.message.trim() !== '') return error.message;
  if (error.name === 'RelaySessionError')
    return `The connection to this machine broke before it answered${detail(error)}. It may still have made the change — check before trying again.`;
  return `This machine didn’t answer${detail(error)}. Check it is awake and try again.`;
};
