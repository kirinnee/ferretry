import { describe, it } from 'bun:test';
import should from 'should';

import { UNSIGNED_RELEASE_SIGNATURE, formatReleaseSignature, toBase64Url } from '../../src/lib/release-manifest.ts';
import {
  type InstalledOrder,
  RELEASE_REFUSAL_WORDS,
  type ReleaseDecision,
  checkReleaseSignature,
  releaseKeyChain,
  verifyReleaseFile,
  verifyReleaseManifest,
} from '../../src/lib/release-verification.ts';
import { buildRelease, bytesOf, releaseSigner } from '../support/release.ts';

const SIGNED_ONLY = { allowUnsigned: false } as const;

const refusalOf = (decision: ReleaseDecision): string | undefined =>
  decision.accepted || decision.unverified === true ? undefined : decision.refusal;

const installedAt = (sequence: number, commit = 'abcdef1', signerRank = 0): InstalledOrder => ({
  sequence,
  commit,
  signerRank,
});

describe('verifyReleaseManifest', () => {
  it('accepts a first release signed by the compiled-in key', async () => {
    // Arrange
    const signer = await releaseSigner();
    const release = await buildRelease(signer, { version: '1.2.3', sequence: 7 });

    // Act
    const actual = await verifyReleaseManifest(release, [signer.publicKey], null, SIGNED_ONLY);

    // Assert
    should(actual).eql({ accepted: true, manifest: release.manifest, signerRank: 0, standing: 'first' });
  });

  it('refuses a release signed by a key the chain does not hold', async () => {
    // Arrange
    const trusted = await releaseSigner();
    const stranger = await releaseSigner();

    // Act
    const actual = await verifyReleaseManifest(await buildRelease(stranger), [trusted.publicKey], null, SIGNED_ONLY);

    // Assert
    should(refusalOf(actual)).equal('unknown-key');
  });

  it('refuses a stranger who claims the trusted key by its fingerprint', async () => {
    // Arrange
    const trusted = await releaseSigner();
    const stranger = await releaseSigner();
    const release = await buildRelease(stranger);
    const forged = formatReleaseSignature(trusted.fingerprint, await stranger.sign(release.manifestBytes));

    // Act
    const actual = await verifyReleaseManifest(
      { ...release, signatureText: forged },
      [trusted.publicKey],
      null,
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
      [signer.publicKey],
      null,
      SIGNED_ONLY,
    );

    // Assert
    should(refusalOf(actual)).equal('bad-signature');
  });

  it('skips a chain key that cannot be decoded', async () => {
    // Arrange
    const signer = await releaseSigner();
    const release = await buildRelease(signer);

    // Act
    const actual = await verifyReleaseManifest(release, ['not base64url!', signer.publicKey], null, SIGNED_ONLY);

    // Assert
    should(actual.accepted && actual.signerRank).equal(1);
  });

  it('refuses a chain key that is not an Ed25519 key at all', async () => {
    // Arrange: 44 bytes that hash to the claimed fingerprint but are no SPKI.
    const junk = new Uint8Array(44).fill(7);
    const signer = await releaseSigner();
    const release = await buildRelease(signer);
    const fingerprint = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', junk)));
    const signatureText = formatReleaseSignature(fingerprint, await signer.sign(release.manifestBytes));

    // Act
    const actual = await verifyReleaseManifest(
      { manifestBytes: release.manifestBytes, signatureText },
      [toBase64Url(junk)],
      null,
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
    const actual = await verifyReleaseManifest({ ...release, signatureText }, [signer.publicKey], null, SIGNED_ONLY);

    // Assert
    should(refusalOf(actual)).equal('malformed');
  });

  it('refuses a correctly signed list that is not a valid release', async () => {
    // Arrange
    const signer = await releaseSigner();
    const manifestBytes = bytesOf('{"version":"1.0.0"}');
    const signatureText = formatReleaseSignature(signer.fingerprint, await signer.sign(manifestBytes));

    // Act
    const actual = await verifyReleaseManifest({ manifestBytes, signatureText }, [signer.publicKey], null, SIGNED_ONLY);

    // Assert
    should(refusalOf(actual)).equal('malformed');
  });

  it.each([
    ['a lower sequence, whatever its version says', { sequence: 4, version: '9.0.0' }],
    ['the same sequence from a different commit', { sequence: 5, commit: 'fffffff' }],
  ])('refuses %s as older', async (_name, older) => {
    // Arrange
    const signer = await releaseSigner();
    const release = await buildRelease(signer, older);

    // Act
    const actual = await verifyReleaseManifest(release, [signer.publicKey], installedAt(5), SIGNED_ONLY);

    // Assert
    should(refusalOf(actual)).equal('older');
  });

  it('accepts a higher sequence as newer, whatever its version and commit time say', async () => {
    // Arrange
    const signer = await releaseSigner();
    const release = await buildRelease(signer, {
      sequence: 6,
      version: '0.1.0',
      createdAt: '2001-01-01T00:00:00.000Z',
    });

    // Act
    const actual = await verifyReleaseManifest(release, [signer.publicKey], installedAt(5), SIGNED_ONLY);

    // Assert
    should(actual.accepted && actual.standing).equal('newer');
  });

  it('answers "same" for the very release that is installed, so a re-check is not a refusal', async () => {
    // Arrange
    const signer = await releaseSigner();
    const release = await buildRelease(signer, { sequence: 5 });

    // Act
    const actual = await verifyReleaseManifest(release, [signer.publicKey], installedAt(5), SIGNED_ONLY);

    // Assert
    should(actual.accepted && actual.standing).equal('same');
  });

  it('refuses a newer release signed by a key ranked below the one that signed the installed release', async () => {
    // Arrange: the installed release was signed by the rotated-in key (rank 1).
    const old = await releaseSigner();
    const next = await releaseSigner();
    const release = await buildRelease(old, { sequence: 9 });

    // Act
    const actual = await verifyReleaseManifest(
      release,
      [old.publicKey, next.publicKey],
      installedAt(5, 'abcdef1', 1),
      SIGNED_ONLY,
    );

    // Assert
    should(refusalOf(actual)).equal('unknown-key');
  });

  it('refuses the unsigned marker where unsigned builds are not allowed', async () => {
    // Arrange
    const signer = await releaseSigner();
    const release = await buildRelease(signer);

    // Act
    const actual = await verifyReleaseManifest(
      { ...release, signatureText: `${UNSIGNED_RELEASE_SIGNATURE}\n` },
      [signer.publicKey],
      null,
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
      [signer.publicKey],
      null,
      { allowUnsigned: true },
    );

    // Assert
    should(actual).eql({ accepted: false, unverified: true });
  });
});

describe('releaseKeyChain', () => {
  it('is the compiled-in key alone when nothing endorses another', async () => {
    const signer = await releaseSigner();
    should(await releaseKeyChain(signer.publicKey, [await buildRelease(signer)])).eql([signer.publicKey]);
  });

  it('adds each key announced by a release that verifies under the chain, in any stored order', async () => {
    // Arrange: compiled → second → third, stored newest first.
    const compiled = await releaseSigner();
    const second = await releaseSigner();
    const third = await releaseSigner();
    const first = await buildRelease(compiled, { nextKey: second.publicKey });
    const later = await buildRelease(second, { sequence: 2, nextKey: third.publicKey });

    // Act
    const actual = await releaseKeyChain(compiled.publicKey, [later, first]);

    // Assert
    should(actual).eql([compiled.publicKey, second.publicKey, third.publicKey]);
  });

  it('ignores an endorsement nobody in the chain signed, and one that announces a key twice', async () => {
    // Arrange
    const compiled = await releaseSigner();
    const attacker = await releaseSigner();
    const forged = await buildRelease(attacker, { nextKey: attacker.publicKey });
    const self = await buildRelease(compiled, { nextKey: compiled.publicKey });

    // Act
    const actual = await releaseKeyChain(compiled.publicKey, [forged, self]);

    // Assert
    should(actual).eql([compiled.publicKey]);
  });

  it('checks each endorsement with the check it is given', async () => {
    // Arrange
    const compiled = await releaseSigner();
    const next = await releaseSigner();
    const endorsement = await buildRelease(compiled, { nextKey: next.publicKey });
    const asked: number[] = [];

    // Act
    const actual = await releaseKeyChain(compiled.publicKey, [endorsement], async (release, chain) => {
      asked.push(chain.length);
      return await checkReleaseSignature(release, chain, SIGNED_ONLY);
    });

    // Assert
    should(actual).eql([compiled.publicKey, next.publicKey]);
    should(asked).eql([1, 2]);
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
