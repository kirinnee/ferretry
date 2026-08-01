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

/**
 * The visible default demonstrates all three pieces of the language in one
 * line: aggregation, grouping, and an exact matcher. `sum` returns the full
 * token ledger and equivalent API cost rather than the measure-free count view.
 */
export const sessionAnalyticsDefaultQuery = (sessionId: string): string =>
  `sum by (model) ${analyticsIdQuery(sessionId)}`;

/**
 * Every aggregation the language supports, visible without hunting for
 * documentation. A starter always writes a real, editable query into the same
 * input; it never opens a second competing result surface.
 */
export const sessionAnalyticsStarterQueries = (sessionId: string): readonly AnalyticsStarter[] => {
  const scope = analyticsIdQuery(sessionId);
  return [
    {
      id: 'sum',
      label: 'sum',
      query: `sum by (model) ${scope}`,
      hint: 'Total tokens and equivalent API cost, grouped by attributed model.',
    },
    {
      id: 'avg',
      label: 'avg',
      query: `avg by (model) ${scope}`,
      hint: 'Average measures for this session (useful when adding another grouping dimension globally).',
    },
    { id: 'min', label: 'min', query: `min by (model) ${scope}`, hint: 'Minimum known measures.' },
    { id: 'max', label: 'max', query: `max by (model) ${scope}`, hint: 'Maximum known measures.' },
    {
      id: 'count',
      label: 'count',
      query: `count by (status) ${scope}`,
      hint: 'Session count only; count deliberately has no token or cost measures.',
    },
  ];
};
