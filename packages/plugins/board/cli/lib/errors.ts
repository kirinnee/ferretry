/**
 * A refusal the user caused: a missing flag, an unparseable id, a value outside its enum. The verb prints `message`
 * and exits non-zero, so the message must be actionable on its own: never a stack trace, never a bare "invalid".
 */
export class CliInputError extends Error {
  override readonly name = 'CliInputError';
}

/** Throw a {@link CliInputError}; typed `never` so callers can use it in expression position. */
export function refuse(message: string): never {
  throw new CliInputError(message);
}
