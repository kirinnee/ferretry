import { describe, it } from 'bun:test';
import should from 'should';
import {
  CREDENTIAL_FINGERPRINT_LENGTH,
  credentialFingerprint,
  type CredentialMaterialReader,
  StoreCredentialClassifier,
} from '../../src/adapters/credential-classifier.ts';
import type { CredentialMaterial } from '../../src/lib/identity.ts';
import type { FleetManifestAccount, HarnessKind } from '../../src/lib/manifest.ts';

const NOW = 1_786_000_000_000;

const account = (kind: HarnessKind = 'claude'): FleetManifestAccount =>
  ({
    id: 'acct',
    kind,
    mode: 'auto',
    wrapper: 'fy-acct',
    home: '/tmp/acct',
    displayName: 'acct',
    models: [],
    available: true,
    unavailableReason: null,
  }) as unknown as FleetManifestAccount;

const reader = (material: CredentialMaterial): CredentialMaterialReader => ({ material: async () => material });

const claudeBlob = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt', expiresAt: NOW + 600_000, ...patch } });

const classify = (material: CredentialMaterial, kind: HarnessKind = 'claude') =>
  new StoreCredentialClassifier({ credentials: reader(material), now: () => NOW }).classify(account(kind));

describe('credentialFingerprint', () => {
  it('is stable for the same bytes and different for different bytes', async () => {
    // Arrange / Act — the ONLY property the guard needs: an equality test against one previous value.
    const one = credentialFingerprint('{"accessToken":"aaa"}');
    const again = credentialFingerprint('{"accessToken":"aaa"}');
    const other = credentialFingerprint('{"accessToken":"bbb"}');

    // Assert
    should(one).equal(again);
    should(one).not.equal(other);
  });

  it('does not carry the material it digested', () => {
    // Arrange — this value is persisted and it must not be a token in disguise. Hex only, fixed
    // length, and no substring of the input survives.
    const secret = 'sk-ant-oat01-super-secret-token-value';

    // Act
    const actual = credentialFingerprint(JSON.stringify({ accessToken: secret }));

    // Assert
    should(actual).match(/^[0-9a-f]+$/u);
    should(actual).have.length(CREDENTIAL_FINGERPRINT_LENGTH);
    should(actual).not.containEql('sk-ant');
    should(actual).not.containEql(secret);
  });
});

describe('StoreCredentialClassifier', () => {
  it('classifies a live Claude credential and digests it', async () => {
    // Act
    const actual = await classify({ outcome: 'found', blob: claudeBlob() });

    // Assert
    should(actual.state).equal('valid');
    should(actual.expiresAt).equal(NOW + 600_000);
    should(actual.fingerprint).equal(credentialFingerprint(claudeBlob()));
  });

  it('digests the WHOLE material rather than a parsed token', async () => {
    // Arrange — bytes this build cannot parse are exactly the case where a replacement matters most,
    // so a digest must still exist for them. Parsing first would leave them undetectable — and would
    // put a token in a local variable for no reason.
    const blob = 'this is not the JSON any harness writes';

    // Act
    const actual = await classify({ outcome: 'found', blob });

    // Assert
    should(actual.state).equal('unreadable');
    should(actual.fingerprint).equal(credentialFingerprint(blob));
  });

  it('gives an absent credential NO digest, so "nothing here" never compares equal to a value', async () => {
    // Act
    const actual = await classify({ outcome: 'absent' });

    // Assert
    should(actual).deepEqual({ state: 'missing' });
  });

  it('gives an unreadable READ no digest either, because there were no bytes to digest', async () => {
    // Arrange — a locked keychain or a timed-out read. Distinct from `absent`: one is safe to
    // overwrite and the other is not.
    const actual = await classify({ outcome: 'unreadable', reason: 'the keychain is locked' });

    // Assert
    should(actual).deepEqual({ state: 'unreadable' });
  });

  it('reports an expired Claude access token with a refresh path as renewable, not signed out', async () => {
    // Act
    const actual = await classify({ outcome: 'found', blob: claudeBlob({ expiresAt: NOW - 1 }) });

    // Assert
    should(actual.state).equal('refreshable');
  });

  it('reports an expired Claude token with NO refresh path as a hard negative', async () => {
    // Act
    const actual = await classify({
      outcome: 'found',
      blob: JSON.stringify({ claudeAiOauth: { accessToken: 'at', expiresAt: NOW - 1 } }),
    });

    // Assert — `missing` WITH an expiry, which is what lets the verdict say "expired" rather than
    // "there is nothing here".
    should(actual.state).equal('missing');
    should(actual.expiresAt).equal(NOW - 1);
  });

  it('classifies a Codex credential through its own JWT expiry', async () => {
    // Arrange — Codex keeps expiry as an `exp` claim rather than a field.
    const claims = Buffer.from(JSON.stringify({ exp: Math.floor((NOW + 600_000) / 1_000) })).toString('base64url');
    const blob = JSON.stringify({ tokens: { access_token: `h.${claims}.s`, refresh_token: 'rt' } });

    // Act
    const actual = await classify({ outcome: 'found', blob }, 'codex');

    // Assert
    should(actual.state).equal('valid');
    should(actual.fingerprint).equal(credentialFingerprint(blob));
  });

  it('asks the store for the account’s own harness and home', async () => {
    // Arrange — a classifier that read the wrong home would report one account's credential as
    // another's, which is the mistake the whole per-home identity model exists to prevent.
    const asked: { kind: HarnessKind; home: string }[] = [];
    const subject = new StoreCredentialClassifier({
      credentials: {
        material: async (kind, home) => {
          asked.push({ kind, home });
          return { outcome: 'absent' };
        },
      },
      now: () => NOW,
    });

    // Act
    await subject.classify(account('codex'));

    // Assert
    should(asked).deepEqual([{ kind: 'codex', home: '/tmp/acct' }]);
  });
});
