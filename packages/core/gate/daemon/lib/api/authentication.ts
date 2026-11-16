import { createHash } from 'node:crypto';
import type { FerretId } from '@ferretry/kernel/contract';
import {
  type AuthenticatedCredential,
  type BearerDigest,
  type FerretBearerDirectory,
  isFerretToken,
} from '../../../contract/index.ts';

/**
 * The tokens Gate accepts — the HOST's tokens, and only those (today's `ApiCredentials`).
 *
 * `admin` is the full-authority token. `warden` is a capability-scoped token the warden pane runs under. A ferret's
 * own `fys_` token is looked up through the `bearers:ferret` directory Ferrets provides, by digest.
 *
 * THERE IS NO DEVICE CREDENTIAL HERE, AND THAT IS THE POINT. A paired device proves a key inside a session, and the
 * kernel stamps the proven holder as `ApiRequest.principal`. Nothing a request can send resolves to a device, so a
 * stolen or replayed value has no door left to fit.
 */
export interface GateTokens {
  readonly admin: string;
  readonly warden?: string;
}

/** Who a call proved itself to be (today's `Authentication`, with `session` renamed `ferret`, §1). */
export type Authentication = { readonly kind: 'anonymous' } | AuthenticatedCredential;

/** A ferret token the boundary refused, as the audit log is told it. Nothing the caller sent but the claim. */
export interface FerretTokenRefusal {
  readonly reason: 'session_mismatch';
  /** The ferret the TOKEN names. */
  readonly ferret: FerretId;
  /** `METHOD path` of the refused call. */
  readonly route: string;
}

/**
 * Compares two secrets without leaking WHERE they differ through timing.
 *
 * This walks the full length of the longer string every time and folds the length disagreement into the same
 * accumulator. The length itself is not hidden — a token's length is not the secret, its content is.
 */
export function secretsMatch(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
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

/** SHA-256 of a presented bearer, hex: the only form a ferret token is looked up in. */
export function bearerDigest(bearer: string): BearerDigest {
  return createHash('sha256').update(bearer, 'utf8').digest('hex') as BearerDigest;
}

/**
 * What one call presented as a bearer, read from its `Authorization` header and from nowhere else (a token in a URL
 * reaches argv, shell history and every proxy's log). A device's principal is the kernel's stamp, read by admission.
 */
export interface Presented {
  readonly bearer?: string;
  /**
   * Whether the call ARRIVED on this machine's privileged local listener. A ferret token is looked up only then: a
   * pane presents its credential from this host and from nowhere else, so a `fys_` bearer from a carrier is a
   * stranger's, answered from its shape.
   */
  readonly privilegedLocal: boolean;
}

/**
 * Classifies a call's credentials (today's `authenticate`).
 *
 * A blank configured token authenticates NOTHING: a daemon that failed to mint a token would otherwise accept
 * `Authorization: Bearer` from anyone. A ferret token authenticates only as the ferret the directory names for THAT
 * value's digest; one it names nothing for — unknown, rotated, or its ferret no longer running — is anonymous,
 * exactly like a wrong admin token.
 */
export function authenticate(
  tokens: GateTokens | undefined,
  ferrets: FerretBearerDirectory | undefined,
  presented: Presented,
): Authentication {
  const bearer = presented.bearer;
  if (bearer === undefined || tokens === undefined) return { kind: 'anonymous' };
  if (tokens.admin !== '' && secretsMatch(bearer, tokens.admin)) return { kind: 'authenticated', tokenClass: 'admin' };
  if (tokens.warden !== undefined && tokens.warden !== '' && secretsMatch(bearer, tokens.warden))
    return { kind: 'authenticated', tokenClass: 'warden' };
  if (presented.privilegedLocal && isFerretToken(bearer) && ferrets !== undefined) {
    let ferret: FerretId | undefined;
    try {
      ferret = ferrets.ferretFor(bearerDigest(bearer));
    } catch {
      ferret = undefined;
    }
    if (ferret !== undefined && ferret.trim() !== '') return { kind: 'authenticated', tokenClass: 'ferret', ferret };
  }
  return { kind: 'anonymous' };
}
