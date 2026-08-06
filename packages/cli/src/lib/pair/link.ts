import { PAIRING_FRAGMENT_PATTERN, type PairingInvitationLink } from '@ferretry/protocol';

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
 * THE VERSION PREFIX IS CHECKED THROUGH THE PROTOCOL'S OWN PATTERN, and that is the whole lesson of
 * the defect this line used to be. It read `#v1;` literally, because when it was written there was
 * one version and this file could not be wrong about it. Then the daemon learned to mint a `v2`
 * fragment whenever it publishes a rendezvous — and `fy pair` refused the daemon's own link outright:
 * no code, no QR, no link, on the one screen that exists to hand a person all three.
 *
 * The rule that was supposed to prevent it — ship the tolerant reader before the emitter — was applied
 * to the PWA and missed here, because nobody had noticed that the fragment has TWO readers and that
 * the host's own screen is one of them. So this no longer keeps its own list of versions: it asks the
 * package that owns the fragment. A version this reader has never heard of is now the protocol's fact
 * to add, in one place, rather than a string three packages each have to remember to change.
 *
 * What it is still asking is unchanged: is this a pairing claim at all? Without a version prefix the
 * PWA treats the fragment as somebody else's and shows the cold screen, so a scan looks like nothing
 * happened rather than like a broken link. It deliberately does NOT read the fragment's fields —
 * `PairingCodeMintResponseSchema` already binds them to the daemon, code and fingerprint the link was
 * minted with, and a second opinion here would be a second thing to keep in step.
 */
export function checkedPairUrl(invitation: PairingInvitationLink): string {
  const pairUrl = absoluteHttpUrl(invitation.pairUrl, 'pairing URL');
  if (!PAIRING_FRAGMENT_PATTERN.test(pairUrl.hash)) throw new Error('pairing URL does not carry a pairing fragment');
  assertPairableDaemonUrl(invitation.daemonUrl);
  return invitation.pairUrl;
}

/** The part of the daemon address a human can recognise: the host names the machine, the origin is too long to read. */
export function pairingDaemonHost(daemonUrl: string): string {
  return new URL(daemonUrl).host;
}
