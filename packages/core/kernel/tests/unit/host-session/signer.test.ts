import { describe, expect, it } from 'bun:test';
import { createIdentitySigner, SIGNER_USERS, signerFor } from '../../../host/session/signer.ts';
import {
  catalogSignedBytes,
  claimTranscript,
  concatBytes,
  decodeClaim,
  fromBase64UrlFixed,
  lengthPrefixed,
  linkStoreTranscript,
  NONCE_BYTES,
  toBase64Url,
  tunnelTranscript,
  utf8Bytes,
  verifyCatalogSignature,
  verifyLinkStoreRequest,
  verifySecretOfferSignature,
  verifyRendezvousClaim,
  verifyTunnelRequest,
} from '../../../host/session/wire/index.ts';
import { newDaemonIdentity, relayCrypto } from './identities.ts';

const host = 'relay.example.test';
const nonceText = (): string => toBase64Url(relayCrypto.randomBytes(NONCE_BYTES));
const be32 = (value: number): Uint8Array =>
  new Uint8Array([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);

describe('identity signer: the rendezvous claim', () => {
  it('signs the claim layout: label (not length-prefixed), then LP(protocol), LP(daemonId), LP(host), LP(nonce)', async () => {
    const identity = await newDaemonIdentity();
    const nonce = relayCrypto.randomBytes(NONCE_BYTES);
    const expected = concatBytes([
      utf8Bytes('ferretry-relay-claim-v1'),
      be32(16),
      utf8Bytes('ferretry-relay/1'),
      be32(identity.daemonId.length),
      utf8Bytes(identity.daemonId),
      be32(host.length),
      utf8Bytes(host),
      be32(NONCE_BYTES),
      nonce,
    ]);
    expect(claimTranscript({ daemonId: identity.daemonId, relayHost: host, challenge: nonce })).toEqual(expected);
    const signed = await createIdentitySigner(identity).sign({ host, nonce: toBase64Url(nonce) });
    expect(signed.daemonId).toBe(identity.daemonId);
    expect(signed.publicKey).toBe(toBase64Url(identity.publicKeySpki));
    const signature = fromBase64UrlFixed(signed.signature, 64) as Uint8Array;
    expect(await relayCrypto.verifyEd25519(identity.publicKeySpki, signature, expected)).toBe(true);
  });

  it('a signed claim verifies with the existing verifier; a wrong host or nonce is refused', async () => {
    const identity = await newDaemonIdentity();
    const nonce = nonceText();
    const signed = await createIdentitySigner(identity).sign({ host, nonce });
    const claim = decodeClaim(signed.publicKey, signed.signature);
    expect(claim).not.toBeNull();
    const challenge = fromBase64UrlFixed(nonce, NONCE_BYTES) as Uint8Array;
    const context = { daemonId: identity.daemonId, relayHost: host, challenge };
    expect((await verifyRendezvousClaim(relayCrypto, context, claim!)).ok).toBe(true);
    expect((await verifyRendezvousClaim(relayCrypto, { ...context, relayHost: 'evil.test' }, claim!)).ok).toBe(false);
    const otherNonce = fromBase64UrlFixed(nonceText(), NONCE_BYTES) as Uint8Array;
    expect((await verifyRendezvousClaim(relayCrypto, { ...context, challenge: otherNonce }, claim!)).ok).toBe(false);
  });

  it('refuses a malformed nonce or an empty host before signing anything', async () => {
    const identity = await newDaemonIdentity();
    let signed = 0;
    const counted = {
      ...identity,
      sign: async (bytes: Uint8Array) => {
        signed += 1;
        return await identity.sign(bytes);
      },
    };
    const signer = createIdentitySigner(counted);
    await expect(signer.sign({ host, nonce: 'short' })).rejects.toThrow(TypeError);
    await expect(signer.sign({ host, nonce: `${nonceText()}=` })).rejects.toThrow(TypeError);
    await expect(signer.sign({ host: '', nonce: nonceText() })).rejects.toThrow(TypeError);
    expect(signed).toBe(0);
  });

  it('offers no way to read the key: the signer has exactly its fixed-label methods', async () => {
    const signer = createIdentitySigner(await newDaemonIdentity());
    expect(Object.keys(signer).sort()).toEqual(['sign', 'signCatalog', 'signLinkStoreRequest', 'signSecretOffer', 'signTunnel']);
    expect(Object.isFrozen(signer)).toBe(true);
  });
});

describe('identity signer: tunnel requests', () => {
  const todaysTranscript = (label: string, daemonId: string, nonce: Uint8Array, port: string): Uint8Array =>
    concatBytes([
      utf8Bytes(label),
      lengthPrefixed(utf8Bytes('ferretry-tunnel/1')),
      lengthPrefixed(utf8Bytes(daemonId)),
      lengthPrefixed(utf8Bytes(host)),
      lengthPrefixed(nonce),
      lengthPrefixed(utf8Bytes(port)),
    ]);

  it('a provision signs today’s exact transcript, with the origin port, and verifies', async () => {
    const identity = await newDaemonIdentity();
    const nonce = relayCrypto.randomBytes(NONCE_BYTES);
    const signed = await createIdentitySigner(identity).signTunnel({
      action: 'provision',
      host,
      nonce: toBase64Url(nonce),
      originPort: 8443,
    });
    expect(signed).toMatchObject({
      daemonId: identity.daemonId,
      nonce: toBase64Url(nonce),
      publicKey: toBase64Url(identity.publicKeySpki),
    });
    const expected = todaysTranscript('ferretry-tunnel-provision-v1', identity.daemonId, nonce, '8443');
    expect(
      tunnelTranscript({ action: 'provision', daemonId: identity.daemonId, host, nonce, originPort: 8443 }),
    ).toEqual(expected);
    const signature = fromBase64UrlFixed(signed.signature, 64) as Uint8Array;
    expect(await relayCrypto.verifyEd25519(identity.publicKeySpki, signature, expected)).toBe(true);
    const context = { action: 'provision' as const, daemonId: identity.daemonId, host, nonce, originPort: 8443 };
    expect(await verifyTunnelRequest(relayCrypto, context, signed)).toEqual({ ok: true });
    // A port changed in between redirects the ingress: refused.
    expect((await verifyTunnelRequest(relayCrypto, { ...context, originPort: 9000 }, signed)).ok).toBe(false);
  });

  it('a release signs today’s exact transcript (empty port) and verifies', async () => {
    const identity = await newDaemonIdentity();
    const nonce = relayCrypto.randomBytes(NONCE_BYTES);
    const signed = await createIdentitySigner(identity).signTunnel({
      action: 'release',
      host,
      nonce: toBase64Url(nonce),
    });
    const expected = todaysTranscript('ferretry-tunnel-release-v1', identity.daemonId, nonce, '');
    const signature = fromBase64UrlFixed(signed.signature, 64) as Uint8Array;
    expect(await relayCrypto.verifyEd25519(identity.publicKeySpki, signature, expected)).toBe(true);
    expect(
      await verifyTunnelRequest(relayCrypto, { action: 'release', daemonId: identity.daemonId, host, nonce }, signed),
    ).toEqual({
      ok: true,
    });
  });

  it('a provision signature does not verify as a release, nor as a rendezvous claim', async () => {
    const identity = await newDaemonIdentity();
    const nonce = relayCrypto.randomBytes(NONCE_BYTES);
    const signer = createIdentitySigner(identity);
    const signed = await signer.signTunnel({ action: 'provision', host, nonce: toBase64Url(nonce) });
    const asRelease = { action: 'release' as const, daemonId: identity.daemonId, host, nonce };
    expect((await verifyTunnelRequest(relayCrypto, asRelease, signed)).ok).toBe(false);
    const claim = decodeClaim(signed.publicKey, signed.signature)!;
    const asClaim = { daemonId: identity.daemonId, relayHost: host, challenge: nonce };
    expect((await verifyRendezvousClaim(relayCrypto, asClaim, claim)).ok).toBe(false);
  });

  it('refuses an unknown action, a bad port or a malformed nonce', async () => {
    const signer = createIdentitySigner(await newDaemonIdentity());
    const nonce = nonceText();
    await expect(signer.signTunnel({ action: 'delete' as 'release', host, nonce })).rejects.toThrow(TypeError);
    await expect(signer.signTunnel({ action: 'provision', host, nonce, originPort: 0 })).rejects.toThrow(TypeError);
    await expect(signer.signTunnel({ action: 'provision', host, nonce, originPort: 1.5 })).rejects.toThrow(TypeError);
    await expect(signer.signTunnel({ action: 'release', host, nonce: 'AAAA' })).rejects.toThrow(TypeError);
  });
});

describe('identity signer: catalog signatures', () => {
  const canonical = utf8Bytes('{"catalogId":"cat_x","publisher":"fy_daemon_x"}');

  it('signs today’s layout, label ‖ 0x00 ‖ SHA-256(canonical), and verifies with verifyCatalogSignature', async () => {
    const identity = await newDaemonIdentity();
    const signed = await createIdentitySigner(identity).signCatalog({ kind: 'manifest', canonical });
    const digest = await relayCrypto.sha256(canonical);
    const expected = concatBytes([utf8Bytes('ferretry-catalog-manifest-v1'), new Uint8Array([0]), digest]);
    expect(catalogSignedBytes('manifest', digest)).toEqual(expected);
    const signature = fromBase64UrlFixed(signed.signature, 64) as Uint8Array;
    expect(await relayCrypto.verifyEd25519(identity.publicKeySpki, signature, expected)).toBe(true);
    expect(signed).toMatchObject({ daemonId: identity.daemonId, publicKey: toBase64Url(identity.publicKeySpki) });
    expect(await verifyCatalogSignature(relayCrypto, signed.publicKey, 'manifest', canonical, signed.signature)).toBe(
      true,
    );
  });

  it('a manifest signature does not verify as versions, as a link, as other bytes, nor as a claim', async () => {
    const identity = await newDaemonIdentity();
    const signed = await createIdentitySigner(identity).signCatalog({ kind: 'manifest', canonical });
    expect(await verifyCatalogSignature(relayCrypto, signed.publicKey, 'versions', canonical, signed.signature)).toBe(
      false,
    );
    expect(await verifyCatalogSignature(relayCrypto, signed.publicKey, 'link', canonical, signed.signature)).toBe(
      false,
    );
    expect(
      await verifyCatalogSignature(relayCrypto, signed.publicKey, 'manifest', utf8Bytes('{}'), signed.signature),
    ).toBe(false);
    const nonce = (await relayCrypto.sha256(canonical)).slice(0, NONCE_BYTES);
    const claim = decodeClaim(signed.publicKey, signed.signature)!;
    expect(
      (
        await verifyRendezvousClaim(
          relayCrypto,
          { daemonId: identity.daemonId, relayHost: host, challenge: nonce },
          claim,
        )
      ).ok,
    ).toBe(false);
  });

  it('refuses an unknown kind or a canonical that is not bytes', async () => {
    const signer = createIdentitySigner(await newDaemonIdentity());
    await expect(signer.signCatalog({ kind: 'offer' as 'link', canonical })).rejects.toThrow(TypeError);
    await expect(signer.signCatalog({ kind: 'link', canonical: '{}' as unknown as Uint8Array })).rejects.toThrow(
      TypeError,
    );
  });
});

describe('kernel.signer: each signature is offered only to the plugin that needs it', () => {
  it('Connections may sign claims and tunnel requests; Catalogs may sign catalogs; nobody else signs anything', async () => {
    const signer = createIdentitySigner(await newDaemonIdentity());
    const nonce = nonceText();
    expect(Object.keys(SIGNER_USERS).sort()).toEqual(['sign', 'signCatalog', 'signLinkStoreRequest', 'signSecretOffer', 'signTunnel']);
    const connections = signerFor('connections', signer);
    expect((await connections.sign({ host, nonce })).signature.length).toBeGreaterThan(0);
    await expect(connections.signCatalog({ kind: 'manifest', canonical: utf8Bytes('{}') })).rejects.toThrow(TypeError);
    const catalogs = signerFor('catalogs', signer);
    expect(
      (await catalogs.signCatalog({ kind: 'versions', canonical: utf8Bytes('{}') })).signature.length,
    ).toBeGreaterThan(0);
    await expect(catalogs.sign({ host, nonce })).rejects.toThrow(TypeError);
    const board = signerFor('board', signer);
    await expect(board.sign({ host, nonce })).rejects.toThrow(
      'board may not ask the daemon identity for that signature.',
    );
    await expect(board.signTunnel({ action: 'release', host, nonce })).rejects.toThrow(TypeError);
    await expect(board.signCatalog({ kind: 'link', canonical: utf8Bytes('{}') })).rejects.toThrow(TypeError);
  });
});

describe('identity signer: secret-import offers (Vault)', () => {
  const request = {
    v: 1,
    importId: 'imp_abc',
    publicKey: toBase64Url(new Uint8Array(32).fill(7)),
    expiresAt: '2026-11-07T10:00:00.000Z',
  };

  it('signs today’s offerSignedBytes: every field length-prefixed, the label first', async () => {
    const identity = await newDaemonIdentity();
    const signed = await createIdentitySigner(identity).signSecretOffer(request);
    expect(signed.daemonId).toBe(identity.daemonId);
    expect(signed.identityKey).toBe(toBase64Url(identity.publicKeySpki));
    const expected = concatBytes(
      [
        'ferretry-secret-import-offer-v1',
        '1',
        request.importId,
        identity.daemonId,
        signed.identityKey,
        request.publicKey,
        request.expiresAt,
      ].map(field => lengthPrefixed(utf8Bytes(field))),
    );
    const signature = fromBase64UrlFixed(signed.signature, 64) as Uint8Array;
    expect(await relayCrypto.verifyEd25519(identity.publicKeySpki, signature, expected)).toBe(true);
    const offer = { ...request, ...signed };
    expect(await verifySecretOfferSignature(relayCrypto, offer)).toBe(true);
    expect(await verifySecretOfferSignature(relayCrypto, { ...offer, expiresAt: '2026-11-08T10:00:00.000Z' })).toBe(
      false,
    );
    const other = await newDaemonIdentity();
    expect(await verifySecretOfferSignature(relayCrypto, { ...offer, daemonId: other.daemonId })).toBe(false);
  });

  it('an offer signature verifies as no catalog signature and no claim; only Vault may ask for one', async () => {
    const identity = await newDaemonIdentity();
    const signer = createIdentitySigner(identity);
    const signed = await signer.signSecretOffer(request);
    expect(
      await verifyCatalogSignature(relayCrypto, signed.identityKey, 'manifest', utf8Bytes('{}'), signed.signature),
    ).toBe(false);
    await expect(signerFor('connections', signer).signSecretOffer(request)).rejects.toThrow(TypeError);
    expect((await signerFor('vault', signer).signSecretOffer(request)).signature).toBe(signed.signature);
    await expect(signer.signSecretOffer({ ...request, importId: '' })).rejects.toThrow(TypeError);
  });
});

describe('identity signer: link-store requests (Catalogs) — R594', () => {
  const nonce = (): Uint8Array => relayCrypto.randomBytes(NONCE_BYTES);
  const field = (text: string): Uint8Array => lengthPrefixed(utf8Bytes(text));
  const json = (value: unknown): Uint8Array => utf8Bytes(JSON.stringify(value));
  const upload = {
    request: 'upload',
    bundleId: 'lnk_abc',
    action: 'create',
    kind: 'catalog',
    sequence: 3,
    notAfter: '2026-11-08T00:00:00.000Z',
    fetchVerifier: 'verifier',
    envelopeSha256: 'digest',
    envelopeBytes: 512,
  } as const;
  const head = (daemonId: string, bytes: Uint8Array): Uint8Array[] => [
    field('ferretry-link-store/1'),
    field(daemonId),
    field(host),
    lengthPrefixed(bytes),
  ];

  it('R594 an upload signs today’s exact transcript (label, protocol, daemon, host, nonce, then every field) and verifies', async () => {
    const identity = await newDaemonIdentity();
    const bytes = nonce();
    const expected = concatBytes([
      utf8Bytes('ferretry-link-store-upload-v1'),
      ...head(identity.daemonId, bytes),
      field('lnk_abc'),
      field('create'),
      field('catalog'),
      field('3'),
      field(''),
      field('2026-11-08T00:00:00.000Z'),
      field(''),
      field(''),
      field('verifier'),
      field('digest'),
      field('512'),
    ]);
    const signed = await createIdentitySigner(identity).signLinkStoreRequest({
      host,
      nonce: bytes,
      canonicalBody: json(upload),
    });
    expect(signed.daemonId).toBe(identity.daemonId);
    expect(Object.keys(signed).sort()).toEqual(['daemonId', 'publicKey', 'signature']);
    expect(
      await relayCrypto.verifyEd25519(
        fromBase64UrlFixed(signed.publicKey, 44)!,
        fromBase64UrlFixed(signed.signature, 64)!,
        expected,
      ),
    ).toBe(true);
    const context = { daemonId: identity.daemonId, host, nonce: bytes, body: upload };
    expect(
      (await verifyLinkStoreRequest(relayCrypto, context, { ...signed, nonce: toBase64Url(bytes) })).ok,
    ).toBe(true);
    expect(linkStoreTranscript(context)).toEqual(expected);
  });

  it('R594 delete and status each have their own label, and a status sorts its ids', async () => {
    const identity = await newDaemonIdentity();
    const bytes = nonce();
    const signer = createIdentitySigner(identity);
    const del = await signer.signLinkStoreRequest({
      host,
      nonce: bytes,
      canonicalBody: json({ request: 'delete', bundleId: 'lnk_abc' }),
    });
    const ctx = { daemonId: identity.daemonId, host, nonce: bytes };
    const asDelete = { ...ctx, body: { request: 'delete', bundleId: 'lnk_abc' } } as const;
    expect((await verifyLinkStoreRequest(relayCrypto, asDelete, { ...del, nonce: toBase64Url(bytes) })).ok).toBe(true);
    expect(linkStoreTranscript(asDelete)).toEqual(
      concatBytes([utf8Bytes('ferretry-link-store-delete-v1'), ...head(identity.daemonId, bytes), field('lnk_abc')]),
    );
    // a delete signature is not a status signature for the same id
    const asStatus = { ...ctx, body: { request: 'status', bundleIds: ['lnk_abc'] } } as const;
    expect((await verifyLinkStoreRequest(relayCrypto, asStatus, { ...del, nonce: toBase64Url(bytes) })).ok).toBe(false);
    const status = await signer.signLinkStoreRequest({
      host,
      nonce: bytes,
      canonicalBody: json({ request: 'status', bundleIds: ['b', 'a'] }),
    });
    const sorted = { ...ctx, body: { request: 'status', bundleIds: ['a', 'b'] } } as const;
    expect((await verifyLinkStoreRequest(relayCrypto, sorted, { ...status, nonce: toBase64Url(bytes) })).ok).toBe(true);
    expect(linkStoreTranscript(sorted)).toEqual(
      concatBytes([utf8Bytes('ferretry-link-store-status-v1'), ...head(identity.daemonId, bytes), field('a,b')]),
    );
  });

  it('R594 the signature does not verify for another host, another nonce or another daemon', async () => {
    const identity = await newDaemonIdentity();
    const bytes = nonce();
    const signed = await createIdentitySigner(identity).signLinkStoreRequest({
      host,
      nonce: bytes,
      canonicalBody: json({ request: 'delete', bundleId: 'lnk_abc' }),
    });
    const base = { daemonId: identity.daemonId, host, nonce: bytes, body: { request: 'delete', bundleId: 'lnk_abc' } } as const;
    const request = { ...signed, nonce: toBase64Url(bytes) };
    expect((await verifyLinkStoreRequest(relayCrypto, { ...base, host: 'other.example.test' }, request)).ok).toBe(false);
    expect((await verifyLinkStoreRequest(relayCrypto, { ...base, nonce: nonce() }, request)).ok).toBe(false);
    expect((await verifyLinkStoreRequest(relayCrypto, { ...base, body: { request: 'delete', bundleId: 'other' } }, request)).ok).toBe(false);
  });

  it('refuses a short nonce, an empty host, text that is not exactly a request, and anything signed for the wrong shape — before the key is used', async () => {
    const identity = await newDaemonIdentity();
    let signed = 0;
    const signer = createIdentitySigner({
      ...identity,
      sign: async (bytes: Uint8Array) => {
        signed += 1;
        return await identity.sign(bytes);
      },
    });
    const good = json({ request: 'delete', bundleId: 'lnk_abc' });
    await expect(signer.signLinkStoreRequest({ host, nonce: new Uint8Array(8), canonicalBody: good })).rejects.toThrow(TypeError);
    await expect(signer.signLinkStoreRequest({ host: '', nonce: nonce(), canonicalBody: good })).rejects.toThrow(TypeError);
    for (const bad of [
      utf8Bytes('not json'),
      json({ request: 'delete' }),
      json({ request: 'delete', bundleId: 'lnk_abc', extra: 1 }),
      json({ request: 'download', bundleId: 'lnk_abc' }),
      json({ ...upload, sequence: -1 }),
      json({ ...upload, action: 'destroy' }),
      new Uint8Array([0xff, 0xfe]),
    ])
      await expect(signer.signLinkStoreRequest({ host, nonce: nonce(), canonicalBody: bad })).rejects.toThrow(TypeError);
    await expect(
      signer.signLinkStoreRequest({ host, nonce: nonce(), canonicalBody: '{}' as unknown as Uint8Array }),
    ).rejects.toThrow(TypeError);
    expect(signed).toBe(0);
  });

  it('only Catalogs may ask', async () => {
    const signer = createIdentitySigner(await newDaemonIdentity());
    const request = { host, nonce: nonce(), canonicalBody: json({ request: 'delete', bundleId: 'lnk_abc' }) };
    expect((await signerFor('catalogs', signer).signLinkStoreRequest(request)).signature.length).toBeGreaterThan(0);
    for (const other of ['connections', 'vault', 'board'])
      await expect(signerFor(other, signer).signLinkStoreRequest(request)).rejects.toThrow(TypeError);
  });
});
