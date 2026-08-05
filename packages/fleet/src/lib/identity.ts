/**
 * Identity — which accounts share one provider login, and how one credential reaches all of them.
 *
 * This is the shape the whole fleet rests on. Every lane of one account (`kirin`, `auto-kirin`,
 * `f5-kirin`, …) is the **same provider account**, but each home keeps its own credential copy: a
 * per-home keychain item for Claude, a per-home `auth.json` for Codex. So a fleet of thirty wrappers
 * on six provider accounts needs **six** browser approvals, not thirty — the other twenty-four are
 * copies.
 *
 * Getting there is three decisions, all of them here and all of them pure:
 *
 * 1. **Group.** Accounts sharing a provider login form an identity. The grouping is read from the
 *    configuration's declared `identity`, never inferred from a name infix — the tool this replaces
 *    inferred it, so renaming a wrapper silently moved it to another provider account.
 * 2. **Classify.** Each member's credential is `valid`, `refreshable`, `missing`, or `unreadable`.
 * 3. **Pick a donor and clone it.** The freshest usable credential is copied onto the siblings that
 *    need one. Only an identity with no usable credential anywhere needs a human.
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
 * - it can never be a **donor** — a credential nobody could classify is never cloned onto siblings,
 *   because cloning one broken credential across an identity turns one broken lane into thirty;
 * - it can never be a **target** — a sibling whose credential could not be read is refused and
 *   reported, never overwritten;
 * - an identity with no donor and any unreadable member is **indeterminate**, not "needs login".
 *
 * Nothing in this module reads a credential, writes one, or names one in a message. Classification
 * takes material a caller already holds and returns a verdict; the material itself stays behind
 * {@link FleetCredentialStore}, in an adapter, and never reaches a log line.
 */
import type { FleetConfig } from './config.ts';
import type { AccountMode, FleetManifest, FleetManifestAccount, HarnessKind } from './manifest.ts';
import { groupByIdentity, resolveAccounts } from './profiles.ts';

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
function classifyTokens(
  accessToken: unknown,
  refreshToken: unknown,
  expiresAt: number | undefined,
  now: number,
): CredentialReading {
  const hasAccess = isPresent(accessToken);
  const hasRefresh = isPresent(refreshToken);
  if (!hasAccess && !hasRefresh) return { state: 'missing' };
  if (!hasAccess) return { state: 'refreshable' };
  if (expiresAt === undefined) {
    return { state: 'unreadable', reason: 'the credential has an access token but no readable expiry' };
  }
  if (expiresAt > now + CREDENTIAL_EXPIRY_SKEW_MS) return { state: 'valid', expiresAt };
  return hasRefresh ? { state: 'refreshable', expiresAt } : { state: 'missing', expiresAt };
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

/** Classify a Claude Code OAuth credential blob. */
export function classifyClaudeCredential(material: CredentialMaterial, now: number): CredentialReading {
  const parsed = parseMaterial(material, 'the Claude credential');
  if (isReading(parsed)) return parsed;
  const nested = parsed.claudeAiOauth;
  const credential = (nested !== null && typeof nested === 'object' ? nested : parsed) as Record<string, unknown>;
  const expiresAt =
    typeof credential.expiresAt === 'number' && Number.isFinite(credential.expiresAt)
      ? Math.trunc(credential.expiresAt)
      : undefined;
  return classifyTokens(credential.accessToken, credential.refreshToken, expiresAt, now);
}

/** Classify a Codex `auth.json`. Its access token carries its own expiry, as a JWT claim. */
export function classifyCodexCredential(material: CredentialMaterial, now: number): CredentialReading {
  const parsed = parseMaterial(material, 'the Codex credential');
  if (isReading(parsed)) return parsed;
  const tokens = parsed.tokens;
  if (tokens === null || typeof tokens !== 'object') return { state: 'missing' };
  const { access_token: accessToken, refresh_token: refreshToken } = tokens as Record<string, unknown>;
  return classifyTokens(accessToken, refreshToken, decodeJwtExpiry(accessToken), now);
}

/** Classify whichever credential shape this harness keeps. */
export function classifyCredential(kind: HarnessKind, material: CredentialMaterial, now: number): CredentialReading {
  return kind === 'claude' ? classifyClaudeCredential(material, now) : classifyCodexCredential(material, now);
}

/** One account inside an identity: everything a credential store or a login needs, and nothing else. */
export interface FleetIdentityMember {
  readonly accountId: string;
  readonly wrapper: string;
  /** Absolute harness config directory. Where this account's own credential copy lives. */
  readonly home: string;
  readonly displayName: string;
  readonly mode: AccountMode;
  readonly available: boolean;
  readonly unavailableReason: string | null;
}

/** The accounts behind one provider login. */
export interface FleetIdentity {
  /** `<kind>:<identity>` for a declared identity; `account:<id>` for one the configuration lost. */
  readonly key: string;
  readonly kind: HarnessKind;
  readonly identity: string;
  readonly auth: 'oauth' | 'api-key';
  /**
   * Whether the configuration still describes these accounts. A manifest outlives the configuration
   * that produced it, and an account nobody declared is an identity of one — never a donor for
   * somebody else, never the target of a stranger's credential.
   */
  readonly declared: boolean;
  readonly members: readonly FleetIdentityMember[];
}

/** Two accounts claim one provider login but disagree about how it authenticates. */
export class MixedIdentityAuthError extends Error {
  constructor(
    readonly identityKey: string,
    readonly modes: readonly string[],
  ) {
    super(
      `identity "${identityKey}" mixes authentication modes (${modes.join(', ')}) — give the accounts distinct "identity" values`,
    );
    this.name = 'MixedIdentityAuthError';
  }
}

const memberOf = (account: FleetManifestAccount): FleetIdentityMember => ({
  accountId: account.id,
  wrapper: account.wrapper,
  home: account.home,
  displayName: account.displayName,
  mode: account.mode,
  available: account.available,
  unavailableReason: account.unavailableReason,
});

/**
 * Join the declared configuration to the published manifest and return the provider logins this host
 * has.
 *
 * The configuration owns `identity` and `auth`; the manifest owns where each account actually lives.
 * Neither alone is enough, and neither is guessed from the other. A published account the
 * configuration no longer mentions becomes its own single-member identity, so a stale manifest can
 * cost a human one extra approval but can never move a credential between provider accounts.
 *
 * Throws {@link MixedIdentityAuthError} rather than choosing a reading when two accounts claim one
 * identity and disagree about `auth`: cloning across that boundary is exactly the mistake that has no
 * safe default.
 */
export function buildFleetIdentities(config: FleetConfig, manifest: FleetManifest): readonly FleetIdentity[] {
  const published = new Map(manifest.accounts.map(account => [account.id, account]));
  const claimed = new Set<string>();
  const identities: FleetIdentity[] = [];

  for (const [key, group] of groupByIdentity(resolveAccounts(config))) {
    // Checked across the whole declared group, not just its published members: an identity that
    // disagrees with itself about `auth` is a contradiction whether or not every lane made it into
    // the manifest, and there is no safe way to pick one reading.
    const modes = [...new Set(group.map(resolved => resolved.auth))];
    if (modes.length > 1) throw new MixedIdentityAuthError(key, modes);

    const matched = group.flatMap(resolved => {
      const account = published.get(resolved.id);
      return account === undefined ? [] : [{ resolved, account }];
    });
    const first = matched[0];
    // Declared but never provisioned: the configuration names these accounts and the manifest has
    // none of them, so there is no home to read and nothing to log in.
    if (first === undefined) continue;

    for (const { resolved } of matched) claimed.add(resolved.id);
    identities.push({
      key,
      kind: first.resolved.kind,
      identity: first.resolved.identity,
      auth: first.resolved.auth,
      declared: true,
      members: matched.map(({ account }) => memberOf(account)),
    });
  }

  for (const account of manifest.accounts) {
    if (claimed.has(account.id)) continue;
    identities.push({
      key: `account:${account.id}`,
      kind: account.kind,
      identity: account.id,
      auth: 'oauth',
      declared: false,
      members: [memberOf(account)],
    });
  }

  return identities;
}

/** One member with what was found in its home. */
export interface FleetIdentityMemberStatus {
  readonly member: FleetIdentityMember;
  readonly reading: CredentialReading;
}

/**
 * What should happen to one identity.
 *
 * `indeterminate` is the state this product keeps failing to have: no usable credential was found
 * *and* at least one home could not be read, so "nobody is logged in" is a guess. It asks a human to
 * look rather than opening a browser or overwriting anything.
 */
export type FleetIdentityVerdict =
  | { readonly kind: 'no-login'; readonly reason: string }
  | { readonly kind: 'complete' }
  | { readonly kind: 'sync'; readonly donor: FleetIdentityMember }
  | { readonly kind: 'login' }
  | { readonly kind: 'indeterminate'; readonly reason: string };

export interface FleetIdentityStatus {
  readonly identity: FleetIdentity;
  /** Available members, with the credential each home holds. */
  readonly members: readonly FleetIdentityMemberStatus[];
  /** Members the manifest declares unavailable. Never read, never written, never a donor. */
  readonly unavailable: readonly FleetIdentityMember[];
  readonly verdict: FleetIdentityVerdict;
  /** Siblings that need a credential and would receive the donor's. */
  readonly targets: readonly FleetIdentityMember[];
  /** Siblings refused a clone because their own credential could not be read. */
  readonly refused: readonly FleetIdentityMemberStatus[];
}

const DONOR_RANK: Readonly<Record<CredentialState, number>> = {
  valid: 2,
  refreshable: 1,
  missing: 0,
  unreadable: 0,
};

/**
 * The credential worth cloning: a valid one with the furthest expiry, else the freshest renewable
 * one.
 *
 * A `refreshable` donor is deliberate and is what keeps the approval count down — an expired token
 * with a refresh token renews itself the first time each sibling runs, so one browser approval still
 * covers the whole identity. `missing` and `unreadable` rank zero and can never donate, which is the
 * rule that stops one broken credential becoming thirty.
 */
export function pickDonor(members: readonly FleetIdentityMemberStatus[]): FleetIdentityMemberStatus | undefined {
  const ranked = [...members].sort(
    (left, right) =>
      DONOR_RANK[right.reading.state] - DONOR_RANK[left.reading.state] ||
      (right.reading.expiresAt ?? 0) - (left.reading.expiresAt ?? 0) ||
      left.member.accountId.localeCompare(right.member.accountId),
  );
  const best = ranked[0];
  return best !== undefined && DONOR_RANK[best.reading.state] > 0 ? best : undefined;
}

/**
 * Which member's wrapper represents the identity when a human has to approve something.
 *
 * An interactive lane is preferred because a browser approval is interactive; the choice is read from
 * the declared `mode`, never from a wrapper called `auto-something`.
 */
export function chooseLoginMember(members: readonly FleetIdentityMemberStatus[]): FleetIdentityMember | undefined {
  return (members.find(status => status.member.mode === 'interactive') ?? members[0])?.member;
}

/**
 * Decide one identity from its readings. Pure: the same readings always give the same verdict, and
 * nothing here can touch a credential.
 */
export function decideIdentity(
  identity: FleetIdentity,
  members: readonly FleetIdentityMemberStatus[],
  unavailable: readonly FleetIdentityMember[],
): FleetIdentityStatus {
  const base = { identity, members, unavailable } as const;
  if (identity.auth === 'api-key') {
    return {
      ...base,
      verdict: { kind: 'no-login', reason: 'this account authenticates with a key' },
      targets: [],
      refused: [],
    };
  }

  const donor = pickDonor(members);
  const unreadable = members.filter(status => status.reading.state === 'unreadable');

  if (donor === undefined) {
    if (unreadable.length > 0) {
      return {
        ...base,
        verdict: {
          kind: 'indeterminate',
          reason: `no usable credential was found, and ${unreadable.length} of ${members.length} could not be read — refusing to decide`,
        },
        targets: [],
        refused: unreadable,
      };
    }
    return { ...base, verdict: { kind: 'login' }, targets: [], refused: [] };
  }

  const siblings = members.filter(status => status.member.accountId !== donor.member.accountId);
  const targets = siblings
    .filter(status => status.reading.state === 'missing' || status.reading.state === 'refreshable')
    .map(status => status.member);
  const refused = siblings.filter(status => status.reading.state === 'unreadable');

  return targets.length === 0
    ? { ...base, verdict: { kind: 'complete' }, targets: [], refused }
    : { ...base, verdict: { kind: 'sync', donor: donor.member }, targets, refused };
}

/**
 * Reading and copying credential material.
 *
 * The material never crosses this boundary. `read` returns a classification and `clone` performs the
 * copy end to end, so no secret ever reaches a service, a renderer, or a log line — the only way to
 * keep that promise is for the caller never to hold one.
 */
export interface FleetCredentialStore {
  read(kind: HarnessKind, member: FleetIdentityMember): Promise<CredentialReading>;
  clone(kind: HarnessKind, donor: FleetIdentityMember, target: FleetIdentityMember): Promise<CredentialCloneOutcome>;
}

export type CredentialCloneOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface FleetIdentityCloneResult {
  readonly accountId: string;
  readonly outcome: CredentialCloneOutcome;
}

/**
 * Surveys identities and clones credentials across them.
 *
 * Reads are concurrent because a keychain read can block for seconds and an identity has many homes;
 * clones are sequential because they write.
 */
export class FleetIdentityService {
  constructor(private readonly store: FleetCredentialStore) {}

  async survey(identities: readonly FleetIdentity[]): Promise<readonly FleetIdentityStatus[]> {
    const surveyed: FleetIdentityStatus[] = [];
    for (const identity of identities) surveyed.push(await this.surveyOne(identity));
    return surveyed;
  }

  /**
   * Read every available home in one identity and decide what to do.
   *
   * An API-key identity is decided without a single read: it has no provider credential to find, and
   * looking would be the tool inventing work.
   */
  async surveyOne(identity: FleetIdentity): Promise<FleetIdentityStatus> {
    const available = identity.members.filter(member => member.available);
    const unavailable = identity.members.filter(member => !member.available);
    if (identity.auth === 'api-key') {
      return decideIdentity(
        identity,
        available.map(member => ({ member, reading: { state: 'missing' as const } })),
        unavailable,
      );
    }
    const members = await Promise.all(
      available.map(async member => ({ member, reading: await this.#read(identity.kind, member) })),
    );
    return decideIdentity(identity, members, unavailable);
  }

  /**
   * Clone the donor's credential onto the targets this status named.
   *
   * A status whose verdict is not `sync` yields nothing. The guard is here rather than at the call
   * site because it is the one place that can guarantee it: a caller that forgot to check cannot
   * cause a write.
   */
  async sync(status: FleetIdentityStatus): Promise<readonly FleetIdentityCloneResult[]> {
    if (status.verdict.kind !== 'sync') return [];
    const donor = status.verdict.donor;
    const results: FleetIdentityCloneResult[] = [];
    for (const target of status.targets) {
      results.push({ accountId: target.accountId, outcome: await this.#clone(status.identity.kind, donor, target) });
    }
    return results;
  }

  /** A store that throws is a read that failed, not a home with no credential. */
  async #read(kind: HarnessKind, member: FleetIdentityMember): Promise<CredentialReading> {
    try {
      return await this.store.read(kind, member);
    } catch (error) {
      return { state: 'unreadable', reason: failureMessage(error, 'the credential could not be read') };
    }
  }

  async #clone(
    kind: HarnessKind,
    donor: FleetIdentityMember,
    target: FleetIdentityMember,
  ): Promise<CredentialCloneOutcome> {
    try {
      return await this.store.clone(kind, donor, target);
    } catch (error) {
      return { ok: false, reason: failureMessage(error, 'the credential could not be copied') };
    }
  }
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

/**
 * Identities containing any of `accountIds`, in survey order.
 *
 * Naming one account selects its whole identity, because the credential is shared: there is no such
 * thing as logging half an identity in, and pretending otherwise would leave siblings signed out with
 * nothing said. An id no identity claims is an error rather than an empty selection.
 */
export function selectIdentities(
  identities: readonly FleetIdentity[],
  accountIds: readonly string[],
): readonly FleetIdentity[] {
  const owners = new Map<string, string>();
  for (const identity of identities) {
    for (const member of identity.members) owners.set(member.accountId, identity.key);
  }
  const wanted = new Set<string>();
  for (const accountId of accountIds) {
    const key = owners.get(accountId);
    if (key === undefined) throw new UnknownIdentityAccountError(accountId);
    wanted.add(key);
  }
  return identities.filter(identity => wanted.has(identity.key));
}

export class UnknownIdentityAccountError extends Error {
  constructor(readonly accountId: string) {
    super(`unknown fleet account "${accountId}"`);
    this.name = 'UnknownIdentityAccountError';
  }
}
