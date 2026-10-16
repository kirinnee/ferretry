/**
 * The query grammar for reading ONE session's analytics.
 *
 * This module is deliberately pure and transport-free. A session-scoped surface
 * is only honest if the exact session identity is carried by the query itself,
 * so the scope survives every hop — the visible input box, the request, and the
 * canonical query the daemon echoes back. Building that scope is therefore a
 * decision, not a formatting detail, and it is proved by unit tests rather than
 * by a rendered screen.
 *
 * Nothing here reads a daemon, an origin, or a module singleton: callers pass
 * the session id they already resolved from a `(daemonId, sessionId)` scope.
 */

export interface AnalyticsStarter {
  readonly id: string;
  readonly label: string;
  readonly query: string;
  readonly hint: string;
}

/**
 * The exact-session matcher.
 *
 * JSON quoting is the analytics grammar's own quoted-string escape mechanism,
 * so a session id containing a quote, a backslash, a space or a control
 * character round-trips through the parser unchanged instead of terminating the
 * matcher early.
 *
 * `==` is the grammar's LITERAL operator. An id containing `*` or `?` would be
 * read as a glob under the ordinary `=`, which would silently widen a
 * single-session view into a pattern match over the fleet; `==` keeps those
 * characters exact. Ordinary ids retain the compact `=` spelling.
 */
export const analyticsIdQuery = (sessionId: string): string =>
  `{id${/[*?]/.test(sessionId) ? '==' : '='}${JSON.stringify(sessionId)}}`;
