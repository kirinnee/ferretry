/**
 * The daemon's half of the link store wire over a REAL loopback HTTP server whose answers are the REAL link-store
 * Worker's (its Durable Objects on an in-memory store, the same as the Worker's own tests): the challenge, a signed
 * upload, status and delete are verified by the Worker's own code, so a signature or a canonical spelling the two halves
 * disagree about fails here. Cases only a misbehaving store can produce are answered by the same server, crafted.
 * The locator that decides which store the next link goes to is run against it too.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { HttpLinkStoreClient } from '../../../daemon/adapters/http-link-store-client.ts';
import { ConfiguredLinkStoreLocator, type LinkStoreSetting } from '../../../daemon/adapters/link-store-locator.ts';
import { WebCryptoSessionCrypto } from '../../../daemon/adapters/web-crypto.ts';
import type { LinkUpload } from '../../../daemon/lib/catalog-links/ports.ts';
import type { CatalogSigningIdentity } from '../../../daemon/lib/relay-wire/signatures.ts';
import { relayCrypto, newDaemonIdentity } from '../../support/worker/identities.ts';
import { linkStoreWorld, newBundleId, type LinkStoreWorld } from '../../support/worker/link-store-fakes.ts';
import { signLinkStoreRequest, toBase64Url } from '../../../worker/src/lib/index.ts';

const DAY = 24 * 60 * 60 * 1000;

let world: LinkStoreWorld;
let server: ReturnType<typeof Bun.serve>;
let origin: string;
/** A case the real Worker would never produce: answered instead of it when this returns a response. */
let crafted: (request: Request) => Response | undefined | Promise<Response | undefined> = () => undefined;
const seen: { url: string; init: RequestInit | undefined }[] = [];

beforeEach(async () => {
  world = await linkStoreWorld();
  crafted = () => undefined;
  seen.length = 0;
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async request => {
      const answer = await crafted(request);
      if (answer !== undefined) return answer;
      const url = new URL(request.url);
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
      return await world.send(
        new Request(`https://${request.headers.get('host')}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          ...(body === undefined ? {} : { body }),
        }),
      );
    },
  });
  origin = `http://127.0.0.1:${String(server.port)}`;
});

afterEach(async () => {
  await server.stop(true);
});

const wire = new WebCryptoSessionCrypto();

/** The daemon's identity source: the signer is the Worker library's own signing, over the daemon's own key. */
async function identitySource(present = true) {
  const identity = await newDaemonIdentity();
  const signing: CatalogSigningIdentity = {
    daemonId: identity.daemonId,
    signer: {
      signCatalog: async () => {
        throw new Error('not used by the link store');
      },
      signLinkStoreRequest: async ({ host, nonce, canonicalBody }) => {
        const signed = await signLinkStoreRequest(relayCrypto, identity, {
          daemonId: identity.daemonId,
          host,
          nonce,
          body: JSON.parse(new TextDecoder().decode(canonicalBody)),
        });
        return { daemonId: signed.daemonId, publicKey: signed.publicKey, signature: signed.signature };
      },
    },
  };
  return { identity: async () => (present ? signing : undefined), publisherName: () => 'Publisher' };
}

async function clientWith(options: { timeoutMs?: number; present?: boolean; record?: boolean } = {}) {
  return new HttpLinkStoreClient(wire, await identitySource(options.present ?? true), {
    fetcher: async (input, init) => {
      if (options.record === true) seen.push({ url: input, init });
      return await fetch(input, init);
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

const envelope = (length: number, sequence: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + 7) & 0xff;
  bytes.set(new TextEncoder().encode('FYL1'), 0);
  new DataView(bytes.buffer).setUint32(4, sequence, false);
  return bytes;
};

async function upload(overrides: Partial<LinkUpload> = {}): Promise<LinkUpload> {
  const token = relayCrypto.randomBytes(32);
  const sequence = overrides.sequence ?? 1;
  return {
    bundleId: newBundleId(),
    action: 'create',
    kind: 'public',
    sequence,
    notAfter: new Date(world.clock.now + 7 * DAY).toISOString(),
    fetchVerifier: toBase64Url(await relayCrypto.sha256(token)),
    envelope: envelope(16_500, sequence),
    ...overrides,
  };
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('what a store says about itself', () => {
  it('is taking links when its advertisement says so', async () => {
    expect(await (await clientWith()).available(origin)).toBe(true);
  });

  it('is not taking links when it says so, answers otherwise, or answers nothing sensible', async () => {
    const client = await clientWith();
    const advertised = { version: 1, available: true, maxEnvelopeBytes: 3 * 1024 * 1024, maxLiveLinks: 50 };

    crafted = () => json({ ...advertised, available: false });
    expect(await client.available(origin)).toBe(false);
    crafted = () => new Response('gone', { status: 503 });
    expect(await client.available(origin)).toBe(false);
    crafted = () => json({ unexpected: true });
    expect(await client.available(origin)).toBe(false);
    crafted = () => new Response('<html>not json</html>');
    expect(await client.available(origin)).toBe(false);
    crafted = () => new Response(null, { status: 200 });
    expect(await client.available(origin)).toBe(false);
  });

  it('reads no more than it must of an answer: one that declares or streams more than the cap is refused unread', async () => {
    const client = await clientWith();

    crafted = () => new Response('x'.repeat(100_000), { headers: { 'content-length': '100000' } });
    expect(await client.available(origin)).toBe(false);

    crafted = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(16 * 1024).fill(0x20));
          },
        }),
      );
    expect(await client.available(origin)).toBe(false);
  });

  it('gives up on an answer that stops arriving, and on one that breaks off', async () => {
    const hung = await clientWith({ timeoutMs: 300 });

    crafted = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"version":'));
          },
        }),
      );
    expect(await hung.available(origin)).toBe(false);

    crafted = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"version":'));
            controller.error(new Error('the store went away'));
          },
        }),
      );
    expect(await (await clientWith()).available(origin)).toBe(false);
  });

  it('never follows a redirect, and asks for no cache, with a deadline', async () => {
    const client = await clientWith({ record: true });
    crafted = () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.test/' } });

    expect(await client.available(origin)).toBe(false);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store' });
    expect(seen[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('is not reachable when nothing listens', async () => {
    const closed = await clientWith();
    await server.stop(true);

    expect(await closed.available(origin)).toBe(false);
  });

  it('needs the kernel fetch port', async () => {
    expect(() => new HttpLinkStoreClient(wire, { identity: async () => undefined, publisherName: () => 'x' })).toThrow(
      'the kernel fetch port is required',
    );
  });
});

describe('a link from upload to end, signed by this daemon and verified by the store', () => {
  it('uploads a link, reports it live, replaces it, and ends it, then is told it is gone', async () => {
    const client = await clientWith();
    const first = await upload({ expiresAt: new Date(world.clock.now + 30 * DAY).toISOString(), installCap: 3 });

    expect(await client.upload(origin, first)).toEqual({ ok: true, value: undefined });
    const status = await client.status(origin, [first.bundleId]);
    expect(status.ok && status.value.links).toMatchObject([
      { bundleId: first.bundleId, state: 'live', kind: 'public', sequence: 1, installCap: 3 },
    ]);

    const replaced = await client.upload(origin, {
      ...first,
      action: 'replace',
      sequence: 2,
      expectSequence: 1,
      envelope: envelope(16_500, 2),
    });
    expect(replaced.ok).toBe(true);
    const after = await client.status(origin, [first.bundleId]);
    expect(after.ok && after.value.links[0]?.sequence).toBe(2);

    expect(await client.remove(origin, first.bundleId)).toEqual({ ok: true, value: undefined });
    const ended = await client.status(origin, [first.bundleId]);
    expect(ended.ok && ended.value.links[0]?.state).not.toBe('live');
  });

  it('is told the store’s closed refusal code, and nothing else of what it said', async () => {
    const client = await clientWith();
    const first = await upload();
    await client.upload(origin, first);

    const again = await client.upload(origin, first);
    const never = await client.remove(origin, newBundleId());

    expect(again).toEqual({ ok: false, reason: 'refused', code: 'link_exists' });
    expect(never).toMatchObject({ ok: false, reason: 'refused' });
  });

  it('reads an answer it cannot trust to mean no as unreachable, for every call', async () => {
    const client = await clientWith();
    const link = await upload();
    crafted = request =>
      new URL(request.url).pathname.endsWith('/challenge')
        ? undefined
        : new Response('upstream exploded', { status: 500 });

    expect(await client.upload(origin, link)).toEqual({ ok: false, reason: 'unreachable' });
    expect(await client.remove(origin, link.bundleId)).toEqual({ ok: false, reason: 'unreachable' });
    expect(await client.status(origin, [link.bundleId])).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('reads a status that is not a status as unreachable', async () => {
    const client = await clientWith();
    crafted = request =>
      new URL(request.url).pathname.endsWith('/status') ? json({ links: 'not a list' }) : undefined;

    expect(await client.status(origin, ['x'])).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('reads a call that fails after the challenge as unreachable, for every call', async () => {
    const link = await upload();
    const quick = await clientWith({ timeoutMs: 200 });
    crafted = async request =>
      new URL(request.url).pathname.endsWith('/challenge') ? undefined : await new Promise<Response>(() => undefined);

    expect(await quick.upload(origin, link)).toEqual({ ok: false, reason: 'unreachable' });
    expect(await quick.remove(origin, link.bundleId)).toEqual({ ok: false, reason: 'unreachable' });
    expect(await quick.status(origin, [link.bundleId])).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('asks nothing of the store when this daemon has no identity to sign with', async () => {
    const client = await clientWith({ present: false, record: true });

    expect(await client.status(origin, ['x'])).toEqual({ ok: false, reason: 'unreachable' });
    expect(await client.upload(origin, await upload())).toEqual({ ok: false, reason: 'unreachable' });
    expect(await client.remove(origin, 'x')).toEqual({ ok: false, reason: 'unreachable' });
    expect(seen).toEqual([]);
  });

  it('sends nothing signed when the store gives no usable challenge', async () => {
    const client = await clientWith({ record: true });
    const challenges: (() => Response)[] = [
      () => new Response('no', { status: 429 }),
      () => json({ nonce: 'too-short' }),
      () => json({ unexpected: true }),
      () => new Response('<html>', { status: 200 }),
    ];

    for (const challenge of challenges) {
      crafted = request => (new URL(request.url).pathname.endsWith('/challenge') ? challenge() : undefined);
      expect(await client.remove(origin, 'x')).toEqual({ ok: false, reason: 'unreachable' });
    }
    expect(seen.every(call => call.url.endsWith('/challenge'))).toBe(true);
  });
});

describe('the locator that decides which store the next link goes to', () => {
  const locator = (
    setting: LinkStoreSetting,
    directory: string | undefined,
    client: ConstructorParameters<typeof ConfiguredLinkStoreLocator>[2],
  ) =>
    new ConfiguredLinkStoreLocator(
      () => setting,
      () => directory,
      client,
    );

  it('uses the store the owner named, asking it whether it is taking links', async () => {
    const client = await clientWith();

    expect(await locator({ url: origin }, undefined, client).locate()).toEqual({
      kind: 'ready',
      origin,
      selfHosted: true,
    });
  });

  it('uses the store the relay directory names when the owner named none', async () => {
    const client = await clientWith();

    expect(await locator({ source: 'discovery' }, `${origin}/`, client).locate()).toEqual({
      kind: 'ready',
      origin,
      selfHosted: false,
    });
  });

  it('says why there is no store: turned off, no directory, an address that is not https, or a store that is not taking links', async () => {
    const client = await clientWith();

    expect(await locator({ enabled: false }, origin, client).locate()).toMatchObject({
      kind: 'unavailable',
      reason: 'Download links are turned off on this machine (catalogs.linkStore).',
    });
    expect(await locator({ source: 'discovery' }, undefined, client).locate()).toMatchObject({
      kind: 'unavailable',
      reason: expect.stringContaining('the relay directory is off'),
    });
    expect(await locator({ url: 'http://links.example.test' }, undefined, client).locate()).toMatchObject({
      kind: 'unavailable',
      reason: expect.stringContaining('not a plain https address'),
    });
    crafted = () => new Response('busy', { status: 503 });
    expect(await locator({ url: origin }, undefined, client).locate()).toEqual({
      kind: 'unavailable',
      reason: 'The link store is not taking new links right now. Try again later.',
    });
  });
});
