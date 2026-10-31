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
 */
export interface ApiCredentials {
  readonly admin: string;
  readonly warden?: string;
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

/** What a request presented, read from its `Authorization` header and from nowhere else. A token in
 *  a URL reaches argv, shell history and every proxy's access log, so no query parameter is read. */
export interface PresentedToken {
  readonly bearer?: string;
}

export type Authentication =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'authenticated'; readonly tokenClass: 'admin' | 'warden' }
  | { readonly kind: 'authenticated'; readonly tokenClass: 'device'; readonly deviceId: string };

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

/** A request that DID authenticate, and as which kind of caller. */
export type AuthenticatedCredential = Extract<Authentication, { readonly kind: 'authenticated' }>;
