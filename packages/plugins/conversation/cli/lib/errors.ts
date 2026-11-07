/**
 * A caller mistake, stated in the caller's own vocabulary.
 *
 * Carries the exit code the verb ends with, so a controller never reaches for `process` to say "this was a usage
 * error" (2) rather than "the operation failed" (1).
 */
export class CommandError extends Error {
  override readonly name = 'CommandError';

  constructor(
    message: string,
    readonly exitCode: number = 2,
  ) {
    super(message);
  }
}
