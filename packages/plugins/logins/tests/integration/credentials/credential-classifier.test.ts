import { describe, it } from 'bun:test';
import should from 'should';
import {
  CREDENTIAL_FINGERPRINT_LENGTH,
  credentialFingerprint,
} from '../../../daemon/adapters/credentials/credential-classifier.ts';

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

  it('digests the WHOLE material rather than a parsed token', () => {
    // Arrange — bytes this build cannot parse are exactly the case where a replacement matters most,
    // so a digest must still exist for them.
    const blob = 'this is not the JSON any harness writes';

    // Act
    const actual = credentialFingerprint(blob);

    // Assert
    should(actual).match(/^[0-9a-f]+$/u);
    should(actual).not.equal(credentialFingerprint(`${blob}!`));
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
