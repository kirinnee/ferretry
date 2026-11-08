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
import { AFTER_KEY, KEY_BODY_MARK, privateKeyShapes } from './redact-private-keys.ts';

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

    // Ruling #36, amendment 3: YAML node properties (a tag, an anchor, both in either order) before a block indicator
    // hide nothing of the block from a name that announces a secret.
    it('S26 should hide a block whose indicator follows node properties: db_password: !vault |⏎  value', () => {
      // Assert
      for (const [input, expected] of [
        [
          'db_password: !vault |\n  $ANSIBLE_VAULT;1.1;AES256\n  62316530fake0000\nnext: fake-shown-0000',
          `db_password: !vault |\n  ${HIDDEN}\n  ${HIDDEN}\nnext: fake-shown-0000`,
        ],
        // Today hides the eight-character tag beside the name, and still does.
        ['password: !!binary |\n  fake-block-value-0000', `password: ${HIDDEN} |\n  ${HIDDEN}`],
        ['password: &a |\n  fake-block-value-0000', `password: &a |\n  ${HIDDEN}`],
        ['password: !!str |\n  fake-block-value-0000', `password: !!str |\n  ${HIDDEN}`],
        ['token: &a !!str >-\r\n  fake-block-value-0000', `token: &a !!str >-\r\n  ${HIDDEN}`],
        [
          'secret: !!str &a |- # fake comment\n\tfake-block-value-0000',
          `secret: !!str &a |- # fake comment\n\t${HIDDEN}`,
        ],
        ['- "password": !x |\n    fake-block-value-0000', `- "password": !x |\n    ${HIDDEN}`],
      ] as const) {
        should(shownFor(input)).eql({ text: expected, redacted: true });
      }
    });

    it('S26 should hide a block whose node properties stand off the name line: PASSWORD⏎= !!str |, password:⏎  &a |, password: &a⏎  |', () => {
      // Assert: a line that opens the block is as written or, at eight characters or more, hidden whole.
      for (const [input, expected] of [
        ['PASSWORD\n= !x |\n  fake-block-value-0000', `PASSWORD\n= !x |\n  ${HIDDEN}`],
        ['PASSWORD\n= !!str |\n  fake-block-value-0000', `PASSWORD\n${HIDDEN}\n  ${HIDDEN}`],
        ['password:\n  &a |\n    fake-block-value-0000', `password:\n  &a |\n    ${HIDDEN}`],
        ['PASSWORD\n=\n!x >\n  fake-block-value-0000', `PASSWORD\n=\n!x >\n  ${HIDDEN}`],
        ['password: &a\n|\n  fake-block-value-0000', `password: &a\n|\n  ${HIDDEN}`],
        ['PASSWORD\n= &a\n  |\n    fake-block-value-0000', `PASSWORD\n= &a\n  |\n    ${HIDDEN}`],
      ] as const) {
        should(shownFor(input)).eql({ text: expected, redacted: true });
      }
    });

    // Ruling #36, amendment 3: today reads node properties as the value, and shows the value after them.
    it("S26 should hide the value after node properties on its name's line: password: !!str value", () => {
      // Assert
      for (const [input, expected] of [
        ['password: !!str fake-inline-value-0000', `password: !!str ${HIDDEN}`],
        ['password: &pw fake-inline-value-0000 # fake comment', `password: &pw ${HIDDEN} # fake comment`],
        // A tag today hides (eight characters under a secret name) stays hidden, and the value after it is too.
        ['password: !!binary fake-inline-value-0000', `password: ${HIDDEN} ${HIDDEN}`],
        ['api_token = &a !!str "fake-inline-value-0000"', `api_token = &a !!str "${HIDDEN}"`],
        ['password: !<tag:yaml.org,2002:str> fake-inline-value-0000', `password: ${HIDDEN},2002:str> ${HIDDEN}`],
        // An operand is read as the value too: it only hides more (`!Ref` names a parameter).
        ['password: !Ref DbPasswordFake', `password: !Ref ${HIDDEN}`],
      ] as const) {
        should(shownFor(input)).eql({ text: expected, redacted: true });
      }
    });

    it('S26 should hide the value after node properties on the lines after its name: PASSWORD⏎= !!str value, password:⏎  &a value, password: &a⏎  value', () => {
      // Assert
      for (const [input, expected] of [
        ['PASSWORD\n= !!str fake-inline-value-0000', `PASSWORD\n= !!str ${HIDDEN}`],
        ['PASSWORD\n=\n&a fake-inline-value-0000', `PASSWORD\n=\n&a ${HIDDEN}`],
        ['password:\n  &a fake-inline-value-0000', `password:\n  &a ${HIDDEN}`],
        ['password: &a\n  fake-inline-value-0000', `password: &a\n  ${HIDDEN}`],
        ['password: !!binary\r\n  fake-inline-value-0000', `password: ${HIDDEN}\r\n  ${HIDDEN}`],
        ['PASSWORD\n= !!str &a\n\tfake-inline-value-0000', `PASSWORD\n= !!str &a\n\t${HIDDEN}`],
      ] as const) {
        should(shownFor(input)).eql({ text: expected, redacted: true });
      }
    });

    it('S26 should leave node properties and what follows them under a name that announces no secret, a pointer or a comment after them, and a lone &', () => {
      // Assert
      for (const input of [
        'mode: !!str plain-inline-text-0000',
        'mode: !vault |\n  plain-block-text-0000',
        'mode: &a\n  plain-inline-text-0000',
        'MODE\n= !!str plain-inline-text-0000',
        'password: !!str ${secret:FAKE}',
        'password: &a !!str # see-the-notes-below',
        'Q=& plain-inline-text-0000',
        'password: & fake-inline-value-0000',
        'e=! sk-<2xyz',
      ]) {
        should(shownFor(input)).eql({ text: input, redacted: false });
      }
    });

    // A cut that took a private key's header would leave its body for no pass to find, so a reading leaves the key
    // whole for the pass that cuts keys. Round 3's blocks of the family took the header, below today's floor.
    it('S26 should cut a private key whole when a block of the family holds its header and its body runs past the block', () => {
      // Assert
      for (const [input, expected] of [
        [
          'PASSWORD\n= |\n  -----BEGIN RSA PRIVATE KEY-----\nMIIEfakefakefake\n-----END RSA PRIVATE KEY-----\nnext: fake-shown-0000',
          `PASSWORD\n= |\n  ${HIDDEN}\nnext: fake-shown-0000`,
        ],
        [
          'password: | # c\n  -----BEGIN PRIVATE KEY-----\nMIIEfakefakefake\n-----END PRIVATE KEY-----',
          `password: | # c\n  ${HIDDEN}`,
        ],
        // Today's own block took it as well: the rest of the line is hidden, and the key cut whole.
        [
          'password: |\n  fake x -----BEGIN RSA PRIVATE KEY-----\nMIIEfake\n-----END RSA PRIVATE KEY-----\nnext: ok',
          `password: |\n  ${HIDDEN} ${HIDDEN}\nnext: ok`,
        ],
        // A key wholly inside the block is hidden line by line, as today hides it.
        [
          'password: |\n  -----BEGIN RSA PRIVATE KEY-----\n  MIIEfakefakefake\n  -----END RSA PRIVATE KEY-----',
          `password: |\n  ${HIDDEN}\n  ${HIDDEN}\n  ${HIDDEN}`,
        ],
      ] as const) {
        should(shownFor(input)).eql({ text: expected, redacted: true });
      }
    });

    it("S26 should cut a private key whole when a name's value starts with it: password: -----BEGIN…", () => {
      // Assert
      const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEfakefakefake\n-----END RSA PRIVATE KEY-----';
      for (const [input, expected] of [
        [`password: ${key}`, `password: ${HIDDEN}`],
        [`password:\n${key}`, `password:\n${HIDDEN}`],
        [`password: !!str ${key}`, `password: !!str ${HIDDEN}`],
        [`password: fake-${key}`, `password: ${HIDDEN}${HIDDEN}`],
      ] as const) {
        should(shownFor(input)).eql({ text: expected, redacted: true });
      }
    });

    // Ruling #36, r5: a key's body ran past no line break written as an escape, nor past a word an earlier pass hid,
    // so its body showed where today's shows it too. Under a name that announces a secret and under any other.
    it('S26 should cut a private key whole when its line breaks are escapes: "private_key": "-----BEGIN…\\n…\\n-----END…"', () => {
      // Assert
      const key = '-----BEGIN PRIVATE KEY-----\\nMIIEvQfakefakefake\\nMIIEfakebody2\\n-----END PRIVATE KEY-----';
      for (const [input, expected] of [
        [
          `{"private_key": "${key}\\n", "client_email": "fake@example.invalid"}`,
          `{"private_key": "${HIDDEN}\\n", "client_email": "fake@example.invalid"}`,
        ],
        [`private_key: ${key}\nnext: ok`, `private_key: ${HIDDEN}\nnext: ok`],
        [`TOKEN=${key.replaceAll('\\n', '\\r\\n')}`, `TOKEN=${HIDDEN}`],
        [`"key": "${key}"`, `"key": "${HIDDEN}"`],
      ] as const) {
        should(shownFor(input)).eql({ text: expected, redacted: true });
      }
    });

    it('S26 should cut a private key whole when a body line starts the way a token does: eyJ…, AIza…', () => {
      // Assert
      const key = (line: string) =>
        `-----BEGIN RSA PRIVATE KEY-----\nMIIEfakefake\n${line}\nMIIEfakebody2\n-----END RSA PRIVATE KEY-----`;
      for (const [input, expected] of [
        [`password: ${key('eyJfakefakefake')}\nnext: ok`, `password: ${HIDDEN}\nnext: ok`],
        [`PASSWORD\n= |\n  ${key('AIzaFakefakefakefake')}\nnext: ok`, `PASSWORD\n= |\n  ${HIDDEN}\nnext: ok`],
        [key('eyJfakefakefake'), HIDDEN],
      ] as const) {
        should(shownFor(input)).eql({ text: expected, redacted: true });
      }
    });

    it(`S26 should cut every private key shape whole (${privateKeyShapes().length} shapes), and nothing after it`, () => {
      const leaks: string[] = [];
      for (const { shape, text, shown } of privateKeyShapes()) {
        // Act
        const actual = shownFor(text);

        // Assert
        const right =
          !actual.text.includes(KEY_BODY_MARK) &&
          !actual.text.includes('PRIVATE KEY') &&
          shown.every(piece => actual.text.includes(piece)) &&
          actual.text.endsWith(AFTER_KEY) &&
          actual.redacted;
        if (!right) leaks.push(`${shape}: ${JSON.stringify(text)} -> ${JSON.stringify(actual.text)}`);
      }
      should(leaks).deepEqual([]);
    });

    // The whole family, generated: every separator, gap before the indicator, indicator (with and without a
    // comment, one ending in a name and its separator), position of the indicator (shallower than the name too),
    // base indent, block indent and line ending, alone or inside an outer block, under a name that announces a
    // secret and under one that does not. And (amendment 3) node properties — tags, anchors, both in either order —
    // before the indicator wherever it stands, or ending the line before the indicator's.
    const SEPARATORS = [':', '='];
    const GAPS = [' ', '', '\t'];
    const INDICATORS = ['|', '|-', '>'];
    const COMMENTS = ['', ' # fake comment', ' # see fake-note:'];
    const BASES = ['', '  ', '\t'];
    const INDENTS = ['  ', '\t'];
    const ENDINGS = ['\n', '\r\n'];
    const WRAPPED = [false, true];
    const NODE_PROPERTIES = ['', '!x ', '!!str ', '!!binary ', '&a ', '&a !!str ', '!!str &a '];
    /** Tens of thousands of shapes take a few seconds, past bun's 5 s per-test default on a slow box. */
    const FAMILY_TIMEOUT = 60_000;
    interface Shape {
      readonly name: string;
      readonly separator: string;
      readonly gap: string;
      /** The indicator with its comment, and the node properties before it (each with its space). */
      readonly indicator: string;
      readonly properties: string;
      readonly base: string;
      readonly indent: string;
    }
    /** The node properties and the indicator, where they share a line. */
    const opener = (s: Shape): string => `${s.properties}${s.indicator}`;
    /**
     * The lines from the name to the indicator, for each place the indicator can stand: whether a gap can stand
     * between the separator and the indicator (they share a line), whether it stands shallower than the name, and
     * whether node properties end a line of their own (so the position needs some).
     */
    const POSITIONS: Readonly<
      Record<
        string,
        {
          readonly gapped: boolean;
          readonly shallow: boolean;
          readonly tagged?: true;
          readonly lines: (s: Shape) => string[];
        }
      >
    > = {
      'same line': {
        gapped: true,
        shallow: false,
        lines: s => [`${s.base}${s.name}${s.separator}${s.gap}${opener(s)}`],
      },
      'next line': {
        gapped: true,
        shallow: false,
        lines: s => [`${s.base}${s.name}`, `${s.base}${s.separator}${s.gap}${opener(s)}`],
      },
      'next line, shallower than the name': {
        gapped: true,
        shallow: true,
        lines: s => [`${s.base}${s.name}`, `${s.separator}${s.gap}${opener(s)}`],
      },
      'own line, indented': {
        gapped: false,
        shallow: false,
        lines: s => [`${s.base}${s.name}${s.separator}`, `${s.base}${s.indent}${opener(s)}`],
      },
      'own line, at the name': {
        gapped: false,
        shallow: false,
        lines: s => [`${s.base}${s.name}${s.separator}`, `${s.base}${opener(s)}`],
      },
      'own line, shallower than the name': {
        gapped: false,
        shallow: true,
        lines: s => [`${s.base}${s.name}${s.separator}`, opener(s)],
      },
      'own line after a separator line': {
        gapped: false,
        shallow: false,
        lines: s => [`${s.base}${s.name}`, `${s.base}${s.separator}`, `${s.base}${opener(s)}`],
      },
      'own line after a separator line, indented': {
        gapped: false,
        shallow: false,
        lines: s => [`${s.base}${s.name}`, `${s.base}${s.separator}`, `${s.base}${s.indent}${opener(s)}`],
      },
      'own line after a separator line, shallower than the name': {
        gapped: false,
        shallow: true,
        lines: s => [`${s.base}${s.name}`, s.separator, opener(s)],
      },
      'properties end the name line': {
        gapped: true,
        shallow: false,
        tagged: true,
        lines: s => [
          `${s.base}${s.name}${s.separator}${s.gap}${s.properties.trimEnd()}`,
          `${s.base}${s.indent}${s.indicator}`,
        ],
      },
      'properties end the name line, the indicator at the name': {
        gapped: true,
        shallow: false,
        tagged: true,
        lines: s => [`${s.base}${s.name}${s.separator}${s.gap}${s.properties.trimEnd()}`, `${s.base}${s.indicator}`],
      },
      'properties end the separator line': {
        gapped: true,
        shallow: false,
        tagged: true,
        lines: s => [
          `${s.base}${s.name}`,
          `${s.base}${s.separator}${s.gap}${s.properties.trimEnd()}`,
          `${s.base}${s.indent}${s.indicator}`,
        ],
      },
    };
    const family = Object.entries(POSITIONS).flatMap(([position, { gapped, shallow, tagged, lines }]) =>
      BASES.filter(base => !shallow || base !== '').flatMap(base =>
        (gapped ? GAPS : [' ']).flatMap(gap =>
          SEPARATORS.flatMap(separator =>
            INDICATORS.flatMap(indicator =>
              COMMENTS.flatMap(comment =>
                NODE_PROPERTIES.filter(properties => tagged !== true || properties !== '').flatMap(properties =>
                  INDENTS.flatMap(indent =>
                    ENDINGS.flatMap(ending =>
                      WRAPPED.map(wrapped => ({
                        position,
                        opener: (name: string) =>
                          lines({ name, separator, gap, indicator: indicator + comment, properties, base, indent }),
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
      ),
    );
    /**
     * A line as written, or with the `!!binary` tag today hides as a value (eight characters under a secret name)
     * hidden. {@link asWrittenOrHidden}: or hidden whole after its indent.
     */
    const asWritten = (line: string | undefined, written: string): boolean =>
      line === written || line === written.replace('!!binary', HIDDEN);
    const asWrittenOrHidden = (line: string | undefined, written: string): boolean =>
      asWritten(line, written) || line === `${/^\s*/u.exec(written)?.[0]}${HIDDEN}`;

    it(
      `S26 should hide every value line of every block in the family (${family.length} shapes), and nothing after it`,
      () => {
        const leaks: string[] = [];
        for (const { position, opener, base, indent, ending, wrapped } of family) {
          // Arrange
          const wrap = wrapped ? ['api_token: |'] : [];
          const head = opener('PASSWORD');
          const values = [
            `${base}${indent}fake-block-value-0001`,
            '',
            `${base}${indent}${indent}fake-block-value-0002`,
          ];
          const input = [...wrap, ...head, ...values, 'after: fake-shown-0000', ''].join(ending);

          // Act
          const actual = shownFor(input);

          // Assert: the outer line, the name line (unless the outer block holds it) and the line after the block as
          // written, every value line hidden, and a line that opens the block either as written or hidden whole (one
          // of eight characters or more is read as a block line).
          const lines = actual.text.split(ending).slice(wrap.length);
          const insideOuter = wrapped && base !== '';
          const opensRight =
            (insideOuter ? asWrittenOrHidden(lines[0], head[0] ?? '') : asWritten(lines[0], head[0] ?? '')) &&
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
      },
      FAMILY_TIMEOUT,
    );

    it(
      `S26 should hide nothing of any block in the family (${family.length} shapes) under a name that announces no secret`,
      () => {
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
      },
      FAMILY_TIMEOUT,
    );

    // The value after node properties, generated (amendment 3): every place a value is read — the name's own line,
    // the separator's line after it, a line of its own, the line after a separator line, and the line after one that
    // node properties end — crossed with every separator, gap, node property, comment after the value, base indent,
    // value indent, line ending and outer block, under a name that announces a secret and under one that does not.
    const VALUE = 'fake-inline-value-0001';
    const VALUE_COMMENTS = ['', ' # fake comment'];
    const VALUE_PROPERTIES = NODE_PROPERTIES.filter(properties => properties !== '');
    interface ValueShape {
      readonly name: string;
      readonly separator: string;
      readonly gap: string;
      /** The node properties, each with its space. */
      readonly properties: string;
      /** The value with its comment. */
      readonly value: string;
      readonly base: string;
      readonly indent: string;
    }
    const VALUE_POSITIONS: Readonly<
      Record<
        string,
        { readonly gapped: boolean; readonly shallow: boolean; readonly lines: (s: ValueShape) => string[] }
      >
    > = {
      'same line': {
        gapped: true,
        shallow: false,
        lines: s => [`${s.base}${s.name}${s.separator}${s.gap}${s.properties}${s.value}`],
      },
      'next line': {
        gapped: true,
        shallow: false,
        lines: s => [`${s.base}${s.name}`, `${s.base}${s.separator}${s.gap}${s.properties}${s.value}`],
      },
      'next line, shallower than the name': {
        gapped: true,
        shallow: true,
        lines: s => [`${s.base}${s.name}`, `${s.separator}${s.gap}${s.properties}${s.value}`],
      },
      'own line, indented': {
        gapped: false,
        shallow: false,
        lines: s => [`${s.base}${s.name}${s.separator}`, `${s.base}${s.indent}${s.properties}${s.value}`],
      },
      'own line, at the name': {
        gapped: false,
        shallow: false,
        lines: s => [`${s.base}${s.name}${s.separator}`, `${s.base}${s.properties}${s.value}`],
      },
      'own line, shallower than the name': {
        gapped: false,
        shallow: true,
        lines: s => [`${s.base}${s.name}${s.separator}`, `${s.properties}${s.value}`],
      },
      'own line after a separator line': {
        gapped: false,
        shallow: false,
        lines: s => [`${s.base}${s.name}`, `${s.base}${s.separator}`, `${s.base}${s.properties}${s.value}`],
      },
      'own line after a separator line, shallower than the name': {
        gapped: false,
        shallow: true,
        lines: s => [`${s.base}${s.name}`, s.separator, `${s.properties}${s.value}`],
      },
      'properties end the name line': {
        gapped: true,
        shallow: false,
        lines: s => [
          `${s.base}${s.name}${s.separator}${s.gap}${s.properties.trimEnd()}`,
          `${s.base}${s.indent}${s.value}`,
        ],
      },
      'properties end the separator line': {
        gapped: true,
        shallow: false,
        lines: s => [
          `${s.base}${s.name}`,
          `${s.base}${s.separator}${s.gap}${s.properties.trimEnd()}`,
          `${s.base}${s.indent}${s.value}`,
        ],
      },
    };
    const valueFamily = Object.entries(VALUE_POSITIONS).flatMap(([position, { gapped, shallow, lines }]) =>
      BASES.filter(base => !shallow || base !== '').flatMap(base =>
        (gapped ? GAPS : [' ']).flatMap(gap =>
          SEPARATORS.flatMap(separator =>
            VALUE_PROPERTIES.flatMap(properties =>
              VALUE_COMMENTS.flatMap(comment =>
                INDENTS.flatMap(indent =>
                  ENDINGS.flatMap(ending =>
                    WRAPPED.map(wrapped => ({
                      position,
                      head: (name: string, value: string) =>
                        lines({ name, separator, gap, properties, value: value + comment, base, indent }),
                      base,
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

    it(
      `S26 should hide the value after node properties in every place a value is read (${valueFamily.length} shapes), and nothing else`,
      () => {
        const leaks: string[] = [];
        for (const { position, head, base, ending, wrapped } of valueFamily) {
          // Arrange
          const wrap = wrapped ? ['api_token: |'] : [];
          const written = [...wrap, ...head('PASSWORD', VALUE), 'after: fake-shown-0000', ''];
          const input = written.join(ending);

          // Act
          const actual = shownFor(input);

          // Assert: each line as written, its value hidden or not, with the tag today hides hidden or not — or, inside
          // the outer block, hidden whole — and the value shown nowhere.
          const lines = actual.text.split(ending);
          const insideOuter = wrapped && base !== '';
          const right = written.every((line, at) => {
            const shown = lines[at];
            const hidden = line.replace(VALUE, HIDDEN);
            return (
              asWritten(shown, line) ||
              asWritten(shown, hidden) ||
              (insideOuter && at > 0 && line.startsWith(base) && asWrittenOrHidden(shown, line))
            );
          });
          if (!right || lines.length !== written.length || actual.text.includes(VALUE) || !actual.redacted) {
            leaks.push(`${position}: ${JSON.stringify(input)} -> ${JSON.stringify(actual.text)}`);
          }
        }
        should(leaks).deepEqual([]);
      },
      FAMILY_TIMEOUT,
    );

    it(
      `S26 should hide nothing after node properties in any place a value is read (${valueFamily.length} shapes) under a name that announces no secret`,
      () => {
        const touched: string[] = [];
        for (const { head, ending, wrapped } of valueFamily) {
          // Arrange
          const wrap = wrapped ? ['notes: |'] : [];
          const input = [...wrap, ...head('mode', 'plain-inline-text-0001'), 'after: plain-text-0000'].join(ending);

          // Act
          const actual = shownFor(input);

          // Assert
          if (actual.text !== input || actual.redacted) touched.push(JSON.stringify(input));
        }
        should(touched).deepEqual([]);
      },
      FAMILY_TIMEOUT,
    );

    // Ruling #36, r5: a comment between a name and its value — after the separator, after node properties, or on lines
    // of its own — hid nothing of the value YAML reads past it; today shows it the same way.
    it('S26 should hide the value a comment stands before: password: # note⏎  value, password:⏎  # note⏎  value, password: &a # c⏎  value', () => {
      // Assert
      for (const [input, expected] of [
        ['password: # fake note\n  fake-value-0000', `password: # fake note\n  ${HIDDEN}`],
        ['password: #note\n  fake-value-0000', `password: #note\n  ${HIDDEN}`],
        [
          'password: # fake note\n  # more fake notes\n\n  fake-value-0000',
          `password: # fake note\n  # more fake notes\n\n  ${HIDDEN}`,
        ],
        ['password:\n  # fake note\n  fake-value-0000', `password:\n  # fake note\n  ${HIDDEN}`],
        ['password: &a # fake note\n  fake-value-0000', `password: &a # fake note\n  ${HIDDEN}`],
        ['password: !!str # c\n  fake-value-0000', `password: !!str # c\n  ${HIDDEN}`],
        ['password: &a\n  # fake note\n  fake-value-0000', `password: &a\n  # fake note\n  ${HIDDEN}`],
        ['password: # c\n  &a fake-value-0000', `password: # c\n  &a ${HIDDEN}`],
        ['password: # c\n  "fake-value-0000"', `password: # c\n  "${HIDDEN}"`],
        [
          'db:\n  password: # fake note\n    fake-value-0000\n  user: bob',
          `db:\n  password: # fake note\n    ${HIDDEN}\n  user: bob`,
        ],
        ['api_token: # c\r\n\t# d\r\n\tfake-value-0000', `api_token: # c\r\n\t# d\r\n\t${HIDDEN}`],
        ['PASSWORD\n= # fake note\n  fake-value-0000', `PASSWORD\n= # fake note\n  ${HIDDEN}`],
        ['PASSWORD\n=\n# fake note\nfake-value-0000', `PASSWORD\n=\n# fake note\n${HIDDEN}`],
        ['PASSWORD\n= &a # c\n  fake-value-0000', `PASSWORD\n= &a # c\n  ${HIDDEN}`],
      ] as const) {
        should(shownFor(input)).eql({ text: expected, redacted: true });
      }
    });

    it('S26 should hide the block a comment stands before: password: # c⏎  |⏎    value', () => {
      // Assert: a line between the name and the block's last line is read like any line of the block, as it always was
      // when it stood deeper than the name, so a comment of eight characters or more there is hidden whole.
      for (const [input, expected] of [
        [
          'password: # c\n  |\n    fake-block-value-0000\nnext: fake-shown-0000',
          `password: # c\n  |\n    ${HIDDEN}\nnext: fake-shown-0000`,
        ],
        ['password:\n  # fake note\n  >-\n    fake-block-value-0000', `password:\n  ${HIDDEN}\n  >-\n    ${HIDDEN}`],
        ['password: &a # c\n  |\n    fake-block-value-0000', `password: &a # c\n  |\n    ${HIDDEN}`],
        ['password: # c\n  &a |\n    fake-block-value-0000', `password: # c\n  &a |\n    ${HIDDEN}`],
        ['PASSWORD\n= # c\n  |\n    fake-block-value-0000', `PASSWORD\n= # c\n  |\n    ${HIDDEN}`],
      ] as const) {
        should(shownFor(input)).eql({ text: expected, redacted: true });
      }
    });

    it('S26 should read nothing past a comment under a name that announces no secret, from a comment line, into a key or a pointer, or past a # glued to its separator', () => {
      // Assert
      for (const input of [
        'mode: # fake note\n  plain-value-0000',
        'mode:\n  # fake note\n  |\n    plain-block-text-0000',
        // A name in a line that is a comment is no key.
        '# password: # fake note\n  plain-value-0000',
        '# password:\n# fake note\nplain-value-0000',
        'password: # fake note\nuser: plain-user-0000',
        'password: # fake note\n  ${secret:FAKE}',
        // `password:#c` is no key and its comment (YAML), and `=#c` a value (an environment file).
        'password:# fake-note\n  plain-value-0000',
        'password: # fake note',
      ]) {
        should(shownFor(input)).eql({ text: input, redacted: false });
      }
      should(shownFor('PASSWORD\n=#fake-note\n  plain-value-0000')).eql({
        text: `PASSWORD\n=${HIDDEN}\n  plain-value-0000`,
        redacted: true,
      });
    });

    // A comment between a name and its value, generated (r5): on the name's line or on its separator's line (after
    // node properties or not), and none, one or two comment lines of their own (at the name, deeper, shallower, with a
    // blank line and a tab) — crossed with every separator, the space before the comment, what the value line holds (a
    // value, a quoted one, node properties and a value, a block indicator with or without a comment, node properties
    // and an indicator), base indent, value indent, line ending and outer block.
    const NOTE = '# fake note';
    const NOTE_GAPS = [' ', '\t'];
    const LEAD_PROPERTIES = ['', '&a ', '!!str &a '];
    const NOTE_LEADS: Readonly<Record<string, (s: NoteShape) => string[]>> = {
      'name line': s => [`${s.base}${s.name}${s.separator}${s.gap}${s.properties}${s.note}`],
      'separator line': s => [`${s.base}${s.name}`, `${s.base}${s.separator}${s.gap}${s.properties}${s.note}`],
    };
    const NOTE_LINES: readonly ((base: string, indent: string) => string[])[] = [
      () => [],
      base => [`${base}${NOTE}`],
      (base, indent) => [`${base}${indent}${NOTE}`],
      (base, indent) => [`${base}${indent}${NOTE}`, '', `${base}\t${NOTE} two`],
      () => [NOTE],
    ];
    /** What the value line holds, and the lines after it; whether it opens a block, and holds node properties. */
    const NOTE_TARGETS: readonly { readonly block: boolean; readonly properties: boolean; readonly opener: string }[] =
      [
        { block: false, properties: false, opener: '' },
        { block: false, properties: false, opener: '"' },
        { block: false, properties: true, opener: '&a ' },
        { block: false, properties: true, opener: '!!str &a ' },
        { block: true, properties: false, opener: '|' },
        { block: true, properties: false, opener: '>-' },
        { block: true, properties: false, opener: '| # fake comment' },
        { block: true, properties: true, opener: '!!str |' },
      ];
    interface NoteShape {
      readonly name: string;
      readonly separator: string;
      readonly gap: string;
      readonly properties: string;
      readonly note: string;
      readonly base: string;
    }
    const noteFamily = Object.entries(NOTE_LEADS).flatMap(([lead, leadLines]) =>
      BASES.flatMap(base =>
        SEPARATORS.flatMap(separator =>
          [{ gap: ' ', note: '' }, ...NOTE_GAPS.map(gap => ({ gap, note: NOTE }))].flatMap(({ gap, note }) =>
            LEAD_PROPERTIES.flatMap(properties =>
              NOTE_LINES.flatMap((noteLines, layout) =>
                NOTE_TARGETS.filter(target => properties === '' || !target.properties)
                  .filter(() => note !== '' || layout > 0)
                  .flatMap(target =>
                    INDENTS.flatMap(indent =>
                      ENDINGS.flatMap(ending =>
                        WRAPPED.map(wrapped => ({
                          shape: `${lead}, layout ${String(layout)}, ${JSON.stringify(target.opener)}`,
                          target,
                          base,
                          indent,
                          ending,
                          wrapped,
                          head: (name: string) => [
                            ...leadLines({ name, separator, gap, properties, note, base }),
                            ...noteLines(base, indent),
                          ],
                          value: (value: string) =>
                            target.block
                              ? [`${base}${indent}${target.opener}`, `${base}${indent}${indent}${value}`]
                              : [`${base}${indent}${target.opener}${value}${target.opener === '"' ? '"' : ''}`],
                        })),
                      ),
                    ),
                  ),
              ),
            ),
          ),
        ),
      ),
    );

    it(
      `S26 should hide the value past every comment in the family (${noteFamily.length} shapes), and nothing else`,
      () => {
        const leaks: string[] = [];
        for (const { shape, target, base, ending, wrapped, head, value } of noteFamily) {
          // Arrange
          const wrap = wrapped ? ['api_token: |'] : [];
          const named = head('PASSWORD');
          const written = [...wrap, ...named, ...value(VALUE), 'after: fake-shown-0000', ''];
          const input = written.join(ending);

          // Act
          const actual = shownFor(input);

          // Assert: the name line as written, the lines to the value as written (or, in a block or inside the outer
          // one, hidden whole), the value hidden, and the line after it as written.
          const lines = actual.text.split(ending);
          const insideOuter = wrapped && base !== '';
          const right = written.every((line, at) => {
            const shown = lines[at];
            const own = at - wrap.length;
            const before = own >= 0 && at < written.length - 2;
            const whole = before && (insideOuter || (target.block && own > 0));
            return (
              asWritten(shown, line) ||
              asWritten(shown, line.replace(VALUE, HIDDEN)) ||
              (whole && asWrittenOrHidden(shown, line))
            );
          });
          if (!right || lines.length !== written.length || actual.text.includes(VALUE) || !actual.redacted) {
            leaks.push(`${shape}: ${JSON.stringify(input)} -> ${JSON.stringify(actual.text)}`);
          }
        }
        should(leaks).deepEqual([]);
      },
      FAMILY_TIMEOUT,
    );

    it(
      `S26 should hide nothing past any comment in the family (${noteFamily.length} shapes) under a name that announces no secret`,
      () => {
        const touched: string[] = [];
        for (const { ending, wrapped, head, value } of noteFamily) {
          // Arrange
          const wrap = wrapped ? ['notes: |'] : [];
          const input = [...wrap, ...head('mode'), ...value('plain-inline-text-0001'), 'after: plain-text-0000'].join(
            ending,
          );

          // Act
          const actual = shownFor(input);

          // Assert
          if (actual.text !== input || actual.redacted) touched.push(JSON.stringify(input));
        }
        should(touched).deepEqual([]);
      },
      FAMILY_TIMEOUT,
    );

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
