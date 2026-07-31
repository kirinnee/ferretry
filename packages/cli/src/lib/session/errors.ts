/**
 * A caller mistake, stated in the caller's own vocabulary.
 *
 * Carries the exit code the CLI should end with, so the controllers never reach for `process` to
 * express "this was a usage error" (2) rather than "the operation failed" (1).
 */
export class SessionCommandError extends Error {
  override readonly name = 'SessionCommandError';

  constructor(
    message: string,
    readonly exitCode: number = 2,
  ) {
    super(message);
  }
}
