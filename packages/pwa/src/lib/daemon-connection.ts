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
 * Normalizes only a daemon origin/path supplied at runtime.  Credentials,
 * queries, and fragments are deliberately rejected so they cannot become an
 * accidental transport or persistence channel.
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
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return url.toString().replace(/\/$/u, '');
};

/** Constructs an immutable connection from runtime pairing output. */
export const daemonConnection = (input: DaemonConnectionInput): DaemonConnection => ({
  daemonId: daemonId(input.daemonId),
  baseUrl: daemonBaseUrl(input.baseUrl),
  deviceToken: requireNonEmpty(input.deviceToken, 'deviceToken'),
});
