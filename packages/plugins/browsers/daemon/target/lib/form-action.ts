import { createHash } from 'node:crypto';

/** What the card keeps of a form's action: a readable value cut to the protocol's bound, and a fingerprint when it was cut. */
export interface BoundedAction {
  readonly display: string;
  /** SHA-256 (hex) of the WHOLE action, present only when `display` is shorter than it: so two long actions that share a prefix still differ. */
  readonly digest?: string;
}

/**
 * A form's action (origin + path) held to `limit` characters without losing what it is compared by: the first `limit`
 * characters are the readable display, and a longer one also carries a fingerprint of the whole, so the write's proof
 * compares the full destination while the facts stay bounded.
 */
export function boundedAction(action: string, limit: number): BoundedAction {
  if (action.length <= limit) return { display: action };
  return { display: action.slice(0, limit), digest: createHash('sha256').update(action).digest('hex') };
}
