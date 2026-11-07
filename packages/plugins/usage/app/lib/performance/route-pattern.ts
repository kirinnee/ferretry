/**
 * A REQUEST NAMED BY ITS ROUTE, NEVER BY WHAT IT ASKED FOR.
 *
 * A performance report is meant to be pasted into an issue, so it may say which route was slow and
 * nothing else: not the machine's address, not a session id, not a search the owner typed, not a
 * terminal's name. `GET https://studio.local:8787/v1/sessions/fy_s_…/logs?tail=200` is reported as
 * `GET /v1/sessions/:id/logs`, and every session's reads fold into that one row — which is also what
 * makes the row useful, because "the logs route is slow" is the finding, not "this session's".
 *
 * WHAT IS KEPT is the shape every daemon route is written in: lowercase words joined by hyphens
 * (`fleet`, `apply-preview`) and the version segment (`v1`). Anything else in the path — an id with a
 * digit, a capital or an underscore in it, a percent-encoded name — is an `:id`. A few collections
 * are keyed by names a person or an agent chose, which can look exactly like a route word (a
 * terminal called `dev`), so the segment after those is always an `:id`. The origin and the query are
 * dropped whole: the query is where content travels.
 */

/** Collections whose member is named by a person or an agent, so the next segment is never a route word. */
const NAMED_MEMBERS: ReadonlySet<string> = new Set([
  'browsers',
  'profiles',
  'runtimes',
  'secrets',
  'skills',
  'terminals',
]);

/** Route words that follow such a collection on the wire, and so are never a member's name. */
const COLLECTION_ROUTES: ReadonlySet<string> = new Set(['control']);

const ROUTE_WORD = /^(?:[a-z][a-z-]{0,39}|v\d{1,2})$/u;

/** At most this many segments are kept: a deeper path is a file path, and the rest is `…`. */
const MAX_SEGMENTS = 8;

/** `GET /v1/sessions/:id/logs` for a daemon request; the method is upper-cased. */
export const routePattern = (method: string, url: string): string => {
  let pathname: string;
  try {
    pathname = new URL(url, 'http://route.invalid').pathname;
  } catch {
    return `${method.toUpperCase()} :unparsed`;
  }
  const segments = pathname.split('/').filter(segment => segment.length > 0);
  const kept: string[] = [];
  for (const [index, segment] of segments.entries()) {
    if (index === MAX_SEGMENTS) {
      kept.push('…');
      break;
    }
    const previous = segments[index - 1];
    const named = previous !== undefined && NAMED_MEMBERS.has(previous) && !COLLECTION_ROUTES.has(segment);
    kept.push(!named && ROUTE_WORD.test(segment) ? segment : ':id');
  }
  return `${method.toUpperCase()} /${kept.join('/')}`;
};
