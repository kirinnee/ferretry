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

/**
 * Is this the same LIVE connection? The liveness boundary for anything holding
 * a credential — an in-flight request, a poll generation, an open socket, the
 * pixels already painted.
 *
 * `daemonId` alone cannot answer it. The id is DURABLE ACROSS A RE-PAIR, and a
 * re-pair is exactly when the base URL or the device token rotates: the same
 * daemon id can afterwards name a new endpoint or a new device grant. A holder
 * that treated `(daemonId, sessionId)` as its whole identity would let the old
 * pairing's late answer land in the new one.
 *
 * Compared FIELD BY FIELD, deliberately, and on purpose not as a derived key
 * string. A host that rebuilds an equivalent connection object each render has
 * not re-paired, so object identity is the wrong test; and a key string
 * containing `deviceToken` invites the credential into a cache key, a DOM
 * attribute or a log line, none of which may ever hold it.
 *
 * DURABLE state is a separate question with a separate answer: a remembered
 * preference keyed by `(daemonId, sessionId)` — the browser engine memory, for
 * instance — SHOULD survive a re-pair. Only liveness may not.
 */
export const sameDaemonConnection = (left: DaemonConnection, right: DaemonConnection): boolean =>
  left.daemonId === right.daemonId && left.baseUrl === right.baseUrl && left.deviceToken === right.deviceToken;
