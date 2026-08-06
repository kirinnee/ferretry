/**
 * FIRST CONTACT WITH A DAEMON THIS BROWSER CANNOT REACH.
 *
 * `docs/relay-protocol.md` §14 "Pairing sessions" is the contract and this is the browser's half of
 * it. The document used to forbid this outright; the error it named in retiring that prohibition is
 * worth restating here, because it is the reason every line below is safe:
 *
 *   THE QR IS THE OUT-OF-BAND ENROLMENT PATH, AND ALWAYS WAS. It hands the device the daemon's
 *   fingerprint before any carrier is dialled, and §6 has the client refuse to derive keys — or
 *   reveal anything at all — until the presented identity hashes to that pinned fingerprint. So by
 *   the time the `pair` record below can exist, the daemon has already been proved to this browser,
 *   end to end, THROUGH the untrusted rendezvous. The comparison lands the other way from where the
 *   old prohibition pointed: the permitted DIRECT redemption is a plain-HTTP POST to an address
 *   nothing has authenticated, which hands the live code to whatever answers at it.
 *
 * WHY THIS IS NOT IN `relay-carrier.ts`. That module's whole subject is a daemon this browser is
 * already paired with: every entry point it owns takes a `DaemonConnection`, which requires a device
 * token. A pairing attempt has none — that is the point of it — and has no entry in the router's
 * registry to be torn down by an unpair, because there is nothing paired yet. Bolting a
 * credential-less branch into the router would put "sometimes there is no credential" into the one
 * class whose invariant is that there always is.
 *
 * WHAT THIS MODULE REFUSES TO DO:
 *
 * - **It will not dial a fingerprint it cannot verify.** A rendezvous is addressed by
 *   `fy_daemon_<43 base64url>` (§4) and the handshake is checked against that same string (§6), so a
 *   link whose `fp` is in any other spelling is refused rather than dialled at.
 * - **It will not treat a refusal as a reason to try elsewhere.** A sealed `pair-refused` means the
 *   exchange HAPPENED and the answer is final for that attempt; carrying the same code to the next
 *   rendezvous would spend another attempt from the relay budget to be told the same thing.
 * - **It will not remember the rendezvous it used.** The candidate is for one redemption. What the
 *   device navigates by afterwards is the daemon's own published set, and `pairedDaemonConnection`
 *   refuses the pairing outright if that set does not name the rendezvous this exchange crossed.
 */

import type { PairingResponse } from '@ferretry/protocol';
import { type ConnectionMethod, connectionSocketUrl, parseDaemonId, RELAY_CLOSE_CODES } from '@ferretry/relay';
import { daemonRelayCarrier, type RelayCarrier } from './daemon-connection.ts';
import type { PairingSeed } from './pairing.ts';
import { browserRelayDial, driveRelaySession, type RelayDial, type RelayHeartbeatSchedule } from './relay-carrier.ts';
import { RelayClientSession, type RelayClientSessionDependencies, RelaySessionError } from './relay-session.ts';

/**
 * Every rendezvous this redemption may try, in the order §14 gives — and never the direct address.
 *
 * §1's rule does not bend for pairing: direct is attempted first and is attempted by the caller,
 * over ordinary HTTP, because a browser that can reach the daemon has no reason to involve a third
 * party. This list is what comes AFTER that, and its order is the protocol's:
 *
 * 1. **the link's own candidate**, daemon-authored and carried out of band with the same trust as
 *    the fingerprint beside it — so a daemon published only on a self-hosted rendezvous is pairable
 *    off-LAN, which is the entire reason the v2 fragment exists;
 * 2. **the discovery advertisement's hosted rendezvous**, which is what a v1 link leaves as the only
 *    relayed path.
 *
 * DEDUPLICATED BY ADDRESS, because a daemon whose first published relay IS the hosted one would
 * otherwise be dialled twice — two sockets, two handshakes, and two attempts spent from a five-guess
 * budget to ask one question.
 *
 * A FINGERPRINT THIS PROTOCOL CANNOT ADDRESS GETS NO CANDIDATES AT ALL. `connectionSocketUrl` would
 * refuse the address and `completeClientHandshake` would have nothing to check the daemon against, so
 * a session keyed here could not be proved to be with the right daemon — which is exactly the session
 * a hostile carrier would like this browser to open.
 */
export const relayPairingCandidates = (
  seed: PairingSeed,
  hostedRelayUrl: string | undefined,
): readonly RelayCarrier[] => {
  if (parseDaemonId(seed.daemonId) === null) return [];
  const candidates: RelayCarrier[] = [];
  const seen = new Set<string>();
  const offer = (carrier: RelayCarrier | undefined): void => {
    if (carrier === undefined || seen.has(carrier.relayUrl)) return;
    seen.add(carrier.relayUrl);
    candidates.push(carrier);
  };
  offer(seed.relay);
  offer(discoveredRendezvous(hostedRelayUrl));
  return candidates;
};

/**
 * The advertisement's address, parsed by the protocol's own rule rather than trusted.
 *
 * The same treatment `daemonRelayCarrier` gives a stored carrier and `hostedRelayFallbackCarrier`
 * gives a paired daemon's fallback: an address arriving from anywhere is held to
 * `ConnectionMethodSchema` before anything dials it. A build with no directory answers `undefined`
 * here and offers nothing, which is what a fail-closed discovery honestly is.
 */
const discoveredRendezvous = (hostedRelayUrl: string | undefined): RelayCarrier | undefined => {
  if (hostedRelayUrl === undefined) return undefined;
  try {
    return daemonRelayCarrier({ kind: 'relay', relayUrl: hostedRelayUrl, operator: 'hosted' });
  } catch {
    return undefined;
  }
};

export interface RelayPairingAttemptOptions {
  readonly crypto: RelayClientSessionDependencies['crypto'];
  readonly seed: PairingSeed;
  readonly deviceName: string;
  /** The one rendezvous this attempt may dial. One attempt is one session is one rendezvous. */
  readonly rendezvous: RelayCarrier;
  readonly dial?: RelayDial;
  readonly heartbeat?: RelayHeartbeatSchedule;
}

/**
 * One redemption attempt, over one rendezvous, answered by the daemon's own sealed outcome.
 *
 * Resolves with the pairing API's verbatim redemption response — §14 embeds it whole rather than
 * re-listing its fields, "so the next field the pairing API adds crosses the relay the day it ships
 * instead of being silently dropped by a copy of the list".
 *
 * Rejects with `RelayPairingRefusedError` when the daemon refused inside the channel, and with a
 * `RelaySessionError` when nothing reached the daemon. Those are the two facts §14 requires a client
 * to keep apart, and it says how they are told apart: "one arrives as a close outside the channel,
 * the other as a record inside it."
 */
export const redeemPairingOverRelay = async ({
  crypto,
  seed,
  deviceName,
  rendezvous,
  dial = browserRelayDial,
  heartbeat,
}: RelayPairingAttemptOptions): Promise<PairingResponse> => {
  const url = connectionSocketUrl(rendezvous as ConnectionMethod, seed.daemonId, 'client');
  if (url === null) {
    throw new RelaySessionError('this daemon fingerprint cannot address a rendezvous', RELAY_CLOSE_CODES.protocolError);
  }
  const socket = dial(url);
  const session = new RelayClientSession({
    crypto,
    daemonId: seed.daemonId,
    mode: { kind: 'pair', code: seed.code, deviceName },
    socket,
  });
  const outcome = await driveRelaySession({
    socket,
    session,
    heartbeat: heartbeat ?? defaultHeartbeat,
    settled: session.paired(),
    // The daemon closes this session the moment it has answered, so nothing here goes on to carry
    // traffic and an armed heartbeat would outlive the conversation it was measuring.
    keepAlive: false,
  });
  // The daemon ends the session itself (§14), but a socket this side is finished with is a socket
  // this side closes: an attempt that resolved and then left a rendezvous connection open would hold
  // one of the eight sessions a rendezvous serves for no reason at all.
  socket.close(1000, 'this pairing attempt is complete');
  return outcome.response;
};

const defaultHeartbeat: RelayHeartbeatSchedule = (tick, interval) => {
  const handle = setInterval(tick, interval);
  return () => clearInterval(handle);
};
