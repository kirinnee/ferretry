import { type Advertisement, isLoopbackLinkAddress } from '@ferretry/protocol';
import type { ShareLinkTarget } from './ports.ts';

/** The remedy for a machine nobody else can reach: the relay first (it opens no port), then an address. */
const REACH_REMEDY =
  'Turn on the hosted relay (a carriers entry { "kind": "relay", "source": "discovery" } in daemon.json, not switched off with "enabled": false), or bind every interface and set a public address (publicUrl).';

/**
 * Where a share link points, decided by THE CARRIERS PAIRING USES (docs/pairing.md "The link names no
 * rendezvous; the device finds one itself").
 *
 * A share is for ANOTHER person's browser, so the link must name something a different device can reach:
 * - an address another device can dial, written into the link as it is;
 * - or a loopback address on a machine that dials a rendezvous the other browser DISCOVERS FOR ITSELF. The
 *   link carries the loopback address and the fingerprint, exactly as a pairing link from the same machine
 *   does; the browser proves the publisher against that fingerprint on the rendezvous before the code leaves
 *   it (docs/relay-protocol.md §14 "Member sessions").
 *
 * `discoveredRelayUrl` is the composition root's `discoverableRelayUrl`, the same value pairing's QR is drawn
 * from, so a share link and a pairing QR can never disagree about one machine. A self-hosted rendezvous is
 * not discoverable by a stock browser, so it does not count: pairing's declared GAP, mirrored and not widened.
 *
 * A `publicUrl` that is itself loopback counts as a loopback bind. A wildcard bind with no `publicUrl` has no
 * address to put in a link at all, so it is refused even beside a rendezvous, as pairing refuses it.
 * Asked BEFORE a code is made, so a refused link spends nothing.
 */
export function shareLinkTarget(
  advertisement: Advertisement | undefined,
  daemonId: string | undefined,
  appOrigin: string,
  discoveredRelayUrl: string | undefined,
): ShareLinkTarget {
  if (advertisement === undefined || daemonId === undefined)
    return { kind: 'unavailable', reason: 'This machine is still starting. Try again in a moment.' };
  // An operator's `publicUrl` that is itself loopback reaches nobody else either: it is judged as a loopback bind,
  // so a link is never made that only this machine could open, and a loopback link is always a relayed one (the
  // promise `shareLinkNotice` makes beside it).
  if (advertisement.kind === 'address' && !isLoopbackLinkAddress(advertisement.url))
    return { kind: 'ready', appOrigin, daemonUrl: advertisement.url, daemonId };
  if (advertisement.kind !== 'none') {
    if (discoveredRelayUrl !== undefined) return { kind: 'ready', appOrigin, daemonUrl: advertisement.url, daemonId };
    return {
      kind: 'unavailable',
      reason: `This machine only answers on its own loopback address and is not on a relay another person's browser can find, so nobody else could open a link. ${REACH_REMEDY}`,
    };
  }
  return {
    kind: 'unavailable',
    reason:
      advertisement.refusal === 'no-port'
        ? 'This machine has no port to put in a link. Set a public address (publicUrl) or a port.'
        : 'This machine listens on every address and has no public address to put in a link. Set a public address (publicUrl) so a share link has somewhere to point.',
  };
}
