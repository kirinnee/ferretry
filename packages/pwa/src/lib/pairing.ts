import { type DaemonCarrier, PAIRING_FRAGMENT_PATTERN, parsePairingFragment } from '@ferretry/protocol';
import { type ConnectionMethod, publishedConnectionMethods } from '@ferretry/relay';
import {
  daemonBaseUrl,
  daemonConnection,
  daemonId,
  daemonRelayCarrier,
  type DaemonConnection,
  type RelayCarrier,
} from './daemon-connection.ts';

export interface PairingSeed {
  readonly daemonUrl: string;
  readonly daemonId: string;
  readonly code: string;
  /**
   * The rendezvous this link offers for THIS redemption, and nothing beyond it.
   *
   * `docs/relay-protocol.md` §14: a device that cannot reach the daemon's own address needs a
   * rendezvous to dial and cannot ask the daemon it cannot reach, so a v2 link may name one. It is
   * daemon-authored and travels out of band with the same trust as `fp`.
   *
   * IT IS NEVER STORED. What a device navigates by afterwards is `paired.response.carriers` — the
   * daemon's own published set — and the pairing is refused outright if that set does not name the
   * rendezvous the exchange crossed. So this value exists for the length of one attempt and is
   * deliberately absent from `DaemonConnection`, where a written-down guess would outlive the
   * advertisement that produced it.
   */
  readonly relay?: RelayCarrier;
}

export interface PairingResult {
  readonly daemonId: string;
  readonly deviceToken: string;
  readonly carriers: readonly DaemonCarrier[];
}

/**
 * Reads the pairing values from a PWA URL fragment.  Fragments are never sent in
 * HTTP requests, keeping the single-use pairing code out of logs.
 *
 * THE GRAMMAR IS THE PROTOCOL PACKAGE'S AND IS NOT RESTATED HERE. `parsePairingFragment` is the one
 * implementation of the tolerance rules — both versions read, a duplicated field name refused, an
 * unrecognised one ignored, a `relay` candidate honoured only under `v2` and dropped rather than
 * dialled when it fails the socket-endpoint rule — and the daemon that WRITES a link uses the writer
 * beside it. Two readers of one string is how a daemon and a browser come to hold different opinions
 * about the same QR, which is the failure this whole seam exists to make impossible.
 *
 * WHAT THIS FUNCTION STILL OWNS is the browser's own narrowing on top of that grammar: the daemon
 * address is held to `daemonBaseUrl`'s origin rule — no path, no query, no credentials — because
 * every HTTP and WebSocket adapter in this package resolves `/v1` against it, and the protocol's
 * reader deliberately returns it verbatim so each consumer applies its own.
 *
 * BOTH VERSIONS ARE READ, AND THAT ORDERING IS NORMATIVE. §14: "the current reader rejects any
 * fragment that is not exactly the three-field v1 form, so a v2 link shown to an older app fails
 * pairing outright — direct included. The reader that accepts both v1 and v2 therefore ships before
 * any daemon emits v2." This is that reader; nothing in this package mints a link at all.
 */
export const pairingSeedFromUrl = (value: string): PairingSeed => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('pairing URL must be absolute');
  }
  const seed = parsePairingFragment(url.hash);
  return {
    daemonUrl: daemonBaseUrl(seed.daemonUrl),
    daemonId: daemonId(seed.daemonId),
    code: seed.code,
    // Already normalised by the socket-endpoint rule, which IS the rule `daemonRelayCarrier` applies
    // — so this cannot refuse a candidate the parser accepted, and a defensive catch here would be a
    // branch nothing can reach.
    ...(seed.relayCandidate === undefined
      ? {}
      : { relay: daemonRelayCarrier({ kind: 'relay', relayUrl: seed.relayCandidate }) }),
  };
};

/**
 * How this tab was opened, as far as pairing is concerned.
 *
 * `none` is a COLD OPEN — nothing claimed to be a pairing link, so the screen
 * offers its one action. `unreadable` is the damaged case and is deliberately
 * NOT folded into it: a fragment that announces itself as a pairing link and
 * then fails to parse is evidence of a broken or truncated link, and showing the
 * ordinary cold screen there would quietly tell a reader their link was never
 * there.
 */
export type PairingArrival =
  | { readonly kind: 'none' }
  | { readonly kind: 'seed'; readonly seed: PairingSeed }
  | { readonly kind: 'unreadable'; readonly reason: string };

/**
 * A fragment that CLAIMS to be a pairing link; any other hash belongs to something else.
 *
 * THE PATTERN COMES FROM THE PROTOCOL PACKAGE, beside the parser it gates, and that is not tidiness.
 * When a gate and its parser disagree about which versions exist the failure is SILENT rather than
 * loud: a version the gate rejects never reaches the parser, so `pairingArrival` answers `none`, the
 * screen renders the ordinary cold "Connect a daemon" state, and a reader who just scanned a QR is
 * told nothing whatsoever — strictly worse than the parser's throw, which at least reaches
 * `unreadable` and says the link is damaged. One value, declared once, cannot drift from itself.
 */
const PAIRING_FRAGMENT = PAIRING_FRAGMENT_PATTERN;

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
 * Which carrier a redemption actually crossed, because the answer changes what the response must say.
 *
 * `undefined` is the direct exchange. A rendezvous is named so `pairedDaemonConnection` can hold the
 * daemon to §14's rule below; it is the ONE thing this module needs to know about the carrier, and
 * deliberately not the session, the socket or the walk.
 */
export type PairingCrossing = RelayCarrier | undefined;

/**
 * Does the daemon's published set name THIS rendezvous? Compared by address alone, deliberately.
 *
 * `sameDaemonCarrier` is the right test everywhere else and is the WRONG one here, because it also
 * compares `operator` — and the two values being compared cannot agree on that field even when they
 * name the identical address. A candidate is built from a fragment or from the discovery
 * advertisement before the daemon has said anything, so its `operator` is absent or this browser's
 * own guess, while `publishedConnectionMethods` always stamps `'hosted'` or `'self'` by comparing
 * against the hosted address. Using the whole-carrier test would therefore refuse every relayed
 * pairing that ever succeeded, which is a refusal about a label rather than about reachability.
 *
 * What §14's rule is actually asking is "can this device get back to this daemon the way it just
 * came", and that question is answered by the address. Both sides have been through
 * `ConnectionMethodSchema`, so the two strings are normalised the same way.
 */
const publishesRendezvous = (published: readonly ConnectionMethod[], crossed: RelayCarrier): boolean =>
  published.some(method => method.kind === 'relay' && method.relayUrl === crossed.relayUrl);

/**
 * Binds the daemon's pairing response to the fingerprint carried out of band
 * by the pairing link before the PWA stores or uses its device token.
 *
 * TWO CHECKS, AND THE SECOND ONE ONLY EXISTS FOR A RELAYED REDEMPTION.
 *
 * The first is unchanged: the response's `daemonId` must equal the fingerprint the link pinned. On a
 * relayed exchange §6's handshake has already proved that same fingerprint before a byte of
 * plaintext moved, so this is belt and braces — but the braces are load-bearing on the direct path,
 * where nothing authenticated the daemon at all.
 *
 * The second is §14's: **a relayed pairing whose published set does not name the rendezvous the
 * exchange itself crossed is refused.** That rule is what lets the stored set stay purely what the
 * daemon said. Without it this function would face a choice with no good answer — write down an
 * address the daemon did not publish, or discard the only address known to work — and §14 removes
 * the choice by making the disagreement fatal instead. The cost is stated in the protocol and worth
 * repeating: the daemon has already minted the grant, so the operator sees a device that the device
 * itself discarded, revocable like any other.
 *
 * THE EMPTY-SET FALLBACK IS DIRECT-ONLY, and the asymmetry is the point rather than an oversight. A
 * newer client reading an older daemon receives the schema default `[]`; on the direct path the
 * exchange just succeeded over `seed.daemonUrl`, so that address is a carrier this browser has
 * PROVED. Over a relay it is the opposite — the address the browser could not reach is the only one
 * left — and a connection built from it would be a valid credential pointing at nothing, unable even
 * to refresh its way out, because the `/v1/carriers` read that would teach it the rendezvous needs a
 * carrier it no longer has. The relay branch therefore refuses, and the rule above already covers
 * it: an empty set cannot name the rendezvous.
 */
export const pairedDaemonConnection = (
  seed: PairingSeed,
  result: PairingResult,
  hostedRelayUrl?: string,
  crossed: PairingCrossing = undefined,
): DaemonConnection => {
  const expectedDaemonId = daemonId(seed.daemonId);
  const actualDaemonId = daemonId(result.daemonId);
  if (expectedDaemonId !== actualDaemonId) throw new Error('pairing response daemon ID does not match its fingerprint');
  const published = publishedConnectionMethods(result.carriers, hostedRelayUrl);
  if (crossed !== undefined && !publishesRendezvous(published, crossed)) {
    throw new Error(
      'this daemon paired over a rendezvous it does not publish, so this device would have no address to reach it at; ' +
        'pair again once its carrier configuration has settled',
    );
  }
  return daemonConnection({
    daemonId: actualDaemonId,
    baseUrl: seed.daemonUrl,
    deviceToken: result.deviceToken,
    carriers: published.length === 0 ? [{ kind: 'direct', daemonUrl: seed.daemonUrl }] : published,
  });
};
