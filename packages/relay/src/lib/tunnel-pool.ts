/**
 * THE HOSTED TUNNEL SERVICE'S BOOKKEEPING — `docs/relay-protocol.md` §15, "The hosted tunnel service".
 *
 * Everything here is pure: which account a new tunnel lands on, what one tunnel's durable row says,
 * which nonces are outstanding, when a row is reclaimed, and what the operator is shown. The service in
 * `tunnel-provisioner.ts` sequences these against two ports — Cloudflare and storage — and the Durable
 * Object in `src/adapters/hosted-tunnel-control.ts` only serialises requests and moves bytes.
 *
 * Nothing in this module ever holds a connector token. An account's API token is inside the parsed pool
 * because the provisioner has to send it to Cloudflare, but no row, no status and no log line built here
 * carries it: the operator projection names accounts by their label and zone, and that is all.
 */

import { DaemonIdSchema } from '@ferretry/protocol';
import { z } from 'zod';
import { toBase64Url } from './binary.ts';
import {
  CLOUDFLARE_TUNNELS_PER_ACCOUNT,
  DEFAULT_TUNNEL_RECLAIM_DAYS,
  TUNNEL_CHALLENGE_SECONDS,
  type TunnelAccount,
  TunnelAccountPoolSchema,
  TunnelOriginPortSchema,
  type TunnelRefusalCode,
} from './tunnel.ts';

const TUNNEL_HOUR_MILLISECONDS = 3_600_000;
export const TUNNEL_DAY_MILLISECONDS = 24 * TUNNEL_HOUR_MILLISECONDS;
const TUNNEL_CHALLENGE_MILLISECONDS = TUNNEL_CHALLENGE_SECONDS * 1000;

/**
 * How long a tunnel whose provisioning never finished is kept for its daemon to come back and finish it.
 *
 * Shorter than the reclaim window on purpose: a half-made tunnel serves nobody, and it still counts
 * against its account's ceiling, so leaving it for a month would let a crashing daemon hold capacity it
 * cannot use.
 */
export const TUNNEL_INCOMPLETE_RECLAIM_MILLISECONDS = 24 * TUNNEL_HOUR_MILLISECONDS;

/** A zone check that passed is trusted for a day; one that failed is asked again after an hour. */
export const TUNNEL_ZONE_CHECK_PASSED_MILLISECONDS = 24 * TUNNEL_HOUR_MILLISECONDS;
export const TUNNEL_ZONE_CHECK_FAILED_MILLISECONDS = TUNNEL_HOUR_MILLISECONDS;

/**
 * THE CHALLENGE BOUNDS. Hosted mode has no allowlist and a challenge proves nothing yet — any string
 * shaped like a fingerprint may ask — so the book every nonce lives in is bounded three ways: outstanding
 * nonces per daemon, nonces issued per daemon per window, and nonces issued by the whole service per
 * window. The window is the nonce's own lifetime, so one bounded list holds both the outstanding nonces
 * and the issue log and nothing outlives it.
 */
export const TUNNEL_CHALLENGE_LIMITS = {
  outstandingPerDaemon: 3,
  issuedPerDaemonPerWindow: 6,
  issuedGlobalPerWindow: 512,
} as const;

/** Random bytes behind a hostname label: 80 bits, spelled as 16 lowercase base32 characters. */
export const TUNNEL_LABEL_BYTES = 10;
const LABEL_PATTERN = /^[a-z2-7]{16}$/u;
const HEX32 = /^[0-9a-f]{32}$/u;

const TimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Cloudflare's own identifiers: opaque to us, bounded so a hostile answer cannot grow a row. */
const UpstreamIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9-]+$/u);

export const TunnelLabelSchema = z.string().regex(LABEL_PATTERN, 'a tunnel label');

/**
 * ONE TUNNEL'S DURABLE ROW — the evidence needed to finish making it or to finish deleting it.
 *
 * A row is written BEFORE Cloudflare is asked for anything, and every step it completes is written back
 * before the next one starts. That ordering is the whole defence against an orphan: a tunnel Cloudflare
 * created and nobody recorded can only exist between the create call and the write after it, and the
 * row already names the tunnel (`fy-<label>`), so a retry or the reclaim finds it by name and adopts it.
 *
 * `account` and `accountId` together name the pool entry. A row whose pair the pool no longer holds is
 * ORPHANED: its tunnel is in an account the service has no token for, so it is reported and never
 * retried.
 */
export const TunnelRowSchema = z.strictObject({
  label: TunnelLabelSchema,
  daemonId: DaemonIdSchema,
  account: z.string().min(1).max(32),
  accountId: z.string().regex(HEX32),
  hostname: z.string().min(1).max(260),
  tunnelId: UpstreamIdSchema.nullable(),
  /** The origin port the tunnel's ingress was last written with; null until it has been written. */
  configuredPort: TunnelOriginPortSchema.nullable(),
  dnsRecordId: UpstreamIdSchema.nullable(),
  originPort: TunnelOriginPortSchema,
  createdAt: TimestampSchema,
  lastSeenAt: TimestampSchema,
});
export type TunnelRow = z.infer<typeof TunnelRowSchema>;

/** What the service last learned about an account's zone. Keyed to the triple it checked. */
export const TunnelZoneVerdictSchema = z.strictObject({
  accountId: z.string().regex(HEX32),
  zoneId: z.string().regex(HEX32),
  zone: z.string().min(1).max(200),
  passed: z.boolean(),
  checkedAt: TimestampSchema,
});
export type TunnelZoneVerdict = z.infer<typeof TunnelZoneVerdictSchema>;

const ChallengeEntrySchema = z.strictObject({
  daemonId: DaemonIdSchema,
  nonce: z.string().min(1).max(64),
  issuedAt: TimestampSchema,
  spent: z.boolean(),
});
/** Every nonce issued in the last window, spent or not. */
export const TunnelChallengeBookSchema = z
  .array(ChallengeEntrySchema)
  .max(TUNNEL_CHALLENGE_LIMITS.issuedGlobalPerWindow);
export type TunnelChallengeBook = z.infer<typeof TunnelChallengeBookSchema>;

/** Operator configuration for the tunnel service, beside the pool. */
export const TunnelSettingsSchema = z.strictObject({
  reclaimAfterDays: z.number().int().min(1).max(365),
});
export type TunnelSettings = z.infer<typeof TunnelSettingsSchema>;
export const DEFAULT_TUNNEL_SETTINGS: TunnelSettings = { reclaimAfterDays: DEFAULT_TUNNEL_RECLAIM_DAYS };

// ─── the pool ─────────────────────────────────────────────────────────────────────────────────

export type TunnelPoolState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'ready'; readonly accounts: readonly TunnelAccount[] };

/**
 * Read the `TUNNEL_ACCOUNTS` secret. A pool that does not parse is NO pool, never a partial one.
 *
 * The reason names what is wrong and never echoes the value: a JSON syntax error's own message quotes
 * the text around the fault, which in this secret is an API token, so it is replaced by a fixed sentence,
 * and a schema failure is reported as issue paths and codes — never a message zod built from the input.
 */
export function parseTunnelAccountPool(raw: string | undefined): TunnelPoolState {
  if (raw === undefined || raw.trim() === '') return { kind: 'absent' };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: 'invalid', reason: 'TUNNEL_ACCOUNTS is not JSON' };
  }
  const parsed = TunnelAccountPoolSchema.safeParse(value);
  if (parsed.success) return { kind: 'ready', accounts: parsed.data };
  const issues = parsed.error.issues
    .slice(0, 8)
    .map(issue => `${issue.path.length === 0 ? '(root)' : issue.path.join('.')}: ${issue.code}`);
  return { kind: 'invalid', reason: `TUNNEL_ACCOUNTS does not match the pool schema (${issues.join('; ')})` };
}

/** The pool entry a row belongs to — the same label AND the same account id — or null when orphaned. */
export function tunnelRowAccount(pool: TunnelPoolState, row: Pick<TunnelRow, 'account' | 'accountId'>) {
  if (pool.kind !== 'ready') return null;
  return pool.accounts.find(account => account.name === row.account && account.accountId === row.accountId) ?? null;
}

// ─── hostnames ────────────────────────────────────────────────────────────────────────────────

/** A random hostname label. Never derived from the fingerprint, so DNS cannot link one to a daemon. */
export function tunnelLabel(random: Uint8Array): string {
  if (random.length !== TUNNEL_LABEL_BYTES) throw new RangeError(`a tunnel label needs ${TUNNEL_LABEL_BYTES} bytes`);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let label = '';
  for (const byte of random) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      label += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return label;
}

/** The tunnel's name on Cloudflare: how a retry finds a tunnel whose id was never recorded. */
export function tunnelName(label: string): string {
  return `fy-${label}`;
}

/** What the proxied CNAME points at. */
export function tunnelCnameTarget(tunnelId: string): string {
  return `${tunnelId}.cfargotunnel.com`;
}

/** A row whose every provisioning step is recorded, for the port it currently serves. */
export function tunnelRowComplete(row: TunnelRow): boolean {
  return row.tunnelId !== null && row.configuredPort === row.originPort && row.dnsRecordId !== null;
}

// ─── placement ────────────────────────────────────────────────────────────────────────────────

export type TunnelZoneCheck = 'passed' | 'failed' | 'unchecked';

/** A cached verdict counts only for the triple it checked and only while it is fresh. */
export function tunnelZoneCheck(
  account: TunnelAccount,
  verdict: TunnelZoneVerdict | null,
  now: number,
): TunnelZoneCheck {
  if (
    verdict === null ||
    verdict.accountId !== account.accountId ||
    verdict.zoneId !== account.zoneId ||
    verdict.zone !== account.zone
  ) {
    return 'unchecked';
  }
  const lifetime = verdict.passed ? TUNNEL_ZONE_CHECK_PASSED_MILLISECONDS : TUNNEL_ZONE_CHECK_FAILED_MILLISECONDS;
  if (now - verdict.checkedAt >= lifetime) return 'unchecked';
  return verdict.passed ? 'passed' : 'failed';
}

/** Does Cloudflare's `GET /zones/{zone}` answer place this zone in this account under this name? */
export function tunnelZoneMatches(account: TunnelAccount, zone: { readonly accountId: string; readonly name: string }) {
  return zone.accountId === account.accountId && zone.name === account.zone;
}

export type TunnelAccountStanding = 'eligible' | 'needs-zone-check' | 'draining' | 'full' | 'misconfigured';

/**
 * Whether ONE account can take a new tunnel now. The provisioner walks the pool in its declared order
 * and asks this of each account in turn — the operator's order is the preference.
 */
export function tunnelAccountStanding(
  account: TunnelAccount,
  liveTunnels: number,
  zoneCheck: TunnelZoneCheck,
): TunnelAccountStanding {
  if (!account.accepting) return 'draining';
  if (zoneCheck === 'failed') return 'misconfigured';
  if (liveTunnels >= Math.min(account.maxTunnels, CLOUDFLARE_TUNNELS_PER_ACCOUNT)) return 'full';
  return zoneCheck === 'passed' ? 'eligible' : 'needs-zone-check';
}

/**
 * The refusal when no account took the tunnel. Capacity only when some accepting, correctly configured
 * account exists and is full; every other empty walk is "not set up", because adding capacity would not
 * help it.
 */
export function tunnelPlacementRefusal(standings: readonly TunnelAccountStanding[]): TunnelRefusalCode {
  return standings.includes('full') ? 'tunnel_capacity' : 'tunnel_unavailable';
}

/**
 * The public advertisement: the pool parses and at least one accepting account's zone has not failed
 * its check. Capacity is not consulted — a full pool is still "set up", and says so at provision time.
 */
export function tunnelServiceAvailable(
  pool: TunnelPoolState,
  verdicts: ReadonlyMap<string, TunnelZoneVerdict>,
  now: number,
): boolean {
  if (pool.kind !== 'ready') return false;
  return pool.accounts.some(
    account => account.accepting && tunnelZoneCheck(account, verdicts.get(account.accountId) ?? null, now) !== 'failed',
  );
}

// ─── challenges ───────────────────────────────────────────────────────────────────────────────

export type TunnelChallengeIssue =
  | { readonly ok: true; readonly book: TunnelChallengeBook; readonly nonce: string }
  | { readonly ok: false; readonly book: TunnelChallengeBook; readonly reason: string };

function liveChallenges(book: TunnelChallengeBook, now: number): TunnelChallengeBook {
  return book.filter(entry => now - entry.issuedAt < TUNNEL_CHALLENGE_MILLISECONDS && entry.issuedAt <= now);
}

/** Issue one nonce, or say which bound refused it. The book that comes back has dropped every expired entry. */
export function issueTunnelChallenge(
  book: TunnelChallengeBook,
  daemonId: string,
  nonce: Uint8Array,
  now: number,
): TunnelChallengeIssue {
  const live = liveChallenges(book, now);
  const mine = live.filter(entry => entry.daemonId === daemonId);
  if (live.length >= TUNNEL_CHALLENGE_LIMITS.issuedGlobalPerWindow) {
    return { ok: false, book: live, reason: 'the tunnel service is issuing too many challenges; try again shortly' };
  }
  if (mine.length >= TUNNEL_CHALLENGE_LIMITS.issuedPerDaemonPerWindow) {
    return { ok: false, book: live, reason: 'this machine asked for too many challenges; try again shortly' };
  }
  if (mine.filter(entry => !entry.spent).length >= TUNNEL_CHALLENGE_LIMITS.outstandingPerDaemon) {
    return { ok: false, book: live, reason: 'this machine holds too many unspent challenges' };
  }
  const encoded = toBase64Url(nonce);
  return { ok: true, nonce: encoded, book: [...live, { daemonId, nonce: encoded, issuedAt: now, spent: false }] };
}

/**
 * Spend a nonce by its first use, accepted or not. `valid` is whether it was outstanding for this
 * daemon: issued to it, inside its deadline, and not spent before.
 */
export function spendTunnelChallenge(
  book: TunnelChallengeBook,
  daemonId: string,
  nonce: string,
  now: number,
): { readonly valid: boolean; readonly book: TunnelChallengeBook } {
  const live = liveChallenges(book, now);
  const index = live.findIndex(entry => entry.daemonId === daemonId && entry.nonce === nonce);
  const entry = index === -1 ? undefined : live[index];
  if (entry === undefined || entry.spent) return { valid: false, book: live };
  return { valid: true, book: live.map((each, at) => (at === index ? { ...each, spent: true } : each)) };
}

// ─── reclaim ──────────────────────────────────────────────────────────────────────────────────

export type TunnelRowVerdict = 'keep' | 'retire' | 'orphaned';

/**
 * What the daily alarm does with one active row. Retiring takes the tunnel off its daemon and queues
 * its deletion; an orphaned row is left exactly as it is, because there is no token that could delete it.
 */
export function tunnelRowVerdict(
  row: TunnelRow,
  account: TunnelAccount | null,
  settings: TunnelSettings,
  now: number,
): TunnelRowVerdict {
  if (account === null) return 'orphaned';
  const idle = now - row.lastSeenAt;
  if (!tunnelRowComplete(row)) return idle >= TUNNEL_INCOMPLETE_RECLAIM_MILLISECONDS ? 'retire' : 'keep';
  return idle >= settings.reclaimAfterDays * TUNNEL_DAY_MILLISECONDS ? 'retire' : 'keep';
}

// ─── the operator's view ──────────────────────────────────────────────────────────────────────

export const TunnelOperatorAccountSchema = z.strictObject({
  name: z.string(),
  zone: z.string(),
  accepting: z.boolean(),
  maxTunnels: z.number().int(),
  liveTunnels: z.number().int().nonnegative(),
  zoneCheck: z.enum(['passed', 'failed', 'unchecked']),
});

/**
 * `GET /v1/operator/tunnels`. Never a token of any kind: the schema has no field that could carry one,
 * and the projection below copies named fields rather than spreading an account.
 */
export const TunnelOperatorStatusSchema = z.strictObject({
  version: z.literal(1),
  available: z.boolean(),
  pool: z.enum(['absent', 'invalid', 'ready']),
  poolProblem: z.string().nullable(),
  settings: TunnelSettingsSchema,
  accounts: z.array(TunnelOperatorAccountSchema),
  /** Tunnels on an account the pool no longer holds, by the label and id the rows recorded. */
  orphaned: z.array(
    z.strictObject({ account: z.string(), accountId: z.string(), tunnels: z.number().int().positive() }),
  ),
  /** Tunnels taken off their daemon whose upstream deletion has not finished yet. */
  pendingDeletions: z.number().int().nonnegative(),
  /** Stored rows that would not parse. Nonzero is damage an operator must look at. */
  damagedRows: z.number().int().nonnegative(),
});
export type TunnelOperatorStatus = z.infer<typeof TunnelOperatorStatusSchema>;

export interface TunnelCensus {
  /** Live tunnels per pool account id, retired-but-undeleted ones included: they still exist upstream. */
  readonly liveByAccountId: ReadonlyMap<string, number>;
  /** Every row whose account is not in the pool, active or retired. */
  readonly orphanedRows: readonly Pick<TunnelRow, 'account' | 'accountId'>[];
  readonly pendingDeletions: number;
  readonly damagedRows: number;
}

export function tunnelOperatorStatus(
  pool: TunnelPoolState,
  settings: TunnelSettings,
  verdicts: ReadonlyMap<string, TunnelZoneVerdict>,
  census: TunnelCensus,
  now: number,
): TunnelOperatorStatus {
  const accounts = pool.kind === 'ready' ? pool.accounts : [];
  const orphaned = new Map<string, { account: string; accountId: string; tunnels: number }>();
  for (const row of census.orphanedRows) {
    const key = `${row.account}\u0000${row.accountId}`;
    const entry = orphaned.get(key) ?? { account: row.account, accountId: row.accountId, tunnels: 0 };
    orphaned.set(key, { ...entry, tunnels: entry.tunnels + 1 });
  }
  return {
    version: 1,
    available: tunnelServiceAvailable(pool, verdicts, now),
    pool: pool.kind,
    poolProblem: pool.kind === 'invalid' ? pool.reason : null,
    settings,
    accounts: accounts.map(account => ({
      name: account.name,
      zone: account.zone,
      accepting: account.accepting,
      maxTunnels: account.maxTunnels,
      liveTunnels: census.liveByAccountId.get(account.accountId) ?? 0,
      zoneCheck: tunnelZoneCheck(account, verdicts.get(account.accountId) ?? null, now),
    })),
    orphaned: [...orphaned.values()],
    pendingDeletions: census.pendingDeletions,
    damagedRows: census.damagedRows,
  };
}

/** HTTP status for every refusal code, so the Worker and the Durable Object cannot disagree. */
export function tunnelRefusalStatus(code: TunnelRefusalCode): number {
  switch (code) {
    case 'tunnel_bad_request':
      return 400;
    case 'tunnel_claim_rejected':
    case 'tunnel_challenge_expired':
      return 401;
    case 'tunnel_rate_limited':
      return 429;
    case 'tunnel_upstream_failed':
      return 502;
    case 'tunnel_unavailable':
    case 'tunnel_capacity':
      return 503;
  }
}
