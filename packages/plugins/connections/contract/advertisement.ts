/** Host-facing reach information. It is never included in the published carrier list. */
export const ADVERTISEMENT_REFUSALS = ['loopback-bind', 'wildcard-bind', 'no-port'] as const;
export type AdvertisementRefusal = (typeof ADVERTISEMENT_REFUSALS)[number];

export type Advertisement =
  /** An address a DIFFERENT device can dial. Mint the link and draw the QR. */
  | { readonly kind: 'address'; readonly url: string; readonly origin: 'operator' | 'derived' }
  /**
   * Correct for a browser ON this machine, dead off it. Mint the link, show it, and SAY SO.
   *
   * NOT A REFUSAL. One person, one laptop, a browser on loopback is the common case this product is
   * built around, and that install must keep working. What it must not do is draw a QR: a QR is an
   * offer to another device, and this address cannot be redeemed by one.
   */
  | { readonly kind: 'local-only'; readonly url: string }
  /** There is nothing to hand out. Refuse the link, keep the code, and name the fix. */
  | { readonly kind: 'none'; readonly refusal: AdvertisementRefusal };

export interface ConnectionAdvertisement {
  readonly advertisement: Advertisement;
  /** Only an address read from this daemon’s hosted directory, never an operator-written relay. */
  readonly discoveredRelayUrl?: string;
  readonly port?: number;
}
