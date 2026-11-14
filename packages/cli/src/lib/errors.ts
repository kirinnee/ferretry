/** Exit codes the shell uses. Everything else a verb returns is its own. */
export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  /** EX_UNAVAILABLE: a skeleton plugin, or a plugin this fy and the daemon do not agree on. */
  unavailable: 69,
} as const;

/** A failure with a sentence for the person and an exit code; the router prints `message` and exits. */
export class ShellError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.failure,
  ) {
    super(message);
    this.name = 'ShellError';
  }
}

/** The daemon answered with a refusal. It is final (S54): never retried with another credential. */
export class DaemonRefusal extends ShellError {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** The answer's body, for a verb that reads the located problems a refusal carries (a `422 config_invalid`). Never printed. */
    readonly body?: unknown,
  ) {
    super(message, EXIT.failure);
    this.name = 'DaemonRefusal';
  }
}

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * What the router does with a failure nobody handled: a {@link ShellError} says its own sentence and exit code; anything
 * else is named after the binary and fails. Shared by the full router and the slim `mcp serve` entry, so both end alike.
 */
export function reportFailure(error: unknown, io: { err(text: string): void }, binary: string): number {
  if (error instanceof ShellError) {
    io.err(`${error.message}\n`);
    return error.exitCode;
  }
  io.err(`${binary}: ${errorText(error)}\n`);
  return EXIT.failure;
}
