import { describe, it } from 'bun:test';
import { createCipheriv, hkdfSync } from 'node:crypto';
import {
  concatBytes,
  fromBase64UrlFixed,
  LINK_BUNDLE_ID_BYTES,
  LINK_ENVELOPE_AAD_LABEL,
  LINK_ENVELOPE_MAX_BYTES,
  LINK_PADDING_BUCKET_BYTES,
  LINK_SECRET_BYTES,
  linkEnvelopeSequence,
  linkEnvelopeSize,
  linkFetchToken,
  linkFetchVerifier,
  linkTokenMatchesVerifier,
  mintLinkSecrets,
  openLinkEnvelope,
  sealLinkEnvelope,
  toBase64Url,
  utf8Bytes,
  writeUint32,
} from '@ferretry/relay';
import should from 'should';
import { relayCrypto, stubbedCrypto } from '../support/identities.ts';
import { linkWorld } from '../support/links.ts';

const KEY = toBase64Url(new Uint8Array(32).map((_, index) => index));
const BUNDLE_ID = toBase64Url(new Uint8Array(16).map((_, index) => 0xa0 + index));
const NONCE = new Uint8Array(12).map((_, index) => 0x40 + index);
const fixedNonce = stubbedCrypto({ randomBytes: () => NONCE });
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** Seal arbitrary plaintext exactly as `sealLinkEnvelope` frames it, to forge what an honest sealer never writes. */
async function forge(plaintext: Uint8Array, sequence = 1, key = KEY, bundleId = BUNDLE_ID): Promise<Uint8Array> {
  const keyBytes = fromBase64UrlFixed(key, 32) ?? new Uint8Array();
  const idBytes = fromBase64UrlFixed(bundleId, 16) ?? new Uint8Array();
  const seq = new Uint8Array(4);
  writeUint32(seq, 0, sequence);
  const aead = await relayCrypto.deriveKey(keyBytes, idBytes, `ferretry-link-bundle-key-v1/${sequence}`, 32);
  const aad = concatBytes([utf8Bytes(LINK_ENVELOPE_AAD_LABEL), new Uint8Array(1), idBytes, seq]);
  return concatBytes([utf8Bytes('FYL1'), seq, NONCE, await relayCrypto.seal(aead, NONCE, aad, plaintext)]);
}

const padded = (body: Uint8Array, length = body.length, size = LINK_PADDING_BUCKET_BYTES): Uint8Array => {
  const out = new Uint8Array(size);
  writeUint32(out, 0, length);
  out.set(body, 4);
  return out;
};

describe('link secrets', () => {
  it('should mint a 32-byte key and a 16-byte bundle id, different every time', () => {
    const one = mintLinkSecrets(relayCrypto);
    const two = mintLinkSecrets(relayCrypto);
    should(fromBase64UrlFixed(one.key, LINK_SECRET_BYTES)).not.be.null();
    should(fromBase64UrlFixed(one.bundleId, LINK_BUNDLE_ID_BYTES)).not.be.null();
    should(one.key).not.equal(two.key);
    should(one.bundleId).not.equal(two.bundleId);
  });

  it('should derive the fetch token with HKDF over the key, salted by the bundle id, and match an independent derivation', async () => {
    const token = await linkFetchToken(relayCrypto, KEY, BUNDLE_ID);
    should(token).equal('ckgKIOMdO7Sq6VKL33OxT_36kaJZk24dHgDIT00Wb-Q');
    const independent = hkdfSync(
      'sha256',
      Buffer.from(KEY, 'base64url'),
      Buffer.from(BUNDLE_ID, 'base64url'),
      'ferretry-link-fetch-v1',
      32,
    );
    should(token).equal(Buffer.from(independent).toString('base64url'));
  });

  it('should keep only the SHA-256 of the token and compare it', async () => {
    const token = (await linkFetchToken(relayCrypto, KEY, BUNDLE_ID)) ?? '';
    const verifier = await linkFetchVerifier(relayCrypto, token);
    should(verifier).equal('m4rCwqaC4coDXR7yRg27GIN1PdlNPf4RaBaVWWIl-LY');
    should(await linkTokenMatchesVerifier(relayCrypto, token, verifier ?? '')).be.true();
    should(await linkTokenMatchesVerifier(relayCrypto, token, toBase64Url(new Uint8Array(32)))).be.false();
    should(await linkTokenMatchesVerifier(relayCrypto, token, 'short')).be.false();
    should(await linkTokenMatchesVerifier(relayCrypto, 'short', verifier ?? '')).be.false();
  });

  it('should not derive anything from a key or an id that is not the size it must be', async () => {
    should(await linkFetchToken(relayCrypto, 'short', BUNDLE_ID)).be.null();
    should(await linkFetchToken(relayCrypto, KEY, 'short')).be.null();
    should(await linkFetchVerifier(relayCrypto, 'short')).be.null();
  });

  it('should give a different token to a different key or a different link', async () => {
    const other = mintLinkSecrets(relayCrypto);
    const token = await linkFetchToken(relayCrypto, KEY, BUNDLE_ID);
    should(await linkFetchToken(relayCrypto, other.key, BUNDLE_ID)).not.equal(token);
    should(await linkFetchToken(relayCrypto, KEY, other.bundleId)).not.equal(token);
  });
});

describe('sealing an envelope', () => {
  it('should match a fixed vector: header, sequence, nonce and the AES-256-GCM of the padded plaintext', async () => {
    const sealed = await sealLinkEnvelope(fixedNonce, KEY, BUNDLE_ID, 7, '{"hello":"world"}');
    if (!sealed.ok) throw new Error(sealed.reason);
    const bytes = sealed.value;
    should(bytes.length).equal(16420);
    should(hex(bytes.subarray(0, 32))).equal('46594c3100000007404142434445464748494a4b002adf22ae01df8f9141ee25');
    should(hex(bytes.subarray(-32))).equal('1b1dbc4a8d21e330a4a6837b8774baab61ac5f19cff824ce44bb1aa8f1774a6f');
    should(hex(await relayCrypto.sha256(bytes))).equal(
      '0ee1398bd2301460325bfc5351905210dd063342f2f234d82de297da9a05a3d5',
    );
  });

  it('should equal what node:crypto makes from the same inputs', async () => {
    const sealed = await sealLinkEnvelope(fixedNonce, KEY, BUNDLE_ID, 7, '{"hello":"world"}');
    if (!sealed.ok) throw new Error(sealed.reason);
    const salt = Buffer.from(BUNDLE_ID, 'base64url');
    const aesKey = Buffer.from(
      hkdfSync('sha256', Buffer.from(KEY, 'base64url'), salt, 'ferretry-link-bundle-key-v1/7', 32),
    );
    const aad = Buffer.concat([
      Buffer.from('ferretry-link-envelope-v1'),
      Buffer.from([0]),
      salt,
      Buffer.from([0, 0, 0, 7]),
    ]);
    const plaintext = Buffer.alloc(16384);
    plaintext.writeUInt32BE(17, 0);
    plaintext.write('{"hello":"world"}', 4);
    const cipher = createCipheriv('aes-256-gcm', aesKey, Buffer.from(NONCE));
    cipher.setAAD(aad);
    const expected = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    should(Buffer.compare(expected, Buffer.from(sealed.value.subarray(20)))).equal(0);
  });

  it('should pad to a 16 KiB bucket so only a size class is visible', async () => {
    const sizes = new Set<number>();
    for (const length of [1, 100, 12_000, 16_380]) {
      const sealed = await sealLinkEnvelope(relayCrypto, KEY, BUNDLE_ID, 1, 'x'.repeat(length));
      if (sealed.ok) sizes.add(sealed.value.length);
    }
    should([...sizes]).deepEqual([16420]);
    const next = await sealLinkEnvelope(relayCrypto, KEY, BUNDLE_ID, 1, 'x'.repeat(16_381));
    should(next.ok && next.value.length).equal(16420 + LINK_PADDING_BUCKET_BYTES);
  });

  it('should use a fresh nonce each time, so two seals of one text differ', async () => {
    const one = await sealLinkEnvelope(relayCrypto, KEY, BUNDLE_ID, 1, '{}');
    const two = await sealLinkEnvelope(relayCrypto, KEY, BUNDLE_ID, 1, '{}');
    should(one.ok && two.ok && hex(one.value) === hex(two.value)).be.false();
  });

  it('should refuse a sequence that is not a positive 32-bit integer, or secrets that are the wrong size', async () => {
    for (const sequence of [0, -1, 1.5, 0x1_0000_0000, Number.NaN])
      should(await sealLinkEnvelope(relayCrypto, KEY, BUNDLE_ID, sequence, '{}')).match({
        ok: false,
        refusal: 'malformed_secret',
      });
    should(await sealLinkEnvelope(relayCrypto, 'short', BUNDLE_ID, 1, '{}')).match({ ok: false });
    should(await sealLinkEnvelope(relayCrypto, KEY, 'short', 1, '{}')).match({ ok: false });
  });

  it('should seal the largest text that fits the 3 MiB cap and refuse one byte more of padding', async () => {
    const buckets = Math.floor((LINK_ENVELOPE_MAX_BYTES - 36) / LINK_PADDING_BUCKET_BYTES);
    const fits = 'x'.repeat(buckets * LINK_PADDING_BUCKET_BYTES - 4);
    const sealed = await sealLinkEnvelope(relayCrypto, KEY, BUNDLE_ID, 1, fits);
    should(sealed.ok && sealed.value.length).equal(36 + buckets * LINK_PADDING_BUCKET_BYTES);
    should(sealed.ok && sealed.value.length <= LINK_ENVELOPE_MAX_BYTES).be.true();
    const tooBig = await sealLinkEnvelope(relayCrypto, KEY, BUNDLE_ID, 1, `${fits}x`);
    should(tooBig).match({
      ok: false,
      refusal: 'link_too_big',
      reason: 'This is too large to share as a link. Export it as a file instead.',
    });
  });

  it('should measure an envelope before sealing it, and say null past the cap', () => {
    should(linkEnvelopeSize('{}')).equal(16420);
    should(linkEnvelopeSize('x'.repeat(LINK_ENVELOPE_MAX_BYTES))).be.null();
  });
});

describe('opening an envelope', () => {
  it('should round-trip a signed bundle and answer its sequence', async () => {
    const world = await linkWorld();
    const sealed = await sealLinkEnvelope(relayCrypto, world.secrets.key, world.secrets.bundleId, 1, world.text);
    if (!sealed.ok) throw new Error(sealed.reason);
    should(linkEnvelopeSequence(sealed.value)).equal(1);
    const opened = await openLinkEnvelope(relayCrypto, world.secrets.key, world.secrets.bundleId, sealed.value);
    should(opened).match({ ok: true, value: { sequence: 1 } });
    should(opened.ok && opened.value.bundle).deepEqual(world.bundle);
  });

  it('should refuse any envelope the wrong key, the wrong id or another sequence opens', async () => {
    const world = await linkWorld();
    const { key, bundleId } = world.secrets;
    const sealed = await sealLinkEnvelope(relayCrypto, key, bundleId, 1, world.text);
    if (!sealed.ok) throw new Error(sealed.reason);
    const other = mintLinkSecrets(relayCrypto);
    should(await openLinkEnvelope(relayCrypto, other.key, bundleId, sealed.value)).match({
      refusal: 'authentication_failed',
    });
    should(await openLinkEnvelope(relayCrypto, key, other.bundleId, sealed.value)).match({
      refusal: 'authentication_failed',
    });
    const renumbered = sealed.value.slice();
    writeUint32(renumbered, 4, 2);
    should(await openLinkEnvelope(relayCrypto, key, bundleId, renumbered)).match({ refusal: 'authentication_failed' });
  });

  it('should refuse an envelope with any one byte changed, in the header, the nonce, the ciphertext or the tag', async () => {
    const world = await linkWorld();
    const { key, bundleId } = world.secrets;
    const sealed = await sealLinkEnvelope(relayCrypto, key, bundleId, 1, world.text);
    if (!sealed.ok) throw new Error(sealed.reason);
    const positions = [0, 3, 4, 7, 8, 19, 20, 200, sealed.value.length - 17, sealed.value.length - 1];
    for (const position of positions) {
      const copy = sealed.value.slice();
      copy[position] = (copy[position] ?? 0) ^ 1;
      const opened = await openLinkEnvelope(relayCrypto, key, bundleId, copy);
      should(opened.ok).be.false();
    }
  });

  it('should refuse bytes that are not an envelope: short, long, no magic, sequence zero', async () => {
    const { key, bundleId } = mintLinkSecrets(relayCrypto);
    const refusal = (bytes: Uint8Array) => openLinkEnvelope(relayCrypto, key, bundleId, bytes);
    should(await refusal(new Uint8Array())).match({ refusal: 'malformed_envelope' });
    should(await refusal(new Uint8Array(100))).match({ refusal: 'malformed_envelope' });
    should(await refusal(new Uint8Array(LINK_ENVELOPE_MAX_BYTES + 1))).match({ refusal: 'link_too_big' });
    const noMagic = await forge(padded(utf8Bytes('{}'), 2), 1, key, bundleId);
    noMagic[0] = 0x58;
    should(await refusal(noMagic)).match({ refusal: 'malformed_envelope' });
    const zero = (await forge(padded(utf8Bytes('{}'), 2), 1, key, bundleId)).slice();
    writeUint32(zero, 4, 0);
    should(await refusal(zero)).match({ refusal: 'malformed_envelope' });
    should(linkEnvelopeSequence(zero)).be.null();
  });

  it('should refuse secrets that are not the size they must be', async () => {
    should(await openLinkEnvelope(relayCrypto, 'short', BUNDLE_ID, new Uint8Array(100))).match({
      refusal: 'malformed_secret',
    });
  });

  it('should refuse a plaintext that is not exactly padded: a wrong length, extra padding, or padding that is not zero', async () => {
    const body = utf8Bytes('{}');
    const refusal = async (plaintext: Uint8Array) =>
      openLinkEnvelope(relayCrypto, KEY, BUNDLE_ID, await forge(plaintext));
    // Not a multiple of the bucket.
    should(await refusal(new Uint8Array(100))).match({ refusal: 'malformed_envelope' });
    // A length longer than the plaintext.
    should(await refusal(padded(body, LINK_PADDING_BUCKET_BYTES))).match({ refusal: 'malformed_envelope' });
    // A zero length.
    should(await refusal(padded(body, 0))).match({ refusal: 'malformed_envelope' });
    // Two buckets where one would do: a second spelling of the same bundle.
    should(await refusal(padded(body, 2, 2 * LINK_PADDING_BUCKET_BYTES))).match({ refusal: 'malformed_envelope' });
    // A non-zero byte inside the padding.
    const dirty = padded(body, 2);
    dirty[LINK_PADDING_BUCKET_BYTES - 1] = 1;
    should(await refusal(dirty)).match({ refusal: 'malformed_envelope' });
    // An empty plaintext.
    should(await refusal(new Uint8Array())).match({ refusal: 'malformed_envelope' });
  });

  it('should refuse a bundle that is not UTF-8, not JSON, or not a link bundle', async () => {
    const refusal = async (body: Uint8Array) =>
      openLinkEnvelope(relayCrypto, KEY, BUNDLE_ID, await forge(padded(body)));
    should(await refusal(new Uint8Array([0xff, 0xfe, 0xfd]))).match({ refusal: 'bundle_invalid' });
    should(await refusal(utf8Bytes('{not json'))).match({ refusal: 'bundle_invalid' });
    should(await refusal(utf8Bytes('{"format":"nope"}'))).match({ refusal: 'bundle_invalid' });
  });

  it('should refuse a valid bundle that is not in its one canonical spelling', async () => {
    const world = await linkWorld();
    const pretty = utf8Bytes(JSON.stringify(world.bundle, null, 2));
    const envelope = await forge(padded(pretty), 1, world.secrets.key, world.secrets.bundleId);
    should(await openLinkEnvelope(relayCrypto, world.secrets.key, world.secrets.bundleId, envelope)).match({
      refusal: 'not_canonical',
    });
  });

  it('should refuse a bundle with no canonical spelling at all', async () => {
    const world = await linkWorld();
    const lone = String.fromCharCode(0xd800);
    const text = JSON.stringify({ ...world.bundle, item: { ...world.item, summary: `a${lone}` } });
    const envelope = await forge(padded(utf8Bytes(text)), 1, world.secrets.key, world.secrets.bundleId);
    const opened = await openLinkEnvelope(relayCrypto, world.secrets.key, world.secrets.bundleId, envelope);
    should(opened.ok).be.false();
  });
});
