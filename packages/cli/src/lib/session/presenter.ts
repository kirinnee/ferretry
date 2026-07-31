import type { SessionView } from '@ferretry/protocol';
import { renderSessionView } from './display.ts';
import { SessionCommandError } from './errors.ts';
import type { IClock, ISessionIo } from './ports.ts';

/**
 * The one place session output is shaped.
 *
 * Human-readable by default, `--json` on request. Every JSON body is a value the protocol client
 * already parsed against its schema, so `--json` publishes the wire shape rather than a hand-rolled
 * echo of it. Advisory notes go to stderr so a `--json` consumer's stdout stays parseable.
 */
export class SessionPresenter {
  constructor(
    private readonly io: ISessionIo,
    private readonly clock: IClock,
  ) {}

  /** Prints one session: the detail block, or its schema-parsed JSON. */
  view(view: SessionView, json = false): void {
    if (json) {
      this.json(view);
      return;
    }
    this.lines(renderSessionView(view, this.clock.nowMs()));
  }

  /** Prints already-rendered lines to stdout. */
  lines(lines: readonly string[]): void {
    for (const line of lines) this.io.success(line);
  }

  /** Prints a schema-parsed value as indented JSON. */
  json(value: unknown): void {
    this.io.success(JSON.stringify(value, null, 2));
  }

  /** An advisory note on stderr — never a refusal, and never on stdout. */
  note(message: string): void {
    this.io.error(message);
  }

  /**
   * Reports a failed command: the message on stderr and an exit code, never a stack trace.
   *
   * A caller mistake exits 2 and a failed operation exits 1, which is the distinction a script
   * needs to tell "I typed it wrong" from "the daemon said no".
   */
  fail(error: unknown): void {
    this.io.error(error instanceof Error ? error.message : String(error));
    this.io.setExitCode(error instanceof SessionCommandError ? error.exitCode : 1);
  }
}
