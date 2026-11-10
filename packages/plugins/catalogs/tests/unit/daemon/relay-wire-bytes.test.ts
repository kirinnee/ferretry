/** The daemon's byte-level wire helpers and its link sealing, checked against the worker copy that opens what it seals. */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  encodeLinkUploadBody,
  LINK_ENVELOPE_MAX_BYTES,
  lengthPrefixed,
  linkEnvelopeSize,
  linkFetchToken,
  linkFetchVerifier,
  mintLinkSecrets,
  readUint32,
  sealLinkEnvelope,
  utf8Bytes,
  utf8Text,
  writeUint32,
} from '../../../daemon/lib/relay-wire/index.ts';
import { openLinkEnvelope } from '../../../worker/src/lib/index.ts';
import { relayCrypto } from '../../support/worker/identities.ts';
import { linkWorld } from '../../support/worker/links.ts';

describe('relay-wire byte helpers', () => {
  it('prefixes a field with its big-endian length', () => {
    should([...lengthPrefixed(Uint8Array.of(7, 8, 9))]).eql([0, 0, 0, 3, 7, 8, 9]);
    should([...lengthPrefixed(new Uint8Array())]).eql([0, 0, 0, 0]);
  });

  it('writes and reads an unsigned 32-bit number at an offset', () => {
    const target = new Uint8Array(8);
    writeUint32(target, 2, 0x01020304);
    should([...target]).eql([0, 0, 1, 2, 3, 4, 0, 0]);
    should(readUint32(target, 2)).equal(0x01020304);
  });

  it('decodes UTF-8 a peer sent, and answers null for bytes that are not UTF-8', () => {
    should(utf8Text(utf8Bytes('héllo'))).equal('héllo');
    should(utf8Text(Uint8Array.of(0xff, 0xfe))).be.null();
  });
});

describe('sealing a link envelope', () => {
  it('seals what the worker copy opens, at the sequence it declares', async () => {
    const world = await linkWorld();
    const sealed = await sealLinkEnvelope(relayCrypto, world.secrets.key, world.secrets.bundleId, 2, world.text);
    if (!sealed.ok) throw new Error(sealed.reason);
    should(sealed.value.length).equal(linkEnvelopeSize(world.text));
    const opened = await openLinkEnvelope(relayCrypto, world.secrets.key, world.secrets.bundleId, sealed.value);
    should(opened).match({ ok: true, value: { sequence: 2 } });
  });

  it('refuses a key, id or sequence that is malformed', async () => {
    const world = await linkWorld();
    const { key, bundleId } = world.secrets;
    for (const attempt of [
      sealLinkEnvelope(relayCrypto, 'short', bundleId, 1, world.text),
      sealLinkEnvelope(relayCrypto, key, 'short', 1, world.text),
      sealLinkEnvelope(relayCrypto, key, bundleId, 0, world.text),
      sealLinkEnvelope(relayCrypto, key, bundleId, 1.5, world.text),
      sealLinkEnvelope(relayCrypto, key, bundleId, 0x1_0000_0000, world.text),
    ])
      should(await attempt).match({ ok: false, refusal: 'malformed_secret' });
  });

  it('refuses a bundle that would not fit in an envelope, and says the size cannot be known', async () => {
    const secrets = mintLinkSecrets(relayCrypto);
    const huge = 'x'.repeat(LINK_ENVELOPE_MAX_BYTES);
    should(await sealLinkEnvelope(relayCrypto, secrets.key, secrets.bundleId, 1, huge)).match({
      ok: false,
      refusal: 'link_too_big',
    });
    should(linkEnvelopeSize(huge)).be.null();
  });

  it('derives the fetch token and its verifier, and null for secrets of the wrong size', async () => {
    const secrets = mintLinkSecrets(relayCrypto);
    const token = await linkFetchToken(relayCrypto, secrets.key, secrets.bundleId);
    if (token === null) throw new Error('no token');
    should(await linkFetchVerifier(relayCrypto, token)).be.a.String();
    should(await linkFetchToken(relayCrypto, 'short', secrets.bundleId)).be.null();
    should(await linkFetchVerifier(relayCrypto, 'short')).be.null();
  });
});

describe('encoding a link upload body', () => {
  it('frames the metadata length, the metadata and the envelope, in that order', () => {
    const metadata = {
      daemonId: 'fy_daemon_x',
      publicKey: 'k',
      nonce: 'n',
      signature: 's',
      action: 'create',
      kind: 'public',
      sequence: 1,
      notAfter: '2026-11-07T09:00:00.000Z',
      fetchVerifier: 'v',
      envelopeSha256: 'h',
      envelopeBytes: 3,
    } as const;
    const envelope = Uint8Array.of(1, 2, 3);
    const body = encodeLinkUploadBody(metadata, envelope);
    const length = readUint32(body, 0);
    should(JSON.parse(utf8Text(body.subarray(4, 4 + length)) ?? '')).eql(metadata);
    should([...body.subarray(4 + length)]).eql([1, 2, 3]);
  });
});
