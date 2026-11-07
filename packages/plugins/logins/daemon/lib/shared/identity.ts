/**
 * Identity — which accounts share one provider login, and what each home holds.
 *
 * Every lane of one account (`alex`, `auto-alex`, `f5-alex`, …) is the **same provider account**, so a
 * fleet of thirty wrappers on six provider accounts needs **six** browser approvals, not thirty.
 *
 * Getting there is three decisions, all of them here and all of them pure:
 *
 * 1. **Group.** Accounts sharing a provider login form an identity. The caller builds the group from
 *    what it declares — never from a name infix, which would let renaming a wrapper silently move it
 *    to another provider account.
 * 2. **Classify.** Each member's credential is `valid`, `refreshable`, `missing`, or `unreadable`.
 * 3. **Pick a donor.** The freshest usable credential is the one the siblings that need one would
 *    receive. Only an identity with no usable credential anywhere needs a human.
 *
 * ## `unreadable` is a state, and that is the point
 *
 * The tool this replaces had three states: a locked keychain, a timed-out read, and a home with no
 * credential at all were all `missing`. Three things follow from that, and all three are wrong:
 * a report says "missing" when it does not know; a merely-unreadable sibling gets **overwritten**,
 * destroying a credential that may have been fine; and an identity whose reads all failed looks like
 * "no credential anywhere", so it asks a human for an approval nothing needed.
 *
 * So `unreadable` is distinct here, and it is load-bearing:
 *
 * - it can never be a **donor** — a credential nobody could classify is never offered to siblings,
 *   because one broken credential would turn one broken lane into thirty;
 * - it can never be a **target** — a sibling whose credential could not be read is refused and
 *   reported, never overwritten;
 * - an identity with no donor and any unreadable member is **indeterminate**, not "needs login".
 *
 * Nothing in this module reads a credential or names one in a message. Classification
 * takes material a caller already holds and returns a verdict; the material itself stays behind
 * {@link LoginStore}, in an adapter, and never reaches a log line.
 */
import type { HarnessKind } from './harness.ts';

/**
 * How close to expiry an access token still counts as expired.
 *
 * A token that expires during the command that just decided it was fine is not fine, and a clock a
 * minute out of step should not produce a `valid` reading either.
 */
export const CREDENTIAL_EXPIRY_SKEW_MS = 60_000;

/**
 * What is known about one home's credential.
 *
 * `missing` means positively absent or positively dead — an empty home, or an expired token with no
 * way to renew it. `unreadable` means *unknown*: the read failed, or what came back could not be
 * understood. The two are never merged, because one is safe to overwrite and the other is not.
 */
export type CredentialState = 'valid' | 'refreshable' | 'missing' | 'unreadable';

export interface CredentialReading {
  readonly state: CredentialState;
  /** Epoch milliseconds the access token expires, when the credential said so. */
  readonly expiresAt?: number;
  /** Why the state is `unreadable`. Describes the failure, never the credential. */
  readonly reason?: string;
}

/**
 * Credential material exactly as a store found it.
 *
 * Discriminated rather than `string | undefined` on purpose: this is the type that makes "I could not
 * read it" impossible to write down as "there is nothing there".
 */
export type CredentialMaterial =
  | { readonly outcome: 'found'; readonly blob: string }
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'unreadable'; readonly reason: string };

/** Decode a JWT's `exp` claim to epoch milliseconds. The signature is not checked: only the clock. */
export function decodeJwtExpiry(token: unknown): number | undefined {
  if (typeof token !== 'string') return undefined;
  const payload = token.split('.')[1];
  if (payload === undefined || payload.length === 0) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= 0) return undefined;
    return Math.trunc(claims.exp * 1000);
  } catch {
    return undefined;
  }
}

const isPresent = (value: unknown): boolean => typeof value === 'string' && value.length > 0;

/**
 * Classify a parsed credential from the two things that decide it: whether each token is there, and
 * when the access token expires.
 *
 * The order encodes the fail-closed rule. An access token whose expiry could not be read is
 * `unreadable`, not `refreshable`: the credential exists and may well be working, so calling it
 * missing would let a sibling overwrite it, and calling it valid would let it donate a token that
 * might already be dead. Neither providers write, which is why an unknown expiry is anomalous enough
 * to refuse rather than guess.
 */
function classifyTokens(shape: CredentialTokenShape, now: number): CredentialReading {
  const { hasAccess, hasRefresh, expiresAt } = shape;
  if (!hasAccess && !hasRefresh) return { state: 'missing' };
  if (!hasAccess) return { state: 'refreshable' };
  if (expiresAt === undefined) {
    return { state: 'unreadable', reason: 'the credential has an access token but no readable expiry' };
  }
  if (expiresAt > now + CREDENTIAL_EXPIRY_SKEW_MS) return { state: 'valid', expiresAt };
  return hasRefresh ? { state: 'refreshable', expiresAt } : { state: 'missing', expiresAt };
}

/** Which tokens a credential holds and when its access token expires. Presence flags, never a token. */
export interface CredentialTokenShape {
  readonly kind: 'tokens';
  readonly hasAccess: boolean;
  readonly hasRefresh: boolean;
  readonly expiresAt?: number;
}

/**
 * Everything a classification needs from the material, and nothing that changes with the clock — so
 * it can be KEPT between reads of an unchanged store, where a {@link CredentialReading} cannot: its
 * `valid` becomes `refreshable` as time passes with no byte of the credential changing.
 *
 * Either the material already decided the reading whatever the time (absent, unreadable, not the JSON
 * this build expects), or it is a {@link CredentialTokenShape} that {@link classifyShape} judges at a
 * given instant. Neither holds a token.
 */
export type CredentialShape = { readonly kind: 'decided'; readonly reading: CredentialReading } | CredentialTokenShape;

const tokenShape = (accessToken: unknown, refreshToken: unknown, expiresAt: number | undefined): CredentialShape => ({
  kind: 'tokens',
  hasAccess: isPresent(accessToken),
  hasRefresh: isPresent(refreshToken),
  ...(expiresAt === undefined ? {} : { expiresAt }),
});

/** The reading a shape gives at `now`. {@link classifyCredential} is exactly this over {@link credentialShape}. */
export function classifyShape(shape: CredentialShape, now: number): CredentialReading {
  return shape.kind === 'decided' ? shape.reading : classifyTokens(shape, now);
}

/**
 * Parse material as JSON, or say why it could not be.
 *
 * Bytes that are not the JSON this build expects are `unreadable`, never `missing`: a credential
 * written by a newer harness is still a credential, and overwriting it would lose a working login.
 */
function parseMaterial(material: CredentialMaterial, label: string): Record<string, unknown> | CredentialReading {
  if (material.outcome === 'absent') return { state: 'missing' };
  if (material.outcome === 'unreadable') return { state: 'unreadable', reason: material.reason };
  try {
    const parsed = JSON.parse(material.blob) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { state: 'unreadable', reason: `${label} is not a JSON object` };
    }
    return parsed as Record<string, unknown>;
  } catch {
    return { state: 'unreadable', reason: `${label} is not readable JSON` };
  }
}

const isReading = (value: Record<string, unknown> | CredentialReading): value is CredentialReading =>
  typeof (value as CredentialReading).state === 'string';

/** A Claude Code OAuth credential blob, reduced to its {@link CredentialShape}. */
function claudeShape(material: CredentialMaterial): CredentialShape {
  const parsed = parseMaterial(material, 'the Claude credential');
  if (isReading(parsed)) return { kind: 'decided', reading: parsed };
  const nested = parsed.claudeAiOauth;
  const credential = (nested !== null && typeof nested === 'object' ? nested : parsed) as Record<string, unknown>;
  const expiresAt =
    typeof credential.expiresAt === 'number' && Number.isFinite(credential.expiresAt)
      ? Math.trunc(credential.expiresAt)
      : undefined;
  return tokenShape(credential.accessToken, credential.refreshToken, expiresAt);
}

/** A Codex `auth.json`, reduced to its {@link CredentialShape}. Its access token carries its own expiry. */
function codexShape(material: CredentialMaterial): CredentialShape {
  const parsed = parseMaterial(material, 'the Codex credential');
  if (isReading(parsed)) return { kind: 'decided', reading: parsed };
  const tokens = parsed.tokens;
  if (tokens === null || typeof tokens !== 'object') return { kind: 'decided', reading: { state: 'missing' } };
  const { access_token: accessToken, refresh_token: refreshToken } = tokens as Record<string, unknown>;
  return tokenShape(accessToken, refreshToken, decodeJwtExpiry(accessToken));
}

/** Whichever credential this harness keeps, reduced to the facts a classification needs at any instant. */
export function credentialShape(kind: HarnessKind, material: CredentialMaterial): CredentialShape {
  return kind === 'claude' ? claudeShape(material) : codexShape(material);
}

/** Classify whichever credential shape this harness keeps. */
export function classifyCredential(kind: HarnessKind, material: CredentialMaterial, now: number): CredentialReading {
  return classifyShape(credentialShape(kind, material), now);
}

/**
 * A failure's message, or a stated fallback.
 *
 * Never interpolates anything but an error's own text, so a store that accidentally puts credential
 * material in an exception is still the store's bug and not this module's.
 */
export function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}
