import type { TextRedactor } from '../../lib/secrets/redaction.ts';
import type { TerminalCapture } from '../../lib/terminal/redraw.ts';
import { redactCapture } from '../../lib/terminal/redacted-capture.ts';
import type { TerminalStreamService } from './stream-bridge.ts';

/**
 * THE VIEWER'S STREAM, BEHIND THE SAME REDACTOR AS EVERY OTHER READ.
 *
 * The stream bridge draws what `capture` returns, so wrapping `capture` is the one place a live viewer
 * (the app's terminal, over a relay or not) can be kept from seeing a value the daemon has just typed or
 * holds in the vault. It masks before the bridge diffs, so a delta, a full redraw and a re-attach all
 * carry the masked screen, and a redactor that fails closes the stream rather than draw raw rows.
 */
export class RedactingTerminalStreamService implements TerminalStreamService {
  constructor(
    private readonly inner: TerminalStreamService,
    private readonly redactor: TextRedactor,
  ) {}

  async write(sessionId: string, terminalId: string, bytes: Uint8Array): Promise<void> {
    await this.inner.write(sessionId, terminalId, bytes);
  }

  async resize(sessionId: string, terminalId: string, cols: number, rows: number): Promise<unknown> {
    return await this.inner.resize(sessionId, terminalId, cols, rows);
  }

  async capture(sessionId: string, terminalId: string, historyLines: number): Promise<TerminalCapture> {
    return await redactCapture(await this.inner.capture(sessionId, terminalId, historyLines), this.redactor);
  }
}
