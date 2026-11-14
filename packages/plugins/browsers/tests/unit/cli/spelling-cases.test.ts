import { describe, it } from 'bun:test';
import should from 'should';
import { PrivateText, WITHHELD } from '../../../cli/lib/private-text.ts';
import { cliWorld, FakeDaemon, toolText } from '../../support/cli.ts';

/** A value no real password looks like; every case below is built from a synthetic one. */
const FIXTURE = 'review-fixture-text';

const hex2 = (byte: number, upper: boolean): string => {
  const digits = byte.toString(16).padStart(2, '0');
  return upper ? digits.toUpperCase() : digits;
};

/** Escapes ONE character of the value as `\uXXXX` and leaves the rest as they are (valid JSON). */
const oneEscaped = (value: string, at: number): string =>
  `${value.slice(0, at)}\\u${value.charCodeAt(at).toString(16).padStart(4, '0')}${value.slice(at + 1)}`;

/** Percent-encodes the bytes the value has at `positions`, in the case given, and leaves the others. */
const somePercent = (value: string, positions: readonly number[], upper: boolean): string =>
  [...value].map((char, index) => (positions.includes(index) ? `%${hex2(char.charCodeAt(0), upper)}` : char)).join('');

const SPELLINGS: readonly (readonly [string, (value: string) => string])[] = [
  ['one character unicode-escaped', value => oneEscaped(value, 0)],
  ['a middle character unicode-escaped', value => oneEscaped(value, 7)],
  [
    'a character unicode-escaped in upper-case hex',
    value => oneEscaped(value, 3).replace(/\\u[0-9a-f]{4}/u, m => m.toUpperCase().replace('\\U', '\\u')),
  ],
  ['some characters percent-encoded, lower case', value => somePercent(value, [1, 4, 5], false)],
  ['some characters percent-encoded, upper case', value => somePercent(value, [1, 4, 5], true)],
  ['percent escapes in mixed case', value => value.replace('-', '%2d').replace('-', '%2D')],
  ['percent-encoded twice', value => somePercent(value, [2], true).replaceAll('%', '%25')],
  ['percent-encoded, then its escape unicode-escaped', value => somePercent(value, [2], true).replace('%', '\\u0025')],
  ['a unicode escape written as percent text', value => oneEscaped(value, 2).replaceAll('\\', '%5C')],
  ['every character in hex', value => [...new TextEncoder().encode(value)].map(byte => hex2(byte, false)).join('')],
  [
    'every character in upper-case hex',
    value => [...new TextEncoder().encode(value)].map(byte => hex2(byte, true)).join(''),
  ],
  ['base64', value => Buffer.from(value).toString('base64')],
  ['base64 after a prefix that moves its alignment', value => `x${Buffer.from(`ab${value}`).toString('base64')}`],
  ['url-safe base64', value => Buffer.from(`${value}??>>`).toString('base64url')],
];

describe('typed text in a spelling nobody listed — decode, then compare', () => {
  for (const [label, spell] of SPELLINGS) {
    it(`should never print the stdin text with ${label} (unit)`, () => {
      // Arrange
      const hidden = new PrivateText([FIXTURE]);
      const spelled = spell(FIXTURE);

      // Act
      const clean = hidden.sealed(hidden.clean(`seen: ${spelled} done`));

      // Assert
      should(clean).not.containEql(spelled);
      should(clean).equal(WITHHELD);
    });

    it(`should never print the stdin text with ${label} (--json, whole verb)`, async () => {
      // Arrange
      const spelled = spell(FIXTURE);
      const daemon = new FakeDaemon().answer('browser_type', toolText(`seen: ${spelled}`));
      const world = cliWorld(daemon, { stdin: FIXTURE });

      // Act
      const code = await world.run(['browser', 'page', 'type', 'app', '#field', '--stdin', '--json']);

      // Assert
      should(code).equal(0);
      const out = world.stdout() + world.stderr();
      should(out).not.containEql(spelled);
      should(out).not.containEql(FIXTURE);
      // the answer is still JSON a script can parse
      should(() => JSON.parse(world.stdout())).not.throw();
    });
  }

  it('should withhold the whole answer, with one sentence, in human mode too', async () => {
    // Arrange
    const daemon = new FakeDaemon().answer('browser_type', toolText(`seen ${oneEscaped(FIXTURE, 0)}`));
    const world = cliWorld(daemon, { stdin: FIXTURE });

    // Act
    const code = await world.run(['browser', 'page', 'type', 'app', '#field', '--stdin']);

    // Assert
    should(code).equal(0);
    should(world.stdout()).equal(`${WITHHELD}\n`);
  });

  it('should withhold when decoding cannot settle (nested past the bound), not print it', () => {
    // Arrange
    const hidden = new PrivateText([FIXTURE]);
    let nested = FIXTURE;
    for (let depth = 0; depth < 40; depth += 1)
      nested = nested.replace(/^./u, char => `%${hex2(char.charCodeAt(0), true)}`).replaceAll('%', '%25');

    // Act
    const clean = hidden.sealed(hidden.clean(nested));

    // Assert
    should(clean).equal(WITHHELD);
  });

  it('should leave an answer that only looks encoded alone when it holds nothing typed', () => {
    // Arrange
    const hidden = new PrivateText([FIXTURE]);
    const text = 'https://example.test/a%20b?q=%E2%9C%93 and caf\\u00e9 and aGVsbG8=';

    // Act / Assert
    should(hidden.sealed(hidden.clean(text))).equal(text);
  });

  it('should keep invalid percent runs readable without treating them as unsure', () => {
    // Arrange
    const hidden = new PrivateText([FIXTURE]);

    // Act / Assert
    should(hidden.sealed(hidden.clean('bytes %ff%fe and %'))).equal('bytes %ff%fe and %');
  });
});
