import { describe, it } from 'bun:test';
import should from 'should';
import { RAW_SECRET_MESSAGE, RAW_TEXT_SECRET_MESSAGE, rawSecretFix } from '../../../host/config/secrets.ts';

/** A dollar sign, so a reference is built here rather than written as a template-looking literal. */
const DOLLAR = '$';

describe('the sentences a finding is reported with', () => {
  it('should name the fix without ever holding a value', () => {
    // Assert
    should(rawSecretFix('fy')).containEql('fy secret set NAME');
    should(rawSecretFix('fy')).containEql(`${DOLLAR}{secret:NAME}`);
    should(RAW_SECRET_MESSAGE).containEql('raw secret');
  });

  it('should say what was found in the raw text without the value', () => {
    // Assert
    should(RAW_TEXT_SECRET_MESSAGE).containEql('a comment or a tag counts');
    should(RAW_TEXT_SECRET_MESSAGE).not.containEql('sk-');
  });
});
