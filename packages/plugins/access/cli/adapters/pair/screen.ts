import type { IPairScreen, ITerminalSize } from '../../lib/pair/ports.ts';

/**
 * Writes the pairing screen to stdout with no colour at all.
 *
 * The shipped IO adapter tints everything it prints, and this screen contains a QR whose only job is
 * contrast. A green QR usually still decodes, but "usually" is the wrong standard for the one image
 * the whole onboarding depends on, so the pairing screen goes out verbatim and lets the terminal own
 * its palette.
 */
export class PlainScreen implements IPairScreen {
  write(text: string): void {
    process.stdout.write(`${text}\n`);
  }
}

/**
 * How wide the terminal is.
 *
 * `undefined` when stdout is not a terminal — a pipe or a file reports no width, and that is the one
 * case where the width must not be treated as small: the QR is still written, because a redirected
 * `fy pair` is somebody capturing the screen, not somebody in a 20-column window.
 */
export class ProcessTerminalSize implements ITerminalSize {
  columns(): number | undefined {
    const columns = process.stdout.columns;
    return typeof columns === 'number' && columns > 0 ? columns : undefined;
  }
}
