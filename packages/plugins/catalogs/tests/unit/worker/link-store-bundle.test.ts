import { describe, it } from 'bun:test';
import {
  type BundleDoc,
  BundleDocSchema,
  type BundleEvent,
  chunkEnvelope,
  DEFAULT_LINK_STORE_LIMITS,
  LINK_GONE,
  type LinkUploadMetadata,
  reduceBundle,
  toBase64Url,
} from '../../../worker/lib/index.ts';
import should from 'should';

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-31T09:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const b64 = (length: number, fill: number) => toBase64Url(new Uint8Array(length).fill(fill));
const OWNER = `fy_daemon_${'A'.repeat(43)}`;
const ID = b64(16, 1);
const TOKEN = b64(32, 1);
const L = DEFAULT_LINK_STORE_LIMITS;
const BASE = 16_500;

const envelopeOf = (length: number, sequence: number) => {
  const bytes = new Uint8Array(length).fill(9);
  bytes.set(new TextEncoder().encode('FYL1'), 0);
  new DataView(bytes.buffer).setUint32(4, sequence, false);
  return bytes;
};
const meta = (changes: Partial<LinkUploadMetadata> = {}, bytes = BASE): LinkUploadMetadata =>
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

const upload = (changes: Partial<LinkUploadMetadata> = {}, length = BASE, now = T0): BundleEvent => ({
  type: 'upload',
  daemonId: OWNER,
  metadata: meta(changes, length),
  envelope: envelopeOf(length, changes.sequence ?? 1),
  now,
});
const run = (previous: BundleDoc | null, event: BundleEvent, stored: Uint8Array | null = null) =>
  reduceBundle(ID, previous, event, stored, L);
const live = (changes: Partial<LinkUploadMetadata> = {}, length = BASE) => {
  const step = run(null, upload(changes, length));
  if (step.doc === null) throw new Error(`upload refused: ${JSON.stringify(step.response)}`);
  return step.doc;
};

describe('upload', () => {
  it('should store a live document with its chunk count and the envelope to write', () => {
    const step = run(null, upload());
    should(step.response).containEql({ ok: true, kind: 'stored', sequence: 1 });
    should(step.doc?.row.state).equal('live');
    should(step.doc?.chunks).equal(chunkEnvelope(envelopeOf(BASE, 1)).length);
    should(step.envelope).be.instanceOf(Uint8Array);
    should(step.released).be.false();
    should(step.alarmAt).be.a.Number();
    should(BundleDocSchema.safeParse(step.doc).success).be.true();
  });

  it('should replace a live link with a higher sequence and keep it live', () => {
    const first = live();
    const step = run(first, upload({ action: 'replace', sequence: 2, expectSequence: 1 }));
    should(step.response).containEql({ ok: true, kind: 'stored', sequence: 2 });
    should(step.doc?.row.sequence).equal(2);
    should(step.released).be.false();
  });

  it('should refuse a bad upload, persisting nothing new and releasing nothing it never held', () => {
    const step = run(null, upload({ action: 'replace', sequence: 2, expectSequence: 1 }));
    should(step.response.ok).be.false();
    should(step.doc).be.null();
    should(step.envelope).be.null();
    should(step.released).be.false();
    should(step.alarmAt).be.null();
  });

  it('should keep the previous document when a refused upload leaves the link live', () => {
    const first = live();
    const step = run(first, upload({ action: 'replace', sequence: 1, expectSequence: 1 }));
    should(step.response.ok).be.false();
    should(step.doc?.row.state).equal('live');
    should(step.doc?.chunks).equal(first.chunks);
    should(step.envelope).equal('keep');
    should(step.released).be.false();
  });
});

describe('status and delete', () => {
  it('should report a live link and not change it', () => {
    const doc = live();
    const step = run(doc, { type: 'status', daemonId: OWNER, now: T0 + 1000 });
    should(step.response).containEql({ ok: true, kind: 'status' });
    should(step.doc?.row.state).equal('live');
    should(step.envelope).equal('keep');
    const link = step.response.ok && step.response.kind === 'status' ? step.response.status.links[0] : undefined;
    should(link).containEql({ state: 'live', storedBytes: doc.bytes });
    should(doc.bytes).be.above(0);
  });

  it('should end a link on delete, release its quota and delete the stored envelope', () => {
    const step = run(live(), { type: 'delete', daemonId: OWNER, now: T0 + 1000 });
    should(step.response).containEql({ ok: true, kind: 'deleted' });
    should(step.doc?.row.state).equal('ended');
    should(step.doc?.chunks).equal(0);
    should(step.envelope).be.null();
    should(step.released).be.true();
  });

  it('should answer status of a link that never existed without persisting anything', () => {
    const step = run(null, { type: 'status', daemonId: OWNER, now: T0 });
    should(step.response.ok).be.true();
    should(step.doc).be.null();
    should(step.released).be.false();
  });
});

describe('peek and fetch', () => {
  it('should peek at a live link without spending it', () => {
    const doc = live();
    const step = run(doc, { type: 'peek', tokenVerifier: TOKEN, now: T0 + 1000 });
    should(step.response).containEql({ ok: true, kind: 'peek' });
    should(step.doc?.row.state).equal('live');
    should(step.released).be.false();
  });

  it('should give a one-time link out once: used, released, envelope deleted', () => {
    const doc = live({ kind: 'one-time', notAfter: iso(T0 + DAY / 2) });
    const bytes = envelopeOf(BASE, 1);
    const step = run(doc, { type: 'fetch', tokenVerifier: TOKEN, now: T0 + 1000 }, bytes);
    should(step.response).containEql({ ok: true, kind: 'fetch', linkKind: 'one-time' });
    should(step.doc?.row.state).equal('used');
    should(step.doc?.chunks).equal(0);
    should(step.envelope).be.null();
    should(step.released).be.true();
    const again = run(step.doc, { type: 'fetch', tokenVerifier: TOKEN, now: T0 + 2000 });
    should(again.response).equal(LINK_GONE);
    should(again.released).be.false();
  });

  it('should hand a public link out repeatedly and keep its bytes', () => {
    const doc = live();
    const step = run(doc, { type: 'fetch', tokenVerifier: TOKEN, now: T0 + 1000 }, envelopeOf(BASE, 1));
    should(step.response).containEql({ ok: true, kind: 'fetch', linkKind: 'public' });
    should(step.doc?.row.state).equal('live');
    should(step.envelope).equal('keep');
    should(step.doc?.row.fetchTimes.length).equal(1);
  });

  it('should treat a missing stored envelope of a live link as empty rather than crash', () => {
    const step = run(live(), { type: 'peek', tokenVerifier: TOKEN, now: T0 + 1000 }, null);
    should(step.response.ok).be.true();
  });

  it('should not consume a one-time link on a wrong token, and remember the miss', () => {
    const doc = live({ kind: 'one-time', notAfter: iso(T0 + DAY / 2) });
    const step = run(doc, { type: 'fetch', tokenVerifier: b64(32, 7), now: T0 + 1000 });
    should(step.response).equal(LINK_GONE);
    should(step.doc?.row.state).equal('live');
    should(step.envelope).equal('keep');
    should(step.released).be.false();
    should(step.doc?.wrong.length).equal(1);
    const ok = run(step.doc, { type: 'fetch', tokenVerifier: TOKEN, now: T0 + 2000 }, envelopeOf(BASE, 1));
    should(ok.response).containEql({ ok: true, kind: 'fetch' });
  });

  it('should answer gone for a peek or fetch with no document, persisting nothing', () => {
    for (const type of ['peek', 'fetch'] as const) {
      const step = run(null, { type, tokenVerifier: TOKEN, now: T0 });
      should(step).deepEqual({ doc: null, envelope: null, response: LINK_GONE, released: false, alarmAt: null });
    }
  });
});

describe('alarm', () => {
  it('should leave a live link alone before its end and wake again at it', () => {
    const doc = live();
    const step = run(doc, { type: 'alarm', now: T0 + 1000 });
    should(step.response).containEql({ ok: true, kind: 'alarm' });
    should(step.doc?.row.state).equal('live');
    should(step.envelope).equal('keep');
    should(step.released).be.false();
    should(step.alarmAt).be.a.Number();
  });

  it('should lapse a link past its end, release its quota and drop its envelope', () => {
    const doc = live();
    const step = run(doc, { type: 'alarm', now: T0 + 8 * DAY });
    should(step.doc?.row.state).equal('lapsed');
    should(step.doc?.chunks).equal(0);
    should(step.envelope).be.null();
    should(step.released).be.true();
  });

  it('should forget a link once its tombstone is due, with nothing left to wake for', () => {
    const lapsed = run(live(), { type: 'alarm', now: T0 + 8 * DAY }).doc;
    const step = run(lapsed, { type: 'alarm', now: T0 + 8 * DAY + 31 * DAY });
    should(step.doc).be.null();
    should(step.envelope).be.null();
    should(step.released).be.false();
    should(step.alarmAt).be.null();
  });

  it('should do nothing for a link it has no document for', () => {
    const step = run(null, { type: 'alarm', now: T0 });
    should(step.doc).be.null();
    should(step.released).be.false();
    should(step.alarmAt).be.null();
  });
});

describe('BundleDocSchema', () => {
  it('should accept a stored document, with or without the optional row keys', () => {
    const doc = live();
    should(BundleDocSchema.safeParse(doc).success).be.true();
    const withBoth = { ...doc, row: { ...doc.row, expiresAt: iso(T0 + DAY), installCap: 3 } };
    should(BundleDocSchema.safeParse(withBoth).success).be.true();
    const undef = { ...doc, row: { ...doc.row, expiresAt: undefined, installCap: undefined } };
    should(BundleDocSchema.safeParse(undef).success).be.true();
  });

  it('should refuse extra keys, a bad state, a negative count and a missing part', () => {
    const doc = live();
    should(BundleDocSchema.safeParse({ ...doc, extra: 1 }).success).be.false();
    should(BundleDocSchema.safeParse({ ...doc, row: { ...doc.row, extra: 1 } }).success).be.false();
    should(BundleDocSchema.safeParse({ ...doc, row: { ...doc.row, state: 'gone' } }).success).be.false();
    should(BundleDocSchema.safeParse({ ...doc, row: { ...doc.row, sequence: 0 } }).success).be.false();
    should(BundleDocSchema.safeParse({ ...doc, row: { ...doc.row, installCap: 0 } }).success).be.false();
    should(BundleDocSchema.safeParse({ ...doc, chunks: -1 }).success).be.false();
    should(BundleDocSchema.safeParse({ row: doc.row, chunks: 1 }).success).be.false();
    should(BundleDocSchema.safeParse(null).success).be.false();
  });
});
