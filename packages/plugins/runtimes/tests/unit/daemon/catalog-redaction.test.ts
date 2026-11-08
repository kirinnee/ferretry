/**
 * What a component's text says when it leaves for the edit screen (K4): every value that looks like a credential is
 * cut out as `‹hidden›`, wherever it stands — beside its name on one line, on the lines after it, in a block, in a
 * `${NAME-default}` expansion, or bare. Driven through the components read, the one door the text leaves by.
 *
 * Every secret-looking value here is an obviously fake one.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { componentCatalog } from '../../../daemon/lib/service/catalog.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';

const MODEL = parseAccountModel({ version: 1, components: { instructions: { notes: { file: 'notes.md' } } } });
const HIDDEN = '‹hidden›';

/** What the edit screen is given for an instructions file holding `text`. */
function shownFor(text: string): { text: string; redacted: boolean } {
  const catalog = componentCatalog(MODEL, {
    format: 'present',
    machineName: 'box',
    tools: { claude: undefined, codex: undefined },
    runningSessions: 0,
    userHome: '/home/person',
    acceptsAutoPermissionMode: true,
    instructionBodies: { notes: text },
  });
  const content = catalog.kinds[0]?.components[0]?.content;
  if (content?.form !== 'text') throw new Error('expected text content');
  return { text: content.text, redacted: content.redacted };
}

describe('component text redaction', () => {
  describe('a value beside its name on one line', () => {
    it.each([
      ['password = hunter2-fake-value', `password = ${HIDDEN}`],
      ['password: hunter2-fake-value', `password: ${HIDDEN}`],
      ['token=ghp_abcdefgh1234', `token=${HIDDEN}`],
      ['Q= apikey:xxxxxxxxxx', `Q= apikey:${HIDDEN}`],
    ])('should hide the value in %p', (input, expected) => {
      // Assert
      should(shownFor(input)).eql({ text: expected, redacted: true });
    });

    it.each([
      'api_key=${secret:API_KEY} and ${secret:TOKEN}',
      'token: | and nothing more',
      'name: not-a-secret-at-all',
      'db:\n  pass: fake-pass-0000',
    ])('should leave %p as it is: a pointer, a block opener or no secret by name', input => {
      // Assert
      should(shownFor(input)).eql({ text: input, redacted: false });
    });
  });

  describe('a value on the lines after its name', () => {
    it.each([
      ['password:\nhunter2-fake-value', `password:\n${HIDDEN}`],
      ['PASSWORD\n= hunter2-fake-value', `PASSWORD\n= ${HIDDEN}`],
      ['PASSWORD\n=\nhunter2-fake-value', `PASSWORD\n=\n${HIDDEN}`],
      ['password = \n\n  hunter2-fake-value', `password = \n\n  ${HIDDEN}`],
      ['ghp_x\n=ghp_abcdefgh5678', `ghp_x\n=${HIDDEN}`],
    ])('should hide the value of the name at the end of the line in %p', (input, expected) => {
      // Assert
      should(shownFor(input)).eql({ text: expected, redacted: true });
    });

    it('should hide the whole run when a token at the head of the next line was already cut', () => {
      // Act
      const actual = shownFor('password:\nghp_abcdefgh1234{rest');

      // Assert
      should(actual).eql({ text: `password:\n${HIDDEN}`, redacted: true });
    });

    it('should not hide the next line when it is already hidden, a key of its own, a pointer or no secret’s', () => {
      // Assert
      should(shownFor('password:\nghp_abcdefgh1234')).eql({ text: `password:\n${HIDDEN}`, redacted: true });
      for (const input of [
        'password:\nlogin_page: x',
        'password:\n${secret:PASS}',
        'username:\nalice-fake-name',
        'password:\n',
        'PASSWORD\nnot a separator',
      ]) {
        should(shownFor(input)).eql({ text: input, redacted: false });
      }
    });
  });

  describe('a block value', () => {
    it('should hide every line of the block under a name that announces a secret, and nothing after it', () => {
      // Act
      const actual = shownFor('password: |\n  line-one-fake-0000\n\n  line-two-fake-0000\nnext: ok');

      // Assert
      should(actual).eql({ text: `password: |\n  ${HIDDEN}\n\n  ${HIDDEN}\nnext: ok`, redacted: true });
    });

    it('should read a block opened inside a hidden one as part of it, not again', () => {
      // Act
      const actual = shownFor('secret: |\n  inner: |\n    fake-value-0000\n  more-fake-0000\ntail: ok');

      // Assert
      should(actual).eql({
        text: `secret: |\n  ${HIDDEN}\n    ${HIDDEN}\n  ${HIDDEN}\ntail: ok`,
        redacted: true,
      });
    });

    it('should read a later block of its own once the first has ended', () => {
      // Act
      const actual = shownFor('secret: |\n  a\nsecret: |\n  fake-value-0000');

      // Assert
      should(actual).eql({ text: `secret: |\n  a\nsecret: |\n  ${HIDDEN}`, redacted: true });
    });

    it('should not read the block under a name that announces no secret', () => {
      // Assert
      should(shownFor('name: |\n  plain text here\n')).eql({ text: 'name: |\n  plain text here\n', redacted: false });
    });

    // Ruling #36, tightened by design: today (`packages/daemon/src/lib/fleet/catalog.ts`) leaks a block whose indicator
    // follows a separator on the line AFTER its name: the block was read from the line after the NAME, met the `= |`
    // line at the name's own indent and stopped at once. The separator line opens the block, so it no longer ends it.
    it('S26 should hide a block whose indicator follows a separator on the line after its name: PASSWORD⏎= |⏎  value', () => {
      // Act
      const actual = shownFor('PASSWORD\n= |\n  fake-block-value-0000\nnext: fake-shown-0000');

      // Assert
      should(actual).eql({ text: `PASSWORD\n= |\n  ${HIDDEN}\nnext: fake-shown-0000`, redacted: true });
    });

    it('S26 should hide that block when its lines end in CRLF', () => {
      // Act
      const actual = shownFor('PASSWORD\r\n= |\r\n  fake-block-value-0000\r\nnext: ok\r\n');

      // Assert
      should(actual).eql({ text: `PASSWORD\r\n= |\r\n  ${HIDDEN}\r\nnext: ok\r\n`, redacted: true });
    });

    it('S26 should hide that block when it is indented with tabs', () => {
      // Act
      const actual = shownFor('\tPASSWORD\n\t= |\n\t\tfake-block-value-0000\n\tnext: ok');

      // Assert
      should(actual).eql({ text: `\tPASSWORD\n\t= |\n\t\t${HIDDEN}\n\tnext: ok`, redacted: true });
    });

    it('S26 should hide that block when the indicator is stuck to its separator: PASSWORD⏎=|', () => {
      // Act
      const actual = shownFor('PASSWORD\n=|\n  fake-block-value-0000\ntoken\n:>-\n  fake-block-value-1111');

      // Assert
      should(actual).eql({ text: `PASSWORD\n=|\n  ${HIDDEN}\ntoken\n:>-\n  ${HIDDEN}`, redacted: true });
    });

    it('S26 should hide every line of that block when it runs to the end of the text, and leave one with no lines', () => {
      // Assert
      should(shownFor('PASSWORD\n= |\n  fake-line-one-0000\n\n  fake-line-two-0000')).eql({
        text: `PASSWORD\n= |\n  ${HIDDEN}\n\n  ${HIDDEN}`,
        redacted: true,
      });
      should(shownFor('PASSWORD\n= |')).eql({ text: 'PASSWORD\n= |', redacted: false });
      should(shownFor('PASSWORD\n= |\n')).eql({ text: 'PASSWORD\n= |\n', redacted: false });
    });

    // Ruling #36 amended: three more shapes that today leaks the same way, and 5.0 hides.
    it('S26 should hide a block whose indicator carries a comment: password: | # note⏎  value', () => {
      // Act
      const actual = shownFor('password: | # fake note\n  fake-block-value-0000\nnext: fake-shown-0000');

      // Assert
      should(actual).eql({ text: `password: | # fake note\n  ${HIDDEN}\nnext: fake-shown-0000`, redacted: true });
    });

    it('S26 should hide a block whose indicator stands on a line of its own after its name: password:⏎  |⏎    value', () => {
      // Act
      const actual = shownFor('password:\n  |\n    fake-block-value-0000\nnext: fake-shown-0000');

      // Assert
      should(actual).eql({ text: `password:\n  |\n    ${HIDDEN}\nnext: fake-shown-0000`, redacted: true });
    });

    it('S26 should hide a block whose separator and indicator each stand on a line of their own: PASSWORD⏎=⏎|⏎  value', () => {
      // Act
      const actual = shownFor('PASSWORD\n=\n|\n  fake-block-value-0000\nnext: fake-shown-0000');

      // Assert
      should(actual).eql({ text: `PASSWORD\n=\n|\n  ${HIDDEN}\nnext: fake-shown-0000`, redacted: true });
    });

    it('S26 should hide a separator line of eight characters or more as a line of its block: PASSWORD⏎=        |⏎  value', () => {
      // Assert: the line that opens the block is read like any line of it, as a deeper `  = |` always was; one of
      // seven characters is too short to hide.
      should(shownFor('PASSWORD\n=        |\n  fake-block-value-0000')).eql({
        text: `PASSWORD\n${HIDDEN}\n  ${HIDDEN}`,
        redacted: true,
      });
      should(shownFor('PASSWORD\n=     |\n  fake-block-value-0000')).eql({
        text: `PASSWORD\n=     |\n  ${HIDDEN}`,
        redacted: true,
      });
    });

    it('S26 should keep reading the name a comment ends in when a separator follows it: x: | # token⏎= value', () => {
      // Assert: the comment's last word keeps the value it always had, so the commented block takes nothing from it.
      should(shownFor('mode: | # token\n= fake-value-0000\n  plain-line-0000')).eql({
        text: `mode: | # token\n= ${HIDDEN}\n  plain-line-0000`,
        redacted: true,
      });
    });

    it('S26 should read a block opened on a line that opens its outer block, no deeper than its name: password=⏎| # token: |', () => {
      // Assert: the indicator line is read as the outer block's, and the block it opens runs past the outer one.
      should(shownFor(' password=\n| # token: |\n fake-block-value-0000\nnext: ok')).eql({
        text: ` password=\n${HIDDEN}\n ${HIDDEN}\nnext: ok`,
        redacted: true,
      });
    });

    // The whole family, generated: every separator, indicator (with and without a comment), position of the
    // indicator, indent and line ending, under a name that announces a secret and under one that does not.
    const SEPARATORS = [':', '='];
    const INDICATORS = ['|', '|-', '>'];
    const COMMENTS = ['', ' # fake comment'];
    const INDENTS = ['  ', '\t'];
    const ENDINGS = ['\n', '\r\n'];
    /** The lines from the name to the indicator, for each place the indicator can stand. */
    const POSITIONS: Readonly<
      Record<string, (name: string, separator: string, indicator: string, indent: string) => string[]>
    > = {
      'same line': (name, separator, indicator) => [`${name}${separator} ${indicator}`],
      'next line': (name, separator, indicator) => [name, `${separator} ${indicator}`],
      'own line, indented': (name, separator, indicator, indent) => [`${name}${separator}`, `${indent}${indicator}`],
      'own line, at the name': (name, separator, indicator) => [`${name}${separator}`, indicator],
      'own line after a separator line': (name, separator, indicator) => [name, separator, indicator],
      'own line after a separator line, indented': (name, separator, indicator, indent) => [
        name,
        separator,
        `${indent}${indicator}`,
      ],
    };
    const family = Object.entries(POSITIONS).flatMap(([position, opener]) =>
      SEPARATORS.flatMap(separator =>
        INDICATORS.flatMap(indicator =>
          COMMENTS.flatMap(comment =>
            INDENTS.flatMap(indent =>
              ENDINGS.map(ending => ({ position, opener, separator, indicator: indicator + comment, indent, ending })),
            ),
          ),
        ),
      ),
    );

    it(`S26 should hide every value line of every block in the family (${family.length} shapes), and nothing after it`, () => {
      const leaks: string[] = [];
      for (const { position, opener, separator, indicator, indent, ending } of family) {
        // Arrange
        const head = opener('PASSWORD', separator, indicator, indent);
        const values = [`${indent}fake-block-value-0001`, '', `${indent}${indent}fake-block-value-0002`];
        const input = [...head, ...values, 'after: fake-shown-0000', ''].join(ending);

        // Act
        const actual = shownFor(input);

        // Assert: the name line and the line after the block as written, every value line hidden, and a line that
        // opens the block either as written or hidden whole (one of eight characters or more is read as a block line).
        const lines = actual.text.split(ending);
        const opensRight = lines
          .slice(1, head.length)
          .every((line, at) => line === head[at + 1] || line === `${/^\s*/u.exec(head[at + 1] ?? '')?.[0]}${HIDDEN}`);
        const expected = [
          head[0],
          ...lines.slice(1, head.length),
          `${indent}${HIDDEN}`,
          '',
          `${indent}${indent}${HIDDEN}`,
          'after: fake-shown-0000',
          '',
        ];
        if (!opensRight || actual.text !== expected.join(ending) || !actual.redacted) {
          leaks.push(`${position}: ${JSON.stringify(input)} -> ${JSON.stringify(actual.text)}`);
        }
      }
      should(leaks).deepEqual([]);
    });

    it(`S26 should hide nothing of any block in the family (${family.length} shapes) under a name that announces no secret`, () => {
      const touched: string[] = [];
      for (const { opener, separator, indicator, indent, ending } of family) {
        // Arrange
        const head = opener('mode', separator, indicator, indent);
        const input = [...head, `${indent}plain-block-text-0001`, 'after: plain-text-0000'].join(ending);

        // Act
        const actual = shownFor(input);

        // Assert
        if (actual.text !== input || actual.redacted) touched.push(JSON.stringify(input));
      }
      should(touched).deepEqual([]);
    });

    it('S26 should hide nothing of that shape under a name that announces no secret, nor after the block ends', () => {
      // Assert
      for (const input of [
        'username\n= |\n  plain-block-text-0000\nnext: ok',
        'mode\r\n=|\r\n\tplain-block-text-0000',
        'PASSWORD\n= |\nplain-sibling-text-0000',
      ]) {
        should(shownFor(input)).eql({ text: input, redacted: false });
      }
    });
  });

  describe('a ${NAME<op>default} expansion', () => {
    it('should hide the default of a name that announces a secret, keeping the rest of the text', () => {
      // Act
      const actual = shownFor('a ${TOKEN-fake-secret-1} b ${TOKEN?fake-secret-22} c ${TOKEN+fake-secret-333}');

      // Assert
      should(actual).eql({ text: `a \${TOKEN-${HIDDEN}} b \${TOKEN?${HIDDEN}} c \${TOKEN+${HIDDEN}}`, redacted: true });
    });

    it('should leave a default that is no secret, or already hidden', () => {
      // Assert
      should(shownFor(`\${HOME-/tmp/dir} \${TOKEN-${HIDDEN}}`)).eql({
        text: `\${HOME-/tmp/dir} \${TOKEN-${HIDDEN}}`,
        redacted: false,
      });
    });

    it('should hide a default written with a colon, as the value of its name', () => {
      // Assert
      should(shownFor('export X=${TOKEN:-fake-secret-value-0}')).eql({
        text: `export X=\${TOKEN:${HIDDEN}}`,
        redacted: true,
      });
    });
  });

  describe('a bare token or key', () => {
    it('should hide a well-known token anywhere, with or without a separator stuck to it', () => {
      // Assert
      should(shownFor('ghp_abcdefgh1234 and =ghp_abcdefgh1234 and ?sk-abcdefgh1234')).eql({
        text: `${HIDDEN} and =${HIDDEN} and ?${HIDDEN}`,
        redacted: true,
      });
    });

    it('should hide a private key block whole, header to footer', () => {
      // Act
      const actual = shownFor('-----BEGIN RSA PRIVATE KEY-----\nMIIfake0000AAAA\n-----END RSA PRIVATE KEY-----');

      // Assert
      should(actual).eql({ text: HIDDEN, redacted: true });
    });

    it('should hide a token glued to a non-letter, and not a word that merely ends the way a token starts', () => {
      // Act
      const actual = shownFor('see #ghp_abcdefgh1234 and abcghp_abcdefgh1234 and task-plan-ended');

      // Assert
      should(actual).eql({
        text: `see #${HIDDEN} and abcghp_abcdefgh1234 and task-plan-ended`,
        redacted: true,
      });
    });
  });
});
