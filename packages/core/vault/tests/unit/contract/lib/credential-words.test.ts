import { describe, expect, it } from 'bun:test';
import { looksSecretAt, secretNamedAt } from '../../../../contract/lib/credential-words.ts';

// Fake values only. V is a fake 22-character value.
const V = 'fakevalue0000000000000';

describe('the credential vocabulary at two strengths', () => {
  it('R-0261 should read KEY, PASS, PWD, BEARER and BASIC as secret names at the publish strength only, on word boundaries', () => {
    for (const name of ['LICENSE_KEY', '--signing-key', 'DB_PASS', 'PWD', 'BEARER', 'BASIC']) {
      expect(secretNamedAt(name, 'publish')).toBe(true);
      expect(secretNamedAt(name, 'hide')).toBe(false);
    }
    for (const name of ['KEYBOARD', 'MONKEY', 'PASSENGER_NAME', 'KEYSPACE', 'OLDPWD', 'BYPASS', 'PORT']) {
      expect(secretNamedAt(name, 'publish')).toBe(false);
      expect(secretNamedAt(name, 'hide')).toBe(false);
    }
    for (const strength of ['hide', 'publish'] as const) expect(secretNamedAt('OPENAI_API_KEY', strength)).toBe(true);
  });

  it('R-0261 should take a publish-only name’s value only as one unbroken piece of 16 or more', () => {
    expect(looksSecretAt('LICENSE_KEY', V, 'publish')).toBe(true);
    expect(looksSecretAt('LICENSE_KEY', V, 'hide')).toBe(false);
    for (const value of [
      '/etc/ssl/server.pem',
      'modified_time',
      'a b c d e f g h i j k l',
      '/home/person/.ssh/id_ed25519',
    ])
      expect(looksSecretAt('LICENSE_KEY', value, 'publish')).toBe(false);
    expect(looksSecretAt('LICENSE_KEY', '$SOME_LONG_VARIABLE_NAME', 'publish')).toBe(false);
    expect(looksSecretAt('GITHUB_TOKEN', 'abcdefghij', 'publish')).toBe(true);
    expect(looksSecretAt('LICENSE_KEY', 'short', 'publish')).toBe(false);
  });
});
