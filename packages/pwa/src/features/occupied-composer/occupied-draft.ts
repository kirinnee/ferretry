/**
 * A send refused because the agent's composer already holds the PERSON's own unsent text.
 *
 * The daemon finishes a pointer it typed itself, so what is left is text only the person can decide
 * about. It used to come back as a red sentence naming a session id and a terminal remedy, and the
 * person had to go to the terminal by hand. Now it is read as a fact with the draft attached, so the
 * composer can offer "Send it" and "Clear it" for exactly that text.
 */

import { type ComposerDraftOutcome, composerOccupiedDraft } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';

/** The person's draft a refused send carries, or `undefined` for any other failure. */
export const occupiedDraftOf = (cause: unknown): string | undefined =>
  cause instanceof FyHttpError && cause.status === 409 ? composerOccupiedDraft(cause.body) : undefined;

/** Enough of the draft to recognise, on one line. */
const QUOTE_CHARS = 80;

/** The draft as the notice quotes it: one line, clipped. */
export const draftQuote = (draft: string): string => {
  const line = draft.replace(/\s+/gu, ' ').trim();
  return line.length > QUOTE_CHARS ? `${line.slice(0, QUOTE_CHARS)}…` : line;
};

/**
 * Whether acting on the draft left the composer free for the person's own message to go.
 *
 * `changed` and `absent` count: nothing was pressed, and the retried send meets the composer as it now
 * is — refused again with the new text if there still is some, so a change in the terminal is never
 * overwritten from here.
 */
export const draftResolved = (outcome: ComposerDraftOutcome): boolean =>
  outcome === 'submitted' || outcome === 'cleared' || outcome === 'absent' || outcome === 'changed';

/** What the notice says when the key did not take. */
export const draftStuckLine = (outcome: ComposerDraftOutcome): string =>
  outcome === 'holding'
    ? 'The agent didn’t take that Enter. Try again, or open the terminal.'
    : 'That text didn’t clear. Try again, or open the terminal.';
