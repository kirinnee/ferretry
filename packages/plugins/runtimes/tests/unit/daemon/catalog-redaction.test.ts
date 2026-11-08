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

    // Ruling #36, round 3: a block of the family opened inside an outer block under a name that announces a secret,
    // its indicator no deeper than its own name, so it runs past the outer block: it is read on its own.
    it('S26 should hide a block of the family opened inside an outer secret block, its indicator shallower than its name: password: |⏎  PASSWORD⏎= |⏎    value', () => {
      // Assert
      should(shownFor('password: |\n  PASSWORD\n= |\n    fake-block-value-0000\nnext: fake-shown-0000')).eql({
        text: `password: |\n  ${HIDDEN}\n= |\n    ${HIDDEN}\nnext: fake-shown-0000`,
        redacted: true,
      });
      should(shownFor('token: |\n  password:\n|\n    fake-block-value-0000')).eql({
        text: `token: |\n  ${HIDDEN}\n|\n    ${HIDDEN}`,
        redacted: true,
      });
      should(shownFor('token: |\r\n  PASSWORD\r\n=\r\n|\r\n    fake-block-value-0000')).eql({
        text: `token: |\r\n  ${HIDDEN}\r\n=\r\n|\r\n    ${HIDDEN}`,
        redacted: true,
      });
      should(shownFor('secret: |\n\tx123456789\n token\n= |\n  fake-block-value-0000')).eql({
        text: `secret: |\n\t${HIDDEN}\n token\n= |\n  ${HIDDEN}`,
        redacted: true,
      });
    });

    // Ruling #36, round 3: a line that opens a block is still read as the value it always was, so it hides at least
    // the first word it always hid, even when the line as a whole holds a pointer and is no secret.
    it('S26 should keep hiding the first word today hides on a line that opens a block: password:⏎|12345678 # ${secret:X}', () => {
      // Assert
      for (const [input, expected] of [
        ['password:\n|12345678 # ${secret:FAKE}', `password:\n${HIDDEN} # \${secret:FAKE}`],
        ['PASSWORD\n= |12345678 # ${secret:FAKE}', `PASSWORD\n= ${HIDDEN} # \${secret:FAKE}`],
        ['token:\n>2345678 #${secret:FAKE}', `token:\n${HIDDEN} #\${secret:FAKE}`],
        [
          'PASSWORD=\n|2345678\t#${secret:FAKE}\n  fake-block-value-0000',
          `PASSWORD=\n${HIDDEN}\t#\${secret:FAKE}\n  ${HIDDEN}`,
        ],
      ] as const) {
        should(shownFor(input)).eql({ text: expected, redacted: true });
      }
    });

    // Ruling #36, round 3: a commented block is read beside the reading of the name its comment ends in.
    it('S26 should hide a block whose comment ends in a name and its separator: password: | # see note:⏎  value', () => {
      // Assert
      should(shownFor('password: | # see note:\n  fake-block-value-0000\nnext: fake-shown-0000')).eql({
        text: `password: | # see note:\n  ${HIDDEN}\nnext: fake-shown-0000`,
        redacted: true,
      });
      should(shownFor('password: | # e.g.:\n  fake-block-value-0000')).eql({
        text: `password: | # e.g.:\n  ${HIDDEN}`,
        redacted: true,
      });
      // The name the comment ends in keeps its own reading, under a block name that announces no secret too.
      should(shownFor('mode: | # see token:\n  fake-value-0000\n  plain-line-0000')).eql({
        text: `mode: | # see token:\n  ${HIDDEN}\n  plain-line-0000`,
        redacted: true,
      });
    });

    // The whole family, generated: every separator, gap before the indicator, indicator (with and without a
    // comment, one ending in a name and its separator), position of the indicator (shallower than the name too),
    // base indent, block indent and line ending, alone or inside an outer block, under a name that announces a
    // secret and under one that does not.
    const SEPARATORS = [':', '='];
    const GAPS = [' ', '', '\t'];
    const INDICATORS = ['|', '|-', '>'];
    const COMMENTS = ['', ' # fake comment', ' # see fake-note:'];
    const BASES = ['', '  ', '\t'];
    const INDENTS = ['  ', '\t'];
    const ENDINGS = ['\n', '\r\n'];
    const WRAPPED = [false, true];
    interface Shape {
      readonly name: string;
      readonly separator: string;
      readonly gap: string;
      readonly indicator: string;
      readonly base: string;
      readonly indent: string;
    }
    /**
     * The lines from the name to the indicator, for each place the indicator can stand: whether a gap can stand
     * between the separator and the indicator (they share a line), and whether it stands shallower than the name.
     */
    const POSITIONS: Readonly<
      Record<string, { readonly gapped: boolean; readonly shallow: boolean; readonly lines: (s: Shape) => string[] }>
    > = {
      'same line': {
        gapped: true,
        shallow: false,
        lines: s => [`${s.base}${s.name}${s.separator}${s.gap}${s.indicator}`],
      },
      'next line': {
        gapped: true,
        shallow: false,
        lines: s => [`${s.base}${s.name}`, `${s.base}${s.separator}${s.gap}${s.indicator}`],
      },
      'next line, shallower than the name': {
        gapped: true,
        shallow: true,
        lines: s => [`${s.base}${s.name}`, `${s.separator}${s.gap}${s.indicator}`],
      },
      'own line, indented': {
        gapped: false,
        shallow: false,
        lines: s => [`${s.base}${s.name}${s.separator}`, `${s.base}${s.indent}${s.indicator}`],
      },
      'own line, at the name': {
        gapped: false,
        shallow: false,
        lines: s => [`${s.base}${s.name}${s.separator}`, `${s.base}${s.indicator}`],
      },
      'own line, shallower than the name': {
        gapped: false,
        shallow: true,
        lines: s => [`${s.base}${s.name}${s.separator}`, s.indicator],
      },
      'own line after a separator line': {
        gapped: false,
        shallow: false,
        lines: s => [`${s.base}${s.name}`, `${s.base}${s.separator}`, `${s.base}${s.indicator}`],
      },
      'own line after a separator line, indented': {
        gapped: false,
        shallow: false,
        lines: s => [`${s.base}${s.name}`, `${s.base}${s.separator}`, `${s.base}${s.indent}${s.indicator}`],
      },
      'own line after a separator line, shallower than the name': {
        gapped: false,
        shallow: true,
        lines: s => [`${s.base}${s.name}`, s.separator, s.indicator],
      },
    };
    const family = Object.entries(POSITIONS).flatMap(([position, { gapped, shallow, lines }]) =>
      BASES.filter(base => !shallow || base !== '').flatMap(base =>
        (gapped ? GAPS : [' ']).flatMap(gap =>
          SEPARATORS.flatMap(separator =>
            INDICATORS.flatMap(indicator =>
              COMMENTS.flatMap(comment =>
                INDENTS.flatMap(indent =>
                  ENDINGS.flatMap(ending =>
                    WRAPPED.map(wrapped => ({
                      position,
                      opener: (name: string) =>
                        lines({ name, separator, gap, indicator: indicator + comment, base, indent }),
                      base,
                      indent,
                      ending,
                      wrapped,
                    })),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    /** A line as written, or hidden whole after its indent. */
    const asWrittenOrHidden = (line: string | undefined, written: string): boolean =>
      line === written || line === `${/^\s*/u.exec(written)?.[0]}${HIDDEN}`;

    it(`S26 should hide every value line of every block in the family (${family.length} shapes), and nothing after it`, () => {
      const leaks: string[] = [];
      for (const { position, opener, base, indent, ending, wrapped } of family) {
        // Arrange
        const wrap = wrapped ? ['api_token: |'] : [];
        const head = opener('PASSWORD');
        const values = [`${base}${indent}fake-block-value-0001`, '', `${base}${indent}${indent}fake-block-value-0002`];
        const input = [...wrap, ...head, ...values, 'after: fake-shown-0000', ''].join(ending);

        // Act
        const actual = shownFor(input);

        // Assert: the outer line, the name line (unless the outer block holds it) and the line after the block as
        // written, every value line hidden, and a line that opens the block either as written or hidden whole (one
        // of eight characters or more is read as a block line).
        const lines = actual.text.split(ending).slice(wrap.length);
        const insideOuter = wrapped && base !== '';
        const opensRight =
          (insideOuter ? asWrittenOrHidden(lines[0], head[0] ?? '') : lines[0] === head[0]) &&
          head.slice(1).every((line, at) => asWrittenOrHidden(lines[at + 1], line));
        const expected = [
          ...wrap,
          ...lines.slice(0, head.length),
          `${base}${indent}${HIDDEN}`,
          '',
          `${base}${indent}${indent}${HIDDEN}`,
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
      for (const { opener, base, indent, ending, wrapped } of family) {
        // Arrange
        const wrap = wrapped ? ['notes: |'] : [];
        const input = [
          ...wrap,
          ...opener('mode'),
          `${base}${indent}plain-block-text-0001`,
          'after: plain-text-0000',
        ].join(ending);

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
