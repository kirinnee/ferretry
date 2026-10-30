import { describe, it } from 'bun:test';
import should from 'should';
import { EphemeralAwareRedactor } from '../../../src/lib/input-requests/ephemeral-redactor.ts';
import { EphemeralValues } from '../../../src/lib/input-requests/ephemeral-values.ts';
import { coverageOf } from '../../../src/lib/secrets/policy.ts';
import type { Scrub, TextRedactor } from '../../../src/lib/secrets/redaction.ts';
import { redactCapture } from '../../../src/lib/terminal/redacted-capture.ts';
import type { TerminalCapture } from '../../../src/lib/terminal/redraw.ts';

const ESC = '\u001b';
const RESET = `${ESC}[0m`;

function redactorOf(...secrets: readonly string[]): TextRedactor {
  const scrub: Scrub = {
    text: value => value,
    data: value => value,
    cover: value => coverageOf(value, secrets),
  };
  return { redact: async value => value, redactData: async value => value, batch: async work => work(scrub) };
}

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

  it('should overwrite the cells of a value in place, keep every code, and leave other rows byte for byte', async () => {
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

  it('should cover a value that wrapped over two rows, a code between its halves, and nothing around it', async () => {
    const out = await redactCapture(
      captureOf([`pw: hunt${ESC}[0m`, `er2 done${ESC}[0m`, 'untouched']),
      redactorOf('hunter2'),
    );

    should(out.lines[0]).equal(`pw: ****${ESC}[0m`);
    should(out.lines[1]).equal(`*** done${ESC}[0m`);
    should(out.lines[2]).equal('untouched');
  });

  it('should find a value that ends in spaces, which a trimmed capture would have lost', async () => {
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

  it('should read OSC and CSI escapes as zero-width and keep a marker already on screen as ordinary text', async () => {
    const out = await redactCapture(
      captureOf([`${ESC}]0;title\u0007[redacted:input A9] then hunter2`]),
      redactorOf('hunter2'),
    );

    should(out.lines[0]).equal(`${ESC}]0;title\u0007[redacted:input A9] then *******`);
  });

  it('should cover two values that sit side by side as one run', async () => {
    const out = await redactCapture(captureOf(['hunter2swordfish!']), redactorOf('hunter2', 'swordfish'));

    should(out.lines[0]).equal('****************!');
  });

  it('should cover held values that interact, with no marker for any of them to corrupt', async () => {
    const values = new EphemeralValues({ now: () => 1 });
    values.hold('s1', 'hunter2', 'A1');
    values.hold('s1', ':', 'A2');
    const redactor = new EphemeralAwareRedactor(redactorOf('vault-token'), values);

    const out = await redactCapture(captureOf(['hunter2: vault-token ok']), redactor);

    should(out.lines[0]).equal('******** *********** ok');
    should(out.lines[0]).not.containEql('hunter2');
  });

  it('should fail the capture when the redactor cannot open', async () => {
    const broken: TextRedactor = {
      redact: async () => Promise.reject(new Error('vault locked')),
      redactData: async () => Promise.reject(new Error('vault locked')),
      batch: async () => Promise.reject(new Error('vault locked')),
    };

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
