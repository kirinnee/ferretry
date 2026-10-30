/**
 * THE PRS A SESSION OPENED ITSELF, read from its own transcript: a shell tool call that ran `gh pr create`,
 * and the pull request URL its result printed (`board-design.md` §3.1 item 4).
 *
 * Only the result of THAT call counts. A URL the session merely mentioned, read or was told about is not a
 * PR it created, and linking it would put somebody else's work on the card.
 */
import { prUrlParts } from '@ferretry/protocol';
import type { TranscriptEvent, TranscriptJsonValue } from '../transcript/types.ts';

/** How many of a session's newest transcript events are read for `gh pr create`. */
export const TRANSCRIPT_EVENTS_SCANNED = 400;

const PR_CREATE = /\bgh\s+pr\s+create\b/u;
const PR_URL = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*/gu;

/** Every string inside a JSON value, depth first. */
const strings = (value: TranscriptJsonValue | undefined): readonly string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(item => strings(item));
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(item => strings(item));
  return [];
};

/** The PR URLs the session's own `gh pr create` calls printed, oldest first, each once. */
export const createdPrUrls = (events: readonly TranscriptEvent[]): readonly string[] => {
  const creating = new Set(
    events.flatMap(event =>
      event.kind === 'tool-call' && strings(event.call.input).some(text => PR_CREATE.test(text)) ? [event.call.id] : [],
    ),
  );
  const urls = events.flatMap(event => {
    if (event.kind !== 'tool-result' || event.result.isError || !creating.has(event.result.callId)) return [];
    const text = [event.result.text ?? '', ...strings(event.result.content)].join('\n');
    return [...text.matchAll(PR_URL)].map(match => match[0]).filter(url => prUrlParts(url) !== null);
  });
  return [...new Set(urls)];
};
