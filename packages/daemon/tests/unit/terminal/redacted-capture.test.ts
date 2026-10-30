import { describe, it } from 'bun:test';
import should from 'should';
import { redactCapture } from '../../../src/lib/terminal/redacted-capture.ts';
import type { TerminalCapture } from '../../../src/lib/terminal/redraw.ts';
import type { Scrub, TextRedactor } from '../../../src/lib/secrets/redaction.ts';

const ESC = '\u001b';
const RESET = `${ESC}[0m`;

function redactorOf(secrets: Record<string, string>): TextRedactor {
  const text = (value: string): string =>
    Object.entries(secrets)
      .sort(([a], [b]) => b.length - a.length)
      .reduce((out, [secret, label]) => out.replaceAll(secret, `[redacted:${label}]`), value);
  const scrub: Scrub = { text, data: value => value };
  return {
    redact: async value => text(value),
    redactData: async value => value,
    batch: async work => work(scrub),
  };
}

const captureOf = (lines: readonly string[]): TerminalCapture => ({
  lines,
  cols: 20,
  rows: lines.length,
  cursorX: 0,
  cursorY: 0,
  historySize: 0,
});

describe('redactCapture', () => {
  it('should return the very same capture when nothing needs masking', async () => {
    const capture = captureOf([`${ESC}[31mred${RESET}`, 'plain']);

    should(await redactCapture(capture, redactorOf({ hunter2: 'input A1' }))).equal(capture);
  });

  it('should mask a value inside one row, leave other rows and their colours alone, and drop the touched row’s codes', async () => {
    const colour = `${ESC}[32mok${RESET}`;
    const out = await redactCapture(
      captureOf([colour, `${ESC}[1mpw: hunter2${RESET} tail`]),
      redactorOf({ hunter2: 'input A1' }),
    );

    should(out.lines[0]).equal(colour);
    should(out.lines[1]).equal(`pw: [redacted:input A1] tail${RESET}`);
    should(out.cols).equal(20);
  });

  it('should mask a value that wrapped over two rows with a code between, and blank the rest of its span', async () => {
    const out = await redactCapture(
      captureOf([`pw: hunt${ESC}[0m`, `er2 done${ESC}[0m`, 'untouched']),
      redactorOf({ hunter2: 'input A1' }),
    );
    const text = out.lines.join('|');

    should(text).not.containEql('hunt');
    should(text).not.containEql('er2');
    should(out.lines[0]).equal(`pw: [redacted:input A1]${RESET}`);
    should(out.lines[1]).equal(` done${RESET}`);
    should(out.lines[2]).equal('untouched');
  });

  it('should strip OSC and CSI escapes when reading and keep a literal marker already on screen as text', async () => {
    const out = await redactCapture(
      captureOf([`${ESC}]0;title\u0007[redacted:input A9] then hunter2`]),
      redactorOf({ hunter2: 'input A1' }),
    );

    should(out.lines[0]).equal(`[redacted:input A9] then [redacted:input A1]${RESET}`);
  });

  it('should merge two masks that sit side by side', async () => {
    const out = await redactCapture(
      captureOf(['hunter2swordfish!']),
      redactorOf({ hunter2: 'input A1', swordfish: 'NAME' }),
    );

    should(out.lines[0]).equal(`[redacted:input A1][redacted:NAME]!${RESET}`);
  });

  it('should hide everything from a mask on when the text after it cannot be found again', async () => {
    const lying: TextRedactor = {
      redact: async value => value,
      redactData: async value => value,
      batch: async work =>
        work({
          text: value => (value.includes('SECRET') ? 'a [redacted:x] zzz' : value),
          data: value => value,
        }),
    };
    const out = await redactCapture(captureOf(['a SECRET b']), lying);

    should(out.lines[0]).equal(`a [redacted:x]${RESET}`);
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
