import type { RedactionScope } from '@ferretry/kernel/contract';
import { redactCapture } from '../../lib/terminal/redacted-capture.ts';
import type { TerminalCapture } from '../../lib/terminal/redraw.ts';
import type { TerminalStreamService } from './stream-bridge.ts';

/**
 * One viewer capture as an act (§4.7): `kernel.act(terminal, 'stream', …)` asks the Vault's holds inside the
 * terminal's queue, immediately before `read` runs, and `read` masks inside ONE `Redaction.read` (§7.3). `held` when
 * a hold refuses the viewer (a terminal in quarantine after a secret, I72/I77).
 */
export type StreamAct = (
  sessionId: string,
  terminalId: string,
  read: (scope: RedactionScope) => TerminalCapture,
  capture: () => Promise<TerminalCapture>,
) => Promise<{ readonly shown: TerminalCapture } | { readonly held: true }>;

/**
 * The hold generation of one terminal (`vault.holds-changed`): non-secret, synchronous. A frame built at one
 * generation is not sent at another (§7.3 `permit`).
 */
export type HoldGeneration = (sessionId: string, terminalId: string) => number;

/**
 * THE VIEWER'S STREAM, BEHIND THE SAME REDACTOR AS EVERY OTHER READ.
 *
 * The stream bridge draws what `capture` returns, so wrapping `capture` is the one place a live viewer
 * (the app's terminal, over a relay or not) can be kept from seeing a value the daemon has just typed or
 * holds in the vault. It masks before the bridge diffs, so a delta, a full redraw and a re-attach all
 * carry the masked screen, and a redactor that fails closes the stream rather than draw raw rows.
 *
 * WHILE A TERMINAL IS HELD the viewer is shown a notice instead of the pane: masking can only hide
 * a value it recognises, so the hold is the boundary and the masking is behind it. The notice is a
 * capture like any other, so a delta, a redraw and a re-attach all show it, and the pane returns on its own
 * when the hold ends. Input still reaches the pane.
 */
export class RedactingTerminalStreamService implements TerminalStreamService {
  private readonly notices = new WeakSet<TerminalCapture>();
  /** The hold generation each capture was taken at; a capture shown at another generation is not sent. */
  private readonly takenAt = new WeakMap<TerminalCapture, number>();

  constructor(
    private readonly inner: TerminalStreamService,
    private readonly act: StreamAct,
    private readonly generation: HoldGeneration,
  ) {}

  async write(sessionId: string, terminalId: string, bytes: Uint8Array): Promise<void> {
    await this.inner.write(sessionId, terminalId, bytes);
  }

  async resize(sessionId: string, terminalId: string, cols: number, rows: number): Promise<unknown> {
    return await this.inner.resize(sessionId, terminalId, cols, rows);
  }

  async capture(sessionId: string, terminalId: string, historyLines: number): Promise<TerminalCapture> {
    const before = this.generation(sessionId, terminalId);
    let shape: TerminalCapture | undefined;
    const answer = await this.act(
      sessionId,
      terminalId,
      scope => redactCapture(shape as TerminalCapture, scope),
      async () => {
        shape = await this.inner.capture(sessionId, terminalId, historyLines);
        return shape;
      },
    );
    if ('held' in answer) return this.hidden(shape ?? blank());
    // Asked again once the capture and the redaction are done: a hold that began while they were in flight
    // must not be drawn from a screen that was read before it.
    if (this.generation(sessionId, terminalId) !== before) return this.hidden(shape ?? answer.shown);
    this.takenAt.set(answer.shown, before);
    return answer.shown;
  }

  /**
   * The capture, or another object in its place if a hold began or ended since it was taken: the bridge's permit is
   * `publishable(shown) === shown`, so such a frame is dropped at the final check. A notice is left as it is.
   */
  publishable(sessionId: string, terminalId: string, capture: TerminalCapture): TerminalCapture {
    if (this.notices.has(capture)) return capture;
    const taken = this.takenAt.get(capture);
    return taken === undefined || taken === this.generation(sessionId, terminalId) ? capture : this.hidden(capture);
  }

  private hidden(shape: TerminalCapture): TerminalCapture {
    const shown = notice(shape);
    this.notices.add(shown);
    return shown;
  }
}

const blank = (): TerminalCapture => ({ lines: [], cols: 80, rows: 24, cursorX: 0, cursorY: 0, historySize: 0 });

/** The screen a held terminal shows: the pane's size, a short explanation, nothing of its content. */
function notice(shape: TerminalCapture): TerminalCapture {
  const message = [
    'Kept from view: a secret was just typed into this terminal.',
    'It is hidden for a short while so it cannot be read off the screen.',
    'End the hold from its input card to open it to the ferret again.',
  ];
  const lines = Array.from({ length: shape.rows }, (_, row) => message[row] ?? '');
  return { lines, cols: shape.cols, rows: shape.rows, cursorX: 0, cursorY: 0, historySize: 0 };
}
