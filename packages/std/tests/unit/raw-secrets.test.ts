import { describe, it } from 'bun:test';
import should from 'should';
import {
  findRawSecrets,
  looksLikeRawSecret,
  rawTextHoldsSecret,
  rawTextSecretLine,
  shannonEntropy,
} from '../../src/credential-words/index.ts';

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

  it('should report a token-shaped KEY by the object that holds it, never by a path that contains the key', () => {
    // Arrange
    const name = KNOWN_SHAPES[6]?.[1] ?? '';
    const input = { env: { ok: true, [name]: { nested: RANDOM_LOOKING } }, [name]: 1 };

    // Act
    const actual = findRawSecrets(input);

    // Assert
    should(actual.map(finding => finding.path)).deepEqual([['env'], []]);
    should(actual.map(finding => finding.atKey)).deepEqual([['env', name], [name]]);
    should(JSON.stringify(actual.map(finding => finding.path))).not.containEql(name);
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

describe('rawTextSecretLine — the raw text, comments and tags included', () => {
  it('should find a key in a comment, by its line and nothing else', () => {
    // Arrange
    const text = `limit: 5\n# the old key ${KNOWN_SHAPES[0]?.[1] ?? ''}\n`;

    // Act / Assert
    should(rawTextSecretLine(text)).equal(2);
    should(rawTextHoldsSecret(text)).be.true();
  });

  it('should find a key written as a tag or after a value on the same line', () => {
    // Act / Assert
    should(rawTextSecretLine(`note: !${KNOWN_SHAPES[0]?.[1] ?? ''} x\n`)).equal(1);
    should(rawTextSecretLine(`limit: 5\nnote: ok # ${KNOWN_SHAPES[6]?.[1] ?? ''}\n`)).equal(2);
  });

  it('should find nothing in a file of references, a modeline and ordinary comments', () => {
    // Arrange
    const text = [
      '# yaml-language-server: $schema=../.schema/voice.json',
      '# the key lives in the secret store',
      `apiKey: ${DOLLAR}{secret:WORK_KEY}`,
      'limit: 5',
      '',
    ].join('\n');

    // Act / Assert
    should(rawTextSecretLine(text)).be.undefined();
    should(rawTextHoldsSecret(text)).be.false();
  });
});

/**
 * The scan reads every line by hand and shows no pattern more than a window of a line (R6 critical: the line pattern it
 * replaced backtracked cubically on blanks). Its answers are the old pattern's, checked against that pattern as an
 * oracle on short lines, where its backtracking costs nothing.
 */
describe('rawTextSecretLine — linear, and the same answers as the pattern it replaced', () => {
  /** The line pattern the scan replaced, kept here only as the oracle. */
  const OLD_KEY_VALUE_LINE = /^\s*(?:-\s+)?["']?([^:"'#]+?)["']?\s*:\s*["']?(.+?)["']?\s*$/u;
  const OLD_SHAPES = [
    /\bsk-ant-[A-Za-z0-9_-]{8,}/u,
    /\bsk-or-[A-Za-z0-9_-]{8,}/u,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/u,
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/u,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/u,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/u,
    /\bgsk_[A-Za-z0-9]{20,}/u,
    /\bcsk-[A-Za-z0-9]{20,}/u,
    /\bAIza[0-9A-Za-z_-]{30,}/u,
    /\bglpat-[A-Za-z0-9_-]{16,}/u,
  ];
  const oldLooksLike = (key: string | undefined, value: string): boolean => {
    if (OLD_SHAPES.some(shape => shape.test(value))) return true;
    if (key === undefined || !/(?:(?:key|token|secret|password|passwd)s?|credentials?)$/iu.test(key)) return false;
    const trimmed = value.trim();
    if (/^\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)$/u.test(trimmed) || trimmed.length < 16 || /\s/u.test(trimmed))
      return false;
    if (/^(?:[a-z][a-z0-9+.-]*:\/\/|[/~.])/iu.test(trimmed)) return false;
    return shannonEntropy(trimmed) >= 3.5;
  };
  const oldLine = (line: string): boolean => {
    if (oldLooksLike(undefined, line)) return true;
    const pair = OLD_KEY_VALUE_LINE.exec(line);
    return pair?.[1] !== undefined && pair[2] !== undefined && oldLooksLike(pair[1], pair[2]);
  };

  /** A small seeded generator, so a failure names a line that can be replayed. */
  const random = (seed: number) => () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const PIECES = [
    ' ',
    '  ',
    '\t',
    '-',
    '- ',
    '"',
    "'",
    ':',
    ': ',
    '#',
    'a',
    'token',
    'API_KEY',
    'Secrets',
    'x y',
    RANDOM_LOOKING,
    `${DOLLAR}{secret:X}`,
    `${DOLLAR}NAME`,
    'https://',
    '/path',
    'sk-',
    filler(20),
    '.',
    '"tok"',
    'ghp_',
  ];

  it('should answer exactly as the old pattern on 20 000 generated lines', () => {
    // Arrange
    const next = random(7);
    const disagreements: string[] = [];

    // Act
    for (let count = 0; count < 20_000; count += 1) {
      const pieces = Math.floor(next() * 9) + 1;
      let line = '';
      for (let index = 0; index < pieces; index += 1) line += PIECES[Math.floor(next() * PIECES.length)] ?? '';
      if ((rawTextSecretLine(line) === 1) !== oldLine(line)) disagreements.push(JSON.stringify(line));
    }

    // Assert
    should(disagreements).deepEqual([]);
  });

  it.each([
    ['a plain key', `token: ${RANDOM_LOOKING}`],
    ['a quoted key and value', `"api_key": "${RANDOM_LOOKING}"`],
    ['a key quoted with blanks inside', `'secret  ': ${RANDOM_LOOKING}`],
    ['a list item', `  - password: '${RANDOM_LOOKING}'`],
    ['blanks around the colon', `credentials   :    ${RANDOM_LOOKING}   `],
    ['a comment', `# token: ${RANDOM_LOOKING}`],
    ['a dash with no blank', `-token: ${RANDOM_LOOKING}`],
    ['a reference', `token: ${DOLLAR}{secret:WORK_KEY}`],
    ['a path', `ssh_key: ~/.ssh/${RANDOM_LOOKING}`],
  ])('should agree with the old pattern on %s', (_label, line) => {
    // Act / Assert
    should(rawTextSecretLine(line) === 1).equal(oldLine(line));
  });

  /** A hard bound per call, far above one linear pass. */
  const BOUND_MS = 1500;
  const KIB = 1024;
  let nested = '';
  for (let depth = 0; nested.length < 254 * KIB; depth += 1) nested += `${' '.repeat(depth)}k:\n`;

  it.each([
    ['one 256 KiB line of spaces', ' '.repeat(256 * KIB)],
    ['a value padded with 256 KiB of spaces', `a: x${' '.repeat(256 * KIB - 8)}y`],
    ['a key padded with 256 KiB of spaces', `token${' '.repeat(256 * KIB - 12)}: x`],
    ['block indentation 700 deep', nested],
    ['256 KiB of quotes, colons and blanks', '" : \' '.repeat(43 * KIB)],
    ['256 KiB of key prefixes', 'sk-'.repeat(85 * KIB)],
    ['a 256 KiB credential value', `token: ${RANDOM_LOOKING.repeat(13 * KIB)}`],
  ])('should scan %s in under 1500 ms (R6 critical)', (_label, text) => {
    // Act
    const started = performance.now();
    rawTextSecretLine(text);

    // Assert
    should(performance.now() - started).be.below(BOUND_MS);
  });

  it('should find a key shape wherever a window of a long line cuts it, and nothing a cut could fake', () => {
    // Arrange: a key, and a near-miss, placed at every offset around the first few window edges of a long line.
    const shapes = [`sk-ant-${filler(10)}`, `AKIA${filler(16, 'A1')}`, `AIza${filler(32)}`, `ghp_${filler(24)}`];
    const misses = [`xsk-ant-${filler(10)}`, `AKIA${filler(17, 'A1')}`, `AIza${filler(29)}`, `sk-ant-${filler(7)}`];
    const disagreements: string[] = [];

    // Act
    for (const edge of [4032, 8064, 12_096]) {
      for (let offset = -70; offset <= 70; offset += 1) {
        for (const [index, word] of [...shapes, ...misses].entries()) {
          for (const pad of ['a', ' ']) {
            const at = edge + offset;
            const line = `${pad.repeat(at)}${word}${pad.repeat(Math.max(0, 16_500 - at - word.length))}`;
            if (looksLikeRawSecret(undefined, line) !== oldLooksLike(undefined, line))
              disagreements.push(`${String(index)}@${String(at)}/${JSON.stringify(pad)}`);
          }
        }
      }
    }

    // Assert
    should(disagreements).deepEqual([]);
  });

  /**
   * A fake match glued in front of a real key (R7): `x` + `sk-ant-AAAA-` + `sk-ant-…`. In the window that BORROWS the
   * fake's first character, that character starts a match at index 0 which runs on through the real key; a scan that
   * found it and only then skipped it resumed after its end, and the real key — cut by the window before — was found
   * by neither. Every glued pair, at every offset around every window edge, padded with a word character or a blank.
   */
  const GLUED = [
    [`sk-ant-${filler(4)}-`, `sk-ant-${filler(200)}`],
    [`sk-${filler(4)}-`, `sk-${filler(200)}`],
    [`glpat-${filler(4)}-`, `glpat-${filler(200)}`],
    [`sk-or-${filler(4)}-`, `sk-or-${filler(200)}`],
    [`xoxb-${filler(4)}-`, `xoxb-${filler(200)}`],
  ] as const;

  it('should find a real key glued behind a fake one at offset 4030, where the old scan did (R7 minor)', () => {
    for (const [fake, real] of GLUED) {
      // Arrange: `x` at 4030, so the fake's first character is the one window 2 borrows (4031).
      const line = `${'a'.repeat(4030)}x${fake}${real}${'a'.repeat(9000)}`;

      // Act / Assert
      should(oldLooksLike(undefined, line)).be.true();
      should(looksLikeRawSecret(undefined, line)).be.true();
    }
  });

  it('should agree with the old scan on a glued fake and real key at every offset around every window edge', () => {
    // Arrange
    const disagreements: string[] = [];

    // Act: windows start every 4 032 characters, each borrowing the one before (4 031, 8 063, …).
    for (const edge of [4031, 8063, 12_095, 16_127]) {
      for (let offset = -70; offset <= 70; offset += 1) {
        for (const [index, [fake, real]] of GLUED.entries()) {
          for (const pad of ['a', ' ', '-']) {
            const at = edge + offset;
            const word = `x${fake}${real}`;
            const line = `${pad.repeat(at - 1)}${word}${pad.repeat(Math.max(0, 20_500 - at - word.length))}`;
            if (looksLikeRawSecret(undefined, line) !== oldLooksLike(undefined, line))
              disagreements.push(`${String(index)}@${String(at)}/${JSON.stringify(pad)}`);
          }
        }
      }
    }

    // Assert
    should(disagreements).deepEqual([]);
  });
});
