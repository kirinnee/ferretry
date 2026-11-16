/**
 * The guarded call that turns a refusal into the sentence a person reads (today's `useSetupAccess` and
 * `changeRefusalSentence`, narrowed to what a links read or keep can meet).
 */

import { DaemonCallError } from '@ferretry/app';
import { z } from 'zod';

const NO_ANSWER = 'This machine didn’t answer, so nothing was changed. Check it is awake and try again.';

/** An error's own message as a parenthesised aside, without its trailing full stop; nothing when it has none. */
const detail = (value: unknown): string => {
  const text = value instanceof Error ? value.message.trim() : '';
  return text === '' ? '' : ` (${text.replace(/[.\s]+$/u, '')})`;
};

/** A failed links read or keep, in words a person can act on: the daemon's own sentence when it gave one. */
export const linkRefusalSentence = (error: unknown): string => {
  if (error instanceof DaemonCallError)
    return error.message.trim() === '' ? `This machine refused the change (${String(error.status)}).` : error.message;
  if (error instanceof z.ZodError)
    return 'This machine answered in a form this copy of the app doesn’t understand, so the two are probably on different versions. Reload the app, and update Ferretry on the machine if it still happens.';
  if (!(error instanceof Error)) return NO_ANSWER;
  // A dropped relay session may have carried the keep through, so it is NOT a "try again": matched by name, as today.
  if (error.name === 'RelaySessionError')
    return `The connection to this machine broke before it answered${detail(error)}. It may still have made the change — check before trying again.`;
  return `This machine didn’t answer${detail(error)}. Check it is awake and try again.`;
};

export type Guarded<T> =
  | { readonly kind: 'done'; readonly value: T }
  | { readonly kind: 'refused'; readonly sentence: string };

/** Runs one call and answers its value, or the sentence for its refusal; never throws. */
export const guarded = async <T>(work: () => Promise<T>): Promise<Guarded<T>> => {
  try {
    return { kind: 'done', value: await work() };
  } catch (error) {
    return { kind: 'refused', sentence: linkRefusalSentence(error) };
  }
};
