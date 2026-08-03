/**
 * The tokens the daemon accepts.
 *
 * `admin` is the full-authority token. `warden` is a capability-scoped token the warden pane runs
 * under: it may read, and it may perform the safe-recovery actions, but it may not start, remove or
 * reconfigure anything. A daemon with no warden token simply has no warden-scoped surface.
 */
export interface ApiCredentials {
  readonly admin: string;
  readonly warden?: string;
  /** Per-device credentials are hashed and resolved by the daemon-local registry. */
  readonly devices?: DeviceCredentialVerifier;
}

export interface DeviceCredentialVerifier {
  identify(token: string): string | undefined;
}

/** What a request presented. Assembled by the dispatcher from headers and, for loopback WebSocket
 *  upgrades only, the query string. */
export interface PresentedToken {
  readonly bearer?: string;
  /** A token supplied as a query parameter. Only ever populated for loopback peers. */
  readonly query?: string;
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
  const candidates = [presented.bearer, presented.query].filter((value): value is string => value !== undefined);
  // Admin wins over warden: a token that is somehow both is never treated as scoped.
  if (admin !== '' && candidates.some(candidate => secretsMatch(candidate, admin)))
    return { kind: 'authenticated', tokenClass: 'admin' };
  if (warden !== undefined && warden !== '' && candidates.some(candidate => secretsMatch(candidate, warden)))
    return { kind: 'authenticated', tokenClass: 'warden' };
  if (credentials.devices !== undefined) {
    for (const candidate of candidates) {
      // A blank secret authenticates nothing HERE too, not only against the host tokens above. A
      // loopback upgrade carrying `?token=` arrives as '', and a verifier is an injected port whose
      // implementation is free to be sloppier than this one; the seam must not depend on it.
      if (candidate.trim() === '') continue;
      const identity = credentials.devices.identify(candidate)?.trim();
      // A verifier that answers with a blank identity has said "I do not know who this is". Reading
      // that as a match would authorize an unattributable device on every operator route and
      // journal it as the bare actor `device` — damaged evidence taken for the benign case. An
      // identity or nothing.
      if (identity !== undefined && identity !== '')
        return { kind: 'authenticated', tokenClass: 'device', deviceId: identity };
    }
  }
  return { kind: 'anonymous' };
}
