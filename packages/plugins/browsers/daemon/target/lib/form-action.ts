import { createHash } from 'node:crypto';

/** A display safe for the card and fingerprints of the full canonical destination and its parsed origin. */
export interface BoundedAction {
  readonly display: string;
  readonly digest: string;
  readonly originDigest: string;
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Raw query/fragment bytes stay local to the browser read. A bounded display never substitutes for proof. */
export function boundedAction(action: string, limit: number): BoundedAction {
  const url = new URL(action);
  const canonical = url.href;
  const hash = canonical.indexOf('#');
  const query = canonical.indexOf('?');
  const suffix = (query >= 0 && (hash < 0 || query < hash) ? '?[redacted]' : '') + (hash >= 0 ? '#[redacted]' : '');
  return {
    display: (url.origin + url.pathname).slice(0, Math.max(0, limit - suffix.length)) + suffix,
    digest: digest(canonical),
    originDigest: digest(url.origin),
  };
}
