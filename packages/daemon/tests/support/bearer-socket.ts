/**
 * A WebSocket that presents the daemon's token the only way the daemon reads one: an
 * `Authorization: Bearer` header. Bun's constructor accepts headers; the DOM typings do not say so.
 * No credential is ever put in the URL — the daemon reads none from there, and a test that did would
 * be proving a door the product has closed.
 */
export function bearerSocket(url: string, token: string): WebSocket {
  const AuthenticatedWebSocket = WebSocket as unknown as {
    new (target: string, options: { headers: Record<string, string> }): WebSocket;
  };
  return new AuthenticatedWebSocket(url, { headers: { authorization: `Bearer ${token}` } });
}
