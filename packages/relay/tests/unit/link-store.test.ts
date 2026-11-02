import { describe, it } from 'bun:test';
import {
  decodeLinkUploadBody,
  encodeLinkUploadBody,
  LINK_ENVELOPE_MAX_BYTES,
  LINK_GONE_SENTENCE,
  LINK_STORE_DELETE_LABEL,
  LINK_STORE_REFUSAL_DETAIL,
  LINK_STORE_REFUSALS,
  LINK_STORE_STATUS_LABEL,
  LINK_STORE_UPLOAD_LABEL,
  LINK_UPLOAD_METADATA_MAX_BYTES,
  type LinkStoreRequestBody,
  type LinkStoreRequestContext,
  LinkDeleteRequestSchema,
  LinkFetchRequestSchema,
  LinkPeekSchema,
  LinkStatusRequestSchema,
  LinkStatusSchema,
  LinkStoreAdvertisementSchema,
  LinkStoreChallengeRequestSchema,
  LinkStoreChallengeSchema,
  LinkStoreRefusalSchema,
  type LinkUploadMetadata,
  LinkUploadMetadataSchema,
  linkBundlePath,
  linkFetchPath,
  linkPeekPath,
  linkStoreRefusalBody,
  linkStoreTranscript,
  linkUploadSignedBody,
  signLinkStoreRequest,
  toBase64Url,
  utf8Bytes,
  verifyLinkStoreRequest,
  writeUint32,
} from '@ferretry/relay';
import should from 'should';
import { newDaemonIdentity, relayCrypto } from '../support/identities.ts';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const b64 = (length: number, fill = 1) => toBase64Url(new Uint8Array(length).fill(fill));
const BUNDLE = b64(16, 5);
const NOT_AFTER = '2026-11-07T09:00:00.000Z';
const NONCE = new Uint8Array(32).fill(7);
const DAEMON = `fy_daemon_${'A'.repeat(43)}`;

const metadata = (changes: Record<string, unknown> = {}, daemonId = DAEMON) => ({
  daemonId,
  publicKey: b64(44, 2),
  nonce: toBase64Url(NONCE),
  signature: b64(64, 3),
  action: 'create',
  kind: 'public',
  sequence: 1,
  notAfter: NOT_AFTER,
  fetchVerifier: b64(32, 4),
  envelopeSha256: b64(32, 6),
  envelopeBytes: 16420,
  ...changes,
});

describe('transcripts', () => {
  const host = 'store.example';
  const context = (body: LinkStoreRequestBody): LinkStoreRequestContext => ({
    daemonId: 'daemon-1',
    host,
    nonce: NONCE,
    body,
  });
  const upload = (
    changes: Partial<Extract<LinkStoreRequestBody, { request: 'upload' }>> = {},
  ): LinkStoreRequestBody => ({
    request: 'upload',
    bundleId: 'BUNDLE',
    action: 'replace',
    kind: 'public',
    sequence: 4,
    expectSequence: 3,
    notAfter: NOT_AFTER,
    expiresAt: '2026-11-08T09:00:00.000Z',
    installCap: 25,
    fetchVerifier: 'VERIFIER',
    envelopeSha256: 'SHA',
    envelopeBytes: 16420,
    ...changes,
  });
  const digestOf = async (body: LinkStoreRequestBody) =>
    hex(await relayCrypto.sha256(linkStoreTranscript(context(body))));

  it('should match fixed vectors for upload, delete and status', async () => {
    should(await digestOf(upload())).equal('040a906036d8428a729315d672671f6cbcdadf406cb187052d5d22e292a9dde6');
    should(
      await digestOf({
        request: 'upload',
        bundleId: 'BUNDLE',
        action: 'create',
        kind: 'one-time',
        sequence: 1,
        notAfter: NOT_AFTER,
        fetchVerifier: 'VERIFIER',
        envelopeSha256: 'SHA',
        envelopeBytes: 16420,
      }),
    ).equal('6f6263872602c0cb9aa03629af18fb2071dadd8cdbb11181d59c5514806a1cdd');
    should(await digestOf({ request: 'delete', bundleId: 'BUNDLE' })).equal(
      '374c10d27418b88fe18d0981650bb2322080f87ab48a07d2143c313b95723659',
    );
    should(await digestOf({ request: 'status', bundleIds: ['BBB', 'AAA'] })).equal(
      'd041673785a011b2f57bf62dbaed33098aa48fcafbc4d8d25c8fbde96d1f7f24',
    );
  });

  it('should start each action with its own label', () => {
    const starts = (body: LinkStoreRequestBody, label: string) =>
      should(
        Buffer.from(linkStoreTranscript(context(body)))
          .subarray(0, label.length)
          .toString(),
      ).equal(label);
    starts(upload(), LINK_STORE_UPLOAD_LABEL);
    starts({ request: 'delete', bundleId: 'BUNDLE' }, LINK_STORE_DELETE_LABEL);
    starts({ request: 'status', bundleIds: ['A'] }, LINK_STORE_STATUS_LABEL);
    should(new Set([LINK_STORE_UPLOAD_LABEL, LINK_STORE_DELETE_LABEL, LINK_STORE_STATUS_LABEL]).size).equal(3);
  });

  it('should change when any one field of an upload changes', async () => {
    const base = await digestOf(upload());
    const changes: Partial<Extract<LinkStoreRequestBody, { request: 'upload' }>>[] = [
      { bundleId: 'OTHER' },
      { action: 'create' },
      { kind: 'one-time' },
      { sequence: 5 },
      { expectSequence: 2 },
      { notAfter: '2026-11-07T09:00:00.001Z' },
      { expiresAt: '2026-11-09T09:00:00.000Z' },
      { installCap: 26 },
      { fetchVerifier: 'OTHER' },
      { envelopeSha256: 'OTHER' },
      { envelopeBytes: 32804 },
    ];
    for (const change of changes) should(await digestOf(upload(change))).not.equal(base);
    const {
      expectSequence: _e,
      expiresAt: _x,
      installCap: _i,
      ...bare
    } = upload() as Extract<LinkStoreRequestBody, { request: 'upload' }>;
    should(await digestOf(bare)).not.equal(base);
  });

  it('should change when the daemon, the store host or the nonce changes, and when a byte moves between fields', async () => {
    const body = upload();
    const base = hex(linkStoreTranscript(context(body)));
    should(hex(linkStoreTranscript({ ...context(body), daemonId: 'daemon-2' }))).not.equal(base);
    should(hex(linkStoreTranscript({ ...context(body), host: 'other.example' }))).not.equal(base);
    should(hex(linkStoreTranscript({ ...context(body), nonce: new Uint8Array(32).fill(8) }))).not.equal(base);
    should(hex(linkStoreTranscript(context(upload({ fetchVerifier: 'VERIFIE', envelopeSha256: 'RSHA' }))))).not.equal(
      hex(linkStoreTranscript(context(upload()))),
    );
  });

  it('should not care what order the ids of a status call come in, but care which ids', async () => {
    const one = await digestOf({ request: 'status', bundleIds: ['AAA', 'BBB'] });
    should(await digestOf({ request: 'status', bundleIds: ['BBB', 'AAA'] })).equal(one);
    should(await digestOf({ request: 'status', bundleIds: ['AAA'] })).not.equal(one);
    should(await digestOf({ request: 'status', bundleIds: ['AAA', 'BBB', 'CCC'] })).not.equal(one);
  });

  it('should keep an upload from being replayed as a delete or a status', async () => {
    const delta = await digestOf({ request: 'delete', bundleId: 'BUNDLE' });
    const status = await digestOf({ request: 'status', bundleIds: ['BUNDLE'] });
    should(delta).not.equal(status);
  });
});

describe('signing and verifying a request', () => {
  const body: LinkStoreRequestBody = { request: 'delete', bundleId: BUNDLE };

  async function signed() {
    const identity = await newDaemonIdentity();
    const context: LinkStoreRequestContext = { daemonId: identity.daemonId, host: 'store.example', nonce: NONCE, body };
    return { identity, context, request: await signLinkStoreRequest(relayCrypto, identity, context) };
  }

  it('should verify a request the daemon signed for this store, this nonce and this body', async () => {
    const { context, request } = await signed();
    should(request.nonce).equal(toBase64Url(NONCE));
    should(await verifyLinkStoreRequest(relayCrypto, context, request)).deepEqual({ ok: true });
  });

  it('should refuse it at another host, with another nonce, or for another body', async () => {
    const { context, request } = await signed();
    const refused = async (changed: LinkStoreRequestContext, sent = request) =>
      (await verifyLinkStoreRequest(relayCrypto, changed, sent)).ok;
    should(await refused({ ...context, host: 'other.example' })).be.false();
    should(await refused({ ...context, nonce: new Uint8Array(32).fill(9) })).be.false();
    should(await refused({ ...context, body: { request: 'delete', bundleId: b64(16, 9) } })).be.false();
    should(await refused({ ...context, body: { request: 'status', bundleIds: [BUNDLE] } })).be.false();
  });

  it('should say why it refused', async () => {
    const { context, request } = await signed();
    const stranger = await newDaemonIdentity();
    const verdict = (changed: Partial<typeof request>, ctx = context) =>
      verifyLinkStoreRequest(relayCrypto, ctx, { ...request, ...changed });
    should(await verdict({ publicKey: 'AAAA' })).deepEqual({ ok: false, reason: 'key or signature is malformed' });
    should(await verdict({ signature: 'AAAA' })).deepEqual({ ok: false, reason: 'key or signature is malformed' });
    should(await verdict({ daemonId: stranger.daemonId })).deepEqual({
      ok: false,
      reason: 'fingerprint does not match the challenge',
    });
    should(await verdict({ nonce: toBase64Url(new Uint8Array(32).fill(1)) })).deepEqual({
      ok: false,
      reason: 'nonce does not match the challenge',
    });
    should(await verdict({ publicKey: toBase64Url(stranger.publicKeySpki) })).deepEqual({
      ok: false,
      reason: 'public key does not match the fingerprint',
    });
    const flipped = Buffer.from(request.signature, 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    should(await verdict({ signature: flipped.toString('base64url') })).deepEqual({
      ok: false,
      reason: 'signature failed',
    });
  });

  it('should build the signed body of a parsed upload from only the fields the transcript covers', () => {
    const parsed = LinkUploadMetadataSchema.parse(
      metadata({ action: 'replace', sequence: 4, expectSequence: 3, expiresAt: NOT_AFTER, installCap: 25 }),
    );
    should(linkUploadSignedBody('BUNDLE', parsed)).deepEqual({
      request: 'upload',
      bundleId: 'BUNDLE',
      action: 'replace',
      kind: 'public',
      sequence: 4,
      expectSequence: 3,
      notAfter: NOT_AFTER,
      expiresAt: NOT_AFTER,
      installCap: 25,
      fetchVerifier: parsed.fetchVerifier,
      envelopeSha256: parsed.envelopeSha256,
      envelopeBytes: 16420,
    });
    const bare = linkUploadSignedBody('BUNDLE', LinkUploadMetadataSchema.parse(metadata()));
    should(Object.keys(bare)).not.containEql('expectSequence');
    should(Object.keys(bare)).not.containEql('expiresAt');
    should(Object.keys(bare)).not.containEql('installCap');
  });
});

describe('paths', () => {
  it('should spell the three per-link paths from the bundle id', () => {
    should(linkBundlePath('abc')).equal('/v1/links/abc');
    should(linkPeekPath('abc')).equal('/v1/links/abc/peek');
    should(linkFetchPath('abc')).equal('/v1/links/abc/fetch');
  });
});

describe('the upload metadata schema', () => {
  const accepts = (value: unknown) => LinkUploadMetadataSchema.safeParse(value).success;
  const daemon = async () => (await newDaemonIdentity()).daemonId;

  it('should accept a create, a replace, a one-time link and a bounded cap', async () => {
    const id = await daemon();
    should(accepts(metadata({}, id))).be.true();
    should(accepts(metadata({ action: 'replace', sequence: 2, expectSequence: 1 }, id))).be.true();
    should(accepts(metadata({ kind: 'one-time', expiresAt: NOT_AFTER }, id))).be.true();
    should(accepts(metadata({ installCap: 10_000, expiresAt: NOT_AFTER }, id))).be.true();
  });

  it('should refuse the rules of an upload: create, replace, one-time and end', async () => {
    const id = await daemon();
    const refused: Record<string, unknown>[] = [
      { expectSequence: 1 },
      { action: 'replace' },
      { action: 'replace', sequence: 1, expectSequence: 1 },
      { action: 'replace', sequence: 2, expectSequence: 3 },
      { action: 'replace', sequence: 2, expectSequence: 1, kind: 'one-time' },
      { kind: 'one-time', sequence: 2 },
      { kind: 'one-time', installCap: 5 },
      { expiresAt: '2026-11-07T08:59:59.999Z' },
      { installCap: 0 },
      { installCap: 10_001 },
      { sequence: 0 },
      { sequence: 0x1_0000_0000 },
      { envelopeBytes: 0 },
      { envelopeBytes: LINK_ENVELOPE_MAX_BYTES + 1 },
      { fetchVerifier: 'short' },
      { envelopeSha256: 'short' },
      { publicKey: 'short' },
      { signature: 'short' },
      { nonce: 'short' },
      { daemonId: 'nonsense' },
      { notAfter: 'tomorrow' },
      { kind: 'forever' },
      { action: 'upsert' },
      { extra: 1 },
    ];
    for (const change of refused) should(accepts(metadata(change, id))).be.false();
    should(accepts({ ...metadata({}, id), daemonId: undefined })).be.false();
  });
});

describe('the other wire schemas', () => {
  const id = async () => (await newDaemonIdentity()).daemonId;

  it('should accept or refuse an advertisement', () => {
    const good = { version: 1, available: true, maxEnvelopeBytes: 3_145_728, maxLiveLinks: 50 };
    should(LinkStoreAdvertisementSchema.safeParse(good).success).be.true();
    should(LinkStoreAdvertisementSchema.safeParse({ ...good, available: false }).success).be.true();
    for (const bad of [{ ...good, version: 2 }, { ...good, maxLiveLinks: 0 }, { ...good, extra: 1 }, { version: 1 }])
      should(LinkStoreAdvertisementSchema.safeParse(bad).success).be.false();
  });

  it('should accept or refuse a challenge request and a challenge', async () => {
    should(LinkStoreChallengeRequestSchema.safeParse({ daemonId: await id() }).success).be.true();
    should(LinkStoreChallengeRequestSchema.safeParse({ daemonId: 'x' }).success).be.false();
    should(LinkStoreChallengeRequestSchema.safeParse({ daemonId: await id(), extra: 1 }).success).be.false();
    const good = { version: 1, nonce: toBase64Url(NONCE), deadlineSeconds: 60 };
    should(LinkStoreChallengeSchema.safeParse(good).success).be.true();
    for (const bad of [
      { ...good, deadlineSeconds: 61 },
      { ...good, deadlineSeconds: 0 },
      { ...good, nonce: 'short' },
      { ...good, version: 2 },
    ])
      should(LinkStoreChallengeSchema.safeParse(bad).success).be.false();
  });

  it('should accept or refuse a delete and a status request', async () => {
    const signed = { daemonId: await id(), publicKey: b64(44), nonce: toBase64Url(NONCE), signature: b64(64) };
    should(LinkDeleteRequestSchema.safeParse(signed).success).be.true();
    should(LinkDeleteRequestSchema.safeParse({ ...signed, bundleId: BUNDLE }).success).be.false();
    should(LinkStatusRequestSchema.safeParse({ ...signed, bundleIds: [BUNDLE] }).success).be.true();
    should(LinkStatusRequestSchema.safeParse({ ...signed, bundleIds: Array(64).fill(BUNDLE) }).success).be.true();
    should(LinkStatusRequestSchema.safeParse({ ...signed, bundleIds: [] }).success).be.false();
    should(LinkStatusRequestSchema.safeParse({ ...signed, bundleIds: Array(65).fill(BUNDLE) }).success).be.false();
    should(LinkStatusRequestSchema.safeParse({ ...signed, bundleIds: ['nope'] }).success).be.false();
  });

  it('should accept or refuse a status answer, a fetch request and a peek', () => {
    const row = {
      bundleId: BUNDLE,
      state: 'live',
      kind: 'public',
      sequence: 2,
      opens: 0,
      notAfter: NOT_AFTER,
      storedBytes: 16420,
    };
    should(
      LinkStatusSchema.safeParse({ version: 1, links: [row, { bundleId: BUNDLE, state: 'unknown' }] }).success,
    ).be.true();
    should(LinkStatusSchema.safeParse({ version: 1, links: [{ ...row, state: 'gone' }] }).success).be.false();
    should(LinkStatusSchema.safeParse({ version: 1, links: [{ ...row, secret: 1 }] }).success).be.false();
    should(LinkStatusSchema.safeParse({ version: 1, links: [{ ...row, sequence: 0x1_0000_0000 }] }).success).be.false();
    should(LinkFetchRequestSchema.safeParse({ token: b64(32) }).success).be.true();
    should(LinkFetchRequestSchema.safeParse({ token: b64(31) }).success).be.false();
    should(LinkFetchRequestSchema.safeParse({ token: b64(32), extra: 1 }).success).be.false();
    should(LinkPeekSchema.safeParse({ version: 1, kind: 'one-time' }).success).be.true();
    should(LinkPeekSchema.safeParse({ version: 1, kind: 'public', expiresAt: NOT_AFTER }).success).be.true();
    should(LinkPeekSchema.safeParse({ version: 1, kind: 'public', opens: 3 }).success).be.false();
  });
});

describe('refusals', () => {
  it('should carry a status and a sentence for every code, and the sentence is what the body says', () => {
    for (const code of LINK_STORE_REFUSALS) {
      const detail = LINK_STORE_REFUSAL_DETAIL[code];
      should(detail.status).be.within(400, 503);
      const body = JSON.parse(linkStoreRefusalBody(code));
      should(LinkStoreRefusalSchema.safeParse(body).success).be.true();
      should(body).deepEqual({ error: { code, message: detail.message } });
    }
    should(Object.keys(LINK_STORE_REFUSAL_DETAIL).sort()).deepEqual([...LINK_STORE_REFUSALS].sort());
  });

  it('should make the gone refusal the one 410 and its sentence the published one', () => {
    should(LINK_STORE_REFUSAL_DETAIL.link_gone).deepEqual({ status: 410, message: LINK_GONE_SENTENCE });
    should(LINK_STORE_REFUSALS.filter(code => LINK_STORE_REFUSAL_DETAIL[code].status === 410)).deepEqual(['link_gone']);
    should(linkStoreRefusalBody('link_gone')).equal(linkStoreRefusalBody('link_gone'));
  });

  it('should refuse a refusal body that is not one', () => {
    should(LinkStoreRefusalSchema.safeParse({ error: { code: 'link_gone', message: '' } }).success).be.false();
    should(LinkStoreRefusalSchema.safeParse({ error: { code: 'who_knows', message: 'x' } }).success).be.false();
  });
});

describe('the upload body', () => {
  async function body(envelope: Uint8Array, changes: Record<string, unknown> = {}) {
    const parsed = LinkUploadMetadataSchema.parse(
      metadata({
        envelopeBytes: envelope.length,
        envelopeSha256: toBase64Url(await relayCrypto.sha256(envelope)),
        ...changes,
      }),
    ) as LinkUploadMetadata;
    return { parsed, bytes: encodeLinkUploadBody(parsed, envelope) };
  }
  const envelope = new Uint8Array(1000).map((_, index) => index % 251);

  it('should round-trip metadata and envelope', async () => {
    const { parsed, bytes } = await body(envelope);
    const decoded = await decodeLinkUploadBody(relayCrypto, bytes);
    should(decoded).match({ ok: true });
    should(decoded.ok && decoded.metadata).deepEqual(parsed);
    should(decoded.ok && [...decoded.envelope]).deepEqual([...envelope]);
  });

  it('should refuse a body that is too big before it reads any of it', async () => {
    const big = new Uint8Array(LINK_UPLOAD_METADATA_MAX_BYTES + 4 + LINK_ENVELOPE_MAX_BYTES + 1);
    should(await decodeLinkUploadBody(relayCrypto, big)).deepEqual({ ok: false, reason: 'too_big' });
  });

  it('should refuse a body that is short, mis-framed or whose metadata is not metadata', async () => {
    const malformed = { ok: false, reason: 'malformed' };
    should(await decodeLinkUploadBody(relayCrypto, new Uint8Array(3))).deepEqual(malformed);
    const framed = (length: number, text: Uint8Array) => {
      const out = new Uint8Array(4 + text.length);
      writeUint32(out, 0, length);
      out.set(text, 4);
      return out;
    };
    const json = utf8Bytes('{"a":1}');
    should(await decodeLinkUploadBody(relayCrypto, framed(1, json))).deepEqual(malformed);
    should(await decodeLinkUploadBody(relayCrypto, framed(LINK_UPLOAD_METADATA_MAX_BYTES + 1, json))).deepEqual(
      malformed,
    );
    should(await decodeLinkUploadBody(relayCrypto, framed(json.length + 50, json))).deepEqual(malformed);
    should(await decodeLinkUploadBody(relayCrypto, framed(3, new Uint8Array([0xff, 0xfe, 0xfd])))).deepEqual(malformed);
    should(await decodeLinkUploadBody(relayCrypto, framed(json.length, utf8Bytes('{not json')))).deepEqual(malformed);
    should(await decodeLinkUploadBody(relayCrypto, framed(json.length, json))).deepEqual(malformed);
  });

  it('should refuse an envelope that is not the length or the hash the signed metadata names', async () => {
    const { bytes } = await body(envelope);
    should(await decodeLinkUploadBody(relayCrypto, bytes.subarray(0, bytes.length - 1))).deepEqual({
      ok: false,
      reason: 'malformed',
    });
    should(await decodeLinkUploadBody(relayCrypto, new Uint8Array([...bytes, 0]))).deepEqual({
      ok: false,
      reason: 'malformed',
    });
    const swapped = bytes.slice();
    swapped[swapped.length - 1] = (swapped.at(-1) ?? 0) ^ 1;
    should(await decodeLinkUploadBody(relayCrypto, swapped)).deepEqual({ ok: false, reason: 'malformed' });
  });
});
