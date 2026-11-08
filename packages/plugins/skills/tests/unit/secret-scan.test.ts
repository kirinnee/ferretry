import { describe, it } from 'bun:test';
import should from 'should';
import { mayHoldSecret } from '../../daemon/lib/installs/secret-scan.ts';

describe('credentials written into an address', () => {
  it('should flag a password in the user-info part of an address', () => {
    should(mayHoldSecret('clone https://me:pw@example.com/repo')).be.true();
    should(mayHoldSecret('ssh://git@example.com/repo')).be.true();
  });

  it('should find the user-info of a later address after an earlier one without any', () => {
    should(mayHoldSecret('see https://example.com/ then ftp://me:pw@host/x')).be.true();
  });

  it('should leave an address alone when no @ follows it in the same word', () => {
    should(mayHoldSecret('https://example.com is at a@b')).be.false();
    should(mayHoldSecret('https://example.com')).be.false();
  });

  it('should stay broad on purpose: an @ later in the same word still counts as user:pw@host', () => {
    should(mayHoldSecret('https://example.com/a@b')).be.true();
    should(mayHoldSecret('https://example.com?mail=a@b')).be.true();
    should(mayHoldSecret('https://example.com#a@b')).be.true();
  });
});
