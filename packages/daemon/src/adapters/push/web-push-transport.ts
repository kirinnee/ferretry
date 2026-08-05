import type { BrowserPushSubscription } from '@ferretry/protocol';
import type { PushDelivery, PushDeliveryOutcome, WebPushTransport } from '../../lib/index.ts';
import type { VapidSigner } from './webcrypto-vapid-keys.ts';

/**
 * ONE ENCRYPTED PUSH, SENT.
 *
 * ## WHAT THIS IMPLEMENTS, AND WHY BY HAND
 *
 * Two specifications, both narrow and both mandatory:
 *
 * - **Message encryption.** The push service is an untrusted relay: it stores and forwards the body
 *   without being able to read it. The payload is sealed with a key derived from the browser's own
 *   subscription keys and a per-message ephemeral pair, in the `aes128gcm` content encoding.
 * - **Application-server identification.** Each request carries a short-lived ES256 token signed by
 *   this daemon's own key pair, which is how the push service knows the sender is the same party the
 *   browser subscribed against.
 *
 * Neither needs a dependency: Bun's WebCrypto has P-256 ECDH, HKDF, AES-GCM and ES256 signing, so the
 * whole exchange is about eighty lines of well-specified byte assembly. Pulling a library in for it
 * would add an unaudited dependency to the one path in this daemon that handles another party's key
 * material.
 *
 * ## IT REPORTS FACTS, NEVER CONCLUSIONS
 *
 * The domain decides what a failure means; this classifies only what happened. The one distinction
 * that matters is `expired`: a push service answering 404 or 410 is saying this endpoint will never
 * work again, which is the sole justification for deleting a stored enrolment. Everything else — a
 * timeout, a 5xx, a refused connection — says something about the network and nothing about the
 * browser, and must never cost somebody their notifications.
 */

export type PushFetch = (input: string, init: RequestInit) => Promise<Response>;

/** The record size the single-record body declares. The ceiling every push service accepts. */
const RECORD_BYTES = 4_096;
/** AES-GCM authentication tag. */
const TAG_BYTES = 16;
/** The `aes128gcm` header: 16-byte salt, 4-byte record size, 1-byte key length, 65-byte key. */
const CONTENT_HEADER_BYTES = 16 + 4 + 1 + 65;
const SALT_BYTES = 16;
const PUBLIC_KEY_BYTES = 65;

/** How long a push service should hold an undelivered message: four weeks, the specified maximum. */
const TTL_SECONDS = 2_419_200;
/** How long one authorization token is valid. Comfortably inside the 24-hour ceiling. */
const TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;

/**
 * The contact this daemon identifies itself with.
 *
 * The specification wants a way to reach whoever is sending, so a push service can complain to a human
 * about a misbehaving application server. It is deliberately the PRODUCT's address rather than the
 * operator's: this value travels to a third party on every notification, and an operator's mail address
 * is personal data that nothing here asked them for.
 */
const VAPID_SUBJECT = 'https://ferretry.pages.dev';

const TIMEOUT_MS = 10_000;

function owned(source: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(source.byteLength));
  copy.set(source);
  return copy;
}

function utf8(value: string): Uint8Array<ArrayBuffer> {
  return owned(new TextEncoder().encode(value));
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const joined = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

/** One HKDF expansion over an already-imported input key. Lengths are in BYTES here, bits at the call. */
async function expand(key: CryptoKey, salt: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: owned(salt), info: owned(info) },
      key,
      bytes * 8,
    ),
  );
}

async function hkdfKey(material: Uint8Array): Promise<CryptoKey> {
  return await crypto.subtle.importKey('raw', owned(material), 'HKDF', false, ['deriveBits']);
}

/** `Content-Encoding: <label>` followed by the single zero byte the derivation specifies. */
function encodingInfo(label: string): Uint8Array<ArrayBuffer> {
  return concat(utf8(`Content-Encoding: ${label}`), new Uint8Array([0]));
}

export class WebPushFetchTransport implements WebPushTransport {
  constructor(
    private readonly signer: VapidSigner,
    private readonly fetchImplementation: PushFetch = (input, init) => fetch(input, init),
    private readonly nowMs: () => number = () => Date.now(),
    private readonly randomSalt: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(SALT_BYTES)),
  ) {}

  async deliver(delivery: PushDelivery): Promise<PushDeliveryOutcome> {
    const body = await this.seal(delivery.subscription, delivery.payload);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await this.post(delivery.subscription.endpoint, body, controller);
    } catch {
      // Unreachable, refused, aborted — all of them say something about the network and nothing about
      // whether this browser still exists, so none of them may delete an enrolment.
      return 'failed';
    } finally {
      clearTimeout(timer);
    }
  }

  private async post(endpoint: string, body: Uint8Array, controller: AbortController): Promise<PushDeliveryOutcome> {
    const response = await this.fetchImplementation(endpoint, {
      method: 'POST',
      headers: {
        authorization: await this.authorization(endpoint),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: `${TTL_SECONDS}`,
      },
      body: owned(body),
      signal: controller.signal,
    });
    // The reply body is a diagnostic at best and is never needed to classify the outcome, but it has
    // to be released or the connection stays held for the rest of this daemon's life.
    void response.body?.cancel().catch(() => undefined);
    if (response.status === 404 || response.status === 410) return 'expired';
    return response.ok ? 'delivered' : 'failed';
  }

  /**
   * The `vapid` authorization for one push service.
   *
   * `aud` is the ORIGIN of the endpoint and nothing more — a token scoped to a whole path would be a
   * token another service could replay, and the origin is what the specification binds it to.
   */
  private async authorization(endpoint: string): Promise<string> {
    const header = base64Url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const claims = base64Url(
      utf8(
        JSON.stringify({
          aud: new URL(endpoint).origin,
          exp: Math.floor(this.nowMs() / 1_000) + TOKEN_LIFETIME_SECONDS,
          sub: VAPID_SUBJECT,
        }),
      ),
    );
    const signature = base64Url(await this.signer.sign(utf8(`${header}.${claims}`)));
    return `vapid t=${header}.${claims}.${signature}, k=${await this.signer.publicKey()}`;
  }

  /**
   * The payload, sealed for exactly one browser.
   *
   * The derivation is the specified one, in order: the shared secret from this message's ephemeral key
   * and the browser's public key, mixed with the browser's own auth secret to produce the input keying
   * material, then expanded under a fresh random salt into the content key and the nonce. Every message
   * gets a new ephemeral pair and a new salt, so the same notification sent twice is two different
   * ciphertexts and nothing about the key survives one message.
   */
  private async seal(subscription: BrowserPushSubscription, payload: string): Promise<Uint8Array> {
    // One trailing 0x02 marks this as the last record of the stream.
    const plaintext = concat(utf8(payload), new Uint8Array([2]));
    const budget = RECORD_BYTES - CONTENT_HEADER_BYTES - TAG_BYTES;
    if (plaintext.byteLength > budget)
      throw new Error(`a push payload of ${plaintext.byteLength} bytes exceeds the ${budget}-byte record budget`);

    const browserKey = Buffer.from(subscription.keys.p256dh, 'base64url');
    const authSecret = Buffer.from(subscription.keys.auth, 'base64url');
    const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const ephemeralPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
    const shared = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'ECDH',
          public: await crypto.subtle.importKey(
            'raw',
            owned(browserKey),
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            [],
          ),
        },
        ephemeral.privateKey,
        256,
      ),
    );

    const material = await expand(
      await hkdfKey(shared),
      authSecret,
      concat(utf8('WebPush: info'), new Uint8Array([0]), owned(browserKey), ephemeralPublic),
      32,
    );
    const salt = this.randomSalt();
    const expanded = await hkdfKey(material);
    const contentKey = await expand(expanded, salt, encodingInfo('aes128gcm'), 16);
    const nonce = await expand(expanded, salt, encodingInfo('nonce'), 12);

    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: owned(nonce) },
        await crypto.subtle.importKey('raw', owned(contentKey), { name: 'AES-GCM' }, false, ['encrypt']),
        plaintext,
      ),
    );
    const recordSize = new Uint8Array(4);
    new DataView(recordSize.buffer).setUint32(0, RECORD_BYTES, false);
    return concat(salt, recordSize, new Uint8Array([PUBLIC_KEY_BYTES]), ephemeralPublic, sealed);
  }
}
