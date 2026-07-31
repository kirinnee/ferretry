/**
 * A paired daemon is an explicit runtime value.  The static PWA bundle must
 * never provide a default daemon, URL, or credential.
 */
export type DaemonId = string & { readonly daemonId: unique symbol };

export interface DaemonConnectionInput {
  daemonId: string;
  baseUrl: string;
  deviceToken: string;
}

export interface DaemonConnection {
  readonly daemonId: DaemonId;
  readonly baseUrl: string;
  readonly deviceToken: string;
}

const requireNonEmpty = (value: string, name: string): string => {
  if (value.trim() === '') throw new Error(`${name} must not be empty`);
  return value;
};

/** Validates the durable daemon identity supplied by a successful pairing. */
export const daemonId = (value: string): DaemonId => requireNonEmpty(value, 'daemonId') as DaemonId;

/**
 * Normalizes only a daemon origin supplied at runtime. Credentials, paths,
 * queries, and fragments are deliberately rejected so every HTTP and
 * WebSocket adapter resolves the same `/v1` surface. A reverse-proxy prefix
 * would otherwise be preserved by the typed client and discarded by
 * origin-relative direct requests.
 */
export const daemonBaseUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('daemon URL must be absolute');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('daemon URL must use http or https');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('daemon URL may not include credentials, a query, or a fragment');
  }
  if (url.pathname !== '/') throw new Error('daemon URL must be an origin without a path');
  return url.origin;
};

/** Constructs an immutable connection from runtime pairing output. */
export const daemonConnection = (input: DaemonConnectionInput): DaemonConnection => ({
  daemonId: daemonId(input.daemonId),
  baseUrl: daemonBaseUrl(input.baseUrl),
  deviceToken: requireNonEmpty(input.deviceToken, 'deviceToken'),
});
