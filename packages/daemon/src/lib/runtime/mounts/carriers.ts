/**
 * WHERE THIS DAEMON CAN BE REACHED, ASKED AGAIN LATER.
 *
 * A device learns the set once, when it pairs: `PairingResponse.carriers` travels with the token. That
 * is the only moment the old shape had, and it is the wrong number of moments — a rendezvous is a
 * runtime value whose operator may change or switch it off without a release, so the set a phone holds
 * goes stale while both halves stay healthy. `GET /v1/carriers` is the second moment, and it is the
 * whole of this mount.
 *
 * ## THE DAEMON IS AUTHORITATIVE AND THE CLIENT'S COPY IS A CACHE
 *
 * That is the disagreement rule, and `DaemonCarriersViewSchema`'s own header owns it: a client
 * REPLACES its stored set with this answer rather than merging into it, which is what makes both
 * halves of a disagreement resolve. A relay the daemon dropped disappears instead of being dialled
 * forever, and a relay the daemon added arrives without anybody re-pairing. This route is that rule
 * made reachable; without it the rule is a sentence in a document.
 *
 * ## `authenticated`, AND NOT ONE CLASS HIGHER
 *
 * Any caller this daemon has issued a credential to may refresh its own cache, including a
 * capability-scoped warden. The alternative — `operator` — would mean the device most in need of the
 * answer is the one refused it, and it would buy nothing: NEITHER ENTRY IS A SECRET. A rendezvous
 * address is already known to the rendezvous, and a daemon address is already known to whoever was
 * authorised to pair with it. The daemon FINGERPRINT is the secret in this subject, and it is not on
 * this list — `DaemonCarrierSchema` has no field for one, so the property holds by construction
 * rather than by remembering.
 *
 * ## NOT `privilegedOnly`, AND NOT CAPABILITY-GATED
 *
 * `privilegedOnly` would mean only a caller who arrived over the host's own carrier may read the list,
 * which is precisely backwards: a caller on loopback already has the machine and needs no list, and
 * the remote phone is the reader. A capability demand would be worse than useless — an operator who
 * switched `pairing` off to stop new devices being added would silently strand the devices already
 * paired on a relay this daemon no longer dials, and that is a different decision than the one they
 * made. Nothing here changes state and nothing here discloses a credential.
 *
 * ## PAIRING IS STILL DIRECT-ONLY
 *
 * This route is reached with the device token the pairing exchange already issued, so it cannot be a
 * way in: first contact with a daemon remains direct, over an address reachable on its own once. See
 * `docs/pairing.md` and `docs/relay-protocol.md` §13.
 */

import { type DaemonCarrier, DaemonCarriersViewSchema } from '@ferretry/protocol';
import { type ApiRoute, jsonResponse } from '../../api/index.ts';

/**
 * THERE IS NO SUBSYSTEM INTERFACE HERE, AND THAT IS THE DESIGN.
 *
 * Every other mount in this directory takes an object with methods, because every other mount serves
 * something a daemon DOES. This one serves something a daemon IS, resolved once at boot and constant
 * for the life of the process, so the smallest honest dependency is the value itself.
 *
 * ONE ARRAY, TWO CONSUMERS. `PairingService` hands this set to a device at redemption and this route
 * hands the same set back on refresh. The composition root resolves it once and passes the SAME
 * reference to both, which is what makes the two answers agree by construction. A `current()` getter
 * would have read as the flexible choice and permitted the exact bug the published set exists to end:
 * two calls answering differently, so a device's stored copy and the daemon's next answer describe
 * different daemons. `readonly` is the whole guarantee it needs.
 */
export function carrierRoutes(carriers: readonly DaemonCarrier[]): readonly ApiRoute[] {
  // PARSED HERE, WHERE THE TABLE IS BUILT, AND NOT INSIDE THE HANDLER.
  //
  // The schema is what holds a published direct address to the origin rule its readers apply — the
  // same projection the pairing response is parsed through — so a daemon cannot publish a carrier its
  // own device would refuse. WHERE it runs decides what a refused set looks like: inside the handler a
  // bad set is a generic 500 on every request for the life of the daemon, which reads as a broken
  // daemon and names no remedy. Here it is a boot failure, once, while somebody is still looking at
  // the terminal they started it from.
  //
  // The view is also the whole answer, computed once: the set is resolved at boot and constant for the
  // life of this daemon, so there is nothing about a request that could change it. That is why this
  // route has no per-request work to do at all.
  const view = DaemonCarriersViewSchema.parse({ carriers });
  return [
    {
      method: 'GET',
      path: '/v1/carriers',
      minimum: 'authenticated',
      // The entire value of this answer is that it is current. A cached copy would re-serve the
      // rendezvous the operator has just switched off, which is the failure the route exists to end.
      // The daemon holds ONE answer and reserving it is fine; a CLIENT holding a stale one is the bug.
      noStore: true,
      handle: async () => jsonResponse(view),
    },
  ];
}
