import { describe, it } from 'bun:test';
import type { BrowserPushSubscription } from '@ferretry/protocol';
import should from 'should';
import { WebPushFetchTransport } from '../../../src/adapters/push/index.ts';
import type { VapidSigner } from '../../../src/adapters/push/webcrypto-vapid-keys.ts';

/**
 * The headers one delivery is posted with. The bytes are proved against a real browser's keys in
 * `tests/integration/push/web-push-transport.test.ts`; this pins what a push service is ASKED: how long to hold it and
 * how urgently to deliver it (RFC 8030 §5.2, §5.3).
 */

async function subscription(): Promise<BrowserPushSubscription> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    endpoint: 'https://fcm.googleapis.com/send/abc',
    expirationTime: null,
    keys: {
      p256dh: Buffer.from(publicKey).toString('base64url'),
      auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
    },
  };
}

async function signer(): Promise<VapidSigner> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const point = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    publicKey: async () => Buffer.from(point).toString('base64url'),
    sign: async message =>
      new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, message.slice())),
  };
}

async function posted(delivery: { readonly urgency?: 'high' | 'normal'; readonly ttlSeconds?: number }) {
  const headers: Record<string, string>[] = [];
  const transport = new WebPushFetchTransport(await signer(), async (_input, init) => {
    headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
    return new Response(null, { status: 201 });
  });
  const outcome = await transport.deliver({ subscription: await subscription(), payload: '{}', ...delivery });
  return { outcome, headers: headers[0] ?? {} };
}

describe('WebPushFetchTransport headers', () => {
  it('should send Urgency: high and the short TTL for a high push', async () => {
    // Act
    const { outcome, headers } = await posted({ urgency: 'high', ttlSeconds: 600 });

    // Assert
    should(outcome).equal('delivered');
    should(headers.urgency).equal('high');
    should(headers.ttl).equal('600');
  });

  it('should send no Urgency header and the four-week TTL for every other push, as before', async () => {
    // Act
    const plain = await posted({});
    const normal = await posted({ urgency: 'normal' });

    // Assert
    should(plain.headers).not.have.property('urgency');
    should(plain.headers.ttl).equal('2419200');
    should(normal.headers).not.have.property('urgency');
  });
});
