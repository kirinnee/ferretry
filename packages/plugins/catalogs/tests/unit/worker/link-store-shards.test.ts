import { describe, it } from 'bun:test';
import {
  bundleLimits,
  chunkEnvelope,
  ControlStateSchema,
  controlChallengeGate,
  controlOpenVerdict,
  controlReserveGate,
  countedToday,
  DEFAULT_LINK_STORE_LIMITS,
  dayOf,
  dueKey,
  EMPTY_CONTROL_STATE,
  EMPTY_OWNER_SHARD,
  EMPTY_TOTALS,
  joinChunks,
  LINK_CHUNK_BYTES,
  LINK_TOMBSTONE_MS,
  type LinkRecord,
  LinkRecordSchema,
  LinkStoreConfigSchema,
  type LinkStoreLimits,
  LinkStoreLimitsSchema,
  LinkStoreOperatorUpdateSchema,
  linkRecordDueAt,
  type OwnerShard,
  OwnerShardSchema,
  ownerAlarmAt,
  ownerChallenge,
  ownerIdle,
  ownerRelease,
  ownerReserve,
  ownerSpendNonce,
  ownerUndo,
  parseDueKey,
  PerLinkLimitsSchema,
  replaceRecordTotals,
  SlidingWindows,
  sweepOwner,
} from '../../../worker/src/lib/index.ts';
import should from 'should';

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.parse('2026-10-31T09:00:00.000Z');
const L = DEFAULT_LINK_STORE_LIMITS;
const withLimits = (patch: { [K in keyof LinkStoreLimits]?: Partial<LinkStoreLimits[K]> }): LinkStoreLimits => ({
  perDaemon: { ...L.perDaemon, ...patch.perDaemon },
  perLink: { ...L.perLink, ...patch.perLink },
  perIp: { ...L.perIp, ...patch.perIp },
  challenge: { ...L.challenge, ...patch.challenge },
  global: { ...L.global, ...patch.global },
});
const code = (gate: { readonly ok: boolean; readonly code?: string }) => (gate.ok ? 'ok' : gate.code);

describe('chunks', () => {
  it('R696 should split at exactly 512 KiB and join back to the same bytes', () => {
    const bytes = Uint8Array.from({ length: LINK_CHUNK_BYTES * 2 + 5 }, (_, index) => index % 251);
    const chunks = chunkEnvelope(bytes);
    should(chunks.map(chunk => chunk.length)).deepEqual([LINK_CHUNK_BYTES, LINK_CHUNK_BYTES, 5]);
    should(Array.from(joinChunks(chunks))).deepEqual(Array.from(bytes));
  });

  it('should not add an empty chunk at an exact multiple, and keep one chunk under the bound', () => {
    should(chunkEnvelope(new Uint8Array(LINK_CHUNK_BYTES)).length).equal(1);
    should(chunkEnvelope(new Uint8Array(LINK_CHUNK_BYTES + 1)).length).equal(2);
    should(chunkEnvelope(new Uint8Array(1)).length).equal(1);
  });

  it('should make no chunks of nothing, and join nothing to nothing', () => {
    should(chunkEnvelope(new Uint8Array(0)).length).equal(0);
    should(joinChunks([]).length).equal(0);
  });

  it('should copy, so a chunk is not a view onto the original', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const [chunk] = chunkEnvelope(bytes);
    bytes[0] = 9;
    should(chunk?.[0]).equal(1);
  });
});

describe('sliding windows', () => {
  it('should count hits in the last minute only', () => {
    const windows = new SlidingWindows(10);
    windows.hit('a', T0);
    windows.hit('a', T0 + 30_000);
    should(windows.count('a', T0 + 30_000)).equal(2);
    should(windows.count('a', T0 + MIN)).equal(1);
    should(windows.count('a', T0 + MIN + 30_000)).equal(0);
    should(windows.size()).equal(0);
  });

  it('should count an unknown key as zero and leave an unchanged window alone', () => {
    const windows = new SlidingWindows(10);
    should(windows.count('nobody', T0)).equal(0);
    windows.hit('a', T0);
    should(windows.count('a', T0)).equal(1);
    should(windows.size()).equal(1);
  });

  it('should never hold more than its bound, forgetting the oldest key first', () => {
    const windows = new SlidingWindows(2);
    windows.hit('a', T0);
    windows.hit('b', T0);
    windows.hit('c', T0);
    should(windows.size()).equal(2);
    should(windows.count('a', T0)).equal(0);
    should(windows.count('b', T0)).equal(1);
    windows.hit('b', T0 + 1);
    windows.hit('d', T0 + 2);
    should(windows.count('c', T0 + 2)).equal(0);
    should(windows.count('b', T0 + 2)).equal(2);
  });
});

describe('owner shard', () => {
  const shardWith = (changes: Partial<OwnerShard>): OwnerShard => ({ ...EMPTY_OWNER_SHARD, ...changes });

  it('should hold three unspent nonces and six challenges a minute', () => {
    let shard = EMPTY_OWNER_SHARD;
    for (const nonce of ['a', 'b', 'c']) {
      const [next, gate] = ownerChallenge(shard, { nonce, now: T0 }, L);
      should(gate.ok).be.true();
      shard = next;
    }
    should(code(ownerChallenge(shard, { nonce: 'd', now: T0 }, L)[1])).equal('link_rate_limited');
    const [spent] = ownerSpendNonce(shard, 'a', T0);
    should(code(ownerChallenge(spent, { nonce: 'd', now: T0 }, L)[1])).equal('ok');
    const perMinute = shardWith({ challengeTimes: [T0, T0, T0, T0, T0, T0] });
    should(code(ownerChallenge(perMinute, { nonce: 'x', now: T0 }, L)[1])).equal('link_rate_limited');
    should(code(ownerChallenge(perMinute, { nonce: 'x', now: T0 + MIN }, L)[1])).equal('ok');
  });

  it('should spend a nonce once, and sweep one that ended', () => {
    const [issued] = ownerChallenge(EMPTY_OWNER_SHARD, { nonce: 'n', now: T0 }, L);
    const [left, spent] = ownerSpendNonce(issued, 'n', T0 + 1000);
    should(spent).be.true();
    should(left.nonces).deepEqual([]);
    should(ownerSpendNonce(left, 'n', T0 + 1000)[1]).be.false();
    should(ownerSpendNonce(issued, 'n', T0 + MIN)[1]).be.false();
    should(ownerSpendNonce(issued, 'other', T0)[1]).be.false();
  });

  it('should sweep what has run out and keep what has not', () => {
    const shard = shardWith({
      nonces: [
        { nonce: 'old', issuedAt: T0 - MIN },
        { nonce: 'new', issuedAt: T0 },
      ],
      challengeTimes: [T0 - MIN, T0],
      leases: { gone: { bytes: 1, until: T0 }, kept: { bytes: 2, until: T0 + 1 } },
    });
    const swept = sweepOwner(shard, T0);
    should(swept.nonces.map(entry => entry.nonce)).deepEqual(['new']);
    should(swept.challengeTimes).deepEqual([T0]);
    should(Object.keys(swept.leases)).deepEqual(['kept']);
  });

  it('should be idle only once nothing is left, including a day counter that is not today', () => {
    should(ownerIdle(EMPTY_OWNER_SHARD, T0)).be.true();
    should(ownerIdle(shardWith({ nonces: [{ nonce: 'n', issuedAt: T0 }] }), T0)).be.false();
    should(ownerIdle(shardWith({ challengeTimes: [T0] }), T0)).be.false();
    should(ownerIdle(shardWith({ leases: { a: { bytes: 1, until: T0 + 1 } } }), T0)).be.false();
    should(ownerIdle(shardWith({ uploads: { day: dayOf(T0), count: 1 } }), T0)).be.false();
    should(ownerIdle(shardWith({ uploads: { day: dayOf(T0) - 1, count: 1 } }), T0)).be.true();
  });

  it('should wake at the earliest thing to forget, and never when there is none', () => {
    should(ownerAlarmAt(EMPTY_OWNER_SHARD, T0)).be.null();
    const shard = shardWith({
      nonces: [{ nonce: 'n', issuedAt: T0 }],
      challengeTimes: [T0],
      leases: { a: { bytes: 1, until: T0 + 5 * MIN } },
      uploads: { day: dayOf(T0), count: 1 },
    });
    should(ownerAlarmAt(shard, T0)).equal(T0 + MIN);
    const onlyDay = shardWith({ uploads: { day: dayOf(T0), count: 1 } });
    should(ownerAlarmAt(onlyDay, T0)).equal((dayOf(T0) + 1) * DAY);
    should(ownerAlarmAt(shardWith({ leases: { a: { bytes: 1, until: T0 } } }), T0)).be.null();
  });

  describe('reservations', () => {
    const reservation = (
      changes: Partial<{ bundleId: string; bytes: number; until: number; create: boolean; now: number }> = {},
    ) => ({
      bundleId: 'a',
      bytes: 100,
      until: T0 + DAY,
      create: true,
      now: T0,
      ...changes,
    });

    it('should lease quota, count the upload and let undo put it all back', () => {
      const [shard, gate, undo] = ownerReserve(EMPTY_OWNER_SHARD, reservation(), L);
      should(gate.ok).be.true();
      should(shard.leases).deepEqual({ a: { bytes: 100, until: T0 + DAY } });
      should(shard.uploads).deepEqual({ day: dayOf(T0), count: 1 });
      should(undo).deepEqual({ bundleId: 'a', previous: null, day: dayOf(T0) });
      const back = ownerUndo(shard, undo);
      should(back.leases).deepEqual({});
      should(back.uploads.count).equal(0);
    });

    it('should restore a displaced lease on undo, and leave another day alone', () => {
      const first = ownerReserve(EMPTY_OWNER_SHARD, reservation(), L)[0];
      const [replaced, , undo] = ownerReserve(first, reservation({ create: false, bytes: 300 }), L);
      should(replaced.leases.a?.bytes).equal(300);
      should(undo.previous).deepEqual({ bytes: 100, until: T0 + DAY });
      should(ownerUndo(replaced, undo).leases.a?.bytes).equal(100);
      const tomorrow = shardWith({ uploads: { day: dayOf(T0) + 1, count: 5 } });
      should(ownerUndo(tomorrow, undo).uploads).deepEqual({ day: dayOf(T0) + 1, count: 5 });
    });

    it('should refuse past the daily uploads, the live links and the bytes, and a new day starts over', () => {
      const busy = shardWith({ uploads: { day: dayOf(T0), count: L.perDaemon.uploadsPerDay } });
      const [kept, refused] = ownerReserve(busy, reservation(), L);
      should(code(refused)).equal('link_rate_limited');
      should(kept.leases).deepEqual({});
      should(code(ownerReserve(busy, reservation({ now: T0 + DAY }), L)[1])).equal('ok');
      const small = withLimits({ perDaemon: { liveLinks: 1 } });
      const one = ownerReserve(EMPTY_OWNER_SHARD, reservation(), small)[0];
      should(code(ownerReserve(one, reservation({ bundleId: 'b' }), small)[1])).equal('link_store_full');
      should(code(ownerReserve(one, reservation({ create: false }), small)[1])).equal('ok');
      const tight = withLimits({ perDaemon: { bytes: 150 } });
      should(code(ownerReserve(one, reservation({ bundleId: 'b', bytes: 100 }), tight)[1])).equal('link_store_full');
      should(code(ownerReserve(one, reservation({ create: false, bytes: 150 }), tight)[1])).equal('ok');
    });

    it('should drop a lease that already ended before it counts the rest', () => {
      const old = shardWith({ leases: { stale: { bytes: 1000, until: T0 } } });
      const tight = withLimits({ perDaemon: { liveLinks: 1 } });
      should(code(ownerReserve(old, reservation(), tight)[1])).equal('ok');
    });

    it('should release one lease and nothing else', () => {
      const shard = shardWith({ leases: { a: { bytes: 1, until: T0 + 1 }, b: { bytes: 2, until: T0 + 1 } } });
      should(Object.keys(ownerRelease(shard, 'a').leases)).deepEqual(['b']);
      should(Object.keys(ownerRelease(shard, 'zzz').leases)).deepEqual(['a', 'b']);
    });
  });
});

describe('control shard', () => {
  const leased: LinkRecord = { owner: 'o', bytes: 100, until: T0 + DAY, phase: 'leased' };
  const tomb: LinkRecord = { owner: 'o', bytes: 0, until: T0, phase: 'tomb' };

  it('should say when a record next changes: a lease at its end, a tomb a tombstone later', () => {
    should(linkRecordDueAt(leased)).equal(T0 + DAY);
    should(linkRecordDueAt(tomb)).equal(T0 + LINK_TOMBSTONE_MS);
  });

  it('should keep totals true as a record is created, becomes a tomb and is forgotten', () => {
    const created = replaceRecordTotals(EMPTY_TOTALS, null, leased);
    should(created).deepEqual({ live: 1, bytes: 100, tombs: 0 });
    const ended = replaceRecordTotals(created, leased, tomb);
    should(ended).deepEqual({ live: 0, bytes: 0, tombs: 1 });
    should(replaceRecordTotals(ended, tomb, null)).deepEqual(EMPTY_TOTALS);
    should(replaceRecordTotals(created, leased, { ...leased, bytes: 40 })).deepEqual({ live: 1, bytes: 40, tombs: 0 });
    should(replaceRecordTotals(ended, tomb, leased)).deepEqual({ live: 1, bytes: 100, tombs: 0 });
  });

  describe('reserve gate', () => {
    const input = (changes: Partial<Parameters<typeof controlReserveGate>[0]> = {}) => ({
      available: true,
      owner: 'o',
      create: true,
      bytes: 100,
      record: null,
      ownerKnown: true,
      ownersCount: 1,
      totals: EMPTY_TOTALS,
      uploadsToday: 0,
      ...changes,
    });

    it('should pass an ordinary upload and refuse everything when closed', () => {
      should(code(controlReserveGate(input(), L))).equal('ok');
      should(code(controlReserveGate(input({ available: false }), L))).equal('link_store_unavailable');
    });

    it("should refuse to create over a live id or another owner's tombstone, and let the owner revive its own", () => {
      should(code(controlReserveGate(input({ record: leased }), L))).equal('link_exists');
      should(code(controlReserveGate(input({ record: { ...tomb, owner: 'x' } }), L))).equal('link_exists');
      should(code(controlReserveGate(input({ record: tomb }), L))).equal('ok');
    });

    it('should replace only a live link of the same owner', () => {
      should(code(controlReserveGate(input({ create: false }), L))).equal('link_unknown');
      should(code(controlReserveGate(input({ create: false, record: tomb }), L))).equal('link_unknown');
      should(code(controlReserveGate(input({ create: false, record: { ...leased, owner: 'x' } }), L))).equal(
        'link_unknown',
      );
      should(code(controlReserveGate(input({ create: false, record: leased }), L))).equal('ok');
    });

    it('should hold the store-wide caps: uploads a day, live links, bytes and owners', () => {
      should(code(controlReserveGate(input({ uploadsToday: L.global.uploadsPerDay }), L))).equal('link_store_capacity');
      const full = { live: L.global.liveLinks, bytes: 0, tombs: 0 };
      should(code(controlReserveGate(input({ totals: full }), L))).equal('link_store_capacity');
      should(code(controlReserveGate(input({ totals: full, create: false, record: leased }), L))).equal('ok');
      const heavy = { live: 1, bytes: L.global.bytes, tombs: 0 };
      should(code(controlReserveGate(input({ totals: heavy }), L))).equal('link_store_capacity');
      should(
        code(controlReserveGate(input({ totals: heavy, create: false, record: { ...leased, bytes: 100 } }), L)),
      ).equal('ok');
      should(code(controlReserveGate(input({ ownerKnown: false, ownersCount: L.global.owners }), L))).equal(
        'link_store_capacity',
      );
      should(code(controlReserveGate(input({ ownerKnown: false, ownersCount: 0 }), L))).equal('ok');
    });
  });

  describe('challenge gate', () => {
    const base = { available: true, ownerKnown: true, ownersCount: 1, ip: '1.1.1.1', now: T0 };
    const windows = () => ({ global: new SlidingWindows(1), byIp: new SlidingWindows(10) });

    it('should refuse when closed, and refuse a new owner when the store has none to spare', () => {
      should(code(controlChallengeGate({ ...base, available: false }, windows(), L))).equal('link_store_unavailable');
      should(
        code(controlChallengeGate({ ...base, ownerKnown: false, ownersCount: L.global.owners }, windows(), L)),
      ).equal('link_store_capacity');
    });

    it('should count a pass in both windows, and refuse past each limit without counting', () => {
      const w = windows();
      const tight = withLimits({ perIp: { challengesPerMinute: 2 }, challenge: { globalPerMinute: 3 } });
      should(code(controlChallengeGate(base, w, tight))).equal('ok');
      should(code(controlChallengeGate(base, w, tight))).equal('ok');
      should(code(controlChallengeGate(base, w, tight))).equal('link_rate_limited');
      should(w.global.count('all', T0)).equal(2);
      should(code(controlChallengeGate({ ...base, ip: '2.2.2.2' }, w, tight))).equal('ok');
      should(code(controlChallengeGate({ ...base, ip: '3.3.3.3' }, w, tight))).equal('link_store_capacity');
    });
  });

  describe('open verdict', () => {
    const base = {
      serving: true,
      known: true,
      type: 'fetch' as const,
      bundleId: 'id',
      ip: '1.1.1.1',
      fetchesToday: 0,
      now: T0,
    };
    const windows = () => ({ byIp: new SlidingWindows(10), wrongUnknown: new SlidingWindows(10) });

    it('should refuse while not serving, before anything else', () => {
      should(controlOpenVerdict({ ...base, serving: false }, windows(), L)).deepEqual({
        kind: 'refuse',
        code: 'link_store_unavailable',
      });
    });

    it('should let a known id go on to its bundle', () => {
      should(controlOpenVerdict(base, windows(), L)).deepEqual({ kind: 'proceed' });
    });

    it("should answer an unknown id gone without a record, and 429 it only by the id's own window", () => {
      const w = windows();
      const tight = withLimits({ perLink: { wrongTokensPerMinute: 2 } });
      const unknown = { ...base, known: false };
      should(controlOpenVerdict(unknown, w, tight)).deepEqual({ kind: 'gone' });
      should(controlOpenVerdict(unknown, w, tight)).deepEqual({ kind: 'gone' });
      should(controlOpenVerdict(unknown, w, tight)).deepEqual({ kind: 'refuse', code: 'link_rate_limited' });
      should(controlOpenVerdict({ ...unknown, bundleId: 'other' }, w, tight)).deepEqual({ kind: 'gone' });
    });

    it('should hold a per-address window across ids', () => {
      const w = windows();
      const tight = withLimits({ perIp: { fetchesPerMinute: 1 } });
      should(controlOpenVerdict(base, w, tight).kind).equal('proceed');
      should(controlOpenVerdict(base, w, tight)).deepEqual({ kind: 'refuse', code: 'link_rate_limited' });
      should(controlOpenVerdict({ ...base, ip: '9.9.9.9' }, w, tight).kind).equal('proceed');
    });

    it('should brake fetches at the daily cap but never peeks', () => {
      const capped = { ...base, fetchesToday: L.global.fetchesPerDay };
      should(controlOpenVerdict(capped, windows(), L)).deepEqual({ kind: 'refuse', code: 'link_store_capacity' });
      should(controlOpenVerdict({ ...capped, type: 'peek' }, windows(), L)).deepEqual({ kind: 'proceed' });
    });
  });
});

describe('small helpers', () => {
  it('should relax everything a bundle object does not own', () => {
    const bundle = bundleLimits(L);
    should(bundle.perLink).deepEqual(L.perLink);
    should(bundle.perDaemon.liveLinks).equal(Number.POSITIVE_INFINITY);
    should(bundle.perIp.fetchesPerMinute).equal(Number.POSITIVE_INFINITY);
    should(bundle.challenge.globalPerMinute).equal(Number.POSITIVE_INFINITY);
    should(bundle.global.owners).equal(Number.POSITIVE_INFINITY);
  });

  it('should count today and roll a counter over on a new day', () => {
    should(countedToday({ day: dayOf(T0), count: 4 }, T0)).equal(4);
    should(countedToday({ day: dayOf(T0) - 1, count: 4 }, T0)).equal(0);
  });
});

describe('persisted shapes', () => {
  it('should accept the defaults whole and refuse a patch, an extra key, zero and a negative', () => {
    should(LinkStoreLimitsSchema.safeParse(L).success).be.true();
    should(LinkStoreLimitsSchema.safeParse({ perLink: L.perLink }).success).be.false();
    should(LinkStoreLimitsSchema.safeParse({ ...L, extra: 1 }).success).be.false();
    should(LinkStoreLimitsSchema.safeParse(withLimits({ perDaemon: { bytes: 0 } })).success).be.false();
    should(LinkStoreLimitsSchema.safeParse(withLimits({ global: { owners: -1 } })).success).be.false();
    should(LinkStoreLimitsSchema.safeParse(withLimits({ global: { owners: 1.5 } })).success).be.false();
  });

  it('should read the per-link part on its own', () => {
    should(PerLinkLimitsSchema.safeParse(L.perLink).success).be.true();
    should(PerLinkLimitsSchema.safeParse({ ...L.perLink, extra: 1 }).success).be.false();
  });

  it('should take an operator update with at least one known key', () => {
    should(LinkStoreOperatorUpdateSchema.safeParse({ available: false }).success).be.true();
    should(LinkStoreOperatorUpdateSchema.safeParse({ serving: true, limits: L }).success).be.true();
    should(LinkStoreOperatorUpdateSchema.safeParse({}).success).be.false();
    should(LinkStoreOperatorUpdateSchema.safeParse({ available: 'no' }).success).be.false();
    should(LinkStoreOperatorUpdateSchema.safeParse({ available: true, other: 1 }).success).be.false();
  });

  it('should read the stored configuration, refusing a missing or extra key', () => {
    const config = { available: true, serving: true, limits: L };
    should(LinkStoreConfigSchema.safeParse(config).success).be.true();
    should(LinkStoreConfigSchema.safeParse({ available: true, serving: true }).success).be.false();
    should(LinkStoreConfigSchema.safeParse({ ...config, more: 1 }).success).be.false();
  });

  it('should read a registry record and refuse a malformed one', () => {
    const record = { owner: 'o', bytes: 0, until: 0, phase: 'tomb' };
    should(LinkRecordSchema.safeParse(record).success).be.true();
    should(LinkRecordSchema.safeParse({ ...record, phase: 'live' }).success).be.false();
    should(LinkRecordSchema.safeParse({ ...record, owner: '' }).success).be.false();
    should(LinkRecordSchema.safeParse({ ...record, until: -1 }).success).be.false();
  });

  it('should read the control counters and start from zero', () => {
    should(ControlStateSchema.safeParse(EMPTY_CONTROL_STATE).success).be.true();
    should(ControlStateSchema.safeParse({ ...EMPTY_CONTROL_STATE, owners: -1 }).success).be.false();
    should(ControlStateSchema.safeParse({ ...EMPTY_CONTROL_STATE, totals: { live: 0, bytes: 0 } }).success).be.false();
  });

  it('should read an owner shard and refuse a damaged one', () => {
    should(OwnerShardSchema.safeParse(EMPTY_OWNER_SHARD).success).be.true();
    const full = {
      nonces: [{ nonce: 'n', issuedAt: T0 }],
      challengeTimes: [T0],
      leases: { a: { bytes: 1, until: T0 } },
      uploads: { day: 1, count: 1 },
    };
    should(OwnerShardSchema.safeParse(full).success).be.true();
    should(OwnerShardSchema.safeParse({ ...full, nonces: [{ nonce: '', issuedAt: T0 }] }).success).be.false();
    should(OwnerShardSchema.safeParse({ ...full, leases: { a: { bytes: 1 } } }).success).be.false();
  });
});

describe('due keys', () => {
  it('should round trip, sorting by time', () => {
    const key = dueKey(T0, 'l', 'bundle-1');
    should(parseDueKey(key)).deepEqual({ at: T0, kind: 'l', id: 'bundle-1' });
    should(parseDueKey(dueKey(5, 'o', 'fy_daemon_x'))).deepEqual({ at: 5, kind: 'o', id: 'fy_daemon_x' });
    should(dueKey(9, 'l', 'a') < dueKey(10, 'l', 'a')).be.true();
    should(dueKey(T0 + 0.7, 'l', 'a')).equal(dueKey(T0, 'l', 'a'));
  });

  it('should read a key it did not write as nothing', () => {
    should(parseDueKey('link:abc')).be.null();
    should(parseDueKey('due:123:l:abc')).be.null();
    should(parseDueKey(`due:${'0'.repeat(15)}:x:abc`)).be.null();
    should(parseDueKey(`due:${'0'.repeat(15)}:l:`)).be.null();
  });
});
