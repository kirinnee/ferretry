import { describe, it } from 'bun:test';
import should from 'should';
import {
  findRawSecrets,
  looksLikeRawSecret,
  RAW_SECRET_FIX,
  RAW_SECRET_MESSAGE,
  shannonEntropy,
} from '../../../src/lib/config-files/secrets.ts';

/**
 * Fixtures are assembled at run time from a prefix and a filler, so no file in the repository ever
 * contains a string that looks like a real credential to a secret scanner.
 */
const filler = (length: number, alphabet = 'A1B2'): string =>
  alphabet.repeat(Math.ceil(length / alphabet.length)).slice(0, length);

/** A dollar sign, so a reference is built here rather than written as a template-looking literal. */
const DOLLAR = '$';

/** A value that is random-looking to the entropy test: 20 distinct characters. */
const RANDOM_LOOKING = 'q7Zk2PxV9mLw4TnR8sBd';

const KNOWN_SHAPES: readonly (readonly [string, string])[] = [
  ['sk-ant-', `sk-ant-${filler(10)}`],
  ['sk-or-', `sk-or-${filler(10)}`],
  ['sk-', `sk-${filler(16)}`],
  ['sk-proj-', `sk-proj-${filler(20)}`],
  ['AKIA', `AKIA${filler(16)}`],
  ['ASIA', `ASIA${filler(16)}`],
  ['ghp_', `ghp_${filler(24)}`],
  ['gho_', `gho_${filler(24)}`],
  ['ghu_', `ghu_${filler(24)}`],
  ['ghs_', `ghs_${filler(24)}`],
  ['ghr_', `ghr_${filler(24)}`],
  ['github_pat_', `github_pat_${filler(24)}`],
  ['xoxb-', `xoxb-${filler(12)}`],
  ['xoxa-', `xoxa-${filler(12)}`],
  ['xoxp-', `xoxp-${filler(12)}`],
  ['xoxr-', `xoxr-${filler(12)}`],
  ['xoxs-', `xoxs-${filler(12)}`],
  ['gsk_', `gsk_${filler(24)}`],
  ['csk-', `csk-${filler(24)}`],
  ['AIza', `AIza${filler(32)}`],
  ['glpat-', `glpat-${filler(18)}`],
];

describe('looksLikeRawSecret — a known key shape', () => {
  it.each(KNOWN_SHAPES)('should flag a %s value under a key that names nothing secret', (_prefix, input) => {
    // Act
    const actual = looksLikeRawSecret('description', input);

    // Assert
    should(actual).be.true();
  });

  it.each(KNOWN_SHAPES)('should flag a %s value with no key at all, and under an array index', (_prefix, input) => {
    // Act + Assert
    should(looksLikeRawSecret(undefined, input)).be.true();
    should(looksLikeRawSecret(3, input)).be.true();
  });

  it('should flag a shape found inside a longer sentence', () => {
    // Arrange
    const input = `export the key ${KNOWN_SHAPES[0]?.[1] ?? ''} before you start`;

    // Act
    const actual = looksLikeRawSecret('notes', input);

    // Assert
    should(actual).be.true();
  });

  it.each([
    ['a prefix that is too short', `sk-${filler(15)}`],
    ['a prefix in the middle of a word', `task-force-${filler(20)}`],
    ['an AWS id of the wrong length', `AKIA${filler(15)}`],
    ['an AWS id with trailing characters', `AKIA${filler(16)}Z9`],
    ['a prefix of a different family', `ghx_${filler(24)}`],
    ['plain prose', 'the quick brown fox'],
  ])('should not flag %s', (_label, input) => {
    // Act
    const actual = looksLikeRawSecret('description', input);

    // Assert
    should(actual).be.false();
  });
});

describe('looksLikeRawSecret — a high-entropy value under a credential key', () => {
  it.each([
    'API_KEY',
    'apiKey',
    'apikey',
    'ANTHROPIC_AUTH_TOKEN',
    'authToken',
    'client_secret',
    'DB_PASSWORD',
    'passwd',
    'credential',
    'credentials',
  ])('should flag a random-looking value under %s', key => {
    // Act
    const actual = looksLikeRawSecret(key, RANDOM_LOOKING);

    // Assert
    should(actual).be.true();
  });

  it('should ignore the whitespace around a value when it measures it', () => {
    // Act
    const actual = looksLikeRawSecret('API_KEY', `  ${RANDOM_LOOKING}\n`);

    // Assert
    should(actual).be.true();
  });

  it.each(['name', 'description', 'keyboard', 'tokenizer', 'model'])(
    'should not flag the same value under %s — the key names nothing secret',
    key => {
      // Act
      const actual = looksLikeRawSecret(key, RANDOM_LOOKING);

      // Assert
      should(actual).be.false();
    },
  );

  it('should not apply the key rule to an array item or to a bare value', () => {
    // Act + Assert
    should(looksLikeRawSecret(0, RANDOM_LOOKING)).be.false();
    should(looksLikeRawSecret(undefined, RANDOM_LOOKING)).be.false();
  });

  it.each([
    ['a secret reference', `${DOLLAR}{secret:ANTHROPIC_API_KEY}`],
    ['a padded reference', `  ${DOLLAR}{secret:ANTHROPIC_API_KEY}  `],
    ['a braced reference', `${DOLLAR}{ANTHROPIC_API_KEY_VALUE}`],
    ['a $NAME reference', '$ANTHROPIC_API_KEY_VALUE'],
    ['an https URL', 'https://example.com/.well-known/jwks-q7Zk2PxV9mLw4TnR8sBd'],
    ['a custom-scheme URL', 'vault+tls://q7Zk2PxV9mLw4TnR8sBd.internal'],
    ['an absolute path', '/etc/ssl/private/q7Zk2PxV9mLw4TnR8sBd.key'],
    ['a home path', '~/.ssh/q7Zk2PxV9mLw4TnR8sBd'],
    ['a relative path', './keys/q7Zk2PxV9mLw4TnR8sBd'],
    ['a short value', 'q7Zk2PxV9mLw4Tn'],
    ['a value with spaces', 'correct horse battery staple long enough'],
    ['a long run of one character', 'a'.repeat(32)],
    ['a long low-entropy word', 'passwordpasswordpassword'],
    ['an empty value', ''],
  ])('should not flag %s', (_label, input) => {
    // Act
    const actual = looksLikeRawSecret('API_KEY', input);

    // Assert
    should(actual).be.false();
  });

  it('should draw the length line at sixteen characters', () => {
    // Arrange
    const sixteen = 'abcdefghijklmnop';
    const fifteen = 'abcdefghijklmno';

    // Act + Assert
    should(looksLikeRawSecret('API_KEY', sixteen)).be.true();
    should(looksLikeRawSecret('API_KEY', fifteen)).be.false();
  });
});

describe('shannonEntropy', () => {
  it.each([
    ['', 0],
    ['aaaa', 0],
    ['abab', 1],
    ['abcd', 2],
    ['abcdefgh', 3],
    ['aabbccdd', 2],
  ])('should measure %j as %d bits per character', (input, expected) => {
    // Act
    const actual = shannonEntropy(input);

    // Assert
    should(actual).equal(expected);
  });

  it('should count a character outside the basic plane once, not as two halves', () => {
    // Act + Assert
    should(shannonEntropy('😀😀😀😀')).equal(0);
    should(shannonEntropy('😀🙂😀🙂')).equal(1);
  });
});

describe('findRawSecrets', () => {
  it('should answer nothing for a document with no secret in it', () => {
    // Arrange
    const input = {
      harness: 'claude',
      env: { ANTHROPIC_AUTH_TOKEN: `${DOLLAR}{secret:EXAMPLE_API_KEY}` },
      args: ['--flag'],
    };

    // Act
    const actual = findRawSecrets(input);

    // Assert
    should(actual).deepEqual([]);
  });

  it('should report a secret nested in objects and arrays by its path', () => {
    // Arrange
    const shaped = KNOWN_SHAPES[0]?.[1] ?? '';
    const input = {
      env: { ANTHROPIC_AUTH_TOKEN: RANDOM_LOOKING, ANTHROPIC_BASE_URL: 'https://api.example.com' },
      servers: [{ name: 'one', headers: { apiKey: RANDOM_LOOKING } }, { name: 'two' }],
      notes: ['fine', shaped],
    };

    // Act
    const actual = findRawSecrets(input);

    // Assert
    should(actual.map(finding => finding.path)).deepEqual([
      ['env', 'ANTHROPIC_AUTH_TOKEN'],
      ['servers', 0, 'headers', 'apiKey'],
      ['notes', 1],
    ]);
  });

  it('should name an item of a list by the nearest key above it', () => {
    // Arrange
    const input = {
      api_key: [RANDOM_LOOKING],
      nested: { apiKey: [[RANDOM_LOOKING]], tokens: [{ value: RANDOM_LOOKING }] },
      items: [RANDOM_LOOKING],
      flags: [RANDOM_LOOKING],
    };

    // Act
    const actual = findRawSecrets(input);

    // Assert — `value` is the nearest key of the last one, and it names no credential
    should(actual.map(finding => finding.path)).deepEqual([
      ['api_key', 0],
      ['nested', 'apiKey', 0, 0],
    ]);
  });

  it('should flag an item of a list under a plural credential name such as api_keys', () => {
    // Act
    const actual = findRawSecrets({ api_keys: [RANDOM_LOOKING] });

    // Assert
    should(actual.map(finding => finding.path)).deepEqual([['api_keys', 0]]);
  });

  it('should report a bare string document at the empty path', () => {
    // Arrange
    const input = KNOWN_SHAPES[0]?.[1] ?? '';

    // Act
    const actual = findRawSecrets(input);

    // Assert
    should(actual).deepEqual([{ path: [] }]);
  });

  it('should pass over numbers, booleans, null and undefined', () => {
    // Arrange
    const input = { count: 5, on: true, nothing: null, missing: undefined, nested: [1, false, null] };

    // Act
    const actual = findRawSecrets(input);

    // Assert
    should(actual).deepEqual([]);
  });

  it('should never put the value, or any part of it, into a finding', () => {
    // Arrange
    const input = { API_KEY: RANDOM_LOOKING, nested: [{ note: KNOWN_SHAPES[4]?.[1] ?? '' }] };

    // Act
    const actual = JSON.stringify(findRawSecrets(input));

    // Assert
    should(actual).not.containEql(RANDOM_LOOKING);
    should(actual).not.containEql(KNOWN_SHAPES[4]?.[1] ?? '');
    should(actual).not.containEql('AKIA');
  });
});

describe('the sentences a finding is reported with', () => {
  it('should name the fix without ever holding a value', () => {
    // Assert
    should(RAW_SECRET_FIX).containEql('fy secret set NAME');
    should(RAW_SECRET_FIX).containEql(`${DOLLAR}{secret:NAME}`);
    should(RAW_SECRET_MESSAGE).containEql('raw secret');
  });
});
