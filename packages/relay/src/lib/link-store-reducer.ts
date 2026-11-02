/**
 * THE LINK STORE'S RULES — docs/catalogs.md § Links, as one pure function.
 *
 * `reduceLinkStore(state, event)` answers every request the store can get and returns the state that
 * follows. It reads no clock, no network and no randomness: the adapter that wraps it (a Durable Object,
 * a test) hands in `now`, a nonce it minted, the verifier of the token it hashed and the envelope it read,
 * and does the signature check (`verifyLinkStoreRequest`) between a `spend-nonce` and an `upload`,
 * `delete` or `status`. Because it is a single function over a single value, the rules that must hold
 * under a race hold by construction: two fetches of a one-time link are two events in some order, and
 * exactly one of them finds the link live.
 *
 * ## What a failed peek or fetch says
 *
 * One thing: {@link LINK_GONE}, the same status, code and sentence whether the id is unknown, the token
 * is wrong, or the link was used, ended, lapsed, expired or capped. A stranger who guesses ids learns
 * nothing from the answer. The only other answers on those routes are not about any one link: 429 (a
 * window, keyed by the id whether or not it exists), and 503 (an operator switch).
 *
 * ## Leases
 *
 * A quota slot is a lease that ends at the link's `notAfter`, so a slot lost to a crash costs quota only
 * until then. Every event first runs {@link sweepLinkStore}: due alarms fire, tombstones are purged, old
 * windows and nonces are forgotten.
 *
 * Nothing here logs, and nothing here holds a key: the store sees `SHA-256(token)`, never the token.
 */
import { bytesEqual, fromBase64UrlFixed } from './binary.ts';
import {
  LINK_GONE_SENTENCE,
  LINK_STORE_CHALLENGE_SECONDS,
  LINK_STORE_REFUSAL_DETAIL,
  LINK_STORE_VERSION,
  type LinkPeek,
  type LinkStatus,
  type LinkStoreLinkState,
  type LinkStoreRefusalCode,
  type LinkUploadMetadata,
} from './link-store.ts';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A tombstone outlives the link by this long, so a replayed URL keeps answering 410 rather than 404. */
export const LINK_TOMBSTONE_MS = 30 * DAY_MS;
/** How far past a lease's end an uploader's clock may put `notAfter`. */
export const LINK_UPLOAD_SKEW_MS = 5 * MINUTE_MS;
const MAX_LEASE_MS = 30 * DAY_MS;
const MAX_ONE_TIME_MS = DAY_MS;

/** Operator configuration, not protocol constants (relay-protocol § link store limits). */
export interface LinkStoreLimits {
  readonly perDaemon: { readonly liveLinks: number; readonly bytes: number; readonly uploadsPerDay: number };
  readonly perLink: {
    readonly fetchesPerMinute: number;
    readonly fetchesPerDay: number;
    readonly wrongTokensPerMinute: number;
  };
  readonly perIp: { readonly fetchesPerMinute: number; readonly challengesPerMinute: number };
  readonly challenge: {
    readonly unspentPerDaemon: number;
    readonly perDaemonPerMinute: number;
    readonly globalPerMinute: number;
  };
  readonly global: {
    readonly liveLinks: number;
    readonly bytes: number;
    readonly uploadsPerDay: number;
    readonly fetchesPerDay: number;
    readonly owners: number;
  };
}

export const DEFAULT_LINK_STORE_LIMITS: LinkStoreLimits = {
  perDaemon: { liveLinks: 50, bytes: 64 * 1024 * 1024, uploadsPerDay: 100 },
  perLink: { fetchesPerMinute: 120, fetchesPerDay: 5000, wrongTokensPerMinute: 20 },
  perIp: { fetchesPerMinute: 60, challengesPerMinute: 20 },
  challenge: { unspentPerDaemon: 3, perDaemonPerMinute: 6, globalPerMinute: 512 },
  global: {
    liveLinks: 20_000,
    bytes: 4 * 1024 * 1024 * 1024,
    uploadsPerDay: 5000,
    fetchesPerDay: 200_000,
    owners: 10_000,
  },
};

interface Lease {
  readonly bytes: number;
  readonly until: number;
}

interface OwnerRow {
  readonly nonces: readonly { readonly nonce: string; readonly issuedAt: number }[];
  readonly challengeTimes: readonly number[];
  readonly leases: ReadonlyMap<string, Lease>;
  readonly uploads: { readonly day: number; readonly count: number };
}

interface BundleRow {
  readonly owner: string;
  readonly kind: 'one-time' | 'public';
  readonly sequence: number;
  readonly notAfter: string;
  readonly expiresAt: string | undefined;
  readonly installCap: number | undefined;
  readonly opens: number;
  readonly fetchVerifier: string;
  readonly state: Exclude<LinkStoreLinkState, 'unknown'>;
  /** The sealed bytes, or `null` once the content is deleted. */
  readonly envelope: Uint8Array | null;
  readonly fetchTimes: readonly number[];
  readonly fetchDay: { readonly day: number; readonly count: number };
  /** When a non-live row is forgotten. `null` while live. */
  readonly purgeAt: number | null;
}

export interface LinkStoreState {
  readonly available: boolean;
  readonly serving: boolean;
  readonly limits: LinkStoreLimits;
  readonly owners: ReadonlyMap<string, OwnerRow>;
  readonly bundles: ReadonlyMap<string, BundleRow>;
  readonly challengeTimesByIp: ReadonlyMap<string, readonly number[]>;
  readonly fetchTimesByIp: ReadonlyMap<string, readonly number[]>;
  readonly wrongTokenTimes: ReadonlyMap<string, readonly number[]>;
  readonly challengeTimes: readonly number[];
  readonly uploadsToday: { readonly day: number; readonly count: number };
  readonly fetchesToday: { readonly day: number; readonly count: number };
}

export function initialLinkStoreState(limits: LinkStoreLimits = DEFAULT_LINK_STORE_LIMITS): LinkStoreState {
  return {
    available: true,
    serving: true,
    limits,
    owners: new Map(),
    bundles: new Map(),
    challengeTimesByIp: new Map(),
    fetchTimesByIp: new Map(),
    wrongTokenTimes: new Map(),
    challengeTimes: [],
    uploadsToday: { day: 0, count: 0 },
    fetchesToday: { day: 0, count: 0 },
  };
}

export type LinkStoreEvent =
  | {
      readonly type: 'challenge';
      readonly daemonId: string;
      readonly ip: string;
      readonly nonce: string;
      readonly now: number;
    }
  | { readonly type: 'spend-nonce'; readonly daemonId: string; readonly nonce: string; readonly now: number }
  | {
      readonly type: 'upload';
      readonly daemonId: string;
      readonly bundleId: string;
      readonly metadata: LinkUploadMetadata;
      readonly envelope: Uint8Array;
      readonly now: number;
    }
  | { readonly type: 'delete'; readonly daemonId: string; readonly bundleId: string; readonly now: number }
  | { readonly type: 'status'; readonly daemonId: string; readonly bundleIds: readonly string[]; readonly now: number }
  | {
      readonly type: 'peek' | 'fetch';
      readonly bundleId: string;
      /** `SHA-256(token)` as base64url: the store never sees the token. */
      readonly tokenVerifier: string;
      readonly ip: string;
      readonly now: number;
    }
  | { readonly type: 'alarm'; readonly now: number }
  | {
      readonly type: 'operator';
      readonly available?: boolean;
      readonly serving?: boolean;
      readonly limits?: LinkStoreLimits;
      readonly now: number;
    };

export interface LinkStoreFailure {
  readonly ok: false;
  readonly status: number;
  readonly code: LinkStoreRefusalCode;
  readonly message: string;
}

export type LinkStoreSuccess =
  | { readonly ok: true; readonly kind: 'challenge'; readonly nonce: string; readonly deadlineSeconds: number }
  | { readonly ok: true; readonly kind: 'nonce-spent' }
  | { readonly ok: true; readonly kind: 'stored'; readonly sequence: number }
  | { readonly ok: true; readonly kind: 'deleted' }
  | { readonly ok: true; readonly kind: 'status'; readonly status: LinkStatus }
  | { readonly ok: true; readonly kind: 'peek'; readonly peek: LinkPeek }
  | {
      readonly ok: true;
      readonly kind: 'fetch';
      readonly envelope: Uint8Array;
      readonly linkKind: 'one-time' | 'public';
      readonly sequence: number;
    }
  | { readonly ok: true; readonly kind: 'alarm' }
  | { readonly ok: true; readonly kind: 'operator'; readonly available: boolean; readonly serving: boolean };

export type LinkStoreResponse = LinkStoreSuccess | LinkStoreFailure;

const fail = (code: LinkStoreRefusalCode): LinkStoreFailure => ({
  ok: false,
  status: LINK_STORE_REFUSAL_DETAIL[code].status,
  code,
  message: LINK_STORE_REFUSAL_DETAIL[code].message,
});

/** The one answer to every failed peek or fetch. A constant, so no cause can leak into its bytes. */
export const LINK_GONE: LinkStoreFailure = Object.freeze({
  ok: false,
  status: 410,
  code: 'link_gone',
  message: LINK_GONE_SENTENCE,
});

type Step = readonly [LinkStoreState, LinkStoreResponse];

const put = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> => new Map(map).set(key, value);
const drop = <K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> => {
  const copy = new Map(map);
  copy.delete(key);
  return copy;
};

const dayOf = (now: number): number => Math.floor(now / DAY_MS);
const recent = (times: readonly number[], now: number): readonly number[] =>
  times.filter(time => now - time < MINUTE_MS);

const EMPTY_OWNER: OwnerRow = { nonces: [], challengeTimes: [], leases: new Map(), uploads: { day: 0, count: 0 } };
const ownerOf = (state: LinkStoreState, daemonId: string): OwnerRow => state.owners.get(daemonId) ?? EMPTY_OWNER;
const withOwner = (state: LinkStoreState, daemonId: string, row: OwnerRow): LinkStoreState => ({
  ...state,
  owners: put(state.owners, daemonId, row),
});

const ownerBytes = (owner: OwnerRow): number => [...owner.leases.values()].reduce((sum, lease) => sum + lease.bytes, 0);
const totals = (state: LinkStoreState): { live: number; bytes: number } => {
  let live = 0;
  let bytes = 0;
  for (const owner of state.owners.values()) {
    live += owner.leases.size;
    bytes += ownerBytes(owner);
  }
  return { live, bytes };
};

const releaseLease = (state: LinkStoreState, daemonId: string, bundleId: string): LinkStoreState => {
  const owner = state.owners.get(daemonId);
  return owner === undefined ? state : withOwner(state, daemonId, { ...owner, leases: drop(owner.leases, bundleId) });
};

/** The row a link becomes when its content is deleted: kept as a tombstone, never live again. */
const tombstoned = (row: BundleRow, state: 'used' | 'ended' | 'lapsed', now: number): BundleRow => ({
  ...row,
  state,
  envelope: null,
  purgeAt: Math.max(row.purgeAt ?? 0, Math.max(Date.parse(row.notAfter), now) + LINK_TOMBSTONE_MS),
});

/** When the alarm for this bundle next fires: its end while live, its purge afterwards. */
export function linkBundleAlarmAt(state: LinkStoreState, bundleId: string): number | null {
  const row = state.bundles.get(bundleId);
  if (row === undefined) return null;
  return row.state === 'live' ? Date.parse(row.notAfter) : row.purgeAt;
}

/**
 * Fire everything due at `now`: a live link past its end loses its content (`ended` when the owner's
 * chosen end has passed, otherwise `lapsed`), tombstones past their date are forgotten, and windows,
 * nonces and expired leases are pruned.
 */
export function sweepLinkStore(input: LinkStoreState, now: number): LinkStoreState {
  let state = input;
  for (const [bundleId, row] of input.bundles) {
    if (row.state === 'live' && now >= Date.parse(row.notAfter)) {
      const ended = row.expiresAt !== undefined && now >= Date.parse(row.expiresAt);
      state = releaseLease(
        { ...state, bundles: put(state.bundles, bundleId, tombstoned(row, ended ? 'ended' : 'lapsed', now)) },
        row.owner,
        bundleId,
      );
    } else if (row.purgeAt !== null && row.state !== 'live' && now >= row.purgeAt) {
      state = { ...state, bundles: drop(state.bundles, bundleId) };
    }
  }
  const owners = new Map<string, OwnerRow>();
  for (const [daemonId, owner] of state.owners) {
    const leases = new Map([...owner.leases].filter(([, lease]) => lease.until > now));
    const nonces = owner.nonces.filter(entry => now - entry.issuedAt < LINK_STORE_CHALLENGE_SECONDS * 1000);
    const challengeTimes = recent(owner.challengeTimes, now);
    const idle = leases.size === 0 && nonces.length === 0 && challengeTimes.length === 0;
    if (!idle || owner.uploads.day === dayOf(now)) owners.set(daemonId, { ...owner, leases, nonces, challengeTimes });
  }
  const windows = (map: ReadonlyMap<string, readonly number[]>) =>
    new Map([...map].map(([key, times]) => [key, recent(times, now)] as const).filter(([, times]) => times.length > 0));
  return {
    ...state,
    owners,
    challengeTimesByIp: windows(state.challengeTimesByIp),
    fetchTimesByIp: windows(state.fetchTimesByIp),
    wrongTokenTimes: windows(state.wrongTokenTimes),
    challengeTimes: recent(state.challengeTimes, now),
  };
}

// ── Challenges and nonces ────────────────────────────────────────────────────────────────────────

function challenge(state: LinkStoreState, event: Extract<LinkStoreEvent, { type: 'challenge' }>): Step {
  const { limits } = state;
  if (!state.available) return [state, fail('link_store_unavailable')];
  const owner = state.owners.get(event.daemonId);
  if (owner === undefined && state.owners.size >= limits.global.owners) return [state, fail('link_store_capacity')];
  if (state.challengeTimes.length >= limits.challenge.globalPerMinute) return [state, fail('link_store_capacity')];
  const byIp = state.challengeTimesByIp.get(event.ip) ?? [];
  if (byIp.length >= limits.perIp.challengesPerMinute) return [state, fail('link_rate_limited')];
  const row = owner ?? EMPTY_OWNER;
  if (row.challengeTimes.length >= limits.challenge.perDaemonPerMinute) return [state, fail('link_rate_limited')];
  if (row.nonces.length >= limits.challenge.unspentPerDaemon) return [state, fail('link_rate_limited')];
  const next = withOwner(
    {
      ...state,
      challengeTimes: [...state.challengeTimes, event.now],
      challengeTimesByIp: put(state.challengeTimesByIp, event.ip, [...byIp, event.now]),
    },
    event.daemonId,
    {
      ...row,
      nonces: [...row.nonces, { nonce: event.nonce, issuedAt: event.now }],
      challengeTimes: [...row.challengeTimes, event.now],
    },
  );
  return [next, { ok: true, kind: 'challenge', nonce: event.nonce, deadlineSeconds: LINK_STORE_CHALLENGE_SECONDS }];
}

/** A nonce is spent by its first use, accepted or not: the signature check that follows can fail and the nonce is still gone. */
function spendNonce(state: LinkStoreState, event: Extract<LinkStoreEvent, { type: 'spend-nonce' }>): Step {
  const owner = state.owners.get(event.daemonId);
  if (owner === undefined || !owner.nonces.some(entry => entry.nonce === event.nonce))
    return [state, fail('link_challenge_expired')];
  return [
    withOwner(state, event.daemonId, { ...owner, nonces: owner.nonces.filter(entry => entry.nonce !== event.nonce) }),
    { ok: true, kind: 'nonce-spent' },
  ];
}

// ── Upload, delete, status ───────────────────────────────────────────────────────────────────────

function upload(state: LinkStoreState, event: Extract<LinkStoreEvent, { type: 'upload' }>): Step {
  const { metadata, envelope, now, bundleId, daemonId } = event;
  const { limits } = state;
  if (!state.available) return [state, fail('link_store_unavailable')];
  const notAfter = Date.parse(metadata.notAfter);
  const reach = metadata.kind === 'one-time' ? MAX_ONE_TIME_MS : MAX_LEASE_MS;
  if (envelope.length !== metadata.envelopeBytes || notAfter <= now || notAfter - now > reach + LINK_UPLOAD_SKEW_MS)
    return [state, fail('link_bad_request')];

  const existing = state.bundles.get(bundleId);
  const owner = ownerOf(state, daemonId);
  let replacedBytes = 0;
  let opens = 0;
  if (metadata.action === 'replace') {
    if (existing === undefined || existing.owner !== daemonId || existing.state !== 'live')
      return [state, fail('link_unknown')];
    if (existing.kind !== metadata.kind) return [state, fail('link_bad_request')];
    if (metadata.expectSequence !== existing.sequence) return [state, fail('link_sequence_conflict')];
    replacedBytes = owner.leases.get(bundleId)?.bytes ?? 0;
    opens = existing.opens;
  } else if (existing !== undefined) {
    // Only a lapsed public link, by its own owner, is revived; anything else keeps its id for good.
    const revives =
      existing.state === 'lapsed' &&
      existing.owner === daemonId &&
      existing.kind === 'public' &&
      metadata.kind === 'public';
    if (!revives) return [state, fail('link_exists')];
    if (metadata.sequence <= existing.sequence) return [state, fail('link_sequence_conflict')];
    opens = existing.opens;
  }

  const day = dayOf(now);
  const uploadsByOwner = owner.uploads.day === day ? owner.uploads.count : 0;
  const uploadsGlobal = state.uploadsToday.day === day ? state.uploadsToday.count : 0;
  if (uploadsByOwner >= limits.perDaemon.uploadsPerDay) return [state, fail('link_rate_limited')];
  if (uploadsGlobal >= limits.global.uploadsPerDay) return [state, fail('link_store_capacity')];
  const isNewSlot = metadata.action === 'create';
  if (isNewSlot && owner.leases.size >= limits.perDaemon.liveLinks) return [state, fail('link_store_full')];
  if (ownerBytes(owner) - replacedBytes + envelope.length > limits.perDaemon.bytes)
    return [state, fail('link_store_full')];
  const all = totals(state);
  if (isNewSlot && all.live >= limits.global.liveLinks) return [state, fail('link_store_capacity')];
  if (all.bytes - replacedBytes + envelope.length > limits.global.bytes) return [state, fail('link_store_capacity')];
  if (owner === EMPTY_OWNER && state.owners.size >= limits.global.owners) return [state, fail('link_store_capacity')];

  const row: BundleRow = {
    owner: daemonId,
    kind: metadata.kind,
    sequence: metadata.sequence,
    notAfter: metadata.notAfter,
    expiresAt: metadata.expiresAt,
    installCap: metadata.installCap,
    opens,
    fetchVerifier: metadata.fetchVerifier,
    state: 'live',
    envelope,
    fetchTimes: existing?.fetchTimes ?? [],
    fetchDay: existing?.fetchDay ?? { day: 0, count: 0 },
    purgeAt: null,
  };
  const next = withOwner(
    { ...state, bundles: put(state.bundles, bundleId, row), uploadsToday: { day, count: uploadsGlobal + 1 } },
    daemonId,
    {
      ...owner,
      leases: put(owner.leases, bundleId, { bytes: envelope.length, until: notAfter }),
      uploads: { day, count: uploadsByOwner + 1 },
    },
  );
  return [next, { ok: true, kind: 'stored', sequence: metadata.sequence }];
}

function deleteLink(state: LinkStoreState, event: Extract<LinkStoreEvent, { type: 'delete' }>): Step {
  const row = state.bundles.get(event.bundleId);
  if (row === undefined || row.owner !== event.daemonId) return [state, fail('link_unknown')];
  if (row.state === 'ended') return [state, { ok: true, kind: 'deleted' }];
  const next = releaseLease(
    { ...state, bundles: put(state.bundles, event.bundleId, tombstoned(row, 'ended', event.now)) },
    row.owner,
    event.bundleId,
  );
  return [next, { ok: true, kind: 'deleted' }];
}

function status(state: LinkStoreState, event: Extract<LinkStoreEvent, { type: 'status' }>): Step {
  const links = event.bundleIds.map(bundleId => {
    const row = state.bundles.get(bundleId);
    if (row === undefined || row.owner !== event.daemonId) return { bundleId, state: 'unknown' as const };
    return {
      bundleId,
      state: row.state,
      kind: row.kind,
      sequence: row.sequence,
      opens: row.opens,
      notAfter: row.notAfter,
      ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }),
      ...(row.installCap === undefined ? {} : { installCap: row.installCap }),
      storedBytes: row.envelope?.length ?? 0,
    };
  });
  return [state, { ok: true, kind: 'status', status: { version: LINK_STORE_VERSION, links } }];
}

// ── Peek and fetch ───────────────────────────────────────────────────────────────────────────────

const ZERO_VERIFIER = new Uint8Array(32);

function open(state: LinkStoreState, event: Extract<LinkStoreEvent, { type: 'peek' | 'fetch' }>): Step {
  const { limits } = state;
  const { bundleId, now } = event;
  if (!state.serving) return [state, fail('link_store_unavailable')];
  const byIp = state.fetchTimesByIp.get(event.ip) ?? [];
  if (byIp.length >= limits.perIp.fetchesPerMinute) return [state, fail('link_rate_limited')];
  const counted: LinkStoreState = { ...state, fetchTimesByIp: put(state.fetchTimesByIp, event.ip, [...byIp, now]) };
  // Keyed by the id whether or not it exists, so a 429 says nothing about whether the id is real.
  const wrong = counted.wrongTokenTimes.get(bundleId) ?? [];
  if (wrong.length >= limits.perLink.wrongTokensPerMinute) return [counted, fail('link_rate_limited')];

  const row = counted.bundles.get(bundleId);
  const presented = fromBase64UrlFixed(event.tokenVerifier, 32);
  const stored = row === undefined ? null : fromBase64UrlFixed(row.fetchVerifier, 32);
  const matches =
    bytesEqual(presented ?? ZERO_VERIFIER, stored ?? ZERO_VERIFIER) && presented !== null && stored !== null;
  if (row === undefined || !matches)
    return [{ ...counted, wrongTokenTimes: put(counted.wrongTokenTimes, bundleId, [...wrong, now]) }, LINK_GONE];
  const end = Math.min(Date.parse(row.notAfter), row.expiresAt === undefined ? Infinity : Date.parse(row.expiresAt));
  if (row.state !== 'live' || row.envelope === null || now >= end) return [counted, LINK_GONE];

  // A public link at its cap stays live for its owner's status, but answers like any ended link.
  if (row.kind === 'public' && row.installCap !== undefined && row.opens >= row.installCap) return [counted, LINK_GONE];

  if (event.type === 'peek') {
    const peek: LinkPeek = {
      version: LINK_STORE_VERSION,
      kind: row.kind,
      ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }),
    };
    return [counted, { ok: true, kind: 'peek', peek }];
  }

  if (row.kind === 'one-time') {
    const used = releaseLease(
      { ...counted, bundles: put(counted.bundles, bundleId, { ...tombstoned(row, 'used', now), opens: 1 }) },
      row.owner,
      bundleId,
    );
    return [used, { ok: true, kind: 'fetch', envelope: row.envelope, linkKind: 'one-time', sequence: row.sequence }];
  }

  const day = dayOf(now);
  const minute = recent(row.fetchTimes, now);
  const dayCount = row.fetchDay.day === day ? row.fetchDay.count : 0;
  if (minute.length >= limits.perLink.fetchesPerMinute || dayCount >= limits.perLink.fetchesPerDay)
    return [counted, fail('link_rate_limited')];
  const globalCount = counted.fetchesToday.day === day ? counted.fetchesToday.count : 0;
  if (globalCount >= limits.global.fetchesPerDay) return [counted, fail('link_store_capacity')];
  const served: BundleRow = {
    ...row,
    opens: row.opens + 1,
    fetchTimes: [...minute, now],
    fetchDay: { day, count: dayCount + 1 },
  };
  return [
    { ...counted, bundles: put(counted.bundles, bundleId, served), fetchesToday: { day, count: globalCount + 1 } },
    { ok: true, kind: 'fetch', envelope: row.envelope, linkKind: 'public', sequence: row.sequence },
  ];
}

// ── The reducer ──────────────────────────────────────────────────────────────────────────────────

export function reduceLinkStore(input: LinkStoreState, event: LinkStoreEvent): Step {
  const state = sweepLinkStore(input, event.now);
  switch (event.type) {
    case 'challenge':
      return challenge(state, event);
    case 'spend-nonce':
      return spendNonce(state, event);
    case 'upload':
      return upload(state, event);
    case 'delete':
      return deleteLink(state, event);
    case 'status':
      return status(state, event);
    case 'peek':
    case 'fetch':
      return open(state, event);
    case 'alarm':
      return [state, { ok: true, kind: 'alarm' }];
    case 'operator': {
      const next: LinkStoreState = {
        ...state,
        available: event.available ?? state.available,
        serving: event.serving ?? state.serving,
        limits: event.limits ?? state.limits,
      };
      return [next, { ok: true, kind: 'operator', available: next.available, serving: next.serving }];
    }
  }
}

/** What the operator's GET shows: counts only, never an id, a daemon, a token or an IP. */
export function linkStoreMetrics(state: LinkStoreState): {
  readonly available: boolean;
  readonly serving: boolean;
  readonly owners: number;
  readonly liveLinks: number;
  readonly storedBytes: number;
  readonly tombstones: number;
} {
  const all = totals(state);
  const tombstones = [...state.bundles.values()].filter(row => row.state !== 'live').length;
  return {
    available: state.available,
    serving: state.serving,
    owners: state.owners.size,
    liveLinks: all.live,
    storedBytes: all.bytes,
    tombstones,
  };
}
