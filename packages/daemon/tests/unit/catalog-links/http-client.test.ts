import { describe, it } from 'bun:test';
import {
  decodeLinkUploadBody,
  fromBase64UrlFixed,
  LINK_STORE_CHALLENGE_PATH,
  LINK_STORE_SERVICE_PATH,
  LINK_STORE_STATUS_PATH,
  linkBundlePath,
  linkUploadSignedBody,
  NONCE_BYTES,
  verifyLinkStoreRequest,
  type DaemonIdentity,
  type LinkStoreRequestBody,
} from '@ferretry/relay';
import should from 'should';
import {
  HttpLinkStoreClient,
  type LinkStoreFetch,
} from '../../../src/adapters/catalog-links/http-link-store-client.ts';
import { crypto as relayCrypto, newIdentity } from '../../support/catalog-fixtures.ts';

const ORIGIN = 'https://links.example.test';
const BUNDLE = 'a'.repeat(22);
const NONCE = new Uint8Array(NONCE_BYTES).fill(7);
const nonceText = Buffer.from(NONCE).toString('base64url');
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refusal = (code: string, status = 409): Response => json({ error: { code, message: 'a sentence' } }, status);

interface Seen {
  readonly url: URL;
  readonly init: RequestInit;
}

/** A store: serves the advertisement and challenges, and runs `answer` on each signed call after verifying it. */
class FakeStore {
  readonly seen: Seen[] = [];
  readonly verdicts: boolean[] = [];
  advertisement: unknown = { version: 1, available: true, maxEnvelopeBytes: 1000, maxLiveLinks: 50 };
  challenge: unknown = { version: 1, nonce: nonceText, deadlineSeconds: 30 };
  challengeStatus = 200;
  answer: (url: URL) => Response = () => json({}, 200);
  throws = false;

  constructor(private readonly identity: DaemonIdentity) {}

  readonly fetcher: LinkStoreFetch = async (input, init = {}) => {
    const url = new URL(input);
    this.seen.push({ url, init });
    if (this.throws) throw new Error('offline');
    if (url.pathname === LINK_STORE_SERVICE_PATH) return json(this.advertisement);
    if (url.pathname === LINK_STORE_CHALLENGE_PATH) return json(this.challenge, this.challengeStatus);
    const body = await this.signedBody(url, init);
    const verdict = await verifyLinkStoreRequest(
      relayCrypto,
      { daemonId: this.identity.daemonId, host: url.host, nonce: NONCE, body: body.signed },
      body.fields,
    );
    this.verdicts.push(verdict.ok);
    return this.answer(url);
  };

  private async signedBody(url: URL, init: RequestInit) {
    if (init.method === 'PUT') {
      const decoded = await decodeLinkUploadBody(relayCrypto, init.body as Uint8Array);
      if (!decoded.ok) throw new Error('bad upload');
      const { metadata } = decoded;
      return {
        fields: metadata,
        signed: linkUploadSignedBody(url.pathname.split('/').pop() ?? '', metadata) as LinkStoreRequestBody,
      };
    }
    const parsed = JSON.parse(init.body as string) as { bundleIds?: string[] } & Record<string, string>;
    const fields = parsed as unknown as Parameters<typeof verifyLinkStoreRequest>[2];
    if (url.pathname === LINK_STORE_STATUS_PATH)
      return { fields, signed: { request: 'status', bundleIds: parsed.bundleIds ?? [] } as LinkStoreRequestBody };
    return {
      fields,
      signed: { request: 'delete', bundleId: url.pathname.split('/').pop() ?? '' } as LinkStoreRequestBody,
    };
  }
}

const rig = async (overrides: { identity?: boolean; timeoutMs?: number } = {}) => {
  const identity = await newIdentity();
  const store = new FakeStore(identity);
  const client = new HttpLinkStoreClient(
    relayCrypto,
    { identity: async () => (overrides.identity === false ? undefined : identity), publisherName: () => 'me' },
    { fetcher: store.fetcher, ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }) },
  );
  return { identity, store, client };
};

const UPLOAD = {
  bundleId: BUNDLE,
  action: 'create' as const,
  kind: 'public' as const,
  sequence: 1,
  notAfter: '2026-12-01T00:00:00.000Z',
  fetchVerifier: 'A'.repeat(43),
  envelope: new Uint8Array([1, 2, 3, 4]),
};

describe('HttpLinkStoreClient', () => {
  it('should read the advertisement without signing anything', async () => {
    const { client, store } = await rig();
    should(await client.available(ORIGIN)).equal(true);
    should(store.seen.map(s => s.url.pathname)).deepEqual([LINK_STORE_SERVICE_PATH]);
    const init = store.seen[0]?.init;
    should(init?.redirect).equal('error');
    should(init?.cache).equal('no-store');
    should(init?.signal).be.ok();
  });

  it('should say a store is not available when it says so, answers badly, or cannot be reached', async () => {
    const { client, store } = await rig();
    store.advertisement = { version: 1, available: false, maxEnvelopeBytes: 1, maxLiveLinks: 1 };
    should(await client.available(ORIGIN)).equal(false);
    store.advertisement = { nope: 1 };
    should(await client.available(ORIGIN)).equal(false);
    store.throws = true;
    should(await client.available(ORIGIN)).equal(false);
  });

  it('should upload a signed bundle: the signature covers this store host and the metadata', async () => {
    const { client, store } = await rig();
    should(
      await client.upload(ORIGIN, {
        ...UPLOAD,
        action: 'replace',
        sequence: 2,
        expectSequence: 1,
        expiresAt: '2026-12-02T00:00:00.000Z',
        installCap: 3,
      }),
    ).deepEqual({
      ok: true,
      value: undefined,
    });
    should(store.verdicts).deepEqual([true]);
    const put = store.seen.at(-1);
    should(put?.url.pathname).equal(linkBundlePath(BUNDLE));
    should(put?.init.method).equal('PUT');
    const decoded = await decodeLinkUploadBody(relayCrypto, put?.init.body as Uint8Array);
    should(decoded.ok && decoded.metadata.installCap).equal(3);
  });

  it('should upload with the optional fields left out', async () => {
    const { client, store } = await rig();
    should((await client.upload(ORIGIN, UPLOAD)).ok).equal(true);
    should(store.verdicts).deepEqual([true]);
  });

  it('should remove a bundle with a signed delete', async () => {
    const { client, store } = await rig();
    should((await client.remove(ORIGIN, BUNDLE)).ok).equal(true);
    should(store.verdicts).deepEqual([true]);
    should(store.seen.at(-1)?.init.method).equal('DELETE');
  });

  it('should read the status of several bundles', async () => {
    const { client, store } = await rig();
    store.answer = () => json({ version: 1, links: [{ bundleId: BUNDLE, state: 'live', opens: 2 }] });
    const answer = await client.status(ORIGIN, [BUNDLE]);
    should(answer.ok && answer.value.links[0]?.opens).equal(2);
    should(store.verdicts).deepEqual([true]);
    store.answer = () => json({ version: 1, links: 'x' });
    should(await client.status(ORIGIN, [BUNDLE])).deepEqual({ ok: false, reason: 'unreachable' });
    should(store.verdicts).deepEqual([true, true]);
  });

  it('should hand back the closed code of a refusal, and treat any other answer as unreachable', async () => {
    const { client, store } = await rig();
    store.answer = () => refusal('link_exists');
    should(await client.upload(ORIGIN, UPLOAD)).deepEqual({ ok: false, reason: 'refused', code: 'link_exists' });
    should(await client.remove(ORIGIN, BUNDLE)).deepEqual({ ok: false, reason: 'refused', code: 'link_exists' });
    store.answer = () => json({ error: { code: 'made_up', message: 'x' } }, 500);
    should(await client.remove(ORIGIN, BUNDLE)).deepEqual({ ok: false, reason: 'unreachable' });
    store.answer = () => new Response('<html>', { status: 502 });
    should(await client.status(ORIGIN, [BUNDLE])).deepEqual({ ok: false, reason: 'unreachable' });
  });

  it('should be unreachable when no signed call can be made', async () => {
    const none = await rig({ identity: false });
    should(await none.client.upload(ORIGIN, UPLOAD)).deepEqual({ ok: false, reason: 'unreachable' });
    should(none.store.seen).deepEqual([]);

    const { client, store } = await rig();
    store.challengeStatus = 429;
    should(await client.remove(ORIGIN, BUNDLE)).deepEqual({ ok: false, reason: 'unreachable' });
    store.challengeStatus = 200;
    store.challenge = { version: 1, nonce: 'short', deadlineSeconds: 30 };
    should(await client.remove(ORIGIN, BUNDLE)).deepEqual({ ok: false, reason: 'unreachable' });
    store.challenge = { version: 1, nonce: nonceText, deadlineSeconds: 30 };
    store.throws = true;
    should(await client.upload(ORIGIN, UPLOAD)).deepEqual({ ok: false, reason: 'unreachable' });
    should(fromBase64UrlFixed(nonceText, NONCE_BYTES)).be.ok();
  });

  it('should be unreachable when the signed call itself cannot be made', async () => {
    const identity = await newIdentity();
    const store = new FakeStore(identity);
    let calls = 0;
    const fetcher: LinkStoreFetch = async (input, init) => {
      calls += 1;
      if (calls > 1) throw new Error('dropped');
      return await store.fetcher(input, init);
    };
    const client = new HttpLinkStoreClient(
      relayCrypto,
      { identity: async () => identity, publisherName: () => 'me' },
      { fetcher },
    );
    should(await client.upload(ORIGIN, UPLOAD)).deepEqual({ ok: false, reason: 'unreachable' });
    calls = 0;
    should(await client.remove(ORIGIN, BUNDLE)).deepEqual({ ok: false, reason: 'unreachable' });
    calls = 0;
    should(await client.status(ORIGIN, [BUNDLE])).deepEqual({ ok: false, reason: 'unreachable' });
  });

  it('should refuse a body over 64 KiB, declared or streamed, and not buffer it', async () => {
    const { client, store } = await rig();
    const declared = new Response('{}', { status: 200, headers: { 'content-length': String(64 * 1024 + 1) } });
    store.answer = () => declared;
    should(await client.status(ORIGIN, [BUNDLE])).deepEqual({ ok: false, reason: 'unreachable' });
    should(declared.bodyUsed).equal(true);

    let pulled = 0;
    let cancelled = false;
    store.answer = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1;
            controller.enqueue(new Uint8Array(16 * 1024).fill(32));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      );
    should(await client.status(ORIGIN, [BUNDLE])).deepEqual({ ok: false, reason: 'unreachable' });
    should(cancelled).equal(true);
    should(pulled).be.below(10);

    store.answer = () => json({ error: { code: 'link_exists', message: 'x'.repeat(70_000) } }, 409);
    should(await client.remove(ORIGIN, BUNDLE)).deepEqual({ ok: false, reason: 'unreachable' });
  });

  it('should refuse an oversize advertisement or challenge, and a body that is not there', async () => {
    const identity = await newIdentity();
    const serve = (path: string, response: () => Response): HttpLinkStoreClient =>
      new HttpLinkStoreClient(
        relayCrypto,
        { identity: async () => identity, publisherName: () => 'me' },
        { fetcher: async input => (new URL(input).pathname === path ? response() : json({})) },
      );
    const big = (): Response => new Response(' '.repeat(70_000), { status: 200 });
    should(await serve(LINK_STORE_SERVICE_PATH, big).available(ORIGIN)).equal(false);
    should(await serve(LINK_STORE_SERVICE_PATH, () => new Response(null, { status: 200 })).available(ORIGIN)).equal(
      false,
    );
    should(await serve(LINK_STORE_CHALLENGE_PATH, big).remove(ORIGIN, BUNDLE)).deepEqual({
      ok: false,
      reason: 'unreachable',
    });
  });

  it('should give up on a body that stops arriving once the deadline passes', async () => {
    const identity = await newIdentity();
    const fetcher: LinkStoreFetch = async (_input, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"version":'));
            init?.signal?.addEventListener('abort', () => controller.error(new Error('timed out')));
          },
        }),
        { status: 200 },
      );
    const client = new HttpLinkStoreClient(
      relayCrypto,
      { identity: async () => identity, publisherName: () => 'me' },
      { fetcher, timeoutMs: 40 },
    );
    should(await client.available(ORIGIN)).equal(false);
  });

  it('should use the global fetch and its default deadline when none is given', async () => {
    const identity = await newIdentity();
    const client = new HttpLinkStoreClient(relayCrypto, { identity: async () => identity, publisherName: () => 'me' });
    const real = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (input: string) => {
      asked.push(String(input));
      return json({ version: 1, available: true, maxEnvelopeBytes: 1, maxLiveLinks: 1 });
    }) as unknown as typeof fetch;
    try {
      should(await client.available(ORIGIN)).equal(true);
    } finally {
      globalThis.fetch = real;
    }
    should(asked).deepEqual([`${ORIGIN}${LINK_STORE_SERVICE_PATH}`]);
  });
});
