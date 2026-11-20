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
