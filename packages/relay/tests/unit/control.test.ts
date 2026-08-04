import { describe, it } from 'bun:test';
import {
  ControlMessageSchema,
  decodeControlMessage,
  encodeControlMessage,
  RELAY_LIMITS,
  RelayLimitsSchema,
  RELAY_PROTOCOL_ID,
  toBase64Url,
  utf8Bytes,
} from '@ferretry/relay';
import should from 'should';

const nonce = toBase64Url(new Uint8Array(32).fill(1));
const publicKey = toBase64Url(new Uint8Array(44).fill(2));
const signature = toBase64Url(new Uint8Array(64).fill(3));

describe('rendezvous control messages', () => {
  it('should round-trip every message the rendezvous can send or receive', () => {
    const messages = [
      { t: 'challenge', protocol: RELAY_PROTOCOL_ID, nonce, host: 'relay.example', deadlineSeconds: 10 },
      { t: 'claim', protocol: RELAY_PROTOCOL_ID, publicKey, signature },
      { t: 'claimed', protocol: RELAY_PROTOCOL_ID, limits: RELAY_LIMITS },
      { t: 'ready', protocol: RELAY_PROTOCOL_ID, limits: RELAY_LIMITS },
      { t: 'open' },
      { t: 'closed', code: 4404, reason: 'gone' },
      { t: 'error', code: 4400, reason: 'bad' },
    ] as const;
    for (const message of messages) {
      should(decodeControlMessage(encodeControlMessage(message))).deepEqual(message);
    }
  });

  it('should publish the limits an endpoint would otherwise have to guess', () => {
    should(RelayLimitsSchema.safeParse(RELAY_LIMITS).success).be.true();
    should(RelayLimitsSchema.safeParse({ ...RELAY_LIMITS, maxFrameBytes: 1 }).success).be.false();
  });

  it('should refuse a message that is close but not exact', () => {
    should(ControlMessageSchema.safeParse({ t: 'open', extra: 1 }).success).be.false();
    should(
      ControlMessageSchema.safeParse({ t: 'claim', protocol: 'other/1', publicKey, signature }).success,
    ).be.false();
    should(
      ControlMessageSchema.safeParse({ t: 'claim', protocol: RELAY_PROTOCOL_ID, publicKey: 'short', signature })
        .success,
    ).be.false();
    should(
      ControlMessageSchema.safeParse({
        t: 'claim',
        protocol: RELAY_PROTOCOL_ID,
        publicKey: `${'+'.repeat(59)}`,
        signature,
      }).success,
    ).be.false();
    should(ControlMessageSchema.safeParse({ t: 'closed', code: 200, reason: 'ok' }).success).be.false();
  });

  it('should decode nothing from bad bytes, bad JSON or an unknown shape', () => {
    should(decodeControlMessage(new Uint8Array([0xff, 0xfe]))).be.null();
    should(decodeControlMessage(utf8Bytes('{'))).be.null();
    should(decodeControlMessage(utf8Bytes('{"t":"unheard-of"}'))).be.null();
  });
});
