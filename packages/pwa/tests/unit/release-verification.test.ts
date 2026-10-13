import { describe, it } from 'bun:test';
import should from 'should';

import { UNSIGNED_RELEASE_SIGNATURE, formatReleaseSignature, toBase64Url } from '../../src/lib/release-manifest.ts';
import {
  RELEASE_REFUSAL_WORDS,
  type ReleaseDecision,
  type ReleaseTrust,
  firstUseTrust,
  verifyReleaseFile,
  verifyReleaseManifest,
} from '../../src/lib/release-verification.ts';
import { buildRelease, bytesOf, releaseSigner } from '../support/release.ts';

const SIGNED_ONLY = { allowUnsigned: false } as const;

const refusalOf = (decision: ReleaseDecision): string | undefined =>
  decision.accepted || decision.unverified === true ? undefined : decision.refusal;

describe('verifyReleaseManifest', () => {
  it('accepts a release signed by the pinned key and records it as installed', async () => {
    // Arrange
    const signer = await releaseSigner();
    const release = await buildRelease(signer, { version: '1.2.3', createdAt: '2026-10-02T00:00:00.000Z' });

    // Act
    const actual = await verifyReleaseManifest(release, firstUseTrust(signer.publicKey), SIGNED_ONLY);

    // Assert
    should(actual.accepted).be.true();
    if (!actual.accepted) return;
    should(actual.manifest).eql(release.manifest);
    should(actual.trust).eql({
      keys: [signer.publicKey],
      installed: { version: '1.2.3', createdAt: '2026-10-02T00:00:00.000Z' },
    });
  });

  it('refuses a release signed by a key that was never pinned', async () => {
    // Arrange
    const pinned = await releaseSigner();
    const stranger = await releaseSigner();
    const release = await buildRelease(stranger);

    // Act
    const actual = await verifyReleaseManifest(release, firstUseTrust(pinned.publicKey), SIGNED_ONLY);

    // Assert
    should(refusalOf(actual)).equal('unknown-key');
  });

  it('refuses a stranger who claims the pinned key by its fingerprint', async () => {
    // Arrange
    const pinned = await releaseSigner();
    const stranger = await releaseSigner();
    const release = await buildRelease(stranger);
    const forged = formatReleaseSignature(pinned.fingerprint, await stranger.sign(release.manifestBytes));

    // Act
    const actual = await verifyReleaseManifest(
      { ...release, signatureText: forged },
      firstUseTrust(pinned.publicKey),
      SIGNED_ONLY,
    );

    // Assert
    should(refusalOf(actual)).equal('bad-signature');
  });

  it('refuses a list whose bytes changed after it was signed', async () => {
    // Arrange
    const signer = await releaseSigner();
    const release = await buildRelease(signer);
    const tampered = bytesOf(new TextDecoder().decode(release.manifestBytes).replace('1.0.0', '9.0.0'));

    // Act
    const actual = await verifyReleaseManifest(
      { manifestBytes: tampered, signatureText: release.signatureText },
      firstUseTrust(signer.publicKey),
      SIGNED_ONLY,
    );

    // Assert
    should(refusalOf(actual)).equal('bad-signature');
  });

  it('refuses a signature against a pinned key that cannot be decoded', async () => {
    // Arrange: a stored trust whose key is not base64url, but whose "fingerprint" cannot match either.
    const signer = await releaseSigner();
    const release = await buildRelease(signer);
    const trust: ReleaseTrust = { keys: ['not base64url!', signer.publicKey], installed: null };

    // Act
    const actual = await verifyReleaseManifest(release, trust, SIGNED_ONLY);

    // Assert
    should(actual.accepted).be.true();
  });

  it('refuses a pinned key that is not an Ed25519 key at all', async () => {
    // Arrange: 44 bytes that hash to the claimed fingerprint but are no SPKI.
    const junk = new Uint8Array(44).fill(7);
    const signer = await releaseSigner();
    const release = await buildRelease(signer);
    const fingerprint = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', junk)));
    const signatureText = formatReleaseSignature(fingerprint, await signer.sign(release.manifestBytes));

    // Act
    const actual = await verifyReleaseManifest(
      { manifestBytes: release.manifestBytes, signatureText },
      { keys: [toBase64Url(junk)], installed: null },
      SIGNED_ONLY,
    );

    // Assert
    should(refusalOf(actual)).equal('bad-signature');
  });

  it.each([
    ['an empty signature file', ''],
    ['a signature with a short fingerprint', 'abc.def'],
    ['a signature that is not 64 bytes', `${'A'.repeat(43)}.${toBase64Url(new Uint8Array(10))}`],
    ['three parts', `${'A'.repeat(43)}.${toBase64Url(new Uint8Array(64))}.x`],
  ])('refuses %s as damaged', async (_name, signatureText) => {
    // Arrange
    const signer = await releaseSigner();
    const release = await buildRelease(signer);

    // Act
    const actual = await verifyReleaseManifest(
      { ...release, signatureText },
      firstUseTrust(signer.publicKey),
      SIGNED_ONLY,
    );

    // Assert
    should(refusalOf(actual)).equal('malformed');
  });

  it('refuses a correctly signed list that is not a valid release', async () => {
    // Arrange
    const signer = await releaseSigner();
    const manifestBytes = bytesOf('{"version":"1.0.0"}');
    const signatureText = formatReleaseSignature(signer.fingerprint, await signer.sign(manifestBytes));

    // Act
    const actual = await verifyReleaseManifest(
      { manifestBytes, signatureText },
      firstUseTrust(signer.publicKey),
      SIGNED_ONLY,
    );

    // Assert
    should(refusalOf(actual)).equal('malformed');
  });

  it.each([
    ['an older version', { version: '0.9.0', createdAt: '2026-10-05T00:00:00.000Z' }],
    ['the same version made earlier', { version: '1.0.0', createdAt: '2026-09-01T00:00:00.000Z' }],
  ])('refuses %s than the one installed', async (_name, older) => {
    // Arrange
    const signer = await releaseSigner();
    const release = await buildRelease(signer, older);
    const trust: ReleaseTrust = {
      keys: [signer.publicKey],
      installed: { version: '1.0.0', createdAt: '2026-10-01T00:00:00.000Z' },
    };

    // Act
    const actual = await verifyReleaseManifest(release, trust, SIGNED_ONLY);

    // Assert
    should(refusalOf(actual)).equal('older');
  });

  it('accepts the very release that is installed, so a re-check is not a refusal', async () => {
    // Arrange
    const signer = await releaseSigner();
    const release = await buildRelease(signer);
    const trust: ReleaseTrust = {
      keys: [signer.publicKey],
      installed: { version: '1.0.0', createdAt: '2026-10-01T00:00:00.000Z' },
    };

    // Act
    const actual = await verifyReleaseManifest(release, trust, SIGNED_ONLY);

    // Assert
    should(actual.accepted).be.true();
  });

  it('refuses the unsigned marker where unsigned builds are not allowed', async () => {
    // Arrange
    const signer = await releaseSigner();
    const release = await buildRelease(signer);

    // Act
    const actual = await verifyReleaseManifest(
      { ...release, signatureText: `${UNSIGNED_RELEASE_SIGNATURE}\n` },
      firstUseTrust(signer.publicKey),
      SIGNED_ONLY,
    );

    // Assert
    should(refusalOf(actual)).equal('unsigned');
  });

  it('answers "unverified" for the unsigned marker on a developer machine, accepting nothing', async () => {
    // Arrange
    const signer = await releaseSigner();
    const release = await buildRelease(signer);

    // Act
    const actual = await verifyReleaseManifest(
      { ...release, signatureText: UNSIGNED_RELEASE_SIGNATURE },
      firstUseTrust(signer.publicKey),
      { allowUnsigned: true },
    );

    // Assert
    should(actual).eql({ accepted: false, unverified: true });
  });

  it('pins an announced next key beside the signing key', async () => {
    // Arrange
    const current = await releaseSigner();
    const next = await releaseSigner();
    const release = await buildRelease(current, { nextKey: next.publicKey });

    // Act
    const actual = await verifyReleaseManifest(release, firstUseTrust(current.publicKey), SIGNED_ONLY);

    // Assert
    should(actual.accepted && actual.trust.keys).eql([current.publicKey, next.publicKey]);
  });

  it('retires the old key the first time the announced key signs a release', async () => {
    // Arrange
    const old = await releaseSigner();
    const next = await releaseSigner();
    const release = await buildRelease(next, { version: '1.1.0' });
    const trust: ReleaseTrust = { keys: [old.publicKey, next.publicKey], installed: null };

    // Act
    const actual = await verifyReleaseManifest(release, trust, SIGNED_ONLY);

    // Assert
    should(actual.accepted && actual.trust.keys).eql([next.publicKey]);
  });

  it('treats a release that announces its own key as no rotation', async () => {
    // Arrange
    const signer = await releaseSigner();
    const release = await buildRelease(signer, { nextKey: signer.publicKey });

    // Act
    const actual = await verifyReleaseManifest(release, firstUseTrust(signer.publicKey), SIGNED_ONLY);

    // Assert
    should(actual.accepted && actual.trust.keys).eql([signer.publicKey]);
  });
});

describe('verifyReleaseFile', () => {
  it.each([
    ['the listed bytes', 'assets/app-1.js', 'console.log(1)', true],
    ['changed bytes', 'assets/app-1.js', 'console.log(2)', false],
    ['a path the list does not name', 'assets/other.js', 'console.log(1)', false],
  ])('answers %s', async (_name, path, text, expected) => {
    // Arrange
    const release = await buildRelease(await releaseSigner());

    // Act
    const actual = await verifyReleaseFile(release.manifest, path, bytesOf(text));

    // Assert
    should(actual).equal(expected);
  });
});

describe('RELEASE_REFUSAL_WORDS', () => {
  it('says every refusal in plain words, with no internal vocabulary', () => {
    for (const words of Object.values(RELEASE_REFUSAL_WORDS)) {
      should(words).not.match(/manifest|hash|service worker|spki|ed25519/iu);
    }
  });
});
