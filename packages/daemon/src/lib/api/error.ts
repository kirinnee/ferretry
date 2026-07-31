/**
 * An error a handler raises to answer with a specific status.
 *
 * Anything else escaping a handler is a defect, and the dispatcher answers 500 with a fixed message
 * rather than the thrown text: an unexpected error's message routinely carries a filesystem path or
 * a database fragment, and the API is reachable by every agent on the host.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
