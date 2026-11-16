/**
 * THE LINK STORE'S RULES, CUT TO FIT THREE KINDS OF DURABLE OBJECT.
 *
 * `link-store-reducer.ts` states every rule over ONE value. A deployment cannot keep one value: a hot
 * singleton would hold every link's bytes, so the store is a bundle object per link, an owner object per
 * daemon and one control object. This file is what the owner and control objects decide; the bundle
 * object runs the reducer itself (`link-store-bundle.ts`), with the limits it does not own relaxed.
 *
 * Every function is pure over a value the object persists, except {@link SlidingWindows}, whose whole
 * job is to remember the last minute in memory. Nothing here reads a clock or logs.
 *
 * ## Why a refusal can differ from the reducer's
 *
 * The reducer checks one request against everything at once. Here the Worker asks the control object,
 * then the owner object, then the bundle object, so when SEVERAL limits are exceeded the code that
 * comes back is the first object's, not the reducer's. The limits themselves, and the lease that
 * releases a quota slot at `notAfter`, are the same.
 */
import { z } from 'zod';
import { LINK_STORE_CHALLENGE_SECONDS, type LinkStoreRefusalCode } from './link-store.ts';
import { LINK_TOMBSTONE_MS, type LinkStoreLimits } from './link-store-reducer.ts';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The most one storage row of an envelope holds. A sealed envelope is at most 3 MiB, so six rows. */
export const LINK_CHUNK_BYTES = 512 * 1024;

export type Gate = { readonly ok: true } | { readonly ok: false; readonly code: LinkStoreRefusalCode };
const PASS: Gate = { ok: true };
const refuse = (code: LinkStoreRefusalCode): Gate => ({ ok: false, code });

export const dayOf = (now: number): number => Math.floor(now / DAY_MS);
const recent = (times: readonly number[], now: number): readonly number[] =>
  times.filter(time => now - time < MINUTE_MS);

// ── Chunks ───────────────────────────────────────────────────────────────────────────────────────

export function chunkEnvelope(envelope: Uint8Array): readonly Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < envelope.length; at += LINK_CHUNK_BYTES) chunks.push(envelope.slice(at, at + LINK_CHUNK_BYTES));
  return chunks;
}

export function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return joined;
}

// ── Windows in memory ────────────────────────────────────────────────────────────────────────────

/**
 * Per-key counts over the last minute, held in memory and bounded.
 *
 * It is a rate limiter, not a record: nothing here is persisted, so a restart forgets it, and it never
 * holds more than `maxKeys` keys — the oldest key goes first, which a flood can use to forget its own
 * earlier hits. That is the declared cost of keeping an address out of storage.
 */
export class SlidingWindows {
  private readonly windows = new Map<string, readonly number[]>();

  private readonly maxKeys: number;

  constructor(maxKeys: number) {
    this.maxKeys = maxKeys;
  }

  size(): number {
    return this.windows.size;
  }

  /** How many hits `key` has in the last minute. */
  count(key: string, now: number): number {
    const times = this.windows.get(key);
    if (times === undefined) return 0;
    const live = recent(times, now);
    if (live.length === 0) this.windows.delete(key);
    else if (live.length !== times.length) this.windows.set(key, live);
    return live.length;
  }

  hit(key: string, now: number): void {
    const times = [...recent(this.windows.get(key) ?? [], now), now];
    this.windows.delete(key);
    this.windows.set(key, times);
    while (this.windows.size > this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done === true) break;
      this.windows.delete(oldest.value);
    }
  }
}

// ── Owner shard ──────────────────────────────────────────────────────────────────────────────────

interface Lease {
  readonly bytes: number;
  readonly until: number;
}

/** Everything one daemon's owner object persists. Small by construction: 3 nonces, 50 leases. */
export interface OwnerShard {
  readonly nonces: readonly { readonly nonce: string; readonly issuedAt: number }[];
  readonly challengeTimes: readonly number[];
  readonly leases: Readonly<Record<string, Lease>>;
  readonly uploads: { readonly day: number; readonly count: number };
}

export const EMPTY_OWNER_SHARD: OwnerShard = {
  nonces: [],
  challengeTimes: [],
  leases: {},
  uploads: { day: 0, count: 0 },
};

const NONCE_MS = LINK_STORE_CHALLENGE_SECONDS * 1000;

/** Forget what has run out: expired leases, nonces past their minute, challenge times past theirs. */
export function sweepOwner(shard: OwnerShard, now: number): OwnerShard {
  return {
    ...shard,
    nonces: shard.nonces.filter(entry => now - entry.issuedAt < NONCE_MS),
    challengeTimes: recent(shard.challengeTimes, now),
    leases: Object.fromEntries(Object.entries(shard.leases).filter(([, lease]) => lease.until > now)),
  };
}

/** Nothing left that matters: the object may delete its storage and let the runtime forget it. */
export function ownerIdle(shard: OwnerShard, now: number): boolean {
  return (
    shard.nonces.length === 0 &&
    shard.challengeTimes.length === 0 &&
    Object.keys(shard.leases).length === 0 &&
    shard.uploads.day !== dayOf(now)
  );
}

/** When the owner object next has something to forget, or null when it never will. */
export function ownerAlarmAt(shard: OwnerShard, now: number): number | null {
  const times = [
    ...shard.nonces.map(entry => entry.issuedAt + NONCE_MS),
    ...shard.challengeTimes.map(time => time + MINUTE_MS),
    ...Object.values(shard.leases).map(lease => lease.until),
    ...(shard.uploads.day === 0 ? [] : [(shard.uploads.day + 1) * DAY_MS]),
  ].filter(time => time > now);
  return times.length === 0 ? null : Math.min(...times);
}

/** The per-daemon half of a challenge: the windows this daemon alone is held to. */
export function ownerChallenge(
  input: OwnerShard,
  event: { readonly nonce: string; readonly now: number },
  limits: LinkStoreLimits,
): readonly [OwnerShard, Gate] {
  const shard = sweepOwner(input, event.now);
  if (shard.challengeTimes.length >= limits.challenge.perDaemonPerMinute) return [shard, refuse('link_rate_limited')];
  if (shard.nonces.length >= limits.challenge.unspentPerDaemon) return [shard, refuse('link_rate_limited')];
  return [
    {
      ...shard,
      nonces: [...shard.nonces, { nonce: event.nonce, issuedAt: event.now }],
      challengeTimes: [...shard.challengeTimes, event.now],
    },
    PASS,
  ];
}

/** A nonce is spent by its first use, accepted or not; the signature check that follows can fail. */
export function ownerSpendNonce(input: OwnerShard, nonce: string, now: number): readonly [OwnerShard, boolean] {
  const shard = sweepOwner(input, now);
  if (!shard.nonces.some(entry => entry.nonce === nonce)) return [shard, false];
  return [{ ...shard, nonces: shard.nonces.filter(entry => entry.nonce !== nonce) }, true];
}

export interface OwnerReservation {
  readonly bundleId: string;
  readonly bytes: number;
  readonly until: number;
  readonly create: boolean;
  readonly now: number;
}

/** What puts a reservation back: the lease it displaced, and the day its upload was counted on. */
export interface OwnerUndo {
  readonly bundleId: string;
  readonly previous: Lease | null;
  readonly day: number;
}

export function ownerReserve(
  input: OwnerShard,
  reservation: OwnerReservation,
  limits: LinkStoreLimits,
): readonly [OwnerShard, Gate, OwnerUndo] {
  const shard = sweepOwner(input, reservation.now);
  const day = dayOf(reservation.now);
  const previous = shard.leases[reservation.bundleId] ?? null;
  const undo: OwnerUndo = { bundleId: reservation.bundleId, previous, day };
  const uploadsToday = shard.uploads.day === day ? shard.uploads.count : 0;
  if (uploadsToday >= limits.perDaemon.uploadsPerDay) return [shard, refuse('link_rate_limited'), undo];
  if (reservation.create && Object.keys(shard.leases).length >= limits.perDaemon.liveLinks)
    return [shard, refuse('link_store_full'), undo];
  const held = Object.values(shard.leases).reduce((sum, lease) => sum + lease.bytes, 0);
  if (held - (previous?.bytes ?? 0) + reservation.bytes > limits.perDaemon.bytes)
    return [shard, refuse('link_store_full'), undo];
  return [
    {
      ...shard,
      leases: { ...shard.leases, [reservation.bundleId]: { bytes: reservation.bytes, until: reservation.until } },
      uploads: { day, count: uploadsToday + 1 },
    },
    PASS,
    undo,
  ];
}

/** Put a refused or failed reservation back as it was. The upload stops counting; the lease returns. */
export function ownerUndo(shard: OwnerShard, undo: OwnerUndo): OwnerShard {
  const { [undo.bundleId]: _dropped, ...rest } = shard.leases;
  return {
    ...shard,
    leases: undo.previous === null ? rest : { ...rest, [undo.bundleId]: undo.previous },
    uploads:
      shard.uploads.day === undo.day ? { day: undo.day, count: Math.max(0, shard.uploads.count - 1) } : shard.uploads,
  };
}

export function ownerRelease(shard: OwnerShard, bundleId: string): OwnerShard {
  const { [bundleId]: _dropped, ...rest } = shard.leases;
  return { ...shard, leases: rest };
}

// ── Control shard ────────────────────────────────────────────────────────────────────────────────

/**
 * The control object's entry for one bundle id: who owns it, what it holds against the global caps and
 * how long the id is remembered. `leased` holds quota until `until`; `tomb` holds none and is forgotten
 * a tombstone's life after `until` — which is also the bundle object's, so an id the control object has
 * forgotten is one the bundle object has too.
 */
export interface LinkRecord {
  readonly owner: string;
  readonly bytes: number;
  readonly until: number;
  readonly phase: 'leased' | 'tomb';
}

export interface ControlTotals {
  readonly live: number;
  readonly bytes: number;
  readonly tombs: number;
}

export const EMPTY_TOTALS: ControlTotals = { live: 0, bytes: 0, tombs: 0 };

/** When this record next changes by itself: its lease ends, then it is forgotten. */
export const linkRecordDueAt = (record: LinkRecord): number =>
  record.phase === 'leased' ? record.until : record.until + LINK_TOMBSTONE_MS;

/** The totals once a record becomes another: a leased record holds quota, a tomb is only counted. */
export function replaceRecordTotals(
  totals: ControlTotals,
  before: LinkRecord | null,
  after: LinkRecord | null,
): ControlTotals {
  const held = (record: LinkRecord | null) => (record?.phase === 'leased' ? record : null);
  const tomb = (record: LinkRecord | null) => (record?.phase === 'tomb' ? 1 : 0);
  return {
    live: totals.live + (held(after) === null ? 0 : 1) - (held(before) === null ? 0 : 1),
    bytes: totals.bytes + (held(after)?.bytes ?? 0) - (held(before)?.bytes ?? 0),
    tombs: totals.tombs + tomb(after) - tomb(before),
  };
}

export interface ControlReservation {
  readonly available: boolean;
  readonly owner: string;
  readonly create: boolean;
  readonly bytes: number;
  readonly record: LinkRecord | null;
  readonly ownerKnown: boolean;
  readonly ownersCount: number;
  readonly totals: ControlTotals;
  readonly uploadsToday: number;
}

/** The global half of an upload: the kill switch, what an id can be, and the caps that are the whole store's. */
export function controlReserveGate(input: ControlReservation, limits: LinkStoreLimits): Gate {
  if (!input.available) return refuse('link_store_unavailable');
  const { record } = input;
  if (input.create) {
    // A live id is taken; a tombstone is the bundle object's to judge (only a lapsed public link revives).
    if (record !== null && (record.phase === 'leased' || record.owner !== input.owner)) return refuse('link_exists');
  } else if (record === null || record.phase !== 'leased' || record.owner !== input.owner) {
    return refuse('link_unknown');
  }
  if (input.uploadsToday >= limits.global.uploadsPerDay) return refuse('link_store_capacity');
  const held = record?.phase === 'leased' ? record : null;
  if (held === null && input.totals.live >= limits.global.liveLinks) return refuse('link_store_capacity');
  if (input.totals.bytes - (held?.bytes ?? 0) + input.bytes > limits.global.bytes) return refuse('link_store_capacity');
  if (!input.ownerKnown && input.ownersCount >= limits.global.owners) return refuse('link_store_capacity');
  return PASS;
}

/** The global half of a challenge. `ip` is the caller's address, held only in the windows. */
export function controlChallengeGate(
  input: {
    readonly available: boolean;
    readonly ownerKnown: boolean;
    readonly ownersCount: number;
    readonly ip: string;
    readonly now: number;
  },
  windows: { readonly global: SlidingWindows; readonly byIp: SlidingWindows },
  limits: LinkStoreLimits,
): Gate {
  if (!input.available) return refuse('link_store_unavailable');
  if (!input.ownerKnown && input.ownersCount >= limits.global.owners) return refuse('link_store_capacity');
  if (windows.global.count('all', input.now) >= limits.challenge.globalPerMinute) return refuse('link_store_capacity');
  if (windows.byIp.count(input.ip, input.now) >= limits.perIp.challengesPerMinute) return refuse('link_rate_limited');
  windows.global.hit('all', input.now);
  windows.byIp.hit(input.ip, input.now);
  return PASS;
}

export type OpenVerdict =
  | { readonly kind: 'proceed' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'refuse'; readonly code: LinkStoreRefusalCode };

/**
 * The global half of a peek or fetch, decided BEFORE any bundle object is touched.
 *
 * An id the control object has never recorded is answered here: the uniform 410, or the 429 its
 * wrong-token window earns, which is keyed by the id whether or not it exists so that a 429 says nothing
 * about the id. No storage is created for it. The global fetch budget is a brake, not a ledger — it is
 * read here and counted after a fetch succeeds, so a few requests in flight may carry it past its cap.
 */
export function controlOpenVerdict(
  input: {
    readonly serving: boolean;
    readonly known: boolean;
    readonly type: 'peek' | 'fetch';
    readonly bundleId: string;
    readonly ip: string;
    readonly fetchesToday: number;
    readonly now: number;
  },
  windows: { readonly byIp: SlidingWindows; readonly wrongUnknown: SlidingWindows },
  limits: LinkStoreLimits,
): OpenVerdict {
  if (!input.serving) return { kind: 'refuse', code: 'link_store_unavailable' };
  if (windows.byIp.count(input.ip, input.now) >= limits.perIp.fetchesPerMinute)
    return { kind: 'refuse', code: 'link_rate_limited' };
  windows.byIp.hit(input.ip, input.now);
  if (!input.known) {
    if (windows.wrongUnknown.count(input.bundleId, input.now) >= limits.perLink.wrongTokensPerMinute)
      return { kind: 'refuse', code: 'link_rate_limited' };
    windows.wrongUnknown.hit(input.bundleId, input.now);
    return { kind: 'gone' };
  }
  if (input.type === 'fetch' && input.fetchesToday >= limits.global.fetchesPerDay)
    return { kind: 'refuse', code: 'link_store_capacity' };
  return { kind: 'proceed' };
}

/** The limits a bundle object enforces for itself: the per-link ones. The rest are not its to judge. */
export function bundleLimits(limits: LinkStoreLimits): LinkStoreLimits {
  const open = Number.POSITIVE_INFINITY;
  return {
    perDaemon: { liveLinks: open, bytes: open, uploadsPerDay: open },
    perLink: limits.perLink,
    perIp: { fetchesPerMinute: open, challengesPerMinute: open },
    challenge: { unspentPerDaemon: open, perDaemonPerMinute: open, globalPerMinute: open },
    global: { liveLinks: open, bytes: open, uploadsPerDay: open, fetchesPerDay: open, owners: open },
  };
}

/** A day's counter, rolled over when the day changes. */
export function countedToday(counter: { readonly day: number; readonly count: number }, now: number): number {
  return counter.day === dayOf(now) ? counter.count : 0;
}

// ── What is persisted, and what the operator may set ─────────────────────────────────────────────

const count = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const instant = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Every limit, whole: a replacement of the operator's limits is never a patch, so no key is silently kept. */
export const LinkStoreLimitsSchema = z.strictObject({
  perDaemon: z.strictObject({ liveLinks: count, bytes: count, uploadsPerDay: count }),
  perLink: z.strictObject({ fetchesPerMinute: count, fetchesPerDay: count, wrongTokensPerMinute: count }),
  perIp: z.strictObject({ fetchesPerMinute: count, challengesPerMinute: count }),
  challenge: z.strictObject({ unspentPerDaemon: count, perDaemonPerMinute: count, globalPerMinute: count }),
  global: z.strictObject({
    liveLinks: count,
    bytes: count,
    uploadsPerDay: count,
    fetchesPerDay: count,
    owners: count,
  }),
});

/** The part of the limits a bundle object is told: its own link's. */
export const PerLinkLimitsSchema = LinkStoreLimitsSchema.shape.perLink;

/** `PUT /v1/operator/link-store`: at least one switch or the limits. */
export const LinkStoreOperatorUpdateSchema = z
  .strictObject({
    available: z.boolean().optional(),
    serving: z.boolean().optional(),
    limits: LinkStoreLimitsSchema.optional(),
  })
  .refine(update => Object.keys(update).length > 0, 'name at least one of available, serving, limits');
export const LinkStoreConfigSchema = z.strictObject({
  available: z.boolean(),
  serving: z.boolean(),
  limits: LinkStoreLimitsSchema,
});
export type LinkStoreConfig = z.infer<typeof LinkStoreConfigSchema>;

const dayCounter = z.strictObject({ day: instant, count: instant });

export const LinkRecordSchema = z.strictObject({
  owner: z.string().min(1),
  bytes: instant,
  until: instant,
  phase: z.enum(['leased', 'tomb']),
});

/** The control object's counters: what the registry's totals cannot say. */
export const ControlStateSchema = z.strictObject({
  totals: z.strictObject({ live: instant, bytes: instant, tombs: instant }),
  owners: instant,
  uploads: dayCounter,
  fetches: dayCounter,
});
export type ControlState = z.infer<typeof ControlStateSchema>;

export const EMPTY_CONTROL_STATE: ControlState = {
  totals: EMPTY_TOTALS,
  owners: 0,
  uploads: { day: 0, count: 0 },
  fetches: { day: 0, count: 0 },
};

export const OwnerShardSchema = z.strictObject({
  nonces: z.array(z.strictObject({ nonce: z.string().min(1), issuedAt: instant })),
  challengeTimes: z.array(instant),
  leases: z.record(z.string(), z.strictObject({ bytes: instant, until: instant })),
  uploads: dayCounter,
});

/** The control object's `due:` index key: sorts by time, so the next thing to forget is the first key. */
export const dueKey = (at: number, kind: 'l' | 'o', id: string): string =>
  `due:${String(Math.trunc(at)).padStart(15, '0')}:${kind}:${id}`;

/** The time and the thing a `due:` key names, or null for a key this module did not write. */
export function parseDueKey(
  key: string,
): { readonly at: number; readonly kind: 'l' | 'o'; readonly id: string } | null {
  const match = /^due:(\d{15}):([lo]):(.+)$/u.exec(key);
  return match === null ? null : { at: Number(match[1]), kind: match[2] === 'o' ? 'o' : 'l', id: match[3] ?? '' };
}
