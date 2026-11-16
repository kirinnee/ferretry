/** Onboarding copy only. Discovery belongs to Connections. */
/* ---------- what the screen says about all this --------------------------- */

/**
 * What the connection note on the daemon step says about the hosted relay.
 *
 * `onboarding-connection-note.tsx` states the carrier order rather than asking
 * for one; this is the live fact it cannot state from a constant, because the
 * relay's operator can withdraw it between a release and a reader arriving.
 */
export const HOSTED_RELAY_ROW_NOTE =
  'Ferretry runs this one. Direct is still used whenever the daemon is reachable; the relay carries the ' +
  'connection when it is not.';

/**
 * WHICH CARRIER IS ACTUALLY IN USE — the honest version, at the one moment this
 * screen can honestly say anything about it.
 *
 * This line used to be the literal string `'Direct'`, passed in by the
 * composition root whenever anything was paired. That was a claim nothing had
 * measured. It then said no relay was ever dialled, which was true when it was
 * written and IS NO LONGER: `relay-carrier.ts` attempts direct first and falls
 * back to a rendezvous automatically.
 *
 * IT THEN SAID `Direct — pairing is always direct`, WHICH IS THE SAME MISTAKE A
 * THIRD TIME. That claim came from `docs/relay-protocol.md` §13 when pairing had
 * no relayed path; §14 has since given first contact a session mode of its own,
 * and `exchangePairing` in `lib/store.tsx` walks direct, then the ONE rendezvous
 * this build discovered for itself from the hosted directory advertisement. So a
 * redemption that completed says nothing about which carrier completed it, and a
 * screen that prints `Direct` is guessing again — just with a sentence that reads
 * as a protocol rule rather than as the guess it is.
 *
 * (An earlier draft of this paragraph described a middle leg — "the link's own
 * rendezvous candidate" — from the withdrawn `v2` fragment. No link names a
 * rendezvous: `PairingLinkSeed` has three fields, `relayPairingCandidates` offers
 * at most the discovered hosted address, and a stray `relay=` is an ignored
 * unknown field. The order this function may state is two legs, not three.)
 *
 * WHAT ONBOARDING HONESTLY KNOWS IS THE ORDER, NOT THE ANSWER: direct is tried
 * first, and the hosted relay carries it when direct does not work. There is no
 * reader's pick to echo back — the three-way carrier chooser this used to take an
 * answer from is gone, because the order is the product contract, not a setting.
 * THE MEASURED ANSWER LIVES ELSEWHERE, deliberately: `ActiveCarrierCard` renders
 * `chooseConnection().reason` for whichever carrier a live session won on. A
 * setup screen cannot report a measurement that has not been taken yet.
 */
export const activeCarrierStatus = (): string =>
  'Not measured yet — the daemon is tried directly first, then the hosted relay. Its Connection panel in Settings ' +
  '(the machine’s Machine tab) names the carrier in use, and why, once this daemon is asked for anything.';

/**
 * THE WHOLE DISCLOSURE: what carries this connection, and what the FALLBACK
 * would see if it ever carried one.
 *
 * Naming the carrier in use is half of it. The other half is the half a reader
 * cannot check for themselves: the fallback is a third party, and the daemon step
 * that first said so may be several screens and possibly several days behind
 * them. Saying "Direct" at the end and stopping there would quietly retire that
 * disclosure, so the fallback's terms are restated exactly where the connection
 * becomes real.
 */
export interface CarrierDisclosure {
  /** The carrier this build actually dials, said plainly. */
  readonly inUse: string;
  /** What the fallback would learn, if it were carrying the connection. */
  readonly fallbackWouldSee: readonly string[];
  /** How to name the fallback in a heading. */
  readonly fallbackName: string;
}

export const carrierDisclosure = (): CarrierDisclosure => ({
  inUse: activeCarrierStatus(),
  fallbackName: 'the hosted relay',
  fallbackWouldSee: HOSTED_RELAY_DISCLOSURE,
});

/**
 * What the fallback does and does not cover, said on the screen rather than only in
 * a review.
 *
 * THE TEXT HAS OUTLIVED TWO VERSIONS OF ITSELF. It first said
 * nothing dialled a relay at all. It then said the two remaining constraints were
 * that pairing is always direct and that a relayed connection has no live updates.
 * `docs/relay-protocol.md` §14 has since built a pairing session and one stream
 * session per live feed or terminal, so BOTH of those sentences are now false, and a
 * warning that undersells the fallback sends a reader with a NAT'd daemon to fix a
 * problem they do not have.
 *
 * SO IT NAMES WHAT IS ACTUALLY LEFT, which is narrower and still worth a warning
 * colour: a relay only helps if the daemon holds one — a daemon that dials none has
 * to be reachable from here — and the feature surfaces §13 piece 3 lists still build
 * their requests against the daemon's own address, so they fail on a relayed
 * connection rather than travelling it. Overselling a seamless fallback would be as
 * bad as the underselling this replaces.
 */
export const TRANSPORT_NOT_WIRED_NOTE =
  'Pairing tries the daemon directly first and can finish over the relay instead, so a device that has never ' +
  'been on its network can still pair — as long as the daemon dials a relay of its own. One that dials none ' +
  'has to be reachable from here: same network, a VPN, a tailnet, or a public address. Live updates and ' +
  'terminals travel the relay too, each on its own session. Some panels still go straight to the daemon, so ' +
  'over a relay files, skills, pins, the agenda, the remote browser and dictation correction are unavailable.';

/**
 * The hosted carrier's cost, in the terms somebody actually cares about.
 *
 * Three lines rather than the full disclosure, because this is a setup step and
 * not the protocol document. `docs/relay-protocol.md` §13 is the authority and
 * `packages/relay`'s own `describeConnectionMethod` is the code that will own
 * this text once it is reachable from here; a third copy would be a third thing
 * to keep true.
 */
export const HOSTED_RELAY_DISCLOSURE = [
  'Ferretry and Cloudflare would see your daemon’s fingerprint, both IP addresses, and when and how much you connect.',
  'They could not read a byte of it: frames, device tokens, commands, output and names are encrypted end to end.',
  'The hosted relay is metered and capped per daemon, and its operator can switch it off without an app release.',
] as const;

/**
 * Said when the switch is off, because "direct only" is a real constraint on the reader.
 *
 * It says "unless" rather than "so": a daemon that dials a rendezvous of its OWN is unaffected by
 * this switch, and telling its owner direct is their only carrier would be false in the one direction
 * that costs them a working connection.
 */
export const HOSTED_RELAY_DISABLED_NOTE =
  'The hosted relay is switched off right now, so unless your daemon dials a relay of its own, direct is the only ' +
  'carrier: this browser has to be able to reach the daemon itself — same network, a VPN, a tailnet or a public ' +
  'address.';

/**
 * Said when the page does not know, which is neither of the other two.
 *
 * PAIRING DOES DEPEND ON THIS ANSWER NOW, and the line that said otherwise was written when it could
 * not: `exchangePairing` walks direct and then the hosted rendezvous THIS READ SUPPLIES, which is the
 * only relayed first-contact candidate there is. No link names one — the fragment carries daemon
 * address, code and fingerprint and nothing else — so while the advertisement is unknown there is no
 * relayed path to pair over at all. That makes this read load-bearing rather than decorative: a
 * failed one fails closed to direct-only first contact. Direct pairing is unaffected, which is the
 * part worth keeping.
 *
 * (This paragraph used to name a middle leg, "the rendezvous named in the link". That was the
 * withdrawn `v2` fragment; `relayPairingCandidates` has offered exactly one candidate since
 * `7a0d4633`, and the conclusion below is if anything stronger without it.)
 */
export const HOSTED_RELAY_UNDETERMINED_NOTE =
  'Treat the fallback as unavailable until this page can confirm it. Direct still works whenever the daemon is ' +
  'reachable, and pairing over the hosted relay is the one thing that needs this answer.';
