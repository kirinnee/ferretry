/**
 * Why an input request was not raised, answered or delivered, in words the caller can act on. `code` is the
 * class (the HTTP status and the agent-tool refusal come from it); `reason` is the wire error code the
 * owner's client switches on (`INPUT_ERROR_CODES`). The message never carries a value.
 */
export class InputRequestError extends Error {
  constructor(
    readonly code: 'bad_request' | 'not_found' | 'conflict' | 'forbidden' | 'capacity' | 'unavailable' | 'gone',
    message: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'InputRequestError';
  }
}
