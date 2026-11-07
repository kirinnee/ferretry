import type { FerretSummary } from '../../../contract/index.ts';
import { renderFerret } from './display.ts';
import { SessionCommandError } from './errors.ts';
import type { ISessionIo } from './ports.ts';

/**
 * The one place ferret output is shaped.
 *
 * Human-readable by default, `--json` on request. Every JSON body is a value the daemon answered, so `--json`
 * publishes the wire shape rather than a hand-rolled echo of it. Advisory notes go to stderr so a `--json`
 * consumer's stdout stays parseable.
 */
export class SessionPresenter {
  constructor(private readonly io: ISessionIo) {}

  /** Prints one ferret: the detail block, or its JSON. */
  view(view: FerretSummary, json = false): void {
    if (json) {
      this.json(view);
      return;
    }
    this.lines(renderFerret(view));
  }

  /** Prints already-rendered lines to stdout. */
  lines(lines: readonly string[]): void {
    for (const line of lines) this.io.success(line);
  }

  /** Prints a report to stdout without the success paint: a rendering that colour-codes its own cells. */
  report(lines: readonly string[]): void {
    for (const line of lines) this.io.report(line);
  }

  /** Prints a value as indented JSON. */
  json(value: unknown): void {
    this.io.success(JSON.stringify(value, null, 2));
  }

  /** An advisory note on stderr — never a refusal, and never on stdout. */
  note(message: string): void {
    this.io.error(message);
  }

  /**
   * Reports a failed command: the message on stderr and an exit code, never a stack trace. A caller mistake exits 2
   * and a failed operation exits 1, which is the distinction a script needs to tell "I typed it wrong" from "the
   * daemon said no".
   */
  fail(error: unknown): void {
    this.io.error(error instanceof Error ? error.message : String(error));
    this.io.setExitCode(error instanceof SessionCommandError ? error.exitCode : 1);
  }
}
