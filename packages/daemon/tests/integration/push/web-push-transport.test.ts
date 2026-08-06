import { describe, it } from 'bun:test';
import type { BrowserPushSubscription } from '@ferretry/protocol';
import should from 'should';
import { WebPushFetchTransport } from '../../../src/adapters/push/index.ts';
import type { VapidSigner } from '../../../src/adapters/push/webcrypto-vapid-keys.ts';

/**
 * THE ONE TEST THAT PROVES THIS IS WEB PUSH RATHER THAN BYTES THAT LOOK LIKE IT.
 *
 * Both halves of the exchange are checked against the specifications by DOING what the other side does:
 * a browser's own subscription keys decrypt the body, and the browser's push service verifies the
 * signature. Two fixtures agreeing with each other would prove nothing here — the whole risk in a hand
 * written implementation of a byte format is that both sides of a home-grown pair are wrong together.
 */

const owned = (source: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = new Uint8Array(new ArrayBuffer(source.byteLength));
  copy.set(source);
  return copy;
};
const utf8 = (value: string) => owned(new TextEncoder().encode(value));
const concat = (...parts: readonly Uint8Array[]) => {
  const joined = new Uint8Array(new ArrayBuffer(parts.reduce((sum, part) => sum + part.byteLength, 0)));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
};

/** A browser that really did subscribe: a P-256 pair it keeps, and the auth secret it generated. */
async function browser() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  const subscription: BrowserPushSubscription = {
    endpoint: 'https://push.example.test/send/abc',
    expirationTime: null,
    keys: {
      p256dh: Buffer.from(publicKey).toString('base64url'),
      auth: Buffer.from(authSecret).toString('base64url'),
    },
  };
  return { pair, publicKey, authSecret, subscription };
}

/** The daemon's signing identity, with a verifying half the test keeps so a token can be checked. */
async function signer(): Promise<VapidSigner & { readonly verifier: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const point = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    verifier: pair.publicKey,
    publicKey: async () => Buffer.from(point).toString('base64url'),
    sign: async message =>
      new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, owned(message))),
  };
}

/** Decrypts a body exactly as a service worker would, following the content-encoding header layout. */
async function decrypt(
  body: Uint8Array,
  reader: Awaited<ReturnType<typeof browser>>,
): Promise<{ readonly text: string; readonly recordSize: number; readonly keyLength: number }> {
  const salt = body.subarray(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false);
  const keyLength = body[20] ?? 0;
  const serverPublic = body.subarray(21, 21 + keyLength);
  const ciphertext = body.subarray(21 + keyLength);

  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'ECDH',
        public: await crypto.subtle.importKey(
          'raw',
          owned(serverPublic),
          { name: 'ECDH', namedCurve: 'P-256' },
          false,
          [],
        ),
      },
      reader.pair.privateKey,
      256,
    ),
  );
  const material = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: owned(reader.authSecret),
        info: concat(utf8('WebPush: info'), new Uint8Array([0]), owned(reader.publicKey), owned(serverPublic)),
      },
      await crypto.subtle.importKey('raw', owned(shared), 'HKDF', false, ['deriveBits']),
      256,
    ),
  );
  const expanded = await crypto.subtle.importKey('raw', owned(material), 'HKDF', false, ['deriveBits']);
  const derive = async (label: string, bits: number) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: owned(salt),
          info: concat(utf8(`Content-Encoding: ${label}`), new Uint8Array([0])),
        },
        expanded,
        bits,
      ),
    );
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: owned(await derive('nonce', 96)) },
      await crypto.subtle.importKey('raw', owned(await derive('aes128gcm', 128)), { name: 'AES-GCM' }, false, [
        'decrypt',
      ]),
      owned(ciphertext),
    ),
  );
  // The final record of the stream ends in the 0x02 delimiter; anything else means the wrong layout.
  should(plaintext.at(-1)).equal(2);
  return { text: new TextDecoder().decode(plaintext.subarray(0, -1)), recordSize, keyLength };
}

interface Capture {
  url: string;
  init: RequestInit;
}

function transport(
  identity: VapidSigner,
  status: number,
  captured: Capture[],
  nowMs = 1_780_000_000_000,
): WebPushFetchTransport {
  return new WebPushFetchTransport(
    identity,
    async (url, init) => {
      captured.push({ url, init });
      return new Response(status === 204 ? null : 'ok', { status });
    },
    () => nowMs,
  );
}

describe('WebPushFetchTransport', () => {
  it('should send a body the subscribing browser can decrypt', async () => {
    const reader = await browser();
    const identity = await signer();
    const captured: Capture[] = [];

    const outcome = await transport(identity, 201, captured).deliver({
      subscription: reader.subscription,
      payload: JSON.stringify({ title: 'Notifications are on' }),
    });

    should(outcome).equal('delivered');
    should(captured[0]?.url).equal(reader.subscription.endpoint);
    const headers = captured[0]?.init.headers as Record<string, string>;
    should(headers['content-encoding']).equal('aes128gcm');
    should(headers['content-type']).equal('application/octet-stream');
    should(headers.ttl).equal('2419200');
    const read = await decrypt(captured[0]?.init.body as Uint8Array, reader);
    should(JSON.parse(read.text)).deepEqual({ title: 'Notifications are on' });
    should(read.recordSize).equal(4_096);
    should(read.keyLength).equal(65);
  });

  it('should identify itself with a token the push service can verify', async () => {
    const reader = await browser();
    const identity = await signer();
    const captured: Capture[] = [];

    await transport(identity, 201, captured).deliver({ subscription: reader.subscription, payload: '{}' });

    const headers = (captured[0]?.init.headers ?? {}) as Record<string, string>;
    const [token, key] = (headers.authorization ?? '').replace('vapid ', '').split(', ');
    should(key).equal(`k=${await identity.publicKey()}`);
    const [header, claims, signature] = (token ?? '').replace('t=', '').split('.');
    should(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).deepEqual({ typ: 'JWT', alg: 'ES256' });
    should(JSON.parse(Buffer.from(claims ?? '', 'base64url').toString())).deepEqual({
      // The ORIGIN of the endpoint and nothing more: a token scoped to a path would be replayable by
      // another service on the same host.
      aud: 'https://push.example.test',
      exp: 1_780_000_000 + 12 * 60 * 60,
      sub: 'https://ferretry.pages.dev',
    });
    should(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        identity.verifier,
        owned(Buffer.from(signature ?? '', 'base64url')),
        utf8(`${header}.${claims}`),
      ),
    ).be.true();
  });

  it('should never send the same bytes twice for the same notification', async () => {
    const reader = await browser();
    const identity = await signer();
    const captured: Capture[] = [];
    const subject = transport(identity, 201, captured);

    await subject.deliver({ subscription: reader.subscription, payload: '{"n":1}' });
    await subject.deliver({ subscription: reader.subscription, payload: '{"n":1}' });

    // A fresh ephemeral pair and a fresh salt per message: nothing about one message's key survives it.
    should(Buffer.from(captured[0]?.init.body as Uint8Array)).not.deepEqual(
      Buffer.from(captured[1]?.init.body as Uint8Array),
    );
    should(JSON.parse((await decrypt(captured[1]?.init.body as Uint8Array, reader)).text)).deepEqual({ n: 1 });
  });

  it('should report an endpoint the push service has discarded as expired, and only that', async () => {
    const reader = await browser();
    const identity = await signer();

    const gone = await transport(identity, 410, []).deliver({ subscription: reader.subscription, payload: '{}' });
    const missing = await transport(identity, 404, []).deliver({ subscription: reader.subscription, payload: '{}' });
    const broken = await transport(identity, 500, []).deliver({ subscription: reader.subscription, payload: '{}' });
    const refused = await transport(identity, 429, []).deliver({ subscription: reader.subscription, payload: '{}' });

    // Only 404 and 410 say this browser can never be reached here again. A 5xx or a 429 says something
    // about the push service, and deleting an enrolment over one would cost somebody their notifications.
    should([gone, missing]).deepEqual(['expired', 'expired']);
    should([broken, refused]).deepEqual(['failed', 'failed']);
  });

  it('should treat an accepted-with-no-content answer as delivered', async () => {
    const reader = await browser();

    const outcome = await transport(await signer(), 204, []).deliver({
      subscription: reader.subscription,
      payload: '{}',
    });

    should(outcome).equal('delivered');
  });

  it('should report an unreachable push service as failed rather than as a defect', async () => {
    const reader = await browser();
    const identity = await signer();
    const subject = new WebPushFetchTransport(identity, async () => {
      throw new Error('getaddrinfo ENOTFOUND push.example.test');
    });

    should(await subject.deliver({ subscription: reader.subscription, payload: '{}' })).equal('failed');
  });

  it('should refuse a payload that cannot fit one record instead of sending a truncated one', async () => {
    const reader = await browser();

    await transport(await signer(), 201, [])
      .deliver({ subscription: reader.subscription, payload: 'x'.repeat(4_096) })
      .should.be.rejectedWith(/record budget/u);
  });
});
