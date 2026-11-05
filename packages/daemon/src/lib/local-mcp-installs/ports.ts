/** A refusal in the local-copy contract's vocabulary, with the status a route answers it with. */
import type { LocalMcpRefusal } from '@ferretry/protocol';

export class LocalMcpRefusalError extends Error {
  constructor(
    readonly code: LocalMcpRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'LocalMcpRefusalError';
  }
}
