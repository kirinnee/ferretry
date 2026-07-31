import { daemonBaseUrl, daemonConnection, daemonId, type DaemonConnection } from './daemon-connection.ts';

export interface PairingSeed {
  readonly daemonUrl: string;
  readonly daemonId: string;
  readonly code: string;
}

export interface PairingResult {
  readonly daemonId: string;
  readonly deviceToken: string;
}

const requireNonEmpty = (value: string, name: string): string => {
  if (value.trim() === '') throw new Error(`${name} must not be empty`);
  return value;
};

/**
 * Reads the v1 pairing values from a PWA URL fragment.  Fragments are never
 * sent in HTTP requests, keeping the single-use pairing code out of logs.
 */
export const pairingSeedFromUrl = (value: string): PairingSeed => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('pairing URL must be absolute');
  }
  const pieces = url.hash.replace(/^#/u, '').split(';');
  if (pieces.shift() !== 'v1') throw new Error('pairing URL must use v1');
  const values = new Map<string, string>();
  for (const piece of pieces) {
    const separator = piece.indexOf('=');
    if (separator <= 0) throw new Error('pairing URL contains an invalid field');
    const name = piece.slice(0, separator);
    if (values.has(name)) throw new Error(`pairing URL repeats ${name}`);
    values.set(name, decodeURIComponent(piece.slice(separator + 1)));
  }
  const daemonUrl = values.get('url');
  const code = values.get('code');
  const fingerprint = values.get('fp');
  if (daemonUrl === undefined || code === undefined || fingerprint === undefined || values.size !== 3) {
    throw new Error('pairing URL must include url, code, and fp only');
  }
  return {
    daemonUrl: daemonBaseUrl(daemonUrl),
    daemonId: daemonId(fingerprint),
    code: requireNonEmpty(code, 'pairing code'),
  };
};

/**
 * Binds the daemon's pairing response to the fingerprint carried out of band
 * by the pairing link before the PWA stores or uses its device token.
 */
export const pairedDaemonConnection = (seed: PairingSeed, result: PairingResult): DaemonConnection => {
  const expectedDaemonId = daemonId(seed.daemonId);
  const actualDaemonId = daemonId(result.daemonId);
  if (expectedDaemonId !== actualDaemonId) throw new Error('pairing response daemon ID does not match its fingerprint');
  return daemonConnection({ daemonId: actualDaemonId, baseUrl: seed.daemonUrl, deviceToken: result.deviceToken });
};
