// Realworld: asserts wall-clock speed; the outcome depends on the machine, not the code.
import { describe, test } from 'bun:test';
import should from 'should';
import { sentencesOf, speakableSegments } from '../../app/lib/voice-chat/speakable.ts';

/**
 * Hostile markdown must stay cheap to read aloud. The unit tier proves the STRUCTURE (the reading is bounded and
 * nothing past the scan window can change it); this tier proves the stopwatch, because the unit tier's clock is
 * virtual and could never fail a time assertion.
 */

const elapsed = (work: () => unknown): number => {
  const started = performance.now();
  work();
  return performance.now() - started;
};

describe('Read aloud — hostile input is read quickly', () => {
  // The first call pays for building the parser; time the rest.
  speakableSegments('warm up');

  const cases: ReadonlyArray<readonly [string, string]> = [
    ['3,200 unmatched backticks after text', `Some text ${'`'.repeat(3200)}`],
    ['50,000 backticks', '`'.repeat(50_000)],
    ['alternating backtick runs', '` ``'.repeat(10_000)],
    ['50,000 open brackets', '['.repeat(50_000)],
    ['link openers', '[a]('.repeat(10_000)],
    ['image openers', '!['.repeat(20_000)],
    ['50,000 tildes', '~'.repeat(50_000)],
    ['tilde pairs', 'a ~~ '.repeat(8000)],
    ['a long run of stars around a word', `${'*'.repeat(20_000)}a${'*'.repeat(20_000)}`],
    ['a long run of dots', `a${'.'.repeat(30_000)}b`],
    ['unclosed tags', '<a '.repeat(10_000)],
    ['a line of 5,000 nested list markers', `${'- '.repeat(5000)}x`],
    ['thousands of list lines', '- a\n'.repeat(20_000)],
    ['thousands of table rows', `| a | b |\n|---|---|\n${'| 1 | 2 |\n'.repeat(5000)}`],
    ['a dangling code span past the window', `Run \`${'runDangerousCommand();'.repeat(700)}\` now.`],
    [
      'a long fence delimiter with shorter lines in it',
      `${'~'.repeat(30)}\n${'~'.repeat(25)}\ncode\n${'~'.repeat(30)}`,
    ],
    ['thousands of tiny sentences', 'A. '.repeat(30_000)],
  ];

  for (const [name, markdown] of cases) {
    test(`should read ${name} in well under 250 ms`, () => {
      should(elapsed(() => speakableSegments(markdown))).be.below(250);
    });
  }

  test('should split a long run of marks and thousands of sentences in well under 500 ms', () => {
    should(
      elapsed(() => {
        sentencesOf(`a${'.'.repeat(50_000)}b`);
        sentencesOf(`${'a'.repeat(50_000)}. Next one.`);
        sentencesOf('A. '.repeat(20_000));
      }),
    ).be.below(500);
  });

  test('should bound a huge reply to a couple of seconds', () => {
    should(elapsed(() => speakableSegments('A sentence here. '.repeat(100_000)))).be.below(2000);
  });
});
