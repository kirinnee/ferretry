import type { DaemonCarrier } from '@ferretry/protocol';
import { publishedConnectionMethods } from '@ferretry/relay';
import { daemonBaseUrl, daemonConnection, daemonId, type DaemonConnection } from './daemon-connection.ts';

export interface PairingSeed {
  readonly daemonUrl: string;
  readonly daemonId: string;
  readonly code: string;
}

export interface PairingResult {
  readonly daemonId: string;
  readonly deviceToken: string;
  readonly carriers: readonly DaemonCarrier[];
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
 * How this tab was opened, as far as pairing is concerned.
 *
 * `none` is a COLD OPEN — nothing claimed to be a pairing link, so the screen
 * offers its one action. `unreadable` is the damaged case and is deliberately
 * NOT folded into it: a fragment that announces itself as `v1` and then fails
 * to parse is evidence of a broken or truncated link, and showing the ordinary
 * cold screen there would quietly tell a reader their link was never there.
 */
export type PairingArrival =
  | { readonly kind: 'none' }
  | { readonly kind: 'seed'; readonly seed: PairingSeed }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** Only a `v1` fragment is a pairing claim; any other hash belongs to something else. */
const PAIRING_FRAGMENT = /^#?v1(;|$)/u;

/**
 * Reads a pairing link out of the address the reader arrived at.
 *
 * The overwhelmingly common arrival is a QR scanned with the phone's own
 * camera app, which lands here pre-filled. Parsing it is pure so the screen can
 * be proved against an address rather than against a browser.
 */
export const pairingArrival = (href: string): PairingArrival => {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { kind: 'none' };
  }
  if (!PAIRING_FRAGMENT.test(url.hash)) return { kind: 'none' };
  try {
    return { kind: 'seed', seed: pairingSeedFromUrl(href) };
  } catch (reason) {
    return { kind: 'unreadable', reason: reason instanceof Error ? reason.message : 'the pairing link is malformed' };
  }
};

/**
 * The part of a daemon address a reader can recognise before trusting it.
 *
 * A confirmation that says only "pair?" is not a confirmation, and the whole
 * origin is too long to read on a phone; the host is the piece that identifies
 * the machine.
 */
export const pairingDaemonHost = (seed: PairingSeed): string => new URL(seed.daemonUrl).host;

/**
 * Binds the daemon's pairing response to the fingerprint carried out of band
 * by the pairing link before the PWA stores or uses its device token.
 */
export const pairedDaemonConnection = (
  seed: PairingSeed,
  result: PairingResult,
  hostedRelayUrl?: string,
): DaemonConnection => {
  const expectedDaemonId = daemonId(seed.daemonId);
  const actualDaemonId = daemonId(result.daemonId);
  if (expectedDaemonId !== actualDaemonId) throw new Error('pairing response daemon ID does not match its fingerprint');
  const published = publishedConnectionMethods(result.carriers, hostedRelayUrl);
  return daemonConnection({
    daemonId: actualDaemonId,
    baseUrl: seed.daemonUrl,
    deviceToken: result.deviceToken,
    // A newer client reading an older daemon receives the schema default `[]`.
    // The direct exchange just succeeded, so that address is the one carrier it
    // can prove without inventing a rendezvous.
    carriers: published.length === 0 ? [{ kind: 'direct', daemonUrl: seed.daemonUrl }] : published,
  });
};
