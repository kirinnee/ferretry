import type { CapabilityGrants } from '@ferretry/protocol';

/**
 * The tokens the daemon accepts — the HOST's tokens, and only those.
 *
 * `admin` is the full-authority token. `warden` is a capability-scoped token the warden pane runs
 * under: it may read, and it may perform the safe-recovery actions, but it may not start, remove or
 * reconfigure anything. A daemon with no warden token simply has no warden-scoped surface.
 *
 * THERE IS NO DEVICE CREDENTIAL HERE, AND THAT IS THE POINT. A paired device used to present a bearer
 * token in this header; it now proves a key inside a session, and the tunnel attaches the proven
 * identity as `ApiRequest.device`. Nothing a request can send resolves to a device, so a stolen or
 * replayed value has no door left to fit.
 *
 * A FERRET SESSION'S OWN CREDENTIAL is the third bearer (`sessions`, docs/agent-tools.md § "The ferret
 * session credential"): the one the daemon mints into each agent pane and keeps only a hash of.
 */
export interface ApiCredentials {
  readonly admin: string;
  readonly warden?: string;
  /**
   * Which ACTIVE session a session credential was minted for — absent on a daemon that runs no sessions,
   * where no session credential can authenticate anything: fail closed.
   */
  readonly sessions?: SessionCredentialDirectory;
  /**
   * Which devices are paired THIS INSTANT — consulted for a session's device, never to resolve one.
   *
   * A session's device was proved when the session opened, and revoking the device ends its sessions;
   * this is the second half of that, at the request boundary, so a request already in flight on a
   * session being torn down is refused rather than served for a device that no longer exists. Absent
   * is "nobody can say", which refuses every device: fail closed.
   */
  readonly devices?: PairedDeviceDirectory;
}

/** Whether a device grant exists right now, and what it allows. Answers about an id; it resolves no credential. */
export interface PairedDeviceDirectory {
  has(deviceId: string): boolean;
  /**
   * The device's OWN grants — the per-device half of `effective = daemonWide ∧ device` — or `undefined`
   * for a device this daemon no longer holds. Synchronous, because the boundary asks it per request.
   * A directory that cannot answer it (absent) narrows every device to nothing: fail closed.
   */
  grants?(deviceId: string): CapabilityGrants | undefined;
}

/**
 * Where a session credential is looked up: the ONE lookup the agent tools already use
 * (`CredentialAgentIdentities`), so the bearer and the `x-fy-session-capability` header can never
 * disagree about which session a value names.
 *
 * It hashes the presented value and compares it, in constant time, with the stored hash of every ACTIVE
 * session — a stopped, ended or deleted session's hash is not consulted, which is what revokes it. Only a
 * hash is ever held, so nothing here can hand a credential back.
 */
export interface SessionCredentialDirectory {
  resolve(capability: string): Promise<{ readonly sessionId: string } | undefined>;
  /** Told about a refused session credential, so a forged attribution leaves a trace. Never throws into the request. */
  refused?(refusal: SessionCredentialRefusal): Promise<void>;
}

/** A session credential the boundary refused, as the audit log is told it. Nothing the caller sent but the claim. */
export interface SessionCredentialRefusal {
  readonly reason: 'session_mismatch';
  /** The session the CREDENTIAL names. */
  readonly sessionId: string;
  /** `METHOD path` of the refused request. */
  readonly route: string;
}

/**
 * What a request presented, read from its `Authorization` header and from nowhere else. A token in
 * a URL reaches argv, shell history and every proxy's access log, so no query parameter is read.
 */
export interface PresentedToken {
  readonly bearer?: string;
  /**
   * The directory's answer for a session-shaped `bearer`, looked up by {@link presentToken} before the
   * synchronous boundary runs — never anything a request sent. It names the value it answered for, and
   * {@link authenticate} uses it only for that exact bearer.
   */
  readonly session?: { readonly capability: string; readonly sessionId: string };
}

/**
 * Who a request proved itself to be.
 *
 * `session` is a ferret session's own credential, and it names its session: the actor comes from it,
 * never from `x-ferretry-session-id`.
 */
export type Authentication =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'authenticated'; readonly tokenClass: 'admin' | 'warden' }
  | { readonly kind: 'authenticated'; readonly tokenClass: 'device'; readonly deviceId: string }
  | { readonly kind: 'authenticated'; readonly tokenClass: 'session'; readonly sessionId: string };

/**
 * What every session credential minted from now on starts with, so a bearer can be told to be one from
 * its shape alone — without hashing it against every session. The value after it is 32 random bytes,
 * base64url: 43 characters.
 */
export const SESSION_CREDENTIAL_PREFIX = 'fys_';

/**
 * Whether a bearer has the shape of a session credential — the prefix and exactly 43 base64url characters.
 *
 * Only such a value is ever looked up as a bearer: anything else is answered from its shape, so a wrong
 * prefix or length costs a caller nothing it could time. A pane started before the prefix holds an
 * unprefixed value; that is still accepted where it always was, on `x-fy-session-capability`, and stops
 * mattering the next time that pane is launched, because every launch mints a prefixed one.
 */
export function isSessionCredential(bearer: string | undefined): bearer is string {
  return bearer !== undefined && /^fys_[A-Za-z0-9_-]{43}$/u.test(bearer);
}

/**
 * Reads what a request presented, asking the session directory about a session-shaped bearer.
 *
 * This is the asynchronous half of authentication, and the only one: it runs before the boundary, which
 * is synchronous, and hands it the answer. A directory that fails is "nobody can say", which leaves the
 * bearer unresolved and so anonymous — fail closed.
 */
export async function presentToken(credentials: ApiCredentials, bearer: string | undefined): Promise<PresentedToken> {
  if (bearer === undefined) return {};
  if (!isSessionCredential(bearer) || credentials.sessions === undefined) return { bearer };
  const resolved = await credentials.sessions.resolve(bearer).catch(() => undefined);
  return resolved === undefined
    ? { bearer }
    : { bearer, session: { capability: bearer, sessionId: resolved.sessionId } };
}

/**
 * Compares two secrets without leaking WHERE they differ through timing.
 *
 * The source compared tokens with `===`, which returns as soon as two bytes disagree and so leaks a
 * prefix oracle to anyone who can time the daemon. This walks the full length of the longer string
 * every time and folds the length disagreement into the same accumulator. The length itself is not
 * hidden — a token's length is not the secret, its content is.
 */
export function secretsMatch(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    // charCodeAt is NaN past the end; `| 0` makes the out-of-range side a stable 0 so the loop
    // never short-circuits on the shorter string.
    difference |= (left.charCodeAt(index) | 0) ^ (right.charCodeAt(index) | 0);
  }
  return difference === 0;
}

/** Strips the `Bearer ` scheme from an `Authorization` header value. */
export function bearerToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1];
}

/**
 * Classifies a request's credentials.
 *
 * A blank configured token authenticates NOTHING. The source compared the presented bearer against
 * the configured token directly, so a daemon that failed to mint a token — configured token `''` —
 * accepted `Authorization: Bearer` from anyone, silently turning the whole API public. Here an
 * empty configured secret can never match, so a token-less daemon serves only its public routes.
 *
 * A session credential authenticates only as the session the directory named for THAT value
 * ({@link presentToken}); one it named nothing for — unknown, rotated, or its session no longer active —
 * is anonymous, exactly like a wrong admin token.
 */
export function authenticate(credentials: ApiCredentials, presented: PresentedToken): Authentication {
  const admin = credentials.admin;
  const warden = credentials.warden;
  const candidates = presented.bearer === undefined ? [] : [presented.bearer];
  // Admin wins over warden: a token that is somehow both is never treated as scoped.
  if (admin !== '' && candidates.some(candidate => secretsMatch(candidate, admin)))
    return { kind: 'authenticated', tokenClass: 'admin' };
  if (warden !== undefined && warden !== '' && candidates.some(candidate => secretsMatch(candidate, warden)))
    return { kind: 'authenticated', tokenClass: 'warden' };
  const session = presented.session;
  if (
    session !== undefined &&
    isSessionCredential(presented.bearer) &&
    secretsMatch(presented.bearer, session.capability) &&
    session.sessionId.trim() !== ''
  )
    return { kind: 'authenticated', tokenClass: 'session', sessionId: session.sessionId };
  return { kind: 'anonymous' };
}

/**
 * Whether a presented bearer is a device token from before device keys.
 *
 * Read ONLY to answer an old app in words: such a token authenticates nothing — there is no code
 * left that could compare one — but an app still sending it is an app nobody has updated, and a bare
 * `401` would read as "this device was unpaired" rather than "reload to update". The shape is the old
 * `fy_device_` + 43 base64url characters; a pairing id and a device id have different prefixes.
 */
export function isPreKeyDeviceToken(bearer: string | undefined): boolean {
  return bearer !== undefined && /^fy_device_[A-Za-z0-9_-]{43}$/u.test(bearer);
}

/**
 * A request that DID authenticate, and as which kind of caller — as a route handler is handed it.
 *
 * A SESSION CREDENTIAL IS NOT ONE OF THESE YET, and that is enforced here rather than promised: the
 * boundary refuses a session credential on every route it authenticates, so no handler can be reached by
 * one, and this type says so — every `tokenClass` check in a handler stays exhaustive over what it can
 * actually be handed. Widening this is the change that lets a session credential reach a route, and it
 * makes the compiler name every handler that must then decide.
 */
export type AuthenticatedCredential = Exclude<
  Extract<Authentication, { readonly kind: 'authenticated' }>,
  { readonly tokenClass: 'session' }
>;
