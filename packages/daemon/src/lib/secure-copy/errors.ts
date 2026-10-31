/**
 * Why a copy was not captured, found or discarded, in words the agent can act on. `code` is the agent-tool
 * refusal class. The message never carries a value: a command's stderr is masked before it is quoted.
 */
export class SecureCopyError extends Error {
  constructor(
    readonly code: 'bad_request' | 'not_found' | 'conflict' | 'capacity' | 'unavailable' | 'upstream_failed',
    message: string,
  ) {
    super(message);
    this.name = 'SecureCopyError';
  }
}
