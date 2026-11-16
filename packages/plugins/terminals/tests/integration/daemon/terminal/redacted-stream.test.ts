import { describe, it } from 'bun:test';
import type { SecretName } from '@ferretry/core-vault/contract';
import { FakeRedaction } from '@ferretry/core-vault/contract/testing';
import should from 'should';
import {
  RedactingTerminalStreamService,
  type StreamAct,
} from '../../../../daemon/adapters/terminal/redacted-stream.ts';
import type { TerminalStreamService } from '../../../../daemon/adapters/terminal/stream-bridge.ts';
import type { TerminalCapture } from '../../../../daemon/lib/terminal/redraw.ts';

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

/**
 * The `stream` act as the composition binds it (`daemon/index.ts`): the holds are asked first, then the capture is
 * taken and masked inside ONE `Redaction.read` — here the Vault's contract fake, which masks one value.
 */
const actWith = (redaction: FakeRedaction, held: () => boolean, asked: string[] = []): StreamAct => {
  return async (sessionId, terminalId, read, capture) => {
    asked.push(`${sessionId}:${terminalId}`);
    if (held()) return { held: true };
    await capture();
    return { shown: await redaction.read(scope => read(scope)) };
  };
};

const vault = (): FakeRedaction => new FakeRedaction(new Map([['GITHUB_TOKEN' as SecretName, 'hunter2']]));

describe('RedactingTerminalStreamService', () => {
  it('should pass input and resizes straight through to the terminal', async () => {
    // Arrange
    const inner = new RecordingService();
    const stream = new RedactingTerminalStreamService(
      inner,
      actWith(vault(), () => false),
      () => 0,
    );

    // Act
    await stream.write('s', 't', Uint8Array.of(13, 10));
    const resized = await stream.resize('s', 't', 120, 40);

    // Assert
    should(inner.calls).eql(['write:s:t:13,10', 'resize:s:t:120x40']);
    should(resized).equal('resized');
  });

  it('I105 should draw the masked pane, exactly the matched cells as same-width stars, inside one redaction read', async () => {
    // Arrange
    const redaction = vault();
    const stream = new RedactingTerminalStreamService(
      new RecordingService(),
      actWith(redaction, () => false),
      () => 0,
    );

    // Act
    const capture = await stream.capture('s', 't', 10);

    // Assert
    should(capture.lines[0]).not.containEql('hunter2');
    should(capture.lines[0]).equal('$ *******');
    should(capture.lines[1]).equal('ok');
    should(redaction.opens).equal(1);
  });

  it('I77 should show a notice of the pane size, and nothing of the pane, while the terminal is held', async () => {
    // Arrange
    const asked: string[] = [];
    const inner = new RecordingService();
    const stream = new RedactingTerminalStreamService(
      inner,
      actWith(vault(), () => true, asked),
      () => 0,
    );

    // Act
    const capture = await stream.capture('s', 't', 10);

    // Assert — the hold was asked before the pane was read, and nothing of the pane is in the notice.
    should(asked).eql(['s:t']);
    should(inner.calls).not.containEql('capture');
    should(capture.lines.join('\n')).not.containEql('hunter2');
    should(capture.lines[0]).containEql('Kept from view');
    should(capture.lines[1]).containEql('hidden for a short while');
    should(capture.historySize).equal(0);
    should([capture.cursorX, capture.cursorY]).eql([0, 0]);
  });

  it('should close the read when the redactor fails, never draw the raw rows', async () => {
    // Arrange
    const failing: StreamAct = async (_s, _t, _read, capture) => {
      await capture();
      throw new Error('the redactor failed');
    };
    const stream = new RedactingTerminalStreamService(new RecordingService(), failing, () => 0);

    // Act & Assert
    await should(stream.capture('s', 't', 10)).be.rejectedWith('the redactor failed');
  });
});
