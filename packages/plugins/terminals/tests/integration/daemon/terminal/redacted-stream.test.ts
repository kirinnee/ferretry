import { describe, it } from 'bun:test';
import should from 'should';
import { RedactingTerminalStreamService, type TerminalStreamService } from '../../../src/adapters/index.ts';
import { NO_REDACTION, type TerminalCapture, type TextRedactor } from '../../../src/lib/index.ts';

const pane = (lines: readonly string[]): TerminalCapture => ({
  lines,
  cols: 80,
  rows: lines.length,
  cursorX: 3,
  cursorY: 1,
  historySize: 4,
});

class RecordingService implements TerminalStreamService {
  readonly calls: string[] = [];
  screen = pane(['$ hunter2', 'ok', '', '', '']);
  async write(sessionId: string, terminalId: string, bytes: Uint8Array): Promise<void> {
    this.calls.push(`write:${sessionId}:${terminalId}:${[...bytes].join(',')}`);
  }
  async resize(sessionId: string, terminalId: string, cols: number, rows: number): Promise<unknown> {
    this.calls.push(`resize:${sessionId}:${terminalId}:${cols}x${rows}`);
    return 'resized';
  }
  async capture(): Promise<TerminalCapture> {
    this.calls.push('capture');
    return this.screen;
  }
}

/** A redactor that masks one word, so a test can tell a masked pane from a raw one. */
const maskingWord = (word: string): TextRedactor => ({
  redact: async text => text.split(word).join('[x]'),
  redactData: async value => value,
  batch: async work =>
    work({
      text: text => text.split(word).join('[x]'),
      data: value => value,
      cover: text => {
        const ranges: { start: number; end: number }[] = [];
        for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1))
          ranges.push({ start: at, end: at + word.length });
        return ranges;
      },
    }),
});

describe('RedactingTerminalStreamService', () => {
  it('should pass input and resizes straight through to the terminal', async () => {
    // Arrange
    const inner = new RecordingService();
    const stream = new RedactingTerminalStreamService(inner, NO_REDACTION);

    // Act
    await stream.write('s', 't', Uint8Array.of(13, 10));
    const resized = await stream.resize('s', 't', 120, 40);

    // Assert
    should(inner.calls).eql(['write:s:t:13,10', 'resize:s:t:120x40']);
    should(resized).equal('resized');
  });

  it('should draw the masked pane when no quarantine applies', async () => {
    // Arrange
    const stream = new RedactingTerminalStreamService(new RecordingService(), maskingWord('hunter2'), () => undefined);

    // Act
    const capture = await stream.capture('s', 't', 10);

    // Assert
    should(capture.lines[0]).not.containEql('hunter2');
    should(capture.lines[0]).equal('$ *******');
  });

  it('should draw the masked pane when there is no gate at all', async () => {
    // Arrange
    const stream = new RedactingTerminalStreamService(new RecordingService(), maskingWord('hunter2'));

    // Act
    const capture = await stream.capture('s', 't', 10);

    // Assert
    should(capture.lines[0]).not.containEql('hunter2');
  });

  it('should show a notice of the pane size, and nothing of the pane, while the terminal is quarantined', async () => {
    // Arrange
    const asked: string[] = [];
    const stream = new RedactingTerminalStreamService(
      new RecordingService(),
      NO_REDACTION,
      (sessionId, terminalId) => {
        asked.push(`${sessionId}:${terminalId}`);
        return 100_000 + 30_500;
      },
      () => 100_000,
    );

    // Act
    const capture = await stream.capture('s', 't', 10);

    // Assert
    should(asked).eql(['s:t']);
    should(capture.rows).equal(5);
    should(capture.cols).equal(80);
    should(capture.lines).have.length(5);
    should(capture.lines.join('\n')).not.containEql('hunter2');
    should(capture.lines[0]).containEql('Kept from view');
    should(capture.lines[1]).containEql('about 31s');
    should(capture.lines[4]).equal('');
    should(capture.historySize).equal(0);
    should([capture.cursorX, capture.cursorY]).eql([0, 0]);
  });

  it('should never announce a window shorter than a second', async () => {
    // Arrange
    const stream = new RedactingTerminalStreamService(
      new RecordingService(),
      NO_REDACTION,
      () => 100_001,
      () => 100_000,
    );

    // Act
    const capture = await stream.capture('s', 't', 10);

    // Assert
    should(capture.lines[1]).containEql('about 1s');
  });
});
