import type { TextRedactor } from '../../lib/secrets/redaction.ts';
import { redactCapture } from '../../lib/terminal/redacted-capture.ts';
import type { TerminalCapture } from '../../lib/terminal/redraw.ts';
import type { TerminalStreamService } from './stream-bridge.ts';

/**
 * Asks whether a terminal is kept from view and until when (epoch milliseconds). Absent, or answering
 * nothing, means it is shown. A viewer that chose to see it anyway is given no gate at all.
 */
export type QuarantineGate = (sessionId: string, terminalId: string) => number | undefined;

/**
 * THE VIEWER'S STREAM, BEHIND THE SAME REDACTOR AS EVERY OTHER READ.
 *
 * The stream bridge draws what `capture` returns, so wrapping `capture` is the one place a live viewer
 * (the app's terminal, over a relay or not) can be kept from seeing a value the daemon has just typed or
 * holds in the vault. It masks before the bridge diffs, so a delta, a full redraw and a re-attach all
 * carry the masked screen, and a redactor that fails closes the stream rather than draw raw rows.
 *
 * WHILE A TERMINAL IS QUARANTINED the viewer is shown a notice instead of the pane: masking can only hide
 * a value it recognises, so the quarantine is the boundary and the masking is behind it. The notice is a
 * capture like any other, so a delta, a redraw and a re-attach all show it, and the pane returns on its own
 * when the window ends. Input still reaches the pane. A viewer that asked to see it anyway is built without
 * a gate and gets the masked pane.
 */
export class RedactingTerminalStreamService implements TerminalStreamService {
  constructor(
    private readonly inner: TerminalStreamService,
    private readonly redactor: TextRedactor,
    private readonly quarantined?: QuarantineGate,
    private readonly now: () => number = Date.now,
  ) {}

  async write(sessionId: string, terminalId: string, bytes: Uint8Array): Promise<void> {
    await this.inner.write(sessionId, terminalId, bytes);
  }

  async resize(sessionId: string, terminalId: string, cols: number, rows: number): Promise<unknown> {
    return await this.inner.resize(sessionId, terminalId, cols, rows);
  }

  async capture(sessionId: string, terminalId: string, historyLines: number): Promise<TerminalCapture> {
    const until = this.quarantined?.(sessionId, terminalId);
    const capture = await this.inner.capture(sessionId, terminalId, historyLines);
    if (until !== undefined) return notice(capture, until, this.now());
    return await redactCapture(capture, this.redactor);
  }
}

/** The screen a quarantined terminal shows: the pane's size, a short explanation, nothing of its content. */
function notice(shape: TerminalCapture, until: number, now: number): TerminalCapture {
  const seconds = Math.max(1, Math.ceil((until - now) / 1000));
  const message = [
    'Kept from view: a secret was just typed into this terminal.',
    `It is hidden for about ${seconds}s so it cannot be read off the screen.`,
    'Use "Show anyway" to look at it, or "End quarantine" to open it to the ferret.',
  ];
  const lines = Array.from({ length: shape.rows }, (_, row) => message[row] ?? '');
  return { lines, cols: shape.cols, rows: shape.rows, cursorX: 0, cursorY: 0, historySize: 0 };
}
