import { afterAll, beforeAll, describe, it } from 'bun:test';
import {
  decodeLinkUploadBody,
  LINK_STORE_CHALLENGE_PATH,
  LINK_STORE_SERVICE_PATH,
  LINK_STORE_STATUS_PATH,
  linkUploadSignedBody,
  NONCE_BYTES,
  verifyLinkStoreRequest,
  type DaemonIdentity,
  type LinkStoreRequestBody,
} from '@ferretry/relay';
import should from 'should';
import { HttpLinkStoreClient } from '../../../src/adapters/catalog-links/http-link-store-client.ts';
import { ConfiguredLinkStoreLocator } from '../../../src/adapters/catalog-links/link-store-locator.ts';
import { crypto as relayCrypto, newIdentity } from '../../support/catalog-fixtures.ts';

/**
 * The store client and the locator over real HTTP, against a fake link store on this machine's loopback. The store
 * checks every signed call against the host it was reached at, as the real one does, and answers what a test sets.
 */

const BUNDLE = 'a'.repeat(22);
const NONCE = new Uint8Array(NONCE_BYTES).fill(7);
const nonceText = Buffer.from(NONCE).toString('base64url');
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const UPLOAD = {
  bundleId: BUNDLE,
  action: 'create' as const,
  kind: 'public' as const,
  sequence: 1,
  notAfter: '2026-12-01T00:00:00.000Z',
  fetchVerifier: 'A'.repeat(43),
  envelope: new Uint8Array([1, 2, 3, 4]),
};

const behaviour = {
  advertisement: { version: 1, available: true, maxEnvelopeBytes: 1000, maxLiveLinks: 50 } as unknown,
  challenge: { version: 1, nonce: nonceText, deadlineSeconds: 30 } as unknown,
  challengeStatus: 200,
  answer: (): Response => json({}, 200),
  redirect: false,
  redirectCalls: false,
};
const verdicts: boolean[] = [];

let identity: DaemonIdentity;
let server: ReturnType<typeof Bun.serve>;
let origin: string;

async function signed(request: Request, url: URL) {
  if (request.method === 'PUT') {
    const decoded = await decodeLinkUploadBody(relayCrypto, new Uint8Array(await request.arrayBuffer()));
    if (!decoded.ok) throw new Error('bad upload');
    return {
      fields: decoded.metadata,
      body: linkUploadSignedBody(url.pathname.split('/').pop() ?? '', decoded.metadata) as LinkStoreRequestBody,
    };
  }
  const parsed = (await request.json()) as { bundleIds?: string[] } & Record<string, string>;
  const fields = parsed as unknown as Parameters<typeof verifyLinkStoreRequest>[2];
  return url.pathname === LINK_STORE_STATUS_PATH
    ? { fields, body: { request: 'status', bundleIds: parsed.bundleIds ?? [] } as LinkStoreRequestBody }
    : { fields, body: { request: 'delete', bundleId: url.pathname.split('/').pop() ?? '' } as LinkStoreRequestBody };
}

beforeAll(async () => {
  identity = await newIdentity();
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const url = new URL(request.url);
      if (behaviour.redirect) return new Response(null, { status: 302, headers: { location: '/elsewhere' } });
      if (url.pathname === LINK_STORE_SERVICE_PATH) return json(behaviour.advertisement);
      if (url.pathname === LINK_STORE_CHALLENGE_PATH) return json(behaviour.challenge, behaviour.challengeStatus);
      if (behaviour.redirectCalls) return new Response(null, { status: 302, headers: { location: '/elsewhere' } });
      const call = await signed(request, url);
      const verdict = await verifyLinkStoreRequest(
        relayCrypto,
        { daemonId: identity.daemonId, host: url.host, nonce: NONCE, body: call.body },
        call.fields,
      );
      verdicts.push(verdict.ok);
      return behaviour.answer();
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
});

const reset = () => {
  verdicts.length = 0;
  behaviour.advertisement = { version: 1, available: true, maxEnvelopeBytes: 1000, maxLiveLinks: 50 };
  behaviour.challenge = { version: 1, nonce: nonceText, deadlineSeconds: 30 };
  behaviour.challengeStatus = 200;
  behaviour.answer = () => json({}, 200);
  behaviour.redirect = false;
  behaviour.redirectCalls = false;
};

const clientFor = (withIdentity = true) =>
  new HttpLinkStoreClient(relayCrypto, {
    identity: async () => (withIdentity ? identity : undefined),
    publisherName: () => 'me',
  });

describe('HttpLinkStoreClient over HTTP', () => {
  it('should read the advertisement, and say no when the store says no, answers badly, or is not JSON', async () => {
    reset();
    const client = clientFor();
    should(await client.available(origin)).equal(true);
    behaviour.advertisement = { version: 1, available: false, maxEnvelopeBytes: 1, maxLiveLinks: 1 };
    should(await client.available(origin)).equal(false);
    behaviour.advertisement = { nope: 1 };
    should(await client.available(origin)).equal(false);
    behaviour.redirect = true;
    should(await client.available(origin)).equal(false);
  });

  it('should treat a body that is not JSON as no answer', async () => {
    reset();
    const html = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<html>', { status: 200 }) });
    try {
      should(await clientFor().available(`http://127.0.0.1:${html.port}`)).equal(false);
    } finally {
      await html.stop(true);
    }
  });

  it('should upload, remove and read the status with calls the store verifies for its own host', async () => {
    reset();
    const client = clientFor();
    should(
      await client.upload(origin, {
        ...UPLOAD,
        action: 'replace',
        sequence: 2,
        expectSequence: 1,
        expiresAt: '2026-12-02T00:00:00.000Z',
        installCap: 3,
      }),
    ).deepEqual({ ok: true, value: undefined });
    should((await client.upload(origin, UPLOAD)).ok).equal(true);
    should((await client.remove(origin, BUNDLE)).ok).equal(true);
    behaviour.answer = () => json({ version: 1, links: [{ bundleId: BUNDLE, state: 'live', opens: 2 }] });
    const status = await client.status(origin, [BUNDLE]);
    should(status.ok && status.value.links[0]?.opens).equal(2);
    behaviour.answer = () => json({ version: 1, links: 'x' });
    should(await client.status(origin, [BUNDLE])).deepEqual({ ok: false, reason: 'unreachable' });
    should(verdicts).deepEqual([true, true, true, true, true]);
  });

  it('should hand back a refusal code, and call any other failing answer unreachable', async () => {
    reset();
    const client = clientFor();
    behaviour.answer = () => json({ error: { code: 'link_exists', message: 'a sentence' } }, 409);
    should(await client.upload(origin, UPLOAD)).deepEqual({ ok: false, reason: 'refused', code: 'link_exists' });
    should(await client.remove(origin, BUNDLE)).deepEqual({ ok: false, reason: 'refused', code: 'link_exists' });
    behaviour.answer = () => json({ error: { code: 'made_up', message: 'x' } }, 500);
    should(await client.remove(origin, BUNDLE)).deepEqual({ ok: false, reason: 'unreachable' });
    behaviour.answer = () => new Response('<html>', { status: 502 });
    should(await client.status(origin, [BUNDLE])).deepEqual({ ok: false, reason: 'unreachable' });
  });

  it('should be unreachable when it cannot sign, cannot get a challenge, or is redirected', async () => {
    reset();
    should(await clientFor(false).upload(origin, UPLOAD)).deepEqual({ ok: false, reason: 'unreachable' });
    const client = clientFor();
    behaviour.challengeStatus = 429;
    should(await client.remove(origin, BUNDLE)).deepEqual({ ok: false, reason: 'unreachable' });
    behaviour.challengeStatus = 200;
    behaviour.challenge = { version: 1, nonce: 'short', deadlineSeconds: 30 };
    should(await client.remove(origin, BUNDLE)).deepEqual({ ok: false, reason: 'unreachable' });
    behaviour.challenge = { version: 1, nonce: nonceText, deadlineSeconds: 30 };
    behaviour.redirect = true;
    should(await client.upload(origin, UPLOAD)).deepEqual({ ok: false, reason: 'unreachable' });
    should(await client.remove(origin, BUNDLE)).deepEqual({ ok: false, reason: 'unreachable' });
    should(await client.status(origin, [BUNDLE])).deepEqual({ ok: false, reason: 'unreachable' });
  });

  it('should be unreachable when the store answers the challenge and then redirects the call', async () => {
    reset();
    behaviour.redirectCalls = true;
    const client = clientFor();
    should(await client.upload(origin, UPLOAD)).deepEqual({ ok: false, reason: 'unreachable' });
    should(await client.remove(origin, BUNDLE)).deepEqual({ ok: false, reason: 'unreachable' });
    should(await client.status(origin, [BUNDLE])).deepEqual({ ok: false, reason: 'unreachable' });
  });

  it('should be unreachable once the store has stopped answering', async () => {
    reset();
    const gone = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => json({}) });
    const dead = `http://127.0.0.1:${gone.port}`;
    await gone.stop(true);
    should(await clientFor().available(dead)).equal(false);
    should(await clientFor().remove(dead, BUNDLE)).deepEqual({ ok: false, reason: 'unreachable' });
  });
});

describe('ConfiguredLinkStoreLocator over HTTP', () => {
  it('should answer why there is no store when links are off or no directory is known', async () => {
    reset();
    const off = new ConfiguredLinkStoreLocator(
      () => ({ enabled: false }),
      () => origin,
      clientFor(),
    );
    const none = new ConfiguredLinkStoreLocator(
      () => ({ source: 'discovery' }),
      () => undefined,
      clientFor(),
    );
    should((await off.locate()).kind).equal('unavailable');
    should((await none.locate()).kind).equal('unavailable');
  });

  it('should use the store it discovered, or the one it was given, when that store is taking links', async () => {
    reset();
    const discovered = new ConfiguredLinkStoreLocator(
      () => ({ source: 'discovery' }),
      () => origin,
      clientFor(),
    );
    should(await discovered.locate()).deepEqual({ kind: 'ready', origin, selfHosted: false });
    const own = new ConfiguredLinkStoreLocator(
      () => ({ url: origin }),
      () => undefined,
      clientFor(),
    );
    should(await own.locate()).deepEqual({ kind: 'ready', origin, selfHosted: true });
  });

  it('should say the store is not taking links when it says so', async () => {
    reset();
    behaviour.advertisement = { version: 1, available: false, maxEnvelopeBytes: 1, maxLiveLinks: 1 };
    const down = new ConfiguredLinkStoreLocator(
      () => ({ source: 'discovery' }),
      () => origin,
      clientFor(),
    );
    should((await down.locate()).kind).equal('unavailable');
  });
});
