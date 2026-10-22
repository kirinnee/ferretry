/**
 * A credential's STATUS and USAGE (docs/design/account-model.md §3.2 C5–C6, §8.1.2–§8.1.3,
 * §8.2.2–§8.2.3): whether the login works, needs renewing or needs a person, and how much of its two
 * rate-limit windows is spent.
 *
 * Both are per CREDENTIAL, never per runtime: one credential is one store and one rate-limit pool, so
 * thirty runtimes on one login are one status and one pair of bars.
 *
 * ## Four words, and "Checking" is not a resting state
 *
 * Exactly **Ready**, **Refresh due**, **Needs sign-in** and **Checking**. Checking means a check is in
 * flight RIGHT NOW (a Check now, or the usage pass reading this credential) and nothing else, because a
 * credential whose usage can never be read — an API key, a token without the usage scope, an endpoint
 * that is down — would otherwise sit on a spinner forever. So a locally valid credential nobody has
 * checked yet is **Ready**, with usage "unknown · not checked yet"; and a check that could not conclude
 * changes no word: the LAST KNOWN word stands, with its age, and `lastCheckInconclusive` says so.
 *
 * ## Claude (§8.1.2) and Codex (§8.2.2) are proved differently, and the difference is the point
 *
 * - **Claude** is proved by the free `GET /api/oauth/usage` read: a `200` or a confirmed Anthropic JSON
 *   `403` is acceptance (the `403` only means the token lacks `user:profile`). A rejection condemns the
 *   login only under the digest guard — the rejection must have been measured against THIS credential
 *   — and only for {@link CREDENTIAL_NEGATIVE_FRESH_MS}, so a person who signs in again elsewhere is
 *   never condemned by an old answer. An expired access token with a refresh token is **Refresh due**:
 *   Claude renews it itself on next use, and Ferretry does nothing.
 * - **Codex** cannot be proved by any read: its usage endpoint answers `200` on a stale token, so that
 *   answer is NEVER login evidence here. A Codex login is proved only by a refresh, and a refresh
 *   ROTATES its single-use token, so nothing here refreshes on a timer or on a read. The status is the
 *   local rule Codex itself applies — **Refresh due** when the access token's `exp` is within five
 *   minutes, or, with no readable `exp`, when `last_refresh` is older than eight days — plus what a
 *   refresh that happened anyway (the harness's own, or a person's explicit Check now) was observed to
 *   say: `refresh_token_expired` / `_reused` / `_invalidated` / `invalid_grant` / `401` is **Needs
 *   sign-in**; anything else is transient and judges nothing. A recorded failure is forgotten the
 *   moment the canonical file advances, because that means some refresh succeeded since.
 *
 * ## Usage is "unknown", never 0%
 *
 * A window is reported only when a source measured it. Passive sources are read first because they
 * cost nothing at all: Claude's statusLine (`fy statusline` writes `usage.json`) and the newest Codex
 * rollout `token_count` event. The active free read is used only when no passive reading is younger
 * than the usage pass's interval. A window with no measurement is `usedPercent` absent, which every
 * surface renders as "unknown" — see {@link usagePercentLabel}.
 *
 * Pure decisions and one service over ports. No timer lives here: {@link CredentialStatusService.observe}
 * is what the EXISTING usage pass calls, and {@link CredentialStatusService.checkNow} is a person.
 */
import { dirname } from 'node:path';
import { z } from 'zod';
import { FLEET_HEALTH_FRESH_MS, type LocalCredentialReading } from '../health.ts';
import {
  type CredentialMaterial,
  type CredentialShape,
  classifyShape,
  credentialShape,
  decodeJwtExpiry,
} from '../identity.ts';
import type { HarnessKind } from '../manifest.ts';
import {
  type CodexRefreshFailure,
  classifyCodexRefreshFailure,
  type FleetTokenRefreshPort,
  SingleFlight,
} from '../token-refresh.ts';
import {
  type FleetCredentialSignal,
  type FleetUsageProbeResult,
  type FleetUsageWindow,
  FleetUsageWindowSchema,
  type PassiveUsageRecord,
} from '../usage.ts';
import type { CredentialStoreResolution, StoredCredentialResolution } from './credentials.ts';

const epochMilliseconds = z.number().int().nonnegative();

// ── The words ────────────────────────────────────────────────────────────────────────────────────

export const CredentialStatusWordSchema = z.enum(['ready', 'refresh_due', 'needs_sign_in', 'checking']);
export type CredentialStatusWord = z.infer<typeof CredentialStatusWordSchema>;

/** The product's words, exactly (§2, §4.1 rule 7). Every surface renders these and no others. */
export const CREDENTIAL_STATUS_LABELS: Readonly<Record<CredentialStatusWord, string>> = {
  ready: 'Ready',
  refresh_due: 'Refresh due',
  needs_sign_in: 'Needs sign-in',
  checking: 'Checking',
};

/** The four shapes that go with the words (§4.1 rule 7). */
export const CREDENTIAL_STATUS_SHAPES: Readonly<Record<CredentialStatusWord, string>> = {
  ready: '●',
  refresh_due: '◐',
  needs_sign_in: '○',
  checking: '◌',
};

/**
 * WHY the word is what it is, as a closed set: the daemon publishes a code and each surface owns the
 * sentence. Never a provider message, never anything derived from credential material.
 */
export const CredentialStatusReasonSchema = z.enum([
  // ready
  /** Claude: the free usage read answered for this token. */
  'provider_accepted',
  /** Claude: a confirmed Anthropic JSON `403` — accepted; only the usage is unreadable. */
  'usage_scope_unavailable',
  /** Claude: a statusLine reading arrived, which only an authenticated request produces (INFERRED). */
  'passive_usage_seen',
  /** Codex: the access token is current by Codex's own rule. */
  'access_current',
  /** Codex: a refresh was observed to succeed. */
  'refresh_accepted',
  /** The login is present and current locally, and nothing has read the provider yet. */
  'not_checked_yet',
  /** Codex signed in with an API key: no token to renew. */
  'api_key',
  /** `store: environment`: the environment authenticates it, so there is no login to check. */
  'from_environment',
  /** The login could not be read just now (a locked keychain, a newer format). Nothing is condemned. */
  'credential_unreadable',
  // refresh_due
  /** The access token has expired and a refresh token can renew it. The harness renews on next use. */
  'access_expired_refreshable',
  /** Codex: the access token expires within five minutes. */
  'access_expiring',
  /** Codex: no readable expiry, and `last_refresh` is older than eight days. */
  'last_refresh_old',
  // needs_sign_in
  /** Nothing is signed in here: an empty slot, or a login that was signed out. */
  'not_signed_in',
  /** The access token expired and there is no refresh token. */
  'access_expired_no_refresh',
  /** Claude: the provider rejected this exact credential. */
  'provider_rejected',
  /** Codex: a refresh said the refresh token expired. */
  'refresh_expired',
  /** Codex: a refresh said the refresh token was spent elsewhere or withdrawn. */
  'refresh_revoked',
  /** Codex: a refresh was refused (`invalid_grant`, `401`). */
  'refresh_rejected',
  /** The store cannot be reached at all (a `host` Codex home that cannot be named). */
  'store_unreachable',
  // checking
  /** A check is running now. */
  'check_in_flight',
]);
export type CredentialStatusReason = z.infer<typeof CredentialStatusReasonSchema>;

// ── The memory a status needs ────────────────────────────────────────────────────────────────────

/** A conclusion some check reached, kept so an inconclusive check later shows it with its age. */
export const CredentialConclusionSchema = z.strictObject({
  word: z.enum(['ready', 'needs_sign_in']),
  reason: CredentialStatusReasonSchema,
  at: epochMilliseconds,
  /** The local credential digest it was measured against: what stops it landing on a new login. */
  fingerprint: z.string().min(1).optional(),
});
export type CredentialConclusion = z.infer<typeof CredentialConclusionSchema>;

/** A Codex refresh observed to fail permanently, and the file state it failed against. */
export const CodexRefreshFailureRecordSchema = z.strictObject({
  failure: z.enum(['expired', 'revoked', 'rejected']),
  at: epochMilliseconds,
  /** The canonical file's `last_refresh` at the time. A later one means a refresh succeeded since. */
  lastRefreshAt: epochMilliseconds.optional(),
  /** The canonical file's digest at the time. A different one means the login was replaced. */
  fingerprint: z.string().min(1).optional(),
});
export type CodexRefreshFailureRecord = z.infer<typeof CodexRefreshFailureRecordSchema>;

/** Where a usage reading came from. The first two are passive; the last two are the free reads. */
export const CredentialUsageSourceSchema = z.enum([
  'claude-statusline',
  'codex-rollout',
  'anthropic-usage',
  'codex-usage',
]);
export type CredentialUsageSource = z.infer<typeof CredentialUsageSourceSchema>;

export const CredentialUsageReadingSchema = z.strictObject({
  source: CredentialUsageSourceSchema,
  at: epochMilliseconds,
  fiveHour: FleetUsageWindowSchema.optional(),
  weekly: FleetUsageWindowSchema.optional(),
});
export type CredentialUsageReading = z.infer<typeof CredentialUsageReadingSchema>;

/** Everything one credential's status is decided from beyond its local read. Small, and serialisable. */
export const CredentialStatusHeadSchema = z.strictObject({
  conclusion: CredentialConclusionSchema.optional(),
  /** The newest check, conclusive or not. */
  lastCheck: z.strictObject({ at: epochMilliseconds, conclusive: z.boolean() }).optional(),
  codexFailure: CodexRefreshFailureRecordSchema.optional(),
  /** The newest active (free-read) usage measurement. Passive ones are read from their source. */
  activeUsage: CredentialUsageReadingSchema.optional(),
});
export type CredentialStatusHead = z.infer<typeof CredentialStatusHeadSchema>;

/** How long a NEGATIVE Claude conclusion stands. Positive ones only age; see the module note. */
export const CREDENTIAL_NEGATIVE_FRESH_MS = FLEET_HEALTH_FRESH_MS;

/** Codex's own rule: an access token this close to `exp` is refreshed at the next start. */
export const CODEX_REFRESH_LEEWAY_MS = 5 * 60 * 1_000;

/** Codex's own rule when the access token carries no readable `exp`. */
export const CODEX_LAST_REFRESH_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1_000;

// ── Codex's auth.json, reduced to facts ───────────────────────────────────────────────────────────

/** What a Codex `auth.json` says, with every token removed. */
export type CodexAuthFacts =
  | { readonly state: 'missing' }
  | { readonly state: 'unreadable' }
  | { readonly state: 'api_key' }
  | {
      readonly state: 'tokens';
      readonly hasAccess: boolean;
      readonly hasRefresh: boolean;
      readonly accessExpiresAt?: number;
      readonly lastRefreshAt?: number;
      /** From the id token's `https://api.openai.com/auth` claim `chatgpt_plan_type`. Display only. */
      readonly planType?: string;
      /** The id token's `email` claim, trimmed. Display only. */
      readonly email?: string;
    };

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const present = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';

/** An id token's claims. The signature is not checked: everything read from them is display only. */
function idTokenClaims(idToken: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!present(idToken)) return undefined;
  const payload = idToken.split('.')[1];
  if (payload === undefined || payload.length === 0) return undefined;
  try {
    return asRecord(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown);
  } catch {
    return undefined;
  }
}

/** The plan type out of an id token's claims. The signature is not checked; it is display only. */
export function codexPlanType(idToken: unknown): string | undefined {
  const claims = idTokenClaims(idToken);
  const nested = asRecord(claims?.[OPENAI_AUTH_CLAIM])?.chatgpt_plan_type;
  const flat = claims?.[`${OPENAI_AUTH_CLAIM}.chatgpt_plan_type`];
  const plan = nested ?? flat;
  return present(plan) ? plan : undefined;
}

/** The `email` claim of an id token, trimmed. The signature is not checked; it is display only. */
export function codexEmailClaim(idToken: unknown): string | undefined {
  const email = idTokenClaims(idToken)?.email;
  return typeof email === 'string' && email.trim().length > 0 ? email.trim() : undefined;
}

/**
 * Reduce Codex `auth.json` material to the facts the status needs. No token survives: expiry, the
 * `last_refresh` instant, presence flags, the plan word and the display email.
 */
export function readCodexAuthFacts(material: CredentialMaterial): CodexAuthFacts {
  if (material.outcome === 'absent') return { state: 'missing' };
  if (material.outcome === 'unreadable') return { state: 'unreadable' };
  let root: Readonly<Record<string, unknown>> | undefined;
  try {
    root = asRecord(JSON.parse(material.blob) as unknown);
  } catch {
    return { state: 'unreadable' };
  }
  if (root === undefined) return { state: 'unreadable' };
  const tokens = asRecord(root.tokens);
  if (tokens === undefined) return present(root.OPENAI_API_KEY) ? { state: 'api_key' } : { state: 'missing' };
  const accessExpiresAt = decodeJwtExpiry(tokens.access_token);
  const lastRefresh = typeof root.last_refresh === 'string' ? Date.parse(root.last_refresh) : Number.NaN;
  const planType = codexPlanType(tokens.id_token);
  const email = codexEmailClaim(tokens.id_token);
  return {
    state: 'tokens',
    hasAccess: present(tokens.access_token),
    hasRefresh: present(tokens.refresh_token),
    ...(accessExpiresAt === undefined ? {} : { accessExpiresAt }),
    ...(Number.isFinite(lastRefresh) && lastRefresh >= 0 ? { lastRefreshAt: Math.trunc(lastRefresh) } : {}),
    ...(planType === undefined ? {} : { planType }),
    ...(email === undefined ? {} : { email }),
  };
}

// ── One read of a store, reduced to what may be kept ─────────────────────────────────────────────

/**
 * Everything ONE read of a credential's store says, with no token and no clock in it: what may be kept
 * between reads of a store that has not changed. Derived facts and a truncated digest, never material
 * (docs/secrets.md). What it means at an instant is {@link localReadingAt}.
 */
export interface LocalCredentialFacts {
  readonly shape: CredentialShape;
  /** The truncated digest of the material these facts came from. Absent when nothing was found. */
  readonly fingerprint?: string;
  /** Codex only: its `auth.json`, as facts. */
  readonly codex?: CodexAuthFacts;
}

/** The facts of a store that could not be read at all. Unreadable condemns nothing. */
export const UNREADABLE_CREDENTIAL_FACTS: LocalCredentialFacts = {
  shape: { kind: 'decided', reading: { state: 'unreadable' } },
  codex: { state: 'unreadable' },
};

/** One read's material as facts, given the digest the reader took of it. The material is not kept. */
export function localCredentialFacts(
  harness: HarnessKind,
  material: CredentialMaterial,
  fingerprint: string | undefined,
): LocalCredentialFacts {
  return {
    shape: credentialShape(harness, material),
    ...(fingerprint === undefined ? {} : { fingerprint }),
    ...(harness === 'codex' ? { codex: readCodexAuthFacts(material) } : {}),
  };
}

/** The local reading these facts give at `now`: a kept `valid` still turns `refreshable` on time. */
export function localReadingAt(facts: LocalCredentialFacts, now: number): LocalCredentialReading {
  const reading = classifyShape(facts.shape, now);
  return {
    state: reading.state,
    ...(reading.expiresAt === undefined ? {} : { expiresAt: reading.expiresAt }),
    ...(facts.fingerprint === undefined ? {} : { fingerprint: facts.fingerprint }),
  };
}

// ── The decision ─────────────────────────────────────────────────────────────────────────────────

/** One credential's published status. */
export const CredentialStatusSchema = z.strictObject({
  word: CredentialStatusWordSchema,
  reason: CredentialStatusReasonSchema,
  /** When the evidence behind the word was observed, when there is an instant to name. */
  since: epochMilliseconds.optional(),
  /** When the newest check finished. Absent means nothing has checked this credential yet. */
  lastCheckedAt: epochMilliseconds.optional(),
  /** The newest check could not conclude, and the word rests on older evidence (or none). */
  lastCheckInconclusive: z.boolean(),
  /** Codex: the plan the login is on, when its id token said. Display only. */
  planType: z.string().min(1).optional(),
});
export type CredentialStatus = z.infer<typeof CredentialStatusSchema>;

const status = (
  word: CredentialStatusWord,
  reason: CredentialStatusReason,
  head: CredentialStatusHead,
  since?: number,
  planType?: string,
): CredentialStatus => ({
  word,
  reason,
  ...(since === undefined ? {} : { since }),
  ...(head.lastCheck === undefined ? {} : { lastCheckedAt: head.lastCheck.at }),
  lastCheckInconclusive: head.lastCheck !== undefined && !head.lastCheck.conclusive,
  ...(planType === undefined ? {} : { planType }),
});

/** The last known word, for a credential that could not be read just now. Never condemns. */
function lastKnown(head: CredentialStatusHead): CredentialStatus {
  return head.conclusion === undefined
    ? status('ready', 'credential_unreadable', head)
    : status(head.conclusion.word, head.conclusion.reason, head, head.conclusion.at);
}

export interface ClaudeStatusInput {
  readonly local: LocalCredentialReading;
  readonly head: CredentialStatusHead;
  /** The newest statusLine reading, when one exists. */
  readonly passive?: PassiveUsageRecord;
  readonly checking: boolean;
  readonly now: number;
}

/** §8.1.2, in one ordered pass. Pure and total. */
export function decideClaudeStatus(input: ClaudeStatusInput): CredentialStatus {
  const { local, head } = input;
  if (input.checking) return status('checking', 'check_in_flight', head);
  if (local.state === 'missing') {
    return local.expiresAt === undefined
      ? status('needs_sign_in', 'not_signed_in', head)
      : status('needs_sign_in', 'access_expired_no_refresh', head, local.expiresAt);
  }
  if (local.state === 'refreshable') return status('refresh_due', 'access_expired_refreshable', head, local.expiresAt);
  const conclusion = head.conclusion;
  // THE DIGEST GUARD: a rejection condemns only the credential it was measured against, and only
  // while it is fresh. A login replaced since, or one that is simply old news, is not condemned.
  const rejected =
    conclusion?.word === 'needs_sign_in' &&
    conclusion.fingerprint !== undefined &&
    conclusion.fingerprint === local.fingerprint &&
    input.now - conclusion.at <= CREDENTIAL_NEGATIVE_FRESH_MS;
  if (rejected) return status('needs_sign_in', conclusion.reason, head, conclusion.at);
  if (local.state === 'unreadable') return lastKnown(head);
  const accepted = conclusion?.word === 'ready' ? conclusion : undefined;
  // A statusLine reading is acceptance evidence too: Claude only gets rate limits back from a request
  // the provider ANSWERED for this login (INFERRED). The newer of the two speaks.
  const passiveAt = input.passive?.at;
  if (passiveAt !== undefined && (accepted === undefined || passiveAt > accepted.at)) {
    return status('ready', 'passive_usage_seen', head, passiveAt);
  }
  if (accepted !== undefined) return status('ready', accepted.reason, head, accepted.at);
  return status('ready', 'not_checked_yet', head);
}

export interface CodexStatusInput {
  readonly facts: CodexAuthFacts;
  /** The canonical file's digest now, so a failure recorded against another file does not stand. */
  readonly fingerprint?: string;
  readonly head: CredentialStatusHead;
  readonly checking: boolean;
  readonly now: number;
}

const FAILURE_REASON: Readonly<Record<CodexRefreshFailureRecord['failure'], CredentialStatusReason>> = {
  expired: 'refresh_expired',
  revoked: 'refresh_revoked',
  rejected: 'refresh_rejected',
};

/** Whether the canonical file has moved on since a failure was recorded against it. */
function advancedSince(record: CodexRefreshFailureRecord, facts: CodexAuthFacts, fingerprint?: string): boolean {
  if (record.fingerprint !== undefined && fingerprint !== undefined && record.fingerprint !== fingerprint) return true;
  if (facts.state !== 'tokens' || facts.lastRefreshAt === undefined) return false;
  return record.lastRefreshAt === undefined || facts.lastRefreshAt > record.lastRefreshAt;
}

/** §8.2.2, in one ordered pass. Pure and total. No remote answer is ever an input here. */
export function decideCodexStatus(input: CodexStatusInput): CredentialStatus {
  const { facts, head, now } = input;
  if (input.checking) return status('checking', 'check_in_flight', head);
  if (facts.state === 'missing') return status('needs_sign_in', 'not_signed_in', head);
  if (facts.state === 'unreadable') return lastKnown(head);
  if (facts.state === 'api_key') return status('ready', 'api_key', head);
  const plan = facts.planType;
  const failure = head.codexFailure;
  if (failure !== undefined && !advancedSince(failure, facts, input.fingerprint)) {
    return status('needs_sign_in', FAILURE_REASON[failure.failure], head, failure.at, plan);
  }
  const expiring = facts.accessExpiresAt !== undefined && facts.accessExpiresAt <= now + CODEX_REFRESH_LEEWAY_MS;
  if (!facts.hasRefresh && (!facts.hasAccess || expiring)) {
    return facts.hasAccess
      ? status('needs_sign_in', 'access_expired_no_refresh', head, facts.accessExpiresAt, plan)
      : status('needs_sign_in', 'not_signed_in', head, undefined, plan);
  }
  if (!facts.hasAccess) return status('refresh_due', 'access_expired_refreshable', head, undefined, plan);
  if (expiring) return status('refresh_due', 'access_expiring', head, facts.accessExpiresAt, plan);
  if (
    facts.accessExpiresAt === undefined &&
    (facts.lastRefreshAt === undefined || now - facts.lastRefreshAt > CODEX_LAST_REFRESH_MAX_AGE_MS)
  ) {
    return status('refresh_due', 'last_refresh_old', head, facts.lastRefreshAt, plan);
  }
  const accepted = head.conclusion?.reason === 'refresh_accepted' ? head.conclusion : undefined;
  if (accepted !== undefined) return status('ready', 'refresh_accepted', head, accepted.at, plan);
  return status('ready', 'access_current', head, facts.lastRefreshAt, plan);
}

/** A credential with no login to read: the environment authenticates it, or its store cannot be reached. */
export function decideStorelessStatus(resolution: CredentialStoreResolution): CredentialStatus {
  return resolution.store === 'environment'
    ? status('ready', 'from_environment', {})
    : status('needs_sign_in', 'store_unreachable', {});
}

// ── Folding what a check learned into the head ───────────────────────────────────────────────────

/**
 * Fold one Claude usage read's credential signal into the head. Only `accepted`, `scope_unavailable`
 * and `rejected` conclude; every other signal is an inconclusive check that leaves the conclusion.
 */
export function foldClaudeSignal(
  head: CredentialStatusHead,
  signal: FleetCredentialSignal | undefined,
  at: number,
  fingerprint: string | undefined,
): CredentialStatusHead {
  const word =
    signal === 'accepted' || signal === 'scope_unavailable'
      ? 'ready'
      : signal === 'rejected'
        ? 'needs_sign_in'
        : undefined;
  if (word === undefined) return { ...head, lastCheck: { at, conclusive: false } };
  const reason: CredentialStatusReason =
    signal === 'accepted'
      ? 'provider_accepted'
      : signal === 'scope_unavailable'
        ? 'usage_scope_unavailable'
        : 'provider_rejected';
  return {
    ...head,
    conclusion: { word, reason, at, ...(fingerprint === undefined ? {} : { fingerprint }) },
    lastCheck: { at, conclusive: true },
  };
}

/** What a Codex refresh came to, judged from the file before and after and the words it said. */
export type CodexRefreshObservation =
  | { readonly kind: 'advanced' }
  | { readonly kind: 'failed'; readonly failure: CodexRefreshFailure }
  | { readonly kind: 'not_run' };

/** Fold one observed Codex refresh into the head. A transient failure judges nothing. */
export function foldCodexRefresh(
  head: CredentialStatusHead,
  observation: CodexRefreshObservation,
  at: number,
  after: { readonly facts: CodexAuthFacts; readonly fingerprint?: string },
): CredentialStatusHead {
  if (observation.kind === 'advanced') {
    const { codexFailure: _cleared, ...rest } = head;
    return {
      ...rest,
      conclusion: { word: 'ready', reason: 'refresh_accepted', at },
      lastCheck: { at, conclusive: true },
    };
  }
  if (observation.kind === 'failed' && observation.failure !== 'transient') {
    const lastRefreshAt = after.facts.state === 'tokens' ? after.facts.lastRefreshAt : undefined;
    return {
      ...head,
      codexFailure: {
        failure: observation.failure,
        at,
        ...(lastRefreshAt === undefined ? {} : { lastRefreshAt }),
        ...(after.fingerprint === undefined ? {} : { fingerprint: after.fingerprint }),
      },
      lastCheck: { at, conclusive: true },
    };
  }
  return { ...head, lastCheck: { at, conclusive: false } };
}

/** Whether the canonical file moved between two reads: a newer `last_refresh` or another digest. */
export function codexFileAdvanced(
  before: { readonly facts: CodexAuthFacts; readonly fingerprint?: string },
  after: { readonly facts: CodexAuthFacts; readonly fingerprint?: string },
): boolean {
  if (before.fingerprint !== undefined && after.fingerprint !== undefined && before.fingerprint !== after.fingerprint) {
    return after.facts.state === 'tokens';
  }
  const was = before.facts.state === 'tokens' ? before.facts.lastRefreshAt : undefined;
  const now = after.facts.state === 'tokens' ? after.facts.lastRefreshAt : undefined;
  return now !== undefined && (was === undefined || now > was);
}

// ── Usage ────────────────────────────────────────────────────────────────────────────────────────

/** One credential's two windows. A window with no `usedPercent` is UNKNOWN, never 0%. */
export const CredentialUsageSchema = z.strictObject({
  fiveHour: FleetUsageWindowSchema,
  weekly: FleetUsageWindowSchema,
  source: CredentialUsageSourceSchema.optional(),
  /** When the reading was taken. Absent means nothing has measured this credential yet. */
  at: epochMilliseconds.optional(),
});
export type CredentialUsage = z.infer<typeof CredentialUsageSchema>;

/** A window's percentage as a surface shows it: the number, or "unknown" — never a made-up 0%. */
export function usagePercentLabel(window: FleetUsageWindow): string {
  return window.usedPercent === undefined ? 'unknown' : `${Math.round(window.usedPercent)}%`;
}

const hasSignal = (reading: CredentialUsageReading | undefined): reading is CredentialUsageReading =>
  reading !== undefined && (reading.fiveHour?.usedPercent !== undefined || reading.weekly?.usedPercent !== undefined);

/** A passive record, as a usage reading. */
export function passiveUsageReading(record: PassiveUsageRecord): CredentialUsageReading {
  return {
    source: record.source,
    at: record.at,
    ...(record.fiveHour === undefined ? {} : { fiveHour: record.fiveHour }),
    ...(record.weekly === undefined ? {} : { weekly: record.weekly }),
  };
}

/** Whether the scheduled pass should make the active free read: no passive reading inside the interval. */
export function needsActiveUsageRead(
  passive: PassiveUsageRecord | undefined,
  now: number,
  intervalMs: number,
): boolean {
  return (
    !hasSignal(passive === undefined ? undefined : passiveUsageReading(passive)) ||
    now - (passive?.at ?? 0) >= intervalMs
  );
}

/**
 * WHEN {@link needsActiveUsageRead} next turns true for a credential: the instant a scheduler must give it
 * the active free read, so the read can be armed for that moment instead of asked about on a timer.
 *
 * A passive reading that measured something holds the read off until it is one interval old; with none,
 * the last time a pass observed the credential does (`observedAt`), so a login no session uses is read
 * once an interval, exactly as a fixed pass reads it. Never observed and no passive reading is due now
 * (`-Infinity`).
 */
export function activeUsageReadDueAt(
  passive: PassiveUsageRecord | undefined,
  observedAt: number | undefined,
  intervalMs: number,
): number {
  const measured = passive !== undefined && hasSignal(passiveUsageReading(passive)) ? passive.at : undefined;
  return Math.max(measured ?? Number.NEGATIVE_INFINITY, observedAt ?? Number.NEGATIVE_INFINITY) + intervalMs;
}

/** The newest reading that measured something, or two unknown windows. */
export function chooseCredentialUsage(readings: readonly (CredentialUsageReading | undefined)[]): CredentialUsage {
  const newest = readings.filter(hasSignal).sort((left, right) => right.at - left.at)[0];
  if (newest === undefined) return { fiveHour: {}, weekly: {} };
  return { fiveHour: newest.fiveHour ?? {}, weekly: newest.weekly ?? {}, source: newest.source, at: newest.at };
}

/** A free read's answer, as a usage reading — or nothing, when it measured nothing. */
export function activeUsageReading(
  source: 'anthropic-usage' | 'codex-usage',
  result: FleetUsageProbeResult,
  at: number,
): CredentialUsageReading | undefined {
  const reading: CredentialUsageReading = {
    source,
    at,
    ...(result.shortWindow === undefined ? {} : { fiveHour: result.shortWindow }),
    ...(result.longWindow === undefined ? {} : { weekly: result.longWindow }),
  };
  return hasSignal(reading) ? reading : undefined;
}

// ── The service ──────────────────────────────────────────────────────────────────────────────────

/** Where heads are kept. The daemon decides how durable; {@link InMemoryCredentialStatusStore} is one. */
export interface CredentialStatusStore {
  read(id: string): Promise<CredentialStatusHead | undefined>;
  write(id: string, head: CredentialStatusHead): Promise<void>;
}

/** Heads for one process's lifetime. A restart starts every credential from its local read again. */
export class InMemoryCredentialStatusStore implements CredentialStatusStore {
  readonly #heads = new Map<string, CredentialStatusHead>();

  async read(id: string): Promise<CredentialStatusHead | undefined> {
    return this.#heads.get(id);
  }

  async write(id: string, head: CredentialStatusHead): Promise<void> {
    this.#heads.set(id, CredentialStatusHeadSchema.parse(head));
  }
}

/** One credential, as the service needs it: its id and where its store is. */
export interface CredentialSubject {
  readonly id: string;
  readonly resolution: CredentialStoreResolution;
}

/** How a local read treats facts kept from an earlier read of the same store. */
export interface CredentialReadOptions {
  /** Read the store itself. A Codex refresh judges itself by the file before and after, so it must. */
  readonly fresh?: boolean;
}

/** The free read's answer, and the facts of the very material whose token it sent: ONE read of the store. */
export interface ActiveUsageRead {
  readonly result: FleetUsageProbeResult;
  readonly local: LocalCredentialFacts;
}

export interface CredentialStatusPorts {
  /**
   * The store's local facts (`CachedCredentialReads.local`): a classification's inputs and a digest,
   * never material. It may answer facts kept from an earlier read of a store that has not changed.
   */
  local(resolution: StoredCredentialResolution, options?: CredentialReadOptions): Promise<LocalCredentialFacts>;
  /** The newest passive reading for a credential: its statusLine file, or its attributed rollouts. */
  passiveUsage(subject: CredentialSubject): Promise<PassiveUsageRecord | undefined>;
  /**
   * The free read — one bodyless GET, and the Codex one is never login evidence — made with a token from
   * ONE read of the store, whose facts come back with the answer so nothing reads the store again.
   */
  activeUsage(resolution: StoredCredentialResolution): Promise<ActiveUsageRead>;
  /** The explicit Codex refresh (Check now only). */
  readonly refresh: FleetTokenRefreshPort;
  readonly heads: CredentialStatusStore;
  now(): number;
  /** The usage pass's interval: a passive reading younger than this makes the active read unnecessary. */
  readonly usageIntervalMs: number;
}

/** What a surface shows for one credential. */
export interface CredentialStatusView {
  readonly id: string;
  readonly harness: HarnessKind;
  readonly status: CredentialStatus;
  readonly usage: CredentialUsage;
}

/** How a read treats a check of the credential that is running right now. */
export interface CredentialViewOptions {
  /**
   * Answer from what is already known, as if no check were running. For a reader that CACHES the
   * answer: "Checking" is true only while the flight lasts, and a cached row outlives it, so the row
   * would go on saying "not known" for its whole lifetime about a check that has long concluded.
   */
  readonly settled?: boolean;
}

/**
 * One credential's status and usage, observed on the existing schedule or checked by a person.
 *
 * Every Codex refresh and every check runs under ONE per-credential {@link SingleFlight}: a Check now
 * that arrives while another is running joins it rather than spending a second single-use token, and
 * the same gate is what a launch renewal (U12) takes. Status reads see it as "Checking".
 *
 * Nothing here throws on a port failure: a read that fails is an unreadable credential, and a probe
 * that throws is an inconclusive check.
 */
export class CredentialStatusService {
  readonly #flight = new SingleFlight<CredentialStatusView>();

  constructor(private readonly ports: CredentialStatusPorts) {}

  /** Whether a check or refresh of this credential is in flight now. */
  busy(id: string): boolean {
    return this.#flight.busy(id);
  }

  /** The status and usage from what is already known. No network, no refresh. */
  async view(subject: CredentialSubject, options: CredentialViewOptions = {}): Promise<CredentialStatusView> {
    return await this.#view(subject, options.settled !== true && this.busy(subject.id));
  }

  /**
   * What the EXISTING usage pass calls for each credential: the passive reading, then — only when it
   * is older than the pass interval — the one free read. Never a refresh.
   *
   * The store is read at most ONCE: the free read's own material gives the facts the view is decided
   * from, and a pass with no free read decides from the facts kept for an unchanged store.
   */
  async observe(subject: CredentialSubject): Promise<CredentialStatusView> {
    return await this.#flight.run(subject.id, async () => {
      const resolution = stored(subject.resolution);
      let local: LocalCredentialFacts | undefined;
      if (resolution !== undefined) {
        const passive = await this.#passive(subject);
        if (needsActiveUsageRead(passive, this.ports.now(), this.ports.usageIntervalMs)) {
          local = await this.#activeRead(subject.id, resolution);
        }
      }
      return await this.#view(subject, false, local);
    });
  }

  /**
   * A person's **Check now** (§8.1.2, §8.2.2). Claude: the same free read, forced. Codex: one refresh
   * under the lock — the file is re-read first, so a refresh some other process just finished is
   * observed rather than repeated — then the free read for usage.
   */
  async checkNow(subject: CredentialSubject): Promise<CredentialStatusView> {
    return await this.#flight.run(subject.id, async () => {
      const resolution = stored(subject.resolution);
      if (resolution?.harness === 'codex') await this.#codexRefresh(subject.id, resolution);
      const local = resolution === undefined ? undefined : await this.#activeRead(subject.id, resolution);
      return await this.#view(subject, false, local);
    });
  }

  /** The free read, folded into the head. The facts of the material it read, when the read happened. */
  async #activeRead(id: string, resolution: StoredCredentialResolution): Promise<LocalCredentialFacts | undefined> {
    let read: ActiveUsageRead | undefined;
    try {
      read = await this.ports.activeUsage(resolution);
    } catch {
      read = undefined;
    }
    const result = read?.result ?? { usageBased: true, ok: false, credentialSignal: 'inconclusive' };
    const at = this.ports.now();
    const head = (await this.ports.heads.read(id)) ?? {};
    const usage = activeUsageReading(resolution.harness === 'claude' ? 'anthropic-usage' : 'codex-usage', result, at);
    let next: CredentialStatusHead = usage === undefined ? head : { ...head, activeUsage: usage };
    // Codex's usage read is NOT login evidence (it answers for a stale token): it never touches the
    // conclusion. Claude's is the proof, pinned to the digest of the very material whose token it sent —
    // so a login replaced while the read was out is never the one its answer lands on.
    if (resolution.harness === 'claude') {
      next = foldClaudeSignal(next, result.credentialSignal, at, read?.local.fingerprint);
    }
    await this.ports.heads.write(id, next);
    return read?.local;
  }

  async #codexRefresh(id: string, resolution: StoredCredentialResolution): Promise<void> {
    // Every read here is FRESH: the refresh is judged by the file before and after, and a kept answer
    // could hide the very write that proves it worked.
    const before = await this.#codexLocal(resolution, true);
    // The canonical file's directory IS a Codex home: the refresh rewrites the one file every runtime
    // links to, which is what makes an explicit refresh safe now (§9.1).
    const home = resolution.harness === 'codex' ? dirname(resolution.canonicalFile) : '';
    let attempt: Awaited<ReturnType<FleetTokenRefreshPort['refresh']>>;
    try {
      attempt = await this.ports.refresh.refresh({ accountId: id, kind: 'codex', home }, async () =>
        codexFileAdvanced(before, await this.#codexLocal(resolution, true)),
      );
    } catch {
      attempt = { outcome: 'error', reason: 'the refresh could not be run' };
    }
    const after = await this.#codexLocal(resolution, true);
    const observation: CodexRefreshObservation = codexFileAdvanced(before, after)
      ? { kind: 'advanced' }
      : attempt.outcome === 'ran'
        ? {
            kind: 'failed',
            failure: classifyCodexRefreshFailure(attempt.evidence ?? { codes: [], unauthorized: false }),
          }
        : { kind: 'not_run' };
    const head = (await this.ports.heads.read(id)) ?? {};
    await this.ports.heads.write(id, foldCodexRefresh(head, observation, this.ports.now(), after));
  }

  /** The status and usage, decided from `known` facts when a read just produced them, else the port's. */
  async #view(
    subject: CredentialSubject,
    checking: boolean,
    known?: LocalCredentialFacts,
  ): Promise<CredentialStatusView> {
    const harness = subject.resolution.harness;
    const resolution = stored(subject.resolution);
    if (resolution === undefined) {
      return {
        id: subject.id,
        harness,
        status: decideStorelessStatus(subject.resolution),
        usage: chooseCredentialUsage([]),
      };
    }
    const head = (await this.ports.heads.read(subject.id)) ?? {};
    const passive = await this.#passive(subject);
    const local = known ?? (await this.#local(resolution, false));
    const now = this.ports.now();
    const decided =
      resolution.harness === 'claude'
        ? decideClaudeStatus({
            local: localReadingAt(local, now),
            head,
            ...(passive === undefined ? {} : { passive }),
            checking,
            now,
          })
        : decideCodexStatus({ ...codexLocalOf(local), head, checking, now });
    return {
      id: subject.id,
      harness,
      status: decided,
      usage: chooseCredentialUsage([
        passive === undefined ? undefined : passiveUsageReading(passive),
        head.activeUsage,
      ]),
    };
  }

  async #passive(subject: CredentialSubject): Promise<PassiveUsageRecord | undefined> {
    try {
      return await this.ports.passiveUsage(subject);
    } catch {
      return undefined;
    }
  }

  async #local(resolution: StoredCredentialResolution, fresh: boolean): Promise<LocalCredentialFacts> {
    try {
      return await this.ports.local(resolution, fresh ? { fresh } : {});
    } catch {
      return UNREADABLE_CREDENTIAL_FACTS;
    }
  }

  async #codexLocal(
    resolution: StoredCredentialResolution,
    fresh: boolean,
  ): Promise<{ readonly facts: CodexAuthFacts; readonly fingerprint?: string }> {
    return codexLocalOf(await this.#local(resolution, fresh));
  }
}

/** A Codex store's facts as its status needs them: the `auth.json` facts and the file's digest. */
function codexLocalOf(local: LocalCredentialFacts): { readonly facts: CodexAuthFacts; readonly fingerprint?: string } {
  return {
    facts: local.codex ?? { state: 'unreadable' },
    ...(local.fingerprint === undefined ? {} : { fingerprint: local.fingerprint }),
  };
}

/** The resolution, when it names a store a login can be read from. */
function stored(resolution: CredentialStoreResolution): StoredCredentialResolution | undefined {
  if (resolution.store === 'environment' || 'unavailable' in resolution) return undefined;
  return resolution;
}
