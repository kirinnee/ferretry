import { describe, it } from 'bun:test';
import should from 'should';
import { holdsCredential } from '../../../src/lib/local-skill-installs/credentials.ts';

describe('the credential test that refuses a copy', () => {
  it('should refuse an address with a password in it', () => {
    should(holdsCredential('git clone https://me:s3cretvalue@example.com/repo.git')).be.true();
    should(holdsCredential('see postgres://user:pw@db:5432/app?x=1\nmore')).be.true();
  });

  it('should leave an address alone when no password is in it', () => {
    should(holdsCredential('https://example.com/a@b')).be.false();
    should(holdsCredential('ssh://git@example.com/repo')).be.false();
    should(holdsCredential('https://me:@example.com/')).be.false();
    should(holdsCredential('https://me:${PASSWORD}@example.com/')).be.false();
    should(holdsCredential('https://example.com/ then user:pw@host')).be.false();
    should(holdsCredential('https://example.com')).be.false();
  });

  it('should refuse a long value assigned to a secret-looking name', () => {
    should(holdsCredential('API_KEY=abcdef0123456789abcdef')).be.true();
    should(holdsCredential('export GITHUB_TOKEN="ghp_abcdef0123456789abcdef";')).be.true();
    should(holdsCredential('run --auth-token=abcdef0123456789abcdef now')).be.true();
  });

  it('should leave alone what is short, referenced, or not a secret by name', () => {
    should(holdsCredential('API_KEY=short')).be.false();
    should(holdsCredential('API_KEY=$OTHER_VARIABLE_NAME_HERE')).be.false();
    should(holdsCredential('API_KEY=<your key goes here, 20 chars>')).be.false();
    should(holdsCredential('PATH=/usr/local/bin:/usr/bin:/bin:/sbin')).be.false();
    should(holdsCredential('=abcdefghijklmnopqrstuvwxyz')).be.false();
    should(holdsCredential('bad name!KEY=abcdefghijklmnopqrstuvwxyz')).be.false();
    should(holdsCredential('Plain prose that talks about a password.')).be.false();
  });
});
