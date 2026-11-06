/** Session reads and the ferret session credential (`messages.*`, `session.*`). One fragment of `DAEMON_FEATURES`; `index.ts` spreads them all. */
export const SESSION_FEATURES = {
  /**
   * `GET /v1/sessions/:id/messages` reads backward: `?tail=1` and `?through=<cursor>`, answered with `previousCursor`.
   * A daemon without this name ignores both and serves the FIRST page forward, so the app asks only where the
   * machine reports it and otherwise walks the conversation forward as before.
   */
  messagesTail: 'messages.tail.1',
  /**
   * A ferret session's own credential is a bearer class (docs/agent-tools.md § "The ferret session
   * credential"): `Authorization: Bearer fys_…` names its session, and `x-ferretry-session-id` may only
   * agree. A client that sees this name presents that credential and NEVER falls back to the host's admin
   * token, whatever the answer — a refusal from this daemon is the answer, not a sign it is old.
   *
   * REPORTED SINCE EVERY ROUTE TAKES IT: a route declares `caller: 'person' | 'any'`, the credential is the
   * caller's own on every `any` route a ferret's `fy` and MCP tools need (send, notify, the board, its
   * agenda, signals, input requests, reads), and a `person` route refuses it with `403 owner_only` before
   * anything is read. Health lists it only to a request whose carrier can resolve a session bearer (the privileged
   * loopback carrier): on a wildcard or LAN bind no ferret's credential can be read, so the name is withheld there.
   */
  sessionCredential: 'session.credential.1',
} as const;
