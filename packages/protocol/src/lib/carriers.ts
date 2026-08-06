/**
 * THE SET OF WAYS ONE DAEMON MAY BE REACHED, as the daemon itself publishes it.
 *
 * A daemon used to publish exactly one: `PairingCodeMintResponse.daemonUrl`, the direct address. A
 * rendezvous was never on the wire at all, so each end discovered one INDEPENDENTLY from its own
 * build-time directory and the two met only by coincidence of picking the same service. A daemon on
 * one rendezvous and a browser holding another never meet, and the failure is the worst shape there
 * is: both halves are healthy, the room is simply empty. Publishing the set is what replaces that
 * coincidence with an answer.
 *
 * THE TWO VARIANTS ARE NOT THE SAME KIND OF THING, and the discriminator carries the difference:
 *
 * - `direct` — the daemon's own address. The bytes go to the machine and to nobody else.
 * - `relay` — a rendezvous that passes ciphertext between two parties who cannot see each other. A
 *   third party is on the path, which is why its address is held to the stricter rule below.
 *
 * THE URL RULES DIFFER ON PURPOSE, AND NEITHER IS `z.url()`. A relay address goes through
 * {@link SocketEndpointSchema}, so it is encrypted everywhere except against loopback: a stranger's
 * service carrying a session in plaintext is not a carrier this protocol will dial. A direct address
 * goes through {@link DaemonOriginSchema}, the same origin rule `PairingCodeMintResponse.daemonUrl` is
 * held to by every reader of one — plain HTTP is allowed because the machine on the other end is the
 * operator's own and a daemon on a private network address commonly serves it, while credentials, a
 * proxy path, a query and a fragment are not, because those are the shapes a device refuses AFTER the
 * address has already been published. Inventing a third spelling for either fact is what this module
 * exists to avoid.
 *
 * PRIVILEGE IS NOT HERE, AND MUST NEVER BE ADDED. Whether an arrival is privileged is answered by the
 * carrier that ACCEPTED it, per connection, on the daemon — never by a client reading a list. A field
 * here saying "this one is local" would be a client's claim about its own authority, which is the one
 * thing a daemon may never take from a client. See `docs/grants.md`.
 *
 * NEITHER IS A SECRET, and that is why publishing them is safe: a rendezvous address is already known
 * to the rendezvous, and a daemon address is already known to whoever was authorised to pair with it.
 * The daemon FINGERPRINT is a different matter and is not on this list; it addresses the rendezvous
 * and travels in the pairing fragment, where the existing rule already keeps it out of anything a
 * reader might paste into an issue.
 */

import { z } from 'zod';
import { isLoopbackHost } from './address.ts';

/**
 * A socket address this protocol will dial.
 *
 * Secure schemes anywhere; insecure schemes only against loopback. That is the same line the
 * published site's content-security-policy draws, and drawing it differently here would make one
 * of the two a lie.
 *
 * IT LIVES IN THE PROTOCOL PACKAGE because two packages that may not import each other now decide
 * the same question from it: the rendezvous carrier layer, and this module's published carrier set on
 * a device-facing response. `@ferretry/relay` re-exports it, so nothing that already read it from
 * there had to change — the owner moved, the name did not.
 */
export const SocketEndpointSchema = z
  .string()
  .max(2048)
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'endpoint is not a URL' });
      return z.NEVER;
    }
    const loopback = isLoopbackHost(url.hostname);
    const secure = url.protocol === 'https:' || url.protocol === 'wss:';
    const insecure = url.protocol === 'http:' || url.protocol === 'ws:';
    if (!secure && !(insecure && loopback)) {
      context.addIssue({ code: 'custom', message: 'endpoint must be wss/https, or ws/http on loopback' });
      return z.NEVER;
    }
    if (url.search !== '' || url.hash !== '') {
      context.addIssue({ code: 'custom', message: 'endpoint carries a query or fragment' });
      return z.NEVER;
    }
    return url.toString().replace(/\/$/u, '');
  });

/**
 * A DIRECT DAEMON ADDRESS, in the one spelling every consumer of one already demands.
 *
 * `z.url()` accepted things no reader of this list can dial — `ftp://box`, `https://user:pw@box`,
 * `https://box/behind/a/proxy`, `https://box?token=…` — and the daemon publishing one is not the party
 * that finds out. The PWA normalises a daemon address with `daemonBaseUrl` and the CLI refuses a
 * pairing link with `assertPairableDaemonUrl`; both draw exactly this line, and both draw it AFTER the
 * address has already been printed as a QR or stored as a carrier. Drawing it here is what makes a
 * daemon unable to publish an address its own device would refuse.
 *
 * WHY EACH REJECTION EXISTS, since a rule nobody can justify is a rule somebody will relax:
 *
 * - **scheme** — `/v1` is an HTTP surface. A scheme that is not `http`/`https` is not it.
 * - **credentials** — a password in a URL is a credential this protocol never carries, and a carrier
 *   list is stored, logged and rendered.
 * - **path** — a reverse-proxy prefix survives the typed client and is dropped by origin-relative
 *   requests, so the two halves of one app disagree about where `/v1` is. Normalising to `origin`
 *   makes that disagreement unrepresentable rather than merely unlikely.
 * - **query/fragment** — the same rule {@link SocketEndpointSchema} draws, for the same reason: an
 *   address is an address, and anything else in it is somebody smuggling state through one.
 *
 * IT IS NOT {@link SocketEndpointSchema} AND MUST NOT BECOME IT. A rendezvous has a third party on the
 * path, so plaintext to one is refused; a direct address is the operator's own machine, and a daemon on
 * a private network address commonly serves plain HTTP. Holding this to the rendezvous rule would
 * publish an empty set for the most ordinary deployment there is.
 */
export const DaemonOriginSchema = z
  .string()
  .max(2048)
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'daemon address is not a URL' });
      return z.NEVER;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      context.addIssue({ code: 'custom', message: 'daemon address must use http or https' });
      return z.NEVER;
    }
    if (url.username !== '' || url.password !== '') {
      context.addIssue({ code: 'custom', message: 'daemon address may not carry credentials' });
      return z.NEVER;
    }
    if (url.search !== '' || url.hash !== '') {
      context.addIssue({ code: 'custom', message: 'daemon address may not carry a query or a fragment' });
      return z.NEVER;
    }
    if (url.pathname !== '/') {
      context.addIssue({ code: 'custom', message: 'daemon address must be an origin without a path' });
      return z.NEVER;
    }
    return url.origin;
  });

/**
 * How many carriers one daemon may publish.
 *
 * It is the wire's ceiling rather than the configuration's: a daemon may hold at most one bind and at
 * most four rendezvous links, and this leaves room for that set to grow a little without a protocol
 * change. A BOUND EXISTS AT ALL because this array arrives on a device-facing response and every
 * entry is an address some browser will dial in turn — an unbounded list is an unbounded walk.
 */
export const MAX_PUBLISHED_CARRIERS = 8;

export const DaemonCarrierSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('direct'), url: DaemonOriginSchema }),
  z.strictObject({ kind: z.literal('relay'), url: SocketEndpointSchema }),
]);
export type DaemonCarrier = z.infer<typeof DaemonCarrierSchema>;

/**
 * The published set, in the daemon's own order.
 *
 * THE ORDER IS THE OPERATOR'S PREFERENCE AND IS NOT TO BE RE-SORTED into anything else on the way to
 * a client. A client walks `direct` entries before `relay` entries — that is the protocol's rule and
 * `connectionPreferenceOrder` owns it — but WITHIN each kind the daemon's order is the answer, because
 * the daemon is where the operator wrote it down.
 */
export const PublishedCarriersSchema = z.array(DaemonCarrierSchema).max(MAX_PUBLISHED_CARRIERS).readonly();

/**
 * What `GET /v1/carriers` answers, so a paired device can refresh without pairing again.
 *
 * THE DISAGREEMENT RULE, IN ONE SENTENCE: **the daemon is authoritative and a client's copy is a
 * cache.** A client REPLACES its stored set with this one after any successful connection rather than
 * merging into it, which is what makes both halves of a disagreement resolve — a relay the daemon
 * dropped disappears instead of being retried forever, and a relay the daemon added arrives without
 * anybody re-pairing. A merge would only ever fix the second.
 *
 * A WRAPPER OBJECT RATHER THAN A BARE ARRAY, because a response that is a JSON array has nowhere to
 * put the next fact anybody needs and would have to become an object later — a change every client
 * would notice at once.
 */
export const DaemonCarriersViewSchema = z.strictObject({
  carriers: PublishedCarriersSchema,
});
export type DaemonCarriersView = z.infer<typeof DaemonCarriersViewSchema>;
