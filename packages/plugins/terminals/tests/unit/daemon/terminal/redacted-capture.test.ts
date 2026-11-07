import { describe, it } from 'bun:test';
import should from 'should';
import type { SecretName } from '@ferretry/core-vault/contract';
import { FakeRedaction } from '@ferretry/core-vault/contract/testing';
import type { Redaction } from '@ferretry/kernel/contract';
import { redactCapture as redactWithScope } from '../../../../daemon/lib/terminal/redacted-capture.ts';
import type { TerminalCapture } from '../../../../daemon/lib/terminal/redraw.ts';

const ESC = '\u001b';
const RESET = `${ESC}[0m`;

/** The Vault's contract fake, holding these values: every read is one `Redaction.read` (§7.3). */
function redactorOf(...secrets: readonly string[]): Redaction {
  return new FakeRedaction(new Map(secrets.map((secret, at) => [`S${String(at)}` as SecretName, secret])));
}

/** One capture, masked inside one read scope, as the viewer stream masks it. */
const redactCapture = async (capture: TerminalCapture, redaction: Redaction): Promise<TerminalCapture> =>
  await redaction.read(scope => redactWithScope(capture, scope));

const captureOf = (lines: readonly string[]): TerminalCapture => ({
  lines,
  cols: 20,
  rows: lines.length,
  cursorX: 0,
  cursorY: 0,
  historySize: 0,
});

const visible = (line: string): string => line.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, 'gu'), '');

describe('redactCapture', () => {
  it('should return the very same capture when nothing needs masking', async () => {
    const capture = captureOf([`${ESC}[31mred${RESET}`, 'plain']);

    should(await redactCapture(capture, redactorOf('hunter2'))).equal(capture);
  });

  it('I105 should overwrite the cells of a value in place, keep every code, and leave other rows byte for byte', async () => {
    const colour = `${ESC}[32mok${RESET}`;
    const out = await redactCapture(captureOf([colour, `${ESC}[1mpw: hunter2${RESET} tail`]), redactorOf('hunter2'));

    should(out.lines[0]).equal(colour);
    should(out.lines[1]).equal(`${ESC}[1mpw: *******${RESET} tail`);
    should(out.cols).equal(20);
  });

  it('should keep every row exactly as wide as it was, whatever the value', async () => {
    const lines = ['a', 'pw: x', 'pw: hunter2 done'];
    const out = await redactCapture(captureOf(lines), redactorOf('x', 'hunter2'));

    should(out.lines.map(line => visible(line).length)).eql(lines.map(line => line.length));
    should(out.lines.join('|')).not.containEql('hunter2');
  });

  it('I105 should cover a value that wrapped over two rows, a code between its halves, and nothing around it', async () => {
    const out = await redactCapture(
      captureOf([`pw: hunt${ESC}[0m`, `er2 done${ESC}[0m`, 'untouched']),
      redactorOf('hunter2'),
    );

    should(out.lines[0]).equal(`pw: ****${ESC}[0m`);
    should(out.lines[1]).equal(`*** done${ESC}[0m`);
    should(out.lines[2]).equal('untouched');
  });

  it('I106 should find a value that ends in spaces, which a trimmed capture would have lost', async () => {
    const out = await redactCapture(captureOf(['code: 654321 ']), redactorOf('654321 '));

    should(out.lines[0]).equal('code: *******');
    should(out.lines[0]).not.containEql('6');
  });

  it('should fill a wide character with two cells and a combining mark with none', async () => {
    const out = await redactCapture(captureOf(['x 密码 é y']), redactorOf('密码', 'é'));

    should(out.lines[0]).equal('x **** * y');
  });

  it('should cover a value made of astral characters whole, two cells each', async () => {
    const out = await redactCapture(captureOf(['go 🔑🔑 now']), redactorOf('🔑🔑'));

    should(out.lines[0]).equal('go **** now');
  });

  it('should drop non-colour escapes, which are metadata, and keep a marker already on screen as ordinary text', async () => {
    const out = await redactCapture(
      captureOf([`${ESC}]0;title\u0007[redacted:input A9] then hunter2`]),
      redactorOf('hunter2'),
    );

    should(out.lines[0]).equal('[redacted:input A9] then *******');
  });

  it('should drop a hyperlink payload even when the visible cells hold nothing to mask', async () => {
    const link = `${ESC}]8;;https://example.test/?code=hunter2${ESC}\\label${ESC}]8;;${ESC}\\`;
    const out = await redactCapture(
      captureOf([link, `${ESC}]8;;https://example.test/?code=hunter2 ${ESC}]8;;`]),
      redactorOf('hunter2'),
    );

    should(out.lines[0]).equal('label');
    should(out.lines.join('')).not.containEql('hunter2');
    should(out.lines[1]).equal('');
  });

  it('should keep colour codes and trim only what is neither text nor paint', async () => {
    const out = await redactCapture(
      captureOf([
        `${ESC}[44;7mab  ${ESC}[27m  ${ESC}[0m  `,
        `${ESC}[7;44mab${ESC}[49m  ${ESC}[0m  `,
        `${ESC}[48;2;1;2;3mab  ${ESC}[0m  `,
        `${ESC}[48:2::1:2:3mx ${ESC}[49m  `,
        `${ESC}[38;5;7mab ${ESC}[0m  `,
      ]),
      redactorOf('zzzz'),
    );

    should(out.lines[0]).equal(`${ESC}[44;7mab  ${ESC}[27m  ${ESC}[0m`);
    should(out.lines[1]).equal(`${ESC}[7;44mab${ESC}[49m  ${ESC}[0m`);
    should(out.lines[2]).equal(`${ESC}[48;2;1;2;3mab  ${ESC}[0m`);
    should(out.lines[3]).equal(`${ESC}[48:2::1:2:3mx ${ESC}[49m`);
    should(out.lines[4]).equal(`${ESC}[38;5;7mab${ESC}[0m`);
  });

  it('should count a single-cell wide-range neighbour (U+303F) as one cell and a CJK character as two', async () => {
    const out = await redactCapture(captureOf(['〿hunter2中']), redactorOf('〿hunter2中'));

    should(out.lines[0]).equal('*'.repeat(10));
  });

  it('should cover two values that sit side by side as one run', async () => {
    const out = await redactCapture(captureOf(['hunter2swordfish!']), redactorOf('hunter2', 'swordfish'));

    should(out.lines[0]).equal('****************!');
  });

  it('should cover held values that interact, with no marker for any of them to corrupt', async () => {
    // A value the daemon just typed and a held secret are one scope now: the Vault composes them (§7.3).
    const redactor = redactorOf('hunter2', ':', 'vault-token');

    const out = await redactCapture(captureOf(['hunter2: vault-token ok']), redactor);

    should(out.lines[0]).equal('******** *********** ok');
    should(out.lines[0]).not.containEql('hunter2');
  });

  it('I105 should fail the capture when the redactor cannot open', async () => {
    const broken: Redaction = { read: async () => Promise.reject(new Error('vault locked')) };

    await redactCapture(captureOf(['x']), broken).then(
      () => should.fail('resolved', 'rejected', 'expected a failure'),
      error => should((error as Error).message).equal('vault locked'),
    );
  });
});

describe('redactCapture row padding', () => {
  const cases: readonly [string, string, string][] = [
    ['plain padding', `ready $${' '.repeat(10)}`, 'ready $'],
    ['padding after a reset', `${ESC}[31mred${ESC}[39m${' '.repeat(5)}`, `${ESC}[31mred${ESC}[39m`],
    ['padding after a bare reset', `a${ESC}[m${'   '}`, `a${ESC}[m`],
    ['a background fill', `${ESC}[44mbar${' '.repeat(4)}${RESET}`, `${ESC}[44mbar${' '.repeat(4)}${RESET}`],
    ['a reversed fill', `${ESC}[7mbar${' '.repeat(2)}${RESET}`, `${ESC}[7mbar${' '.repeat(2)}${RESET}`],
    ['a bright background fill', `${ESC}[102mx  ${RESET}`, `${ESC}[102mx  ${RESET}`],
    ['a 256-colour background fill', `${ESC}[48;5;7mx  ${RESET}`, `${ESC}[48;5;7mx  ${RESET}`],
    ['a truecolour background fill', `${ESC}[48;2;1;2;3mx  ${RESET}`, `${ESC}[48;2;1;2;3mx  ${RESET}`],
    ['a foreground-only colour', `${ESC}[38;5;7mx${ESC}[39m  `, `${ESC}[38;5;7mx${ESC}[39m`],
    ['a truecolour foreground', `${ESC}[38;2;7;7;7mx  `, `${ESC}[38;2;7;7;7mx`],
    ['a background ended by default', `${ESC}[44mx${ESC}[49m  `, `${ESC}[44mx${ESC}[49m`],
    ['a reverse ended', `${ESC}[7mx${ESC}[27m  `, `${ESC}[7mx${ESC}[27m`],
  ];

  it.each(cases)('should treat %s', async (_name, row, expected) => {
    const out = await redactCapture(captureOf([row]), redactorOf('nothing-here'));

    should(out.lines[0]).equal(expected);
  });
});
