import { describe, it } from 'bun:test';
import should from 'should';
import { firstCredentialLine } from '../../daemon/lib/installs/credentials.ts';

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

  it('should name the exact line, whatever the line breaks and whichever pass finds it', () => {
    const KEY = `API_KEY=${LONG}`;
    should(firstCredentialLine(KEY)).equal(1);
    should(firstCredentialLine(`#!/bin/sh\n${KEY}\necho filled\n`)).equal(2);
    should(firstCredentialLine(`a\nb\nc\n${KEY}\nd`)).equal(4);
    should(firstCredentialLine(`a\r\nb\r\n${KEY}\r\nd\r\n`)).equal(3);
    should(firstCredentialLine(`a\r\n\r\nb\r\n${KEY}`)).equal(4);
    should(firstCredentialLine(`#!/bin/sh\nAPI_\u202EKEY=${LONG}\necho filled\n`)).equal(2);
    should(firstCredentialLine(`one\ntwo\nAPI_KEY=abcdef01234\n56789abcdef\nfive`)).equal(3);
    should(firstCredentialLine(`one\r\n\r\ntwo\r\nAPI_KEY=abcdef01234\r\n\r\n56789abcdef\r\nsix`)).equal(4);
    should(firstCredentialLine(`one\ntwo\nAPI_\nKEY=${LONG}\nfive`)).equal(4);
  });

  it('should name the line a credential that survives only in the joined text starts on', () => {
    should(firstCredentialLine('sk-1234567890\n1234567890\n! API_KEY=abcdef01234\n56789abcdef')).equal(3);
    should(firstCredentialLine('fill \n"API_KEY=abcdef01234\n56789abcdef')).equal(2);
    should(firstCredentialLine('word \ntoken\n:abcdef01234\n56789abcdef')).equal(2);
    should(firstCredentialLine('sk-1234567890\n1234567890\n! one\nAPI_KEY=abcdef01234\n56789abcdef')).equal(4);
    should(firstCredentialLine('one \n\nghp_0123456789\nabcdefghijklmnopqrstuvwxyz')).equal(3);
    should(firstCredentialLine('one\ntwo ghp_0123456789\nabcdefghijklmnopqrstuvwxyz')).equal(2);
    should(firstCredentialLine('one\ncurl -u me:\npassword1 now')).equal(2);
    should(firstCredentialLine('one\nhttps://h/?a=b&api_key=abcdef01234\n56789abcdef')).equal(2);
    should(firstCredentialLine('pad\n\nhttps://h/?x=1&\napi_key=abcdef0123456789abcdef')).equal(4);
    should(firstCredentialLine('pad\nhttps://h/?x=1&pre\napi_key=abcdef0123456789abcdef')).equal(3);
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

  it('should refuse a credential in an address query, and leave short or referenced ones', () => {
    should(firstCredentialLine(`curl https://api.example.com/v1?token=${LONG}`)).equal(1);
    should(firstCredentialLine(`see\n"https://api.example.com/v1?page=2&access_token=${LONG}"`)).equal(2);
    should(firstCredentialLine(`https://api.example.com/v1?api_key=${LONG}&x=1`)).equal(1);
    should(firstCredentialLine('https://api.example.com/v1?token=short')).be.undefined();
    should(firstCredentialLine('https://api.example.com/v1?token=${TOKEN_FROM_THE_ENVIRONMENT}')).be.undefined();
    should(firstCredentialLine(`https://api.example.com/v1?page=${LONG}`)).be.undefined();
    should(firstCredentialLine(`https://api.example.com/v1?=${LONG}`)).be.undefined();
    should(firstCredentialLine(`https://api.example.com/v1?token`)).be.undefined();
    should(firstCredentialLine(`https://api.example.com/v1/token=${LONG}`)).be.undefined();
  });

  it('should refuse a PEM private key block, whatever its kind', () => {
    should(firstCredentialLine('a\n-----BEGIN RSA PRIVATE KEY-----\nMIIEfake\n-----END RSA PRIVATE KEY-----')).equal(2);
    should(firstCredentialLine('-----BEGIN PRIVATE KEY-----')).equal(1);
    should(firstCredentialLine('-----BEGIN OPENSSH PRIVATE KEY-----')).equal(1);
    should(firstCredentialLine('-----begin encrypted private key-----')).equal(1);
    should(firstCredentialLine('x\n-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQfake')).equal(2);
    should(firstCredentialLine('-----BEGIN PGP PUBLIC KEY BLOCK-----')).be.undefined();
    should(firstCredentialLine('x\n-----BEGIN PUBLIC KEY-----\n-----BEGIN CERTIFICATE-----')).be.undefined();
    should(firstCredentialLine('Generate a private key with openssl genrsa')).be.undefined();
  });

  it('should refuse a well-known token on its own, in prose, a quote or a header', () => {
    for (const token of [
      `ghp_${'0'.repeat(36)}`,
      `github_pat_${'1'.repeat(30)}`,
      `sk-ant-api03-${'2'.repeat(20)}`,
      `xoxb-${'3'.repeat(12)}-${'4'.repeat(12)}`,
      `AKIA${'5'.repeat(16)}`,
      `glpat-${'6'.repeat(20)}`,
    ]) {
      should(firstCredentialLine(token)).equal(1);
      should(firstCredentialLine(`one\nuse it: "${token}" now`)).equal(2);
      should(firstCredentialLine(`env FOO=${token}`)).equal(1);
      should(firstCredentialLine(`Use ${token}.`)).equal(1);
      should(firstCredentialLine(`one\nUse ${token}. Then stop.`)).equal(2);
    }
  });

  it('should leave a word that only starts like a token, or is too short, alone', () => {
    should(firstCredentialLine('sk-learn-is-a-python-library-name')).be.undefined();
    should(firstCredentialLine('ghp_short1')).be.undefined();
    should(firstCredentialLine(`AKIA${'7'.repeat(8)}`)).be.undefined();
    should(firstCredentialLine(`ghp_${'0'.repeat(30)}!`)).be.undefined();
    should(firstCredentialLine(`prefix-ghp_${'0'.repeat(36)}`)).be.undefined();
  });

  it('should take the earliest of a name, an address, a key block and a token on one line', () => {
    should(firstCredentialLine(`-----BEGIN PRIVATE KEY----- API_KEY=${LONG}`)).equal(1);
    should(firstCredentialLine(`a\nAPI_KEY=${LONG}\n-----BEGIN PRIVATE KEY-----`)).equal(2);
  });
});

describe('the credential test on a hostile file', () => {
  const SIZE = 256 * 1024;
  const BOUND_MS = 500;
  const repeated = (unit: string): string => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
  const hostile: readonly (readonly [string, string])[] = [
    ['-u words only', repeated('-u ')],
    ['one curl word, then -u words', `curl ${repeated('-u ')}`],
    ['curl words and -u words', repeated('curl -u ')],
    ['--user words and attached logins', repeated('curl --user x ')],
    ['one line of quote marks, ended by a letter', `${'"'.repeat(SIZE)}x`],
    ['a long word that ends in quote marks and a letter', `${'a'.repeat(SIZE / 2)}${'"'.repeat(SIZE / 2)}x`],
    ['quote marks one to a word', repeated('" ')],
    ['a name followed by equals signs', `api_key ${repeated('= ')}`],
    ['a name, then equals signs with colons', `token: ${repeated('= : ')}`],
    ['names with nothing after them', repeated('api_key= ')],
    ['addresses with no end', repeated('http://a:b')],
    ['question marks and ampersands', repeated('x?token=&')],
    ['PEM openings that never close', repeated('-----BEGIN ABC DEF ')],
    ['PGP openings that never close', repeated('-----BEGIN PGP PRIVATE KEY ')],
    ['a word made of full stops', `ghp_${'.'.repeat(SIZE)}`],
    ['full stops one to a word', repeated('. ')],
    ['token prefixes that never reach the length', repeated('ghp_1 ')],
    ['lines', repeated('a\n')],
    ['joined lines', repeated('api_\nkey\n')],
    ['joined lines ending in a credential', `${repeated('a \n')}api_\nkey=${LONG}`],
  ];

  for (const [name, text] of hostile) {
    it(`should scan ${name} in well under a second`, () => {
      // The fastest of three runs: one GC pause on a shared runner is not a slow scan, a catastrophic pattern is.
      const runs = [0, 1, 2].map(() => {
        const started = performance.now();
        firstCredentialLine(text);
        return performance.now() - started;
      });
      should(Math.min(...runs)).be.below(BOUND_MS);
    });
  }
});
