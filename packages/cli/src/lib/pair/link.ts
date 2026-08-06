import type { PairingInvitationLink } from '@ferretry/protocol';

/**
 * The last check before a pairing link becomes a QR.
 *
 * THE DAEMON BUILDS THE LINK, NOT THIS. `PairingCodeMintResponseSchema` already binds `pairUrl` to the
 * daemon, code and fingerprint it was minted with, and refuses a query string, so nothing here
 * re-derives a fragment that would only be a second opinion about the same contract.
 *
 * WHAT IT DOES ADD is the one rule that contract cannot express: `pairUrl` is validated against the
 * daemon's own `daemonUrl`, but nothing says that address is a shape the READER will accept.
 * `daemonBaseUrl` in the PWA refuses a daemon address carrying a path, a query, a fragment or
 * credentials — a reverse-proxy prefix survives the typed client and is dropped by origin-relative
 * requests, so the two halves of the app would disagree about where `/v1` is. A link that fails there
 * fails on the phone, minutes after the terminal said everything was fine, with nothing left on the
 * host to explain it. Refusing here puts the error where the operator can read it.
 */

/** An absolute `http`/`https` URL, refused rather than guessed at. */
function absoluteHttpUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be absolute, not "${value}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} must use http or https`);
  return url;
}

/** Every rejection here mirrors one in the PWA's reader, in the same order. */
function assertPairableDaemonUrl(value: string): void {
  const url = absoluteHttpUrl(value, 'daemon URL');
  if (url.username !== '' || url.password !== '') throw new Error('daemon URL may not carry credentials');
  if (url.search !== '' || url.hash !== '') throw new Error('daemon URL may not carry a query or a fragment');
  if (url.pathname !== '/') throw new Error('daemon URL must be an origin without a path');
}

/**
 * The link to encode, or a refusal naming what the phone would have rejected.
 *
 * The `v1` prefix is checked too: it is what tells the PWA that a fragment is a pairing claim at all,
 * and a link without it lands on the cold screen as though nobody had scanned anything.
 */
export function checkedPairUrl(invitation: PairingInvitationLink): string {
  const pairUrl = absoluteHttpUrl(invitation.pairUrl, 'pairing URL');
  if (!pairUrl.hash.startsWith('#v1;')) throw new Error('pairing URL does not carry a v1 pairing fragment');
  assertPairableDaemonUrl(invitation.daemonUrl);
  return invitation.pairUrl;
}

/** The part of the daemon address a human can recognise: the host names the machine, the origin is too long to read. */
export function pairingDaemonHost(daemonUrl: string): string {
  return new URL(daemonUrl).host;
}
