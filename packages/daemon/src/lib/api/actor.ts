/**
 * Per-request actor attribution.
 *
 * Every authenticated request is attributed to WHOEVER caused it — the human via the CLI
 * (`admin-cli`) or the web UI (`admin-ui`), a warden (`warden:<its-session-id>`), or a teammate
 * (`peer:<its-session-id>`) — so the journal can answer "who did this" instead of blaming the
 * daemon. The daemon's own reflex actions happen outside any request and keep their genuine
 * `daemon` source.
 *
 * The source threaded this through an `AsyncLocalStorage` singleton: module-level mutable state,
 * ambient and invisible at the call site. Here the actor is resolved once at the authorization
 * boundary and passed to the handler explicitly, which is both testable and impossible to read
 * from the wrong async context.
 *
 * EXTENSIBILITY: an actor is an opaque string to its consumers. A new kind (`cron:…`, `webhook:…`)
 * needs no change here, and an unrecognised value must surface AS ITSELF — never collapsed to
 * `daemon`. `parseActor` splits `kind:id` without a whitelist so unknown kinds round-trip.
 */

/** An event source string. Opaque to consumers; see `parseActor`. */
export type ApiActor = string;

export const WARDEN_ACTOR_PREFIX = 'warden:';
export const PEER_ACTOR_PREFIX = 'peer:';
export const DEVICE_ACTOR_PREFIX = 'device:';

/** A warden's action, tagged with the warden's OWN session id. */
export function wardenActor(sessionId: string): `warden:${string}` {
  return `${WARDEN_ACTOR_PREFIX}${sessionId}`;
}

/** A teammate ("peer") acting over the API, tagged with its session id. */
export function peerActor(sessionId: string): `peer:${string}` {
  return `${PEER_ACTOR_PREFIX}${sessionId}`;
}

/** A paired browser acting under its own revocable credential. */
export function deviceActor(deviceId: string): `device:${string}` {
  return `${DEVICE_ACTOR_PREFIX}${deviceId}`;
}

/** Which bearer token authenticated the request. */
export type TokenClass = 'admin' | 'warden' | 'device';

export interface ApiActorInput {
  readonly tokenClass: TokenClass;
  /** Registry-derived identity, present only for a device token. */
  readonly deviceId?: string;
  /** The acting pane's own session id, present when the request originates inside a teammate or
   *  warden pane. Absent for the human's own shell and for the browser UI. */
  readonly sessionId?: string;
  /** Client self-identification, e.g. `cli`. The browser sends nothing, so absent plus an admin
   *  token means the UI. */
  readonly client?: string;
}

/**
 * Derives the event actor for an authenticated request. Never returns `daemon` — an API request
 * always has a human or an agent behind it. Precedence: a session id (an in-pane caller) names the
 * specific warden or peer; without one, the admin token is the human, split into CLI and UI by the
 * client header.
 */
export function resolveApiActor(input: ApiActorInput): ApiActor {
  if (input.tokenClass === 'device') {
    const deviceId = input.deviceId?.trim();
    return deviceId === undefined || deviceId === '' ? 'device' : deviceActor(deviceId);
  }
  const sessionId = input.sessionId?.trim();
  if (input.tokenClass === 'warden')
    return sessionId === undefined || sessionId === '' ? 'warden' : wardenActor(sessionId);
  if (sessionId !== undefined && sessionId !== '') return peerActor(sessionId);
  return input.client?.trim() === 'cli' ? 'admin-cli' : 'admin-ui';
}

export interface ParsedActor {
  /** The kind before the first ':' (`warden`, `peer`, `admin-cli`, …), or the whole value when
   *  there is no ':'. Never whitelisted, so unknown kinds pass through verbatim. */
  readonly kind: string;
  /** The part after the first ':', when present (a session id for `warden`/`peer`). */
  readonly id?: string;
  /** The original value — what a consumer should display when it does not understand the kind. */
  readonly raw: string;
}

/** Splits a structured actor into `{kind, id}` without a whitelist, so an unrecognised value
 *  degrades to showing itself rather than being lost. */
export function parseActor(source: string): ParsedActor {
  const separator = source.indexOf(':');
  if (separator === -1) return { kind: source, raw: source };
  return { kind: source.slice(0, separator), id: source.slice(separator + 1), raw: source };
}

/**
 * Is this the human operating the daemon directly, rather than an agent self-identifying under the
 * shared admin bearer? The actor must be the value derived by `resolveApiActor`; request bodies and
 * query parameters never participate. This is an operational boundary for honest clients, not a
 * cryptographic per-session capability.
 */
export function isHumanAdminActor(actor: ApiActor | undefined): boolean {
  const { kind } = parseActor(actor ?? '');
  return kind === 'admin-ui' || kind === 'admin-cli';
}
