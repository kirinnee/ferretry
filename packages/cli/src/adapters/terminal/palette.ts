import chalk from 'chalk';
import {
  FALLBACK_TERMINAL_WIDTH,
  type FleetPalette,
  type FleetPresentation,
  NARROWEST_USABLE_WIDTH,
  PLAIN_FLEET_PALETTE,
} from '../../lib/fleet/presentation.ts';

/**
 * The one place a meaning becomes a colour.
 *
 * chalk is the repository's existing terminal dependency and it owns the escape codes, which is why
 * none are written here: hand-rolled sequences would be a second spelling of something already
 * shipped, and one that gets the 256-colour and truecolour cases wrong.
 *
 * It does NOT own whether this invocation may paint — see `terminalFleetPresentation`.
 *
 * `UNKNOWN` gets `muted` rather than a warning colour, and that decision is stated in `healthInk`
 * where the meaning lives. This file only supplies the ink.
 */
export function chalkFleetPalette(): FleetPalette {
  return {
    danger: text => chalk.red(text),
    good: text => chalk.green(text),
    muted: text => chalk.dim(text),
    // Dim so it reads as an aside rather than as prose, cyan so it reads as something to select.
    command: text => chalk.dim(chalk.cyan(text)),
  };
}

/** What the composition root observed about stdout. Every field is read there and never here. */
export interface TerminalSurface {
  /** `process.stdout.isTTY`, as a boolean. */
  readonly terminal: boolean;
  /** `process.stdout.columns`. Absent off a terminal, and 0 on a pty that was never sized. */
  readonly columns: number | undefined;
  /** `NO_COLOR` exactly as the environment holds it — any non-empty value means no colour. */
  readonly noColor: string | undefined;
}

/**
 * Whether this invocation may emit an escape code at all.
 *
 * THIS DOES NOT DELEGATE TO CHALK, and that is deliberate rather than duplication: chalk 5 under Bun
 * reports full colour support with `NO_COLOR=1` set, verified by running it. Trusting its detection
 * would put escape codes in the output of somebody who asked, in the documented way, for none — and
 * the failure is invisible to anybody developing on a runtime where it works.
 *
 * The decision only ever RESTRICTS. When this says yes, chalk still applies its own level, so a
 * terminal chalk considers colourless stays colourless; there is no path where this turns colour ON
 * against chalk's judgement.
 *
 * `FORCE_COLOR` is deliberately NOT honoured. Making it work would mean reaching in and setting
 * chalk's global level, and a piped report is the one this has the least right to decorate.
 */
function mayPaint(surface: TerminalSurface): boolean {
  return surface.terminal && (surface.noColor ?? '') === '';
}

/**
 * How wide this invocation may draw, and in what colours.
 *
 * A width of 0 or nothing at all means the surface never said, which is what a pipe, a redirect and an
 * unsized pty all report. The fallback is what keeps a redirected report readable rather than one very
 * long line per row.
 *
 * A REAL NARROW TERMINAL IS HONOURED rather than rounded up to the fallback, because that is the case
 * the wrapping exists for: rendering 80 columns into a 60-column window hands the wrapping back to the
 * terminal, which indents nothing and puts half a sentence hard against the left margin. The floor is
 * only there to stop a degenerate width from producing one word per line.
 */
export function terminalFleetPresentation(surface: TerminalSurface): FleetPresentation {
  const columns = surface.columns ?? 0;
  return {
    palette: mayPaint(surface) ? chalkFleetPalette() : PLAIN_FLEET_PALETTE,
    width: columns > 0 ? Math.max(NARROWEST_USABLE_WIDTH, columns) : FALLBACK_TERMINAL_WIDTH,
  };
}
