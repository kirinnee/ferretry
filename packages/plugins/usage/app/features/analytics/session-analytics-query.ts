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
