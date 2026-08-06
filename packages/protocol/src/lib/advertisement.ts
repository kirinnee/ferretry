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

import { daemonAddress, isLoopbackHost, isWildcardHost, WILDCARD_BIND_HOST } from './address.ts';

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
  /**
   * What actually makes it redeemable from another device — which is not one change for every
   * reason, and saying it was is how a remedy came to be printed where it could not work.
   */
  readonly remedy: string;
}

/**
 * ONE REMEDY PER REASON, because one remedy for all of them was false for two of them.
 *
 * The single sentence this replaced told everybody to set `publicUrl`. For a wildcard bind that is
 * the whole fix. For a LOOPBACK bind it is half of one: `publicUrl` is what a daemon HANDS OUT and
 * changes nothing about the interface it listens on, so an operator who followed it turned an honest
 * "only this machine can redeem it" into a QR a phone scans and then cannot connect to — a worse
 * failure than the one being remedied, because the screen now claims it works. And for a missing
 * port `publicUrl` is not involved at all: there is no address because nothing has bound one yet.
 *
 * A REMEDY THAT CANNOT BE FOLLOWED IS A DEAD END WITH EXTRA STEPS, so each one names the fields, the
 * document, and the restart that makes it take effect.
 */

/** The document an operator edits, spelled the way every other user-facing sentence spells it. */
const CONFIG_DOCUMENT = '<FY_HOME>/config/daemon.json';

/** A private address: obviously an example, unmistakably a LAN. */
const EXAMPLE_LAN_HOST = '192.168.1.10';

/**
 * The example address a remedy tells somebody to write, carrying THIS daemon's port.
 *
 * ADVICE WITH THE WRONG PORT IN IT IS ADVICE TO TYPE THE WRONG NUMBER. The port comes from the
 * address the reader was just shown rather than from the compiled-in default, because a daemon whose
 * preferred port was taken binds the next free one — the ordinary outcome of a first boot — and an
 * example carrying the default would point at whatever else holds that number.
 *
 * An address this cannot parse still yields an example, because a malformed advertisement is exactly
 * the state somebody most needs a remedy from.
 */
function exampleReachableAddress(daemonUrl: string): string {
  try {
    const url = new URL(daemonUrl);
    url.hostname = EXAMPLE_LAN_HOST;
    return url.origin;
  } catch {
    return `http://${EXAMPLE_LAN_HOST}`;
  }
}

/** The advertise half, shared by the reasons that genuinely need an address written down. */
function advertiseRemedy(example: string): string {
  return `set "publicUrl" in ${CONFIG_DOCUMENT} to the address other devices reach this machine at, e.g. ${example}, then restart the daemon`;
}

/**
 * The two-step remedy for a daemon nothing off this machine can reach: BIND FIRST, then advertise.
 *
 * THE WILDCARD IS WHAT KEEPS THE FIX FROM TAKING THE DAEMON AWAY FROM THE PERSON APPLYING IT.
 * Binding a single routed interface would also let the phone in, and would simultaneously move the
 * daemon off loopback — where this machine's own commands look for it, and the only address an
 * owner-only credential may travel to. Every interface includes loopback, so nothing local changes.
 */
function bindAndAdvertiseRemedy(example: string): string {
  return (
    `bind every interface with "host": "${WILDCARD_BIND_HOST}" and ${advertiseRemedy(example)}. ` +
    `Commands on this machine keep reaching it on loopback`
  );
}

/** What to say beside a link only this machine's own browser can redeem. */
export function localOnlyNotice(daemonUrl: string): AdvertisementNotice {
  return {
    audience: `Only a browser on this machine can redeem this link at ${daemonUrl}; no QR is drawn because another device cannot dial it.`,
    remedy: bindAndAdvertiseRemedy(exampleReachableAddress(daemonUrl)),
  };
}

const REFUSAL_AUDIENCES: Readonly<Record<AdvertisementRefusal, string>> = {
  'loopback-bind': 'This daemon only advertises loopback, so another device has no address to dial.',
  'wildcard-bind': 'This daemon binds every interface, so there is no single address to hand out.',
  'no-port': 'This daemon has no port recorded yet, so there is no address to hand out.',
};

/**
 * WHAT TO DO ABOUT IT, per reason, and no two of these are the same instruction.
 *
 * A wildcard bind is already listening everywhere and needs only somewhere to point a device at — so
 * it takes the advertise half alone, and the notice that used to fire afterwards for "binds one
 * address, advertises another" no longer fires at a wildcard, because that pairing is now the
 * documented answer rather than a suspicious one.
 *
 * A missing port has nothing bound and no advertisement to fix; sending that operator to edit
 * `publicUrl` is sending them to a field that cannot help. `loopback-bind` is never emitted by the
 * decision above and is kept for readers that still speak it: it takes the same two-step answer as a
 * local-only address, with no port known to put in the example.
 *
 * A REFUSAL HAS NO ADDRESS, so no example here can carry a real port. The wildcard case names the
 * gap rather than guessing at it — a number in that slot would be a number to copy.
 */
const REFUSAL_REMEDIES: Readonly<Record<AdvertisementRefusal, string>> = {
  'loopback-bind': bindAndAdvertiseRemedy(`http://${EXAMPLE_LAN_HOST}`),
  'wildcard-bind': advertiseRemedy(`http://${EXAMPLE_LAN_HOST}:<the port this daemon bound>`),
  'no-port': `start the daemon once so it records the port it takes, or write "port" into ${CONFIG_DOCUMENT} yourself; "publicUrl" cannot supply an address nothing has bound`,
};

/** What to say when there is no address to hand out at all, per reason. */
export function refusalNotice(refusal: AdvertisementRefusal): AdvertisementNotice {
  return { audience: REFUSAL_AUDIENCES[refusal], remedy: REFUSAL_REMEDIES[refusal] };
}
