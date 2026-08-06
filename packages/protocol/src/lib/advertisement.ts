/**
 * WHICH ADDRESS THIS DAEMON HANDS OUT, AND WHO CAN DIAL IT — one decision, three answers.
 *
 * ## THE DEFECT THIS EXISTS TO HAVE REMOVED
 *
 * `publicUrl` used to be two facts welded into one field by a single `??`: WHERE I LISTEN and WHERE I
 * CAN BE REACHED. The default bind is loopback, so a default install advertised `http://127.0.0.1:…`
 * and the pairing exchange put that address verbatim into a QR. On the phone that reads it, that
 * address IS THE PHONE. Nothing happened, and nothing said why. No misconfiguration was required —
 * the default configuration could not deliver the journey the product documents.
 *
 * So the decision moves above every surface that renders it, into the one package all three consumers
 * already depend on, and it is a DECISION rather than a fallback: two facts, two fields, no weld.
 *
 * ## WHY THREE ANSWERS AND NOT TWO
 *
 * "Derives an address" / "derives nothing" refuses every default single-machine install, because a
 * loopback-bound daemon is a WORKING daemon and a browser at `127.0.0.1` pairs with it perfectly. The
 * address is genuinely right for the caller who can use it. What is wrong is handing it to somebody
 * who cannot use it WITHOUT SAYING SO — so the middle answer is the one that fixes the blocker, and
 * the doctrine is:
 *
 * > **Never mint a link without saying who can redeem it.**
 *
 * The inbound side of this product already makes the same three-way distinction — local, remote,
 * relayed, decided from the carrier and never from an address. This is that distinction applied to an
 * OUTBOUND value, which is the one direction nobody had applied it to.
 *
 * ## TWO THINGS THIS MUST NOT DO
 *
 * **It never second-guesses an operator's own address.** A daemon behind a reverse proxy or a tunnel
 * legitimately advertises somewhere it does not bind, so reachability must never be re-derived from
 * "the advertised address differs from the bound one" — that reads a correct proxy deployment as
 * broken. An operator's value is handed back verbatim, always.
 *
 * **It never asks who is asking.** The advertisement is a property of the daemon's CONFIGURATION, not
 * of the request that reads it. Conditioning it on the caller's own carrier is the plausible shortcut
 * that re-creates the original defect exactly: the common case is a person standing at the machine
 * minting a code to scan with their phone, so the minter is local and the redeemer is not. That
 * mistake passes every test written on one machine, which is why this module takes no request.
 *
 * ## WHAT THIS IS NOT
 *
 * It does not infer an operator's deployment from whether two URLs happen to match. The daemon's
 * `reachableOffHost(config, carrier?)` already owns the broader question "can anything off this host
 * reach me at all?" and includes outbound relay carriers. This decision owns the narrower value a
 * pairing response may hand to a redeemer. Both questions reuse the same loopback predicate; neither
 * grows another copy.
 */

import { daemonAddress, FY_DEFAULT_DAEMON_PORT, isLoopbackHost, isWildcardHost } from './address.ts';

/**
 * Why there is no address to hand out at all.
 *
 * `loopback-bind` remains in the shared refusal vocabulary so old or independently versioned readers
 * can explain it, but `decideAdvertisement` never emits it. A loopback bind is the `local-only`
 * answer above: it has a working address and a caller who can use it. Treating it as a refusal would
 * break every default single-machine install.
 */
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

/**
 * The one decision, pure and total.
 *
 * ORDER MATTERS AND IS DELIBERATE. An operator's own address is answered first and unconditionally,
 * because it is the only input here that somebody chose. Only when nobody chose one is an address
 * derived from the bind, and then a wildcard is refused before a missing port: a wildcard host is the
 * more specific thing to say, and the port has a well-known default while the host does not.
 */
export function decideAdvertisement(input: {
  /** An operator's own `publicUrl`. Handed back verbatim, never validated against the bind. */
  readonly operatorPublicUrl?: string;
  readonly host: string;
  readonly port?: number;
}): Advertisement {
  if (input.operatorPublicUrl !== undefined)
    return { kind: 'address', url: input.operatorPublicUrl, origin: 'operator' };
  if (isWildcardHost(input.host)) return { kind: 'none', refusal: 'wildcard-bind' };
  if (input.port === undefined) return { kind: 'none', refusal: 'no-port' };
  const url = daemonAddress(input.host, input.port);
  return isLoopbackHost(input.host) ? { kind: 'local-only', url } : { kind: 'address', url, origin: 'derived' };
}

/**
 * WHO CAN REDEEM THIS, and the one line that changes it.
 *
 * COMPOSED ONCE, RENDERED BY BOTH SURFACES. `fy pair` and the browser's Add-a-device panel say the
 * same thing about the same fact, and two surfaces wording one fact twice is how they come to
 * disagree — the reason this decision was hoisted out of them in the first place. The sentences name
 * `publicUrl`, a field this package's schema owns, and their two readers live in packages that may
 * not import each other; this is the one both already depend on.
 */
export interface AdvertisementNotice {
  /** Who can redeem the link, said plainly. */
  readonly audience: string;
  /** The single change that makes it redeemable from another device. */
  readonly remedy: string;
}

/**
 * The one remedy both surfaces render, using the documented default as a concrete example.
 */
function advertisementRemedy(): string {
  return (
    `set publicUrl to the address other devices reach this machine at, ` +
    `e.g. http://192.168.1.10:${String(FY_DEFAULT_DAEMON_PORT)}`
  );
}

/** What to say beside a link only this machine's own browser can redeem. */
export function localOnlyNotice(daemonUrl: string): AdvertisementNotice {
  return {
    audience: `Only a browser on this machine can redeem this link at ${daemonUrl}; no QR is drawn because another device cannot dial it.`,
    remedy: advertisementRemedy(),
  };
}

const REFUSAL_AUDIENCES: Readonly<Record<AdvertisementRefusal, string>> = {
  'loopback-bind': 'This daemon only advertises loopback, so another device has no address to dial.',
  'wildcard-bind': 'This daemon binds every interface, so there is no single address to hand out.',
  'no-port': 'This daemon has no port recorded yet, so there is no address to hand out.',
};

/** What to say when there is no address to hand out at all, per reason. */
export function refusalNotice(refusal: AdvertisementRefusal): AdvertisementNotice {
  return { audience: REFUSAL_AUDIENCES[refusal], remedy: advertisementRemedy() };
}
