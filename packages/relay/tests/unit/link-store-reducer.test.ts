import { describe, it } from 'bun:test';
import {
  DEFAULT_LINK_STORE_LIMITS,
  initialLinkStoreState,
  LINK_GONE,
  LINK_TOMBSTONE_MS,
  LINK_UPLOAD_SKEW_MS,
  linkBundleAlarmAt,
  type LinkStoreEvent,
  type LinkStoreLimits,
  type LinkStoreResponse,
  type LinkUploadMetadata,
  linkStoreMetrics,
  linkStoreRefusalBody,
  reduceLinkStore,
  sweepLinkStore,
  toBase64Url,
} from '@ferretry/relay';
import should from 'should';

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.parse('2026-10-31T09:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const b64 = (length: number, fill: number) => toBase64Url(new Uint8Array(length).fill(fill));
const OWNER = `fy_daemon_${'A'.repeat(43)}`;
const OTHER = `fy_daemon_${'B'.repeat(43)}`;
const ID = b64(16, 1);
const ID2 = b64(16, 2);
const ID3 = b64(16, 3);

type LimitPatch = { [K in keyof LinkStoreLimits]?: Partial<LinkStoreLimits[K]> };
const limitsWith = (patch: LimitPatch): LinkStoreLimits => ({
  perDaemon: { ...DEFAULT_LINK_STORE_LIMITS.perDaemon, ...patch.perDaemon },
  perLink: { ...DEFAULT_LINK_STORE_LIMITS.perLink, ...patch.perLink },
  perIp: { ...DEFAULT_LINK_STORE_LIMITS.perIp, ...patch.perIp },
  challenge: { ...DEFAULT_LINK_STORE_LIMITS.challenge, ...patch.challenge },
  global: { ...DEFAULT_LINK_STORE_LIMITS.global, ...patch.global },
});

function harness(limits: LinkStoreLimits = DEFAULT_LINK_STORE_LIMITS) {
  let state = initialLinkStoreState(limits);
  const go = (event: LinkStoreEvent): LinkStoreResponse => {
    const [next, response] = reduceLinkStore(state, event);
    state = next;
    return response;
  };
  return { go, state: () => state };
}
type Harness = ReturnType<typeof harness>;

const meta = (changes: Partial<LinkUploadMetadata> = {}, bytes = 100): LinkUploadMetadata =>
  ({
    daemonId: OWNER,
    publicKey: b64(44, 2),
    nonce: b64(32, 3),
    signature: b64(64, 4),
    action: 'create',
    kind: 'public',
    sequence: 1,
    notAfter: iso(T0 + 7 * DAY),
    fetchVerifier: b64(32, 1),
    envelopeSha256: b64(32, 2),
    envelopeBytes: bytes,
    ...changes,
  }) as LinkUploadMetadata;

interface UploadOptions {
  readonly bundleId?: string;
  readonly daemonId?: string;
  readonly metadata?: Partial<LinkUploadMetadata>;
  readonly bytes?: number;
  readonly now?: number;
}
const upload = (h: Harness, options: UploadOptions = {}) => {
  const bytes = options.bytes ?? 100;
  return h.go({
    type: 'upload',
    daemonId: options.daemonId ?? OWNER,
    bundleId: options.bundleId ?? ID,
    metadata: meta(options.metadata, bytes),
    envelope: new Uint8Array(bytes).fill(9),
    now: options.now ?? T0,
  });
};

interface OpenOptions {
  readonly bundleId?: string;
  readonly verifier?: string;
  readonly ip?: string;
  readonly now?: number;
}
const open = (h: Harness, type: 'peek' | 'fetch', options: OpenOptions = {}) =>
  h.go({
    type,
    bundleId: options.bundleId ?? ID,
    tokenVerifier: options.verifier ?? b64(32, 1),
    ip: options.ip ?? '10.0.0.1',
    now: options.now ?? T0,
  });
const fetch = (h: Harness, options: OpenOptions = {}) => open(h, 'fetch', options);
const peek = (h: Harness, options: OpenOptions = {}) => open(h, 'peek', options);

const statusOf = (h: Harness, bundleId = ID, daemonId = OWNER, now = T0) => {
  const response = h.go({ type: 'status', daemonId, bundleIds: [bundleId], now });
  if (!response.ok || response.kind !== 'status') throw new Error('no status');
  return response.status.links[0];
};

const code = (response: LinkStoreResponse) => (response.ok ? response.kind : response.code);
const challenge = (h: Harness, daemonId = OWNER, nonce = 'n1', ip = '10.0.0.1', now = T0) =>
  h.go({ type: 'challenge', daemonId, ip, nonce, now });

describe('challenges and nonces', () => {
  it('should issue a nonce with a 60 second deadline', () => {
    const h = harness();
    should(challenge(h)).deepEqual({ ok: true, kind: 'challenge', nonce: 'n1', deadlineSeconds: 60 });
  });

  it('should spend a nonce on its first use, and never twice', () => {
    const h = harness();
    challenge(h);
    should(h.go({ type: 'spend-nonce', daemonId: OWNER, nonce: 'n1', now: T0 + 1000 })).deepEqual({
      ok: true,
      kind: 'nonce-spent',
    });
    should(code(h.go({ type: 'spend-nonce', daemonId: OWNER, nonce: 'n1', now: T0 + 1000 }))).equal(
      'link_challenge_expired',
    );
  });

  it('should refuse a nonce nobody issued, one issued to someone else, and one that has expired', () => {
    const h = harness();
    challenge(h);
    const spend = (daemonId: string, nonce: string, now: number) =>
      code(h.go({ type: 'spend-nonce', daemonId, nonce, now }));
    should(spend(OWNER, 'other', T0)).equal('link_challenge_expired');
    should(spend(OTHER, 'n1', T0)).equal('link_challenge_expired');
    should(spend(OWNER, 'n1', T0 + 60_000)).equal('link_challenge_expired');
  });

  it('should hold at most three unspent nonces per daemon, and free one when it is spent or ends', () => {
    const h = harness();
    for (const nonce of ['a', 'b', 'c']) should(code(challenge(h, OWNER, nonce))).equal('challenge');
    should(code(challenge(h, OWNER, 'd'))).equal('link_rate_limited');
    h.go({ type: 'spend-nonce', daemonId: OWNER, nonce: 'a', now: T0 });
    should(code(challenge(h, OWNER, 'd'))).equal('challenge');
    should(code(challenge(h, OWNER, 'e', '10.0.0.2', T0 + 61_000))).equal('challenge');
  });

  it('should allow six challenges a minute per daemon', () => {
    const h = harness();
    for (let index = 0; index < 6; index += 1) {
      challenge(h, OWNER, `n${index}`);
      h.go({ type: 'spend-nonce', daemonId: OWNER, nonce: `n${index}`, now: T0 });
    }
    should(code(challenge(h, OWNER, 'late'))).equal('link_rate_limited');
    should(code(challenge(h, OWNER, 'later', '10.0.0.1', T0 + MIN))).equal('challenge');
  });

  it('should allow a number of challenges a minute from one address, however many daemons', () => {
    const h = harness(limitsWith({ perIp: { challengesPerMinute: 2 } }));
    should(code(challenge(h, OWNER, 'a', '1.1.1.1'))).equal('challenge');
    should(code(challenge(h, OTHER, 'b', '1.1.1.1'))).equal('challenge');
    should(code(challenge(h, `fy_daemon_${'C'.repeat(43)}`, 'c', '1.1.1.1'))).equal('link_rate_limited');
    should(code(challenge(h, `fy_daemon_${'C'.repeat(43)}`, 'c', '2.2.2.2'))).equal('challenge');
    should(code(challenge(h, `fy_daemon_${'D'.repeat(43)}`, 'd', '1.1.1.1', T0 + MIN))).equal('challenge');
  });

  it('should cap challenges a minute across the whole store, and the owners it will know', () => {
    const globalCap = harness(limitsWith({ challenge: { globalPerMinute: 1 } }));
    should(code(challenge(globalCap, OWNER, 'a', '1.1.1.1'))).equal('challenge');
    should(code(challenge(globalCap, OTHER, 'b', '2.2.2.2'))).equal('link_store_capacity');
    should(code(challenge(globalCap, OTHER, 'b', '2.2.2.2', T0 + MIN))).equal('challenge');

    const owners = harness(limitsWith({ global: { owners: 1 } }));
    should(code(challenge(owners, OWNER, 'a'))).equal('challenge');
    should(code(challenge(owners, OTHER, 'b', '2.2.2.2'))).equal('link_store_capacity');
    should(code(challenge(owners, OWNER, 'c', '3.3.3.3'))).equal('challenge');
  });

  it('should refuse challenges while the store is not taking new links', () => {
    const h = harness();
    h.go({ type: 'operator', available: false, now: T0 });
    should(code(challenge(h))).equal('link_store_unavailable');
  });

  it('should forget an owner with nothing left, but keep one that uploaded today', () => {
    const h = harness();
    challenge(h);
    should(linkStoreMetrics(h.state()).owners).equal(1);
    h.go({ type: 'alarm', now: T0 + 2 * MIN });
    should(linkStoreMetrics(h.state()).owners).equal(0);

    upload(h, { metadata: { notAfter: iso(T0 + 3 * MIN) } });
    h.go({ type: 'alarm', now: T0 + 10 * MIN });
    should(linkStoreMetrics(h.state()).owners).equal(1);
    h.go({ type: 'alarm', now: T0 + 2 * DAY });
    should(linkStoreMetrics(h.state()).owners).equal(0);
  });
});

describe('uploading', () => {
  it('should store a link and say so', () => {
    const h = harness();
    should(upload(h)).deepEqual({ ok: true, kind: 'stored', sequence: 1 });
    should(statusOf(h)).match({ state: 'live', kind: 'public', sequence: 1, opens: 0, storedBytes: 100 });
  });

  it('should refuse every upload while the store is not taking new links', () => {
    const h = harness();
    h.go({ type: 'operator', available: false, now: T0 });
    should(code(upload(h))).equal('link_store_unavailable');
  });

  it('should refuse an envelope that is not the length the metadata names', () => {
    const h = harness();
    const response = h.go({
      type: 'upload',
      daemonId: OWNER,
      bundleId: ID,
      metadata: meta({}, 100),
      envelope: new Uint8Array(99),
      now: T0,
    });
    should(code(response)).equal('link_bad_request');
  });

  it('should refuse a lease that has ended or reaches too far, with five minutes of skew', () => {
    const h = harness();
    const at = (kind: 'public' | 'one-time', notAfter: number, bundleId: string) =>
      code(upload(h, { bundleId, metadata: { kind, notAfter: iso(notAfter) } }));
    should(at('public', T0, ID)).equal('link_bad_request');
    should(at('public', T0 - 1, ID)).equal('link_bad_request');
    should(at('public', T0 + 30 * DAY + LINK_UPLOAD_SKEW_MS + 1, ID)).equal('link_bad_request');
    should(at('public', T0 + 30 * DAY + LINK_UPLOAD_SKEW_MS, ID)).equal('stored');
    should(at('one-time', T0 + DAY + LINK_UPLOAD_SKEW_MS + 1, ID2)).equal('link_bad_request');
    should(at('one-time', T0 + DAY + LINK_UPLOAD_SKEW_MS, ID2)).equal('stored');
  });

  it('should keep an id for good once anything but a lapsed public link by its owner has held it', () => {
    const h = harness();
    upload(h);
    should(code(upload(h))).equal('link_exists');
    should(code(upload(h, { daemonId: OTHER }))).equal('link_exists');
    h.go({ type: 'delete', daemonId: OWNER, bundleId: ID, now: T0 });
    should(code(upload(h))).equal('link_exists');
  });

  it('should replace a live link by compare-and-swap, keeping its opens and re-measuring its bytes', () => {
    const h = harness();
    upload(h);
    fetch(h);
    fetch(h);
    const replaced = upload(h, {
      bytes: 200,
      metadata: { action: 'replace', sequence: 2, expectSequence: 1, fetchVerifier: b64(32, 5) },
    });
    should(replaced).deepEqual({ ok: true, kind: 'stored', sequence: 2 });
    should(statusOf(h)).match({ sequence: 2, opens: 2, storedBytes: 200 });
    should(linkStoreMetrics(h.state()).storedBytes).equal(200);
    should(code(fetch(h))).equal('link_gone');
    should(code(fetch(h, { verifier: b64(32, 5) }))).equal('fetch');
  });

  it('should refuse a replace that expects a sequence the store no longer holds', () => {
    const h = harness();
    upload(h);
    upload(h, { metadata: { action: 'replace', sequence: 2, expectSequence: 1 } });
    const stale = upload(h, { metadata: { action: 'replace', sequence: 3, expectSequence: 1 } });
    should(code(stale)).equal('link_sequence_conflict');
    should(statusOf(h)).match({ sequence: 2 });
  });

  it('should refuse a replace of what is not there, is not theirs, has ended, or is another kind', () => {
    const h = harness();
    const replace = (options: UploadOptions = {}) =>
      code(
        upload(h, { ...options, metadata: { action: 'replace', sequence: 2, expectSequence: 1, ...options.metadata } }),
      );
    should(replace()).equal('link_unknown');
    upload(h);
    should(replace({ daemonId: OTHER })).equal('link_unknown');
    should(replace({ metadata: { kind: 'one-time' } })).equal('link_bad_request');
    h.go({ type: 'delete', daemonId: OWNER, bundleId: ID, now: T0 });
    should(replace()).equal('link_unknown');
  });

  it('should revive a lapsed public link, for its own owner, with a higher sequence', () => {
    const h = harness();
    upload(h, { metadata: { notAfter: iso(T0 + 60 * MIN) } });
    fetch(h);
    const later = T0 + 2 * 60 * MIN;
    h.go({ type: 'alarm', now: later });
    should(statusOf(h, ID, OWNER, later)).match({ state: 'lapsed', storedBytes: 0 });
    should(code(upload(h, { now: later, daemonId: OTHER, metadata: { sequence: 2 } }))).equal('link_exists');
    should(code(upload(h, { now: later, metadata: { sequence: 1 } }))).equal('link_sequence_conflict');
    should(code(upload(h, { now: later, metadata: { kind: 'one-time', notAfter: iso(later + 60 * MIN) } }))).equal(
      'link_exists',
    );
    should(upload(h, { now: later, metadata: { sequence: 2, fetchVerifier: b64(32, 6) } })).deepEqual({
      ok: true,
      kind: 'stored',
      sequence: 2,
    });
    should(statusOf(h, ID, OWNER, later)).match({ state: 'live', sequence: 2, opens: 1 });
    should(code(fetch(h, { now: later, verifier: b64(32, 6) }))).equal('fetch');
  });

  it('should never revive a lapsed one-time link, or an ended link', () => {
    const h = harness();
    upload(h, { bundleId: ID, metadata: { kind: 'one-time', notAfter: iso(T0 + 60 * MIN) } });
    upload(h, { bundleId: ID2, metadata: { notAfter: iso(T0 + 60 * MIN), expiresAt: iso(T0 + 60 * MIN) } });
    const later = T0 + 2 * 60 * MIN;
    h.go({ type: 'alarm', now: later });
    should(statusOf(h, ID, OWNER, later)).match({ state: 'lapsed', kind: 'one-time' });
    should(statusOf(h, ID2, OWNER, later)).match({ state: 'ended' });
    should(code(upload(h, { bundleId: ID, now: later, metadata: { sequence: 9 } }))).equal('link_exists');
    should(code(upload(h, { bundleId: ID2, now: later, metadata: { sequence: 9 } }))).equal('link_exists');
  });

  it('should reuse an id once its tombstone has been forgotten', () => {
    const h = harness();
    const notAfter = T0 + DAY;
    upload(h, { metadata: { notAfter: iso(notAfter) } });
    h.go({ type: 'delete', daemonId: OWNER, bundleId: ID, now: T0 });
    should(linkBundleAlarmAt(h.state(), ID)).equal(notAfter + LINK_TOMBSTONE_MS);
    const again = (now: number) => code(upload(h, { now, metadata: { notAfter: iso(now + DAY) } }));
    should(again(notAfter + LINK_TOMBSTONE_MS - 1)).equal('link_exists');
    should(again(notAfter + LINK_TOMBSTONE_MS)).equal('stored');
  });
});

describe('quotas and capacity', () => {
  it('should cap live links per daemon, but still let a live link be replaced', () => {
    const h = harness(limitsWith({ perDaemon: { liveLinks: 2 } }));
    upload(h, { bundleId: ID });
    upload(h, { bundleId: ID2 });
    should(code(upload(h, { bundleId: ID3 }))).equal('link_store_full');
    should(code(upload(h, { bundleId: ID, metadata: { action: 'replace', sequence: 2, expectSequence: 1 } }))).equal(
      'stored',
    );
    should(code(upload(h, { bundleId: ID3, daemonId: OTHER }))).equal('stored');
  });

  it('should cap stored bytes per daemon, counting a replace by what it adds', () => {
    const h = harness(limitsWith({ perDaemon: { bytes: 250 } }));
    upload(h, { bundleId: ID });
    upload(h, { bundleId: ID2 });
    should(code(upload(h, { bundleId: ID3 }))).equal('link_store_full');
    const replace = (bytes: number, expect: number) =>
      code(
        upload(h, {
          bytes,
          bundleId: ID,
          metadata: { action: 'replace', sequence: expect + 1, expectSequence: expect },
        }),
      );
    should(replace(151, 1)).equal('link_store_full');
    should(replace(150, 1)).equal('stored');
  });

  it('should cap uploads a day per daemon and across the store, and start again the next day', () => {
    const perDaemon = harness(limitsWith({ perDaemon: { uploadsPerDay: 2 } }));
    upload(perDaemon, { bundleId: ID });
    upload(perDaemon, { bundleId: ID2 });
    should(code(upload(perDaemon, { bundleId: ID3 }))).equal('link_rate_limited');
    should(code(upload(perDaemon, { bundleId: ID3, now: T0 + DAY }))).equal('stored');

    const global = harness(limitsWith({ global: { uploadsPerDay: 2 } }));
    upload(global, { bundleId: ID });
    upload(global, { bundleId: ID2, daemonId: OTHER });
    should(code(upload(global, { bundleId: ID3 }))).equal('link_store_capacity');
    should(code(upload(global, { bundleId: ID3, now: T0 + DAY }))).equal('stored');
  });

  it('should cap live links, bytes and owners across the whole store', () => {
    const links = harness(limitsWith({ global: { liveLinks: 1 } }));
    upload(links, { bundleId: ID });
    should(code(upload(links, { bundleId: ID2, daemonId: OTHER }))).equal('link_store_capacity');
    should(
      code(upload(links, { bundleId: ID, metadata: { action: 'replace', sequence: 2, expectSequence: 1 } })),
    ).equal('stored');

    const bytes = harness(limitsWith({ global: { bytes: 150 } }));
    upload(bytes, { bundleId: ID });
    should(code(upload(bytes, { bundleId: ID2, daemonId: OTHER }))).equal('link_store_capacity');

    const owners = harness(limitsWith({ global: { owners: 1 } }));
    upload(owners, { bundleId: ID });
    should(code(upload(owners, { bundleId: ID2, daemonId: OTHER }))).equal('link_store_capacity');
    should(code(upload(owners, { bundleId: ID2 }))).equal('stored');
  });

  it('should give a lease back when it ends, so a crash costs quota only until then', () => {
    const h = harness(limitsWith({ perDaemon: { liveLinks: 1 } }));
    upload(h, { bundleId: ID, metadata: { notAfter: iso(T0 + 60 * MIN) } });
    should(code(upload(h, { bundleId: ID2, now: T0 + 30 * MIN }))).equal('link_store_full');
    should(code(upload(h, { bundleId: ID2, now: T0 + 60 * MIN }))).equal('stored');
  });
});

describe('deleting and status', () => {
  it('should end a link, free its quota and make it answer gone', () => {
    const h = harness(limitsWith({ perDaemon: { liveLinks: 1 } }));
    upload(h);
    should(h.go({ type: 'delete', daemonId: OWNER, bundleId: ID, now: T0 })).deepEqual({ ok: true, kind: 'deleted' });
    should(statusOf(h)).match({ state: 'ended', storedBytes: 0 });
    should(code(fetch(h))).equal('link_gone');
    should(code(upload(h, { bundleId: ID2 }))).equal('stored');
  });

  it('should answer a second delete as it did the first, without extending the tombstone', () => {
    const h = harness();
    upload(h);
    h.go({ type: 'delete', daemonId: OWNER, bundleId: ID, now: T0 });
    const alarm = linkBundleAlarmAt(h.state(), ID);
    should(h.go({ type: 'delete', daemonId: OWNER, bundleId: ID, now: T0 + 5 * MIN })).deepEqual({
      ok: true,
      kind: 'deleted',
    });
    should(linkBundleAlarmAt(h.state(), ID)).equal(alarm);
  });

  it('should answer unknown to a delete by anyone but the owner, and of an id nobody holds', () => {
    const h = harness();
    upload(h);
    should(code(h.go({ type: 'delete', daemonId: OTHER, bundleId: ID, now: T0 }))).equal('link_unknown');
    should(code(h.go({ type: 'delete', daemonId: OWNER, bundleId: ID2, now: T0 }))).equal('link_unknown');
    should(code(fetch(h))).equal('fetch');
  });

  it('should delete a used one-time link and a lapsed link, as an end', () => {
    const h = harness();
    upload(h, { metadata: { kind: 'one-time', notAfter: iso(T0 + DAY) } });
    fetch(h);
    should(h.go({ type: 'delete', daemonId: OWNER, bundleId: ID, now: T0 + MIN })).deepEqual({
      ok: true,
      kind: 'deleted',
    });
    should(statusOf(h, ID, OWNER, T0 + MIN)).match({ state: 'ended' });
  });

  it('should show an owner only its own links, and the optional fields only when set', () => {
    const h = harness();
    upload(h, { metadata: { expiresAt: iso(T0 + 8 * DAY), installCap: 5 } });
    upload(h, { bundleId: ID2 });
    const response = h.go({ type: 'status', daemonId: OWNER, bundleIds: [ID, ID2, ID3], now: T0 });
    if (!response.ok || response.kind !== 'status') throw new Error('no status');
    should(response.status.links[0]).deepEqual({
      bundleId: ID,
      state: 'live',
      kind: 'public',
      sequence: 1,
      opens: 0,
      notAfter: iso(T0 + 7 * DAY),
      expiresAt: iso(T0 + 8 * DAY),
      installCap: 5,
      storedBytes: 100,
    });
    should(Object.keys(response.status.links[1] ?? {})).not.containEql('installCap');
    should(Object.keys(response.status.links[1] ?? {})).not.containEql('expiresAt');
    should(response.status.links[2]).deepEqual({ bundleId: ID3, state: 'unknown' });
    should(statusOf(h, ID, OTHER)).deepEqual({ bundleId: ID, state: 'unknown' });
  });
});

describe('peeking and fetching', () => {
  it('should peek without consuming anything', () => {
    const h = harness();
    upload(h, { metadata: { kind: 'one-time', notAfter: iso(T0 + DAY), expiresAt: iso(T0 + DAY) } });
    for (let index = 0; index < 5; index += 1)
      should(peek(h)).deepEqual({
        ok: true,
        kind: 'peek',
        peek: { version: 1, kind: 'one-time', expiresAt: iso(T0 + DAY) },
      });
    should(statusOf(h)).match({ state: 'live', opens: 0 });
    should(code(fetch(h))).equal('fetch');
  });

  it('should leave the end out of a peek of a link that has none', () => {
    const h = harness();
    upload(h);
    should(peek(h)).deepEqual({ ok: true, kind: 'peek', peek: { version: 1, kind: 'public' } });
  });

  it('should serve a public link over and over, counting each open', () => {
    const h = harness();
    upload(h);
    const first = fetch(h);
    if (!first.ok || first.kind !== 'fetch') throw new Error('no fetch');
    should(first.linkKind).equal('public');
    should(first.sequence).equal(1);
    should(first.envelope.length).equal(100);
    should(first.envelope[0]).equal(9);
    fetch(h);
    should(statusOf(h)).match({ state: 'live', opens: 2 });
  });

  it('should use up a one-time link on the first fetch, so a race has exactly one winner', () => {
    const h = harness();
    upload(h, { metadata: { kind: 'one-time', notAfter: iso(T0 + DAY) } });
    const winner = fetch(h);
    const loser = fetch(h, { ip: '10.0.0.2' });
    should(winner).match({ ok: true, kind: 'fetch', linkKind: 'one-time', sequence: 1 });
    should(loser).equal(LINK_GONE);
    should(statusOf(h)).match({ state: 'used', opens: 1, storedBytes: 0 });
    should(linkStoreMetrics(h.state()).liveLinks).equal(0);
    should(code(peek(h))).equal('link_gone');
  });

  it('should serve a public link up to its install cap, then answer gone while staying live for its owner', () => {
    const h = harness();
    upload(h, { metadata: { installCap: 2 } });
    should(code(fetch(h))).equal('fetch');
    should(code(fetch(h))).equal('fetch');
    should(fetch(h)).equal(LINK_GONE);
    should(peek(h)).equal(LINK_GONE);
    should(statusOf(h)).match({ state: 'live', opens: 2, installCap: 2 });
  });

  it('should answer the same 410, byte for byte, whatever the cause', () => {
    const h = harness();
    upload(h, { bundleId: ID, metadata: { kind: 'one-time', notAfter: iso(T0 + DAY) } });
    fetch(h);
    upload(h, { bundleId: ID2, metadata: { installCap: 1 } });
    fetch(h, { bundleId: ID2 });
    upload(h, { bundleId: ID3, metadata: { notAfter: iso(T0 + 60 * MIN) } });
    const ended = b64(16, 4);
    upload(h, { bundleId: ended });
    h.go({ type: 'delete', daemonId: OWNER, bundleId: ended, now: T0 });
    const early = b64(16, 5);
    upload(h, { bundleId: early, metadata: { notAfter: iso(T0 + 2 * DAY), expiresAt: iso(T0 + MIN) } });
    const live = b64(16, 6);
    upload(h, { bundleId: live });
    const at = T0 + 2 * MIN;
    const answers = [
      fetch(h, { bundleId: ID, now: at, ip: 'a' }),
      fetch(h, { bundleId: ID2, now: at, ip: 'b' }),
      fetch(h, { bundleId: ended, now: at, ip: 'c' }),
      fetch(h, { bundleId: early, now: at, ip: 'd' }),
      fetch(h, { bundleId: b64(16, 7), now: at, ip: 'e' }),
      fetch(h, { bundleId: live, verifier: b64(32, 8), now: at, ip: 'f' }),
      fetch(h, { bundleId: live, verifier: 'not a verifier', now: at, ip: 'g' }),
      fetch(h, { bundleId: live, verifier: b64(31, 1), now: at, ip: 'h' }),
      peek(h, { bundleId: ID3, now: T0 + 61 * MIN, ip: 'i' }),
      peek(h, { bundleId: b64(16, 7), now: at, ip: 'j' }),
    ];
    for (const answer of answers) should(answer).equal(LINK_GONE);
    should(JSON.stringify(answers[0])).equal(JSON.stringify(answers[9]));
    should(Object.isFrozen(LINK_GONE)).be.true();
    should(LINK_GONE.status).equal(410);
    should(JSON.parse(linkStoreRefusalBody('link_gone'))).deepEqual({
      error: { code: LINK_GONE.code, message: LINK_GONE.message },
    });
  });

  it('should limit fetches of one link a minute and a day, and start again after', () => {
    const minute = harness(limitsWith({ perLink: { fetchesPerMinute: 2 }, perIp: { fetchesPerMinute: 1000 } }));
    upload(minute);
    fetch(minute);
    fetch(minute);
    should(code(fetch(minute))).equal('link_rate_limited');
    should(code(fetch(minute, { now: T0 + MIN }))).equal('fetch');

    const day = harness(limitsWith({ perLink: { fetchesPerDay: 2 }, perIp: { fetchesPerMinute: 1000 } }));
    upload(day);
    fetch(day);
    fetch(day, { now: T0 + 2 * MIN });
    should(code(fetch(day, { now: T0 + 4 * MIN }))).equal('link_rate_limited');
    should(code(fetch(day, { now: T0 + DAY }))).equal('fetch');
  });

  it('should limit fetches across the store in a day', () => {
    const h = harness(limitsWith({ global: { fetchesPerDay: 2 }, perIp: { fetchesPerMinute: 1000 } }));
    upload(h, { bundleId: ID });
    upload(h, { bundleId: ID2, metadata: { fetchVerifier: b64(32, 2) } });
    fetch(h, { bundleId: ID });
    fetch(h, { bundleId: ID2, verifier: b64(32, 2) });
    should(code(fetch(h, { bundleId: ID }))).equal('link_store_capacity');
    should(code(fetch(h, { bundleId: ID, now: T0 + DAY }))).equal('fetch');
  });

  it('should limit requests from one address a minute, peeks and fetches alike', () => {
    const h = harness(limitsWith({ perIp: { fetchesPerMinute: 2 } }));
    upload(h);
    peek(h);
    fetch(h);
    should(code(fetch(h))).equal('link_rate_limited');
    should(code(peek(h))).equal('link_rate_limited');
    should(code(fetch(h, { ip: '10.0.0.2' }))).equal('fetch');
    should(code(fetch(h, { now: T0 + MIN }))).equal('fetch');
  });

  it('should limit wrong tokens per id, whether or not the id exists, so a 429 says nothing about it', () => {
    const h = harness(limitsWith({ perLink: { wrongTokensPerMinute: 2 }, perIp: { fetchesPerMinute: 1000 } }));
    upload(h);
    const unknown = b64(16, 9);
    for (const bundleId of [ID, unknown]) {
      should(fetch(h, { bundleId, verifier: b64(32, 8) })).equal(LINK_GONE);
      should(fetch(h, { bundleId, verifier: b64(32, 8) })).equal(LINK_GONE);
    }
    const real = fetch(h);
    const missing = fetch(h, { bundleId: unknown });
    should(real).deepEqual(missing);
    should(code(real)).equal('link_rate_limited');
    should(code(fetch(h, { now: T0 + MIN }))).equal('fetch');
    should(code(fetch(h, { bundleId: unknown, now: T0 + MIN }))).equal('link_gone');
  });
});

describe('the operator switches', () => {
  it('should stop serving without stopping new links, and the reverse', () => {
    const h = harness();
    upload(h);
    should(h.go({ type: 'operator', serving: false, now: T0 })).deepEqual({
      ok: true,
      kind: 'operator',
      available: true,
      serving: false,
    });
    should(code(fetch(h))).equal('link_store_unavailable');
    should(code(peek(h))).equal('link_store_unavailable');
    should(code(upload(h, { bundleId: ID2 }))).equal('stored');

    h.go({ type: 'operator', serving: true, available: false, now: T0 });
    should(code(upload(h, { bundleId: ID3 }))).equal('link_store_unavailable');
    should(code(fetch(h))).equal('fetch');
  });

  it('should take new limits without touching what is stored', () => {
    const h = harness();
    upload(h);
    h.go({ type: 'operator', limits: limitsWith({ perDaemon: { liveLinks: 1 } }), now: T0 });
    should(code(upload(h, { bundleId: ID2 }))).equal('link_store_full');
    should(statusOf(h)).match({ state: 'live' });
  });
});

describe('sweeping and metrics', () => {
  it('should end a live link at its notAfter, as lapsed unless the owner chose an end that has come', () => {
    const h = harness();
    upload(h, { bundleId: ID, metadata: { notAfter: iso(T0 + MIN) } });
    upload(h, { bundleId: ID2, metadata: { notAfter: iso(T0 + MIN), expiresAt: iso(T0 + MIN) } });
    upload(h, { bundleId: ID3, metadata: { notAfter: iso(T0 + MIN), expiresAt: iso(T0 + 2 * MIN) } });
    should(linkBundleAlarmAt(h.state(), ID)).equal(T0 + MIN);
    should(linkBundleAlarmAt(h.state(), b64(16, 9))).be.null();
    h.go({ type: 'alarm', now: T0 + MIN - 1 });
    should(statusOf(h, ID, OWNER, T0 + MIN - 1)).match({ state: 'live' });
    should(h.go({ type: 'alarm', now: T0 + MIN })).deepEqual({ ok: true, kind: 'alarm' });
    should(statusOf(h, ID, OWNER, T0 + MIN)).match({ state: 'lapsed', storedBytes: 0 });
    should(statusOf(h, ID2, OWNER, T0 + MIN)).match({ state: 'ended' });
    should(statusOf(h, ID3, OWNER, T0 + MIN)).match({ state: 'lapsed' });
    should(linkBundleAlarmAt(h.state(), ID)).equal(T0 + MIN + LINK_TOMBSTONE_MS);
  });

  it('should forget a tombstone when its date comes, and not before', () => {
    const h = harness();
    upload(h, { metadata: { notAfter: iso(T0 + MIN) } });
    h.go({ type: 'alarm', now: T0 + MIN });
    should(linkStoreMetrics(h.state()).tombstones).equal(1);
    h.go({ type: 'alarm', now: T0 + MIN + LINK_TOMBSTONE_MS - 1 });
    should(linkStoreMetrics(h.state()).tombstones).equal(1);
    h.go({ type: 'alarm', now: T0 + MIN + LINK_TOMBSTONE_MS });
    should(linkStoreMetrics(h.state()).tombstones).equal(0);
    should(statusOf(h, ID, OWNER, T0 + 31 * DAY)).deepEqual({ bundleId: ID, state: 'unknown' });
  });

  it('should keep a sweep pure: it neither mutates the state it is given nor changes a state with nothing due', () => {
    const h = harness();
    upload(h, { metadata: { notAfter: iso(T0 + MIN) } });
    const before = h.state();
    const swept = sweepLinkStore(before, T0 + 2 * MIN);
    should(before.bundles.get(ID)?.state).equal('live');
    should(swept.bundles.get(ID)?.state).equal('lapsed');
    should(before.owners.size).equal(1);
  });

  it('should count, and name nothing', () => {
    const h = harness();
    upload(h, { bundleId: ID });
    upload(h, { bundleId: ID2, bytes: 50, daemonId: OTHER });
    h.go({ type: 'delete', daemonId: OTHER, bundleId: ID2, now: T0 });
    const metrics = linkStoreMetrics(h.state());
    should(metrics).deepEqual({
      available: true,
      serving: true,
      owners: 2,
      liveLinks: 1,
      storedBytes: 100,
      tombstones: 1,
    });
    const text = JSON.stringify(metrics);
    for (const secret of [ID, OWNER, '10.0.0.1']) should(text).not.containEql(secret);
  });
});
