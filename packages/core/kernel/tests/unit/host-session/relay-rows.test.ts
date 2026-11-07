/**
 * The relay-protocol rows the KERNEL wire owns (docs/relay-protocol.md §3–§9): each test is the row's proof on the
 * real wire functions and real WebCrypto. A part of a row that lives in a carrier or the browser is said in its test.
 */
import { describe, expect, test } from 'bun:test';
import {
  answerClientHandshake,
  completeClientHandshake,
  encodeFrame,
  FRAME_HEADER_BYTES,
  FRAME_KINDS,
  fromBase64Url,
  handshakeTranscriptHash,
  lengthPrefixed,
  MAX_FRAME_SEQUENCE,
  openChannel,
  openRecord,
  RELAY_PROTOCOL_ID,
  SESSION_CLOSE_CODES,
  SESSION_PROTOCOL_ID,
  sealRecord,
  sessionIdFromBytes,
  startClientHandshake,
  toBase64Url,
  utf8Bytes,
} from '../../../host/session/wire/index.ts';
import { CREDIT_WINDOW_FRAMES } from '../../../host/session/index.ts';
import { fixture, serving } from './harness.ts';
import { newDaemonIdentity, relayCrypto } from './identities.ts';

const subtle = globalThis.crypto.subtle;
/** A copy WebCrypto's typings accept (an ArrayBuffer-backed view). */
const bs = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);
const SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await subtle.digest('SHA-256', bs(bytes)));

function sessionIdOf(fill: number) {
  const id = sessionIdFromBytes(new Uint8Array(16).fill(fill));
  if (id === null) throw new Error('session id');
  return id;
}

async function keyed(fill = 7) {
  const sessionId = sessionIdOf(fill);
  const identity = await newDaemonIdentity();
  const pending = await startClientHandshake(relayCrypto, sessionId, identity.daemonId);
  const answered = await answerClientHandshake(relayCrypto, identity, sessionId, pending.hello);
  if (!answered.ok) throw new Error(answered.reason);
  const completed = await completeClientHandshake(relayCrypto, pending, answered.hello);
  if (!completed.ok) throw new Error(completed.reason);
  return {
    sessionId,
    identity,
    pending,
    answered,
    keys: completed.keys,
    client: openChannel(sessionId, completed.keys, 'client'),
    daemon: openChannel(sessionId, answered.keys, 'daemon'),
  };
}

/** relayCrypto, counting the calls named. */
function counting(names: readonly string[]) {
  const calls: string[] = [];
  const crypto = new Proxy(relayCrypto, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (names.includes(String(property))) calls.push(String(property));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { crypto, calls };
}

describe('relay-protocol rows on the kernel wire', () => {
  test('R1 what a relay parses is ferretry-relay/1; the handshake and every record inside the channel are ferretry-relay/2', async () => {
    expect(RELAY_PROTOCOL_ID).toBe('ferretry-relay/1');
    expect(SESSION_PROTOCOL_ID).toBe('ferretry-relay/2');
    const { pending, answered } = await keyed();
    expect(pending.hello.protocol).toBe('ferretry-relay/2');
    expect(answered.hello.protocol).toBe('ferretry-relay/2');
  });

  test('R17 R41 daemonId is fy_daemon_ + base64url(SHA-256(SPKI)), 43 characters, over a 44-byte SPKI with the fixed Ed25519 prefix', async () => {
    const identity = await newDaemonIdentity();
    expect(identity.publicKeySpki.length).toBe(44);
    expect(identity.publicKeySpki.slice(0, 12)).toEqual(SPKI_PREFIX);
    const digest = toBase64Url(await sha256(identity.publicKeySpki));
    expect(digest.length).toBe(43);
    expect(identity.daemonId).toBe(`fy_daemon_${digest}`);
    // (R17's pairing QR carrying it out of band is Access's pairing link.)
  });

  test('R18 every session uses fresh X25519 keys, the daemon signs the whole transcript, and records are AES-256-GCM with the header as AAD', async () => {
    const one = await keyed(1);
    const two = await keyed(1);
    expect(one.pending.hello.epk).not.toBe(two.pending.hello.epk);
    expect(one.answered.hello.epk).not.toBe(two.answered.hello.epk);
    expect(fromBase64Url(one.pending.hello.epk)?.length).toBe(32);
    expect(one.keys.clientToDaemon.length).toBe(32);
    const sealed = await sealRecord(relayCrypto, one.client, utf8Bytes('hello'));
    if (!sealed.ok) throw new Error(sealed.reason);
    const bytes = encodeFrame(sealed.frame);
    const key = await subtle.importKey('raw', bs(one.keys.clientToDaemon), 'AES-GCM', false, ['decrypt']);
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, 1n);
    const plain = await subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: bs(bytes.slice(0, FRAME_HEADER_BYTES)), tagLength: 128 },
      key,
      bs(bytes.slice(FRAME_HEADER_BYTES)),
    );
    expect(new TextDecoder().decode(plain)).toBe('hello');
  });

  test('R22 a relay can drop or delay but cannot read, alter, insert, replay or reflect, nor introduce another daemon', async () => {
    const { client, daemon, identity, sessionId } = await keyed();
    const sealed = await sealRecord(relayCrypto, client, utf8Bytes('secret'));
    if (!sealed.ok) throw new Error(sealed.reason);
    expect(new TextDecoder().decode(sealed.frame.payload).includes('secret')).toBe(false);
    // altered
    const altered = { ...sealed.frame, payload: sealed.frame.payload.map((b, i) => (i === 0 ? b ^ 1 : b)) };
    expect((await openRecord(relayCrypto, daemon, altered)).ok).toBe(false);
    // inserted: a record keyed by another session the relay also carries
    const other = await keyed();
    const foreign = await sealRecord(relayCrypto, other.client, utf8Bytes('x'));
    if (!foreign.ok) throw new Error(foreign.reason);
    expect(await openRecord(relayCrypto, daemon, { ...foreign.frame, sessionId })).toMatchObject({
      ok: false,
      code: SESSION_CLOSE_CODES.frameForged,
    });
    // the genuine one opens once; replayed, it is refused
    const opened = await openRecord(relayCrypto, daemon, sealed.frame);
    if (!opened.ok) throw new Error(opened.reason);
    expect((await openRecord(relayCrypto, opened.state, sealed.frame)).ok).toBe(false);
    // reflected back to the client
    expect((await openRecord(relayCrypto, client, sealed.frame)).ok).toBe(false);
    // another daemon answering for this one is refused by the pin
    const impostor = await newDaemonIdentity();
    const pending = await startClientHandshake(relayCrypto, sessionId, identity.daemonId);
    const answered = await answerClientHandshake(relayCrypto, impostor, sessionId, {
      ...pending.hello,
      daemonId: impostor.daemonId,
    });
    if (!answered.ok) throw new Error(answered.reason);
    expect((await completeClientHandshake(relayCrypto, pending, answered.hello)).ok).toBe(false);
  });

  test('R28 binary values are unpadded base64url without whitespace, and a value that does not re-encode the same is refused', () => {
    expect(fromBase64Url('AQID')).toEqual(Uint8Array.from([1, 2, 3]));
    for (const bad of ['AQI=', 'AQ ID', 'AQ\nID', 'A+/B', 'AR', 'AQJ']) expect(fromBase64Url(bad)).toBeNull();
  });

  test('R30 credit frames carry sequence 0 in both directions and never disturb the record counter', async () => {
    const fx = await fixture();
    const { client } = await serving(fx);
    for (let id = 1; id <= CREDIT_WINDOW_FRAMES / 2; id += 1)
      await client.send({ t: 'req', id, method: 'GET', path: '/v1/health' });
    await client.pump();
    expect(client.creditReceived).toBeGreaterThan(0);
    const records = client.sequences.filter(sequence => sequence !== 0);
    expect(records).toEqual(records.map((_, index) => index + 1));
    expect(client.sequences.filter(sequence => sequence === 0).length).toBeGreaterThanOrEqual(2);
    // the client's own credit (sequence 0) does not move the daemon's expected next record
    client.credit(4);
    await client.send({ t: 'req', id: 999, method: 'GET', path: '/v1/health' });
    await client.pump();
    expect(client.end).toBeUndefined();
  });

  test('R69 the transcript is SHA-256 of the label and the length-prefixed session id, hs1 epk/nonce/daemonId and hs2 epk/nonce/spki, as text', async () => {
    const { sessionId, pending, answered, keys } = await keyed();
    const expected = await sha256(
      concat(
        utf8Bytes('ferretry-relay-handshake-v2'),
        lengthPrefixed(sessionId.bytes),
        ...[pending.hello.epk, pending.hello.nonce, pending.hello.daemonId].map(text =>
          lengthPrefixed(utf8Bytes(text)),
        ),
        ...[answered.hello.epk, answered.hello.nonce, answered.hello.spki].map(text => lengthPrefixed(utf8Bytes(text))),
      ),
    );
    expect(keys.transcriptHash).toEqual(expected);
    expect(await handshakeTranscriptHash(relayCrypto, sessionId, pending.hello, answered.hello)).toEqual(expected);
  });

  test('R70 the daemon signs "ferretry-relay-daemon-auth-v2" ‖ 0x00 ‖ TH with its identity key', async () => {
    const { answered, keys, identity } = await keyed();
    const key = await subtle.importKey('spki', bs(identity.publicKeySpki), { name: 'Ed25519' }, false, ['verify']);
    const message = concat(utf8Bytes('ferretry-relay-daemon-auth-v2'), Uint8Array.of(0), keys.transcriptHash);
    expect(await subtle.verify('Ed25519', key, bs(fromBase64Url(answered.hello.sig) as Uint8Array), bs(message))).toBe(
      true,
    );
    expect(
      await subtle.verify('Ed25519', key, bs(fromBase64Url(answered.hello.sig) as Uint8Array), bs(keys.transcriptHash)),
    ).toBe(false);
  });

  test('R71 the client checks the pin first: on a mismatch no signature is checked and no key is derived', async () => {
    const sessionId = sessionIdOf(9);
    const pinned = await newDaemonIdentity();
    const impostor = await newDaemonIdentity();
    const { crypto, calls } = counting(['verifyEd25519', 'deriveSharedSecret', 'deriveKey']);
    const pending = await startClientHandshake(crypto, sessionId, pinned.daemonId);
    const answered = await answerClientHandshake(relayCrypto, impostor, sessionId, {
      ...pending.hello,
      daemonId: impostor.daemonId,
    });
    if (!answered.ok) throw new Error(answered.reason);
    calls.length = 0;
    const refused = await completeClientHandshake(crypto, pending, answered.hello);
    expect(refused).toMatchObject({ ok: false, reason: 'daemon key does not match the pinned fingerprint' });
    expect(calls).toEqual([]);
    // the genuine daemon: signature, then key agreement, then the keys
    const good = await answerClientHandshake(relayCrypto, pinned, sessionId, pending.hello);
    if (!good.ok) throw new Error(good.reason);
    calls.length = 0;
    expect((await completeClientHandshake(crypto, pending, good.hello)).ok).toBe(true);
    expect(calls.slice(0, 2)).toEqual(['verifyEd25519', 'deriveSharedSecret']);
  });

  test('R73 each direction has its own HKDF key (c2d / d2c, salt TH), so a record cannot be reflected back and accepted', async () => {
    const { keys, client } = await keyed();
    expect(keys.clientToDaemon).not.toEqual(keys.daemonToClient);
    const sealed = await sealRecord(relayCrypto, client, utf8Bytes('mine'));
    if (!sealed.ok) throw new Error(sealed.reason);
    expect((await openRecord(relayCrypto, client, sealed.frame)).ok).toBe(false);
  });

  test('R81 the nonce is 4 zero bytes ‖ 64-bit big-endian sequence, the AAD the verbatim 28-byte header, the body ciphertext ‖ 16-byte tag', async () => {
    const { client, keys } = await keyed();
    let state = client;
    for (const sequence of [1, 2]) {
      const sealed = await sealRecord(relayCrypto, state, utf8Bytes('abc'));
      if (!sealed.ok) throw new Error(sealed.reason);
      state = sealed.state;
      expect(sealed.frame.sequence).toBe(sequence);
      expect(sealed.frame.payload.length).toBe(3 + 16);
      const bytes = encodeFrame(sealed.frame);
      expect(bytes[2]).toBe(FRAME_KINDS.data);
      const key = await subtle.importKey('raw', bs(keys.clientToDaemon), 'AES-GCM', false, ['decrypt']);
      const iv = new Uint8Array(12);
      new DataView(iv.buffer).setBigUint64(4, BigInt(sequence));
      const plain = await subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: bs(bytes.slice(0, 28)), tagLength: 128 },
        key,
        bs(bytes.slice(28)),
      );
      expect(new TextDecoder().decode(plain)).toBe('abc');
    }
  });

  test('R84 a nonce is never reused: a direction at 0xFFFFFFFF ends the session rather than wrapping', async () => {
    const { client } = await keyed();
    expect(MAX_FRAME_SEQUENCE).toBe(0xffff_ffff);
    const last = await sealRecord(relayCrypto, { ...client, sendSequence: MAX_FRAME_SEQUENCE }, utf8Bytes('last'));
    expect(last.ok).toBe(true);
    const past = await sealRecord(relayCrypto, { ...client, sendSequence: MAX_FRAME_SEQUENCE + 1 }, utf8Bytes('no'));
    expect(past).toMatchObject({ ok: false, code: SESSION_CLOSE_CODES.sequenceBroken });
  });
});
