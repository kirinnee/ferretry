import { randomUUID } from 'node:crypto';
import { parseSessionId, type SessionId } from '../../../lib/index.ts';
import type { SessionIdFactory } from '../../../lib/session/lifecycle/index.ts';

/**
 * Server-side session ids: a base-36 timestamp for sortability plus random entropy for uniqueness.
 * Minting ids here — rather than accepting one from a client — is what makes it impossible for a
 * request to name, and so overwrite, a session that already exists.
 */
export class TimeSessionIdFactory implements SessionIdFactory {
  constructor(
    private readonly currentMilliseconds: () => number = () => Date.now(),
    private readonly unique: () => string = randomUUID,
  ) {}

  next(): SessionId {
    const entropy = this.unique().replaceAll('-', '').toLowerCase().slice(0, 8);
    return parseSessionId(`${this.currentMilliseconds().toString(36)}-${entropy}`);
  }
}
