import { describe, test } from 'bun:test';
import should from 'should';
import { findReferences, parseReferenceToken, type Reference } from '../../src/lib/references.ts';

describe('parseReferenceToken', () => {
  const canonical: readonly (readonly [string, Reference])[] = [
    [':zelda', { kind: 'agent', name: 'zelda' }],
    [':ZELDA', { kind: 'agent', name: 'zelda' }],
    ['@handover.md', { kind: 'file', path: 'handover.md' }],
    ['@./handover.md', { kind: 'file', path: './handover.md' }],
    ['@/abs/api.ts', { kind: 'file', path: '/abs/api.ts' }],
    ['@src/api.ts:120', { kind: 'file', path: 'src/api.ts', line: 120 }],
    ['@src/api.ts:120-140', { kind: 'file', path: 'src/api.ts', line: 120, endLine: 140 }],
    ['@src/api.ts:120-120', { kind: 'file', path: 'src/api.ts', line: 120, endLine: 120 }],
    ['&F12', { kind: 'task', id: 'F12' }],
    ['&f12', { kind: 'task', id: 'F12' }],
    ['!A3', { kind: 'attention', id: 'A3' }],
  ];

  for (const [raw, expected] of canonical) {
    test(`should parse ${raw}`, () => {
      // Act
      const actual = parseReferenceToken(raw);

      // Assert
      should(actual).deepEqual(expected);
    });
  }

  const rejected = [
    '',
    '@',
    '@@src/api.ts',
    '@@@src/api.ts',
    'src/api.ts',
    'src/api.ts:12',
    '@src/api.ts:0',
    '@src/api.ts:12-0',
    '@src/api.ts:14-12',
    '@src/api.ts:12:4',
    '@src/',
    '@src//api.ts',
    '@a/./b.ts',
    '@../secret',
    '@a/../secret',
    '#F12',
    '?A3',
    ':1zelda',
    ':zelda_name',
    '&A3',
    '!A0',
    'pin:thing',
  ];

  for (const raw of rejected) {
    test(`should reject the non-canonical token ${JSON.stringify(raw)}`, () => {
      // Act
      const actual = parseReferenceToken(raw);

      // Assert
      should(actual).be.null();
    });
  }

  test('should drop a location that is not a safe integer rather than reject the file', () => {
    // Act — the reader mashed digits; the path is still a real reference.
    const actual = parseReferenceToken('@src/api.ts:99999999999999999999');

    // Assert
    should(actual).deepEqual({ kind: 'file', path: 'src/api.ts' });
  });

  test('should reject a range whose location is unusable but whose end line is not', () => {
    // Act
    const actual = parseReferenceToken('@src/api.ts:99999999999999999999-140');

    // Assert
    should(actual).be.null();
  });
});

describe('findReferences', () => {
  test('should find all four kinds at exact offsets and leave non-boundaries alone', () => {
    // Arrange
    const text =
      'Ping :zelda; inspect @src/api.ts:120-140, then &F12 and !A3. Ignore x:link, word&F2, !!A4, @@@, #F9, ?A8.';

    // Act
    const actual = findReferences(text);

    // Assert
    should(actual).deepEqual([
      {
        reference: { kind: 'agent', name: 'zelda' },
        raw: ':zelda',
        start: text.indexOf(':zelda'),
        end: text.indexOf(':zelda') + ':zelda'.length,
      },
      {
        reference: { kind: 'file', path: 'src/api.ts', line: 120, endLine: 140 },
        raw: '@src/api.ts:120-140',
        start: text.indexOf('@src/api.ts'),
        end: text.indexOf('@src/api.ts') + '@src/api.ts:120-140'.length,
      },
      {
        reference: { kind: 'task', id: 'F12' },
        raw: '&F12',
        start: text.indexOf('&F12'),
        end: text.indexOf('&F12') + '&F12'.length,
      },
      {
        reference: { kind: 'attention', id: 'A3' },
        raw: '!A3',
        start: text.indexOf('!A3'),
        end: text.indexOf('!A3') + '!A3'.length,
      },
    ]);
  });

  test('should skip a lexical candidate the grammar then refuses', () => {
    // Act — `@a/../secret` looks like a token but escapes the session root.
    const actual = findReferences('see @a/../secret and @src/api.ts');

    // Assert
    should(actual.map(match => match.raw)).deepEqual(['@src/api.ts']);
  });

  test('should report nothing for prose without sigils', () => {
    // Act & Assert
    should(findReferences('a plain sentence with no references')).deepEqual([]);
  });
});
