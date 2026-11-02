import { describe, it } from 'bun:test';
import should from 'should';
import { firstCredentialLine } from '../../../src/lib/local-skill-installs/credentials.ts';

const LONG = 'abcdef0123456789abcdef';

describe('the credential test that refuses a copy', () => {
  it('should refuse an address with a password in it, and name its line', () => {
    should(firstCredentialLine('git clone https://me:s3cretvalue@example.com/repo.git')).equal(1);
    should(firstCredentialLine('one\nsee postgres://user:pw@db:5432/app?x=1\nmore')).equal(2);
  });

  it('should leave an address alone when no password is in it', () => {
    should(firstCredentialLine('https://example.com/a@b')).be.undefined();
    should(firstCredentialLine('ssh://git@example.com/repo')).be.undefined();
    should(firstCredentialLine('https://me:@example.com/')).be.undefined();
    should(firstCredentialLine('https://me:${PASSWORD}@example.com/')).be.undefined();
    should(firstCredentialLine('https://example.com/ then user:pw@host')).be.undefined();
    should(firstCredentialLine('https://example.com')).be.undefined();
  });

  it('should refuse a long value assigned to a secret-looking name', () => {
    should(firstCredentialLine(`API_KEY=${LONG}`)).equal(1);
    should(firstCredentialLine(`export GITHUB_TOKEN="ghp_${LONG}";`)).equal(1);
    should(firstCredentialLine(`run --auth-token=${LONG} now`)).equal(1);
  });

  it('should accept spaced and colon separators, quoted names and values', () => {
    should(firstCredentialLine(`api_key = "sk-${LONG}"`)).equal(1);
    should(firstCredentialLine(`api_key= "sk-${LONG}"`)).equal(1);
    should(firstCredentialLine(`api_key ="sk-${LONG}"`)).equal(1);
    should(firstCredentialLine(`api_key =${LONG}`)).equal(1);
    should(firstCredentialLine(`token: ${LONG}`)).equal(1);
    should(firstCredentialLine(`token : ${LONG}`)).equal(1);
    should(firstCredentialLine(`token :${LONG}`)).equal(1);
    should(firstCredentialLine(`token:${LONG}`)).equal(1);
    should(firstCredentialLine(`"token": "${LONG}",`)).equal(1);
    should(firstCredentialLine(`{"token":"${LONG}"}`)).equal(1);
    should(firstCredentialLine(`  password: '${LONG}'  `)).equal(1);
  });

  it('should read Authorization headers whatever the scheme word', () => {
    should(firstCredentialLine(`Authorization: Bearer ${LONG}`)).equal(1);
    should(firstCredentialLine(`curl -H "Authorization: Bearer ${LONG}" x`)).equal(1);
    should(firstCredentialLine(`Authorization: Basic ${LONG}`)).equal(1);
    should(firstCredentialLine(`Authorization=Bearer ${LONG}`)).equal(1);
    should(firstCredentialLine('Authorization: Bearer short')).be.undefined();
    should(firstCredentialLine('Authorization: Bearer')).be.undefined();
    should(firstCredentialLine('Authorization: Bearer $TOKEN_FROM_THE_ENVIRONMENT')).be.undefined();
  });

  it('should refuse curl -u user:pass and curl --user user:pass', () => {
    should(firstCredentialLine('curl -u me:hunter2 https://example.com')).equal(1);
    should(firstCredentialLine('/usr/bin/curl --user "me:hunter2" https://example.com')).equal(1);
    should(firstCredentialLine('curl -u me https://example.com')).be.undefined();
    should(firstCredentialLine('curl -u me: https://example.com')).be.undefined();
    should(firstCredentialLine('curl -u me:$PASSWORD https://example.com')).be.undefined();
    should(firstCredentialLine('curl -u')).be.undefined();
    should(firstCredentialLine('tool -u me:hunter2')).be.undefined();
    should(firstCredentialLine('curl --silent -s me:hunter2')).be.undefined();
  });

  it('should see a name through invisible characters and look-alike letters', () => {
    should(firstCredentialLine(`API​_KEY=${LONG}`)).equal(1);
    should(firstCredentialLine(`to­ken: ${LONG}`)).equal(1);
    should(firstCredentialLine(`API⟨U+200B⟩_KEY=${LONG}`)).equal(1);
    should(firstCredentialLine(`ＡＰＩ＿ＫＥＹ=${LONG}`)).equal(1);
  });

  it('should count every kind of line break, and read a name or value a line break split', () => {
    should(firstCredentialLine(`a\r\nb\rc\nAPI_KEY=${LONG}`)).equal(4);
    should(firstCredentialLine(`name: demo\ntoken:\n  ${LONG}\n`)).equal(2);
    should(firstCredentialLine(`API_\nKEY=${LONG}`)).equal(2);
    should(firstCredentialLine(`API_KEY=abcdef01234\n56789abcdef`)).equal(1);
  });

  it('should leave alone what is short, referenced, a place, or not a secret by name', () => {
    should(firstCredentialLine('API_KEY=short')).be.undefined();
    should(firstCredentialLine('API_KEY=$OTHER_VARIABLE_NAME_HERE')).be.undefined();
    should(firstCredentialLine('API_KEY=<your key goes here, 20 chars>')).be.undefined();
    should(firstCredentialLine('API_KEY={{ a_value_from_a_template }}')).be.undefined();
    should(firstCredentialLine('API_KEY=[a value from elsewhere]')).be.undefined();
    should(firstCredentialLine('PATH=/usr/local/bin:/usr/bin:/bin:/sbin')).be.undefined();
    should(firstCredentialLine(`=${LONG}`)).be.undefined();
    should(firstCredentialLine(`bad name!KEY=${LONG}`)).be.undefined();
    should(firstCredentialLine(`:${LONG}`)).be.undefined();
    should(firstCredentialLine('Plain prose that talks about a password.')).be.undefined();
    should(firstCredentialLine('the key: /home/me/.ssh/id_ed25519_for_work')).be.undefined();
    should(firstCredentialLine('the key: https://example.com/docs/keys/rotation')).be.undefined();
    should(firstCredentialLine('token = [ref]')).be.undefined();
    should(firstCredentialLine('token\n')).be.undefined();
    should(firstCredentialLine('')).be.undefined();
  });

  it('should still refuse a path-like value after an equals sign', () => {
    should(firstCredentialLine('API_KEY=/a/long/value/that/is/a/key/really')).equal(1);
  });

  it('should take the first of an address and a name when a line has both', () => {
    should(firstCredentialLine(`https://me:pw@host API_KEY=${LONG}`)).equal(1);
    should(firstCredentialLine(`API_KEY=${LONG} https://me:pw@host`)).equal(1);
  });
});
