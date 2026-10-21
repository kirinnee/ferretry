/**
 * THE ONE PUBLISHED CARRIER SET, AS A VALUE THAT CAN CHANGE WHILE THE DAEMON RUNS.
 *
 * Until the tunnel carrier (`docs/relay-protocol.md` §15) the set was resolved once at boot and handed
 * around as a frozen array, and two consumers — pairing redemption and `GET /v1/carriers` — held the
 * SAME reference, which is what made their answers agree by construction. A getter was refused on
 * purpose: two calls could answer differently, so a device's first copy and its refresh could describe
 * different daemons.
 *
 * A tunnel breaks the premise rather than the rule. It is published only while `cloudflared` reports a
 * registered connection and withdrawn when the connector is down, so the set is no longer constant for
 * the life of the daemon. What still holds is the rule itself, kept by keeping ONE OWNER: both
 * consumers read this object, every answer is the frozen array current at that instant, and a change
 * replaces the whole array rather than editing one in place. Two reads may differ only because the
 * daemon's reach changed between them — which is exactly what a device's refresh exists to learn.
 *
 * EVERY SET IS PARSED WHEN IT IS MADE, never when it is served. A set this daemon's own device would
 * refuse fails at construction — at boot, while somebody is watching — and a published tunnel address
 * went through the same schema already, so serving can never discover a bad carrier halfway through a
 * redemption.
 */

import { type DaemonCarrier, PublishedCarriersSchema } from '@ferretry/protocol';
import type { PublishedCarrierView } from '../pairing/index.ts';
import { publishedDaemonCarriers, type RelayCarrierSource } from '../relay/discovery.ts';

export type { PublishedCarrierView } from '../pairing/index.ts';

/** The daemon's published set: fixed direct and relay entries, and a tunnel that comes and goes. */
export class PublishedCarrierSet implements PublishedCarrierView {
  #current: readonly DaemonCarrier[];

  constructor(
    private readonly directUrl: string | undefined,
    private readonly relays: readonly RelayCarrierSource[],
  ) {
    this.#current = Object.freeze(publishedDaemonCarriers(directUrl, relays));
  }

  current(): readonly DaemonCarrier[] {
    return this.#current;
  }

  /** Publishes the tunnel at `url`, or withdraws it when `undefined`. The whole set is replaced. */
  tunnel(url: string | undefined): void {
    this.#current = Object.freeze(publishedDaemonCarriers(this.directUrl, this.relays, url));
  }
}

/** A set that never changes, parsed once: for a caller that holds one answer rather than an owner. */
export function fixedCarrierView(carriers: readonly DaemonCarrier[]): PublishedCarrierView {
  const frozen = Object.freeze([...PublishedCarriersSchema.parse(carriers)]);
  return { current: () => frozen };
}
