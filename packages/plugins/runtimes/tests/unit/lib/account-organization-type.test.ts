import { describe, it } from 'bun:test';
import should from 'should';
import { organizationTypeOfAccountDocument } from '../../../daemon/lib/account-organization-type.ts';

describe('the organisation type of a Claude account file', () => {
  it('should read the one non-secret field and nothing else', () => {
    should(
      organizationTypeOfAccountDocument(
        JSON.stringify({ oauthAccount: { organizationType: 'claude_max', emailAddress: 'a@b.c' }, other: 'x' }),
      ),
    ).equal('claude_max');
  });

  it('should answer nothing for no file, malformed text, a missing account and a field that is not a non-empty string', () => {
    for (const text of [
      undefined,
      '{ not json',
      '{}',
      'null',
      '[]',
      JSON.stringify({ oauthAccount: null }),
      JSON.stringify({ oauthAccount: { organizationType: 5 } }),
      JSON.stringify({ oauthAccount: { organizationType: '' } }),
    ])
      should(organizationTypeOfAccountDocument(text)).be.undefined();
  });
});
