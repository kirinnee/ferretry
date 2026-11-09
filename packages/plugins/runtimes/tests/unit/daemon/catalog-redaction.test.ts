/**
 * What a component's text says when it leaves for the edit screen (K4): every value that looks like a credential is
 * cut out as `‹hidden›`, wherever it stands — beside its name on one line, on the lines after it, in a block, in a
 * `${NAME-default}` expansion, or bare. Driven through the components read, the one door the text leaves by.
 *
 * Every secret-looking value here is an obviously fake one.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { HIDDEN, shownFor } from './redact-support.ts';

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

    // FINDING (also in today's `packages/daemon/src/lib/fleet/catalog.ts`): a block whose `|` follows a separator on the
    // line AFTER its name leaks. `opening` returns that line for the block, but the block branch of `redactNextLines`
    // scans from the line after the NAME, meets the `= |` line at the name's own indent and stops at once.
    it.todo('should hide a block whose indicator follows a separator on the line after its name: PASSWORD⏎= |⏎  value');
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

// The guarantee rows of Appendix D (docs/design/redesign.md) that `redactText` enforces, one test each by row id.
describe('the redaction guarantees', () => {
  it('S21 component text is scrubbed by shape to ‹hidden›: a value beside a secret-sounding name, on the same or the next line, or in a block', () => {
    // Assert
    should(shownFor('password = hunter2-fake-value')).eql({ text: `password = ${HIDDEN}`, redacted: true });
    should(shownFor('password:\nhunter2-fake-value')).eql({ text: `password:\n${HIDDEN}`, redacted: true });
    should(shownFor('password: |\n  hunter2-fake-value\n  line-two-fake-0000')).eql({
      text: `password: |\n  ${HIDDEN}\n  ${HIDDEN}`,
      redacted: true,
    });
  });

  it('S22 well-known tokens and private-key blocks are hidden wherever they appear, cut only with no letter or digit before them and a digit in the body', () => {
    // Arrange
    const tokens = [
      'ghp_abcdefgh1234',
      'sk-abcdefgh1234',
      'AKIAABCDEFGHIJKL1234',
      'xoxb-1234-fake-5678',
      'github_pat_fake1234abcd5678',
    ];

    // Assert
    for (const token of tokens) {
      should(shownFor(`before ${token} after`)).eql({ text: `before ${HIDDEN} after`, redacted: true });
    }
    should(shownFor('-----BEGIN RSA PRIVATE KEY-----\nMIIfake0000AAAA\n-----END RSA PRIVATE KEY-----')).eql({
      text: HIDDEN,
      redacted: true,
    });
    should(shownFor('abcghp_abcdefgh1234 task-plan-ended')).eql({
      text: 'abcghp_abcdefgh1234 task-plan-ended',
      redacted: false,
    });
  });

  it('S23 the default in ${NAME-default} and its other operators is treated as the value of NAME and hidden', () => {
    // Arrange
    const operators = ['-', ':-', '=', ':=', '+', ':+', '?', ':?'];

    // Assert
    for (const operator of operators) {
      const shown = shownFor(`x \${TOKEN${operator}fake-secret-value-0} y`);
      should(shown.redacted).be.true();
      should(shown.text).startWith('x ${TOKEN');
      should(shown.text).endWith(`${HIDDEN}} y`);
      should(shown.text).not.containEql('fake-secret-value-0');
    }
  });

  it('S24 pointers $NAME, ${NAME} and ${secret:NAME} are left as they are', () => {
    // Arrange
    const pointers = ['$API_KEY', '${API_KEY}', '${secret:API_KEY}'];

    // Assert
    for (const pointer of pointers) {
      should(shownFor(`api_key=${pointer} and token: ${pointer}\npassword:\n${pointer}`)).eql({
        text: `api_key=${pointer} and token: ${pointer}\npassword:\n${pointer}`,
        redacted: false,
      });
    }
  });

  it('S25 every shape rule is linear: a long run of any shape costs the same per character as a short one', () => {
    // Arrange: the shapes that made the old rules quadratic (name characters with no separator, repeated token heads,
    // a separator with nothing after it, a long block, a long expansion).
    const shapes = [
      (n: number) => 'a'.repeat(n),
      (n: number) => 'sk-'.repeat(n / 3),
      (n: number) => 'a='.repeat(n / 2),
      (n: number) => `password: |\n${'  x\n'.repeat(n / 4)}`,
      (n: number) => '${A-'.repeat(n / 4),
      (n: number) => 'password\n'.repeat(n / 9),
      (n: number) => `${'-'.repeat(n)}=x`,
    ];
    const timeOf = (text: string): number => {
      const start = performance.now();
      shownFor(text);
      return performance.now() - start;
    };

    for (const shape of shapes) {
      // Act
      shownFor(shape(3_000));
      const small = Math.max(timeOf(shape(10_000)), 1);
      const large = timeOf(shape(100_000));

      // Assert: ten times the text is nowhere near a hundred times the time (quadratic), and an absolute ceiling.
      should(large).be.below(small * 40);
      should(large).be.below(3_000);
    }
  });
});
