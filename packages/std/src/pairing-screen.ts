/**
 * THE ONE MARKER A SCREEN SHOWING A LIVE PAIRING CODE CARRIES (docs/pairing.md, "Never show it to an agent").
 *
 * The app puts `<meta name="ferretry-pairing-screen" content="shown">` in the document's head for as long as the page
 * shows a pairing code or its QR — the Add-a-device panel while a minted code is on it, the pair screen while it holds
 * a pasted or arriving link — and removes it the moment that is gone. The browser the daemon drives looks for the marker
 * (a DOM query, no page script) before it answers an agent, so the code is never read from the PAGE: its words, its
 * picture or its markup.
 *
 * The app (Access) and the agent browser (Browsers) are different packages that must agree on this name byte for byte,
 * and plugins never import each other — so the name has exactly one owner, here, and both import it (fact-ownership).
 */
export const PAIRING_SCREEN_META_NAME = 'ferretry-pairing-screen';

/** The CSS selector that finds {@link PAIRING_SCREEN_META_NAME}'s element. */
export const PAIRING_SCREEN_SELECTOR = `meta[name="${PAIRING_SCREEN_META_NAME}"]`;

/** What an agent is told instead of a page that shows a pairing code: no content, and no hint of what it held. */
export const PAIRING_SCREEN_REFUSAL =
  'hidden: this page shows a pairing code, so it cannot be read or pictured. Ask the owner to finish or close it; navigating away or closing the page works.';

/** What `browser_network` prints in place of a pairing mint's response body (the body IS a live code). */
export const PAIRING_MINT_BODY_HIDDEN = '(body not shown: a pairing code)';

/**
 * THE EPOCH THAT OUTLIVES THE MARKER. `<meta name="ferretry-pairing-screen-seen" content="N">` is added the first time a
 * document holds the marker and its count goes up every time a screen starts showing a code; it is NEVER removed. A read
 * that began on an unmarked page and finds the count changed (or the marker present) when it ends knows a code was on
 * screen at some point during the call — even one that came and went in between — and discards what it read. It is
 * only a counter: no code, no link, nothing a page could be asked for.
 */
export const PAIRING_SCREEN_SEEN_META_NAME = 'ferretry-pairing-screen-seen';

/** The CSS selector that finds {@link PAIRING_SCREEN_SEEN_META_NAME}'s element. */
export const PAIRING_SCREEN_SEEN_SELECTOR = `meta[name="${PAIRING_SCREEN_SEEN_META_NAME}"]`;

/**
 * The route that mints a pairing code (`POST /v1/pair/code`): its response IS the code, the link and the QR's text, so no
 * agent tool shows it. Access owns the route; the browser worker must recognise its address, so the path is spelled once
 * here, and Access's own tests pin it to this.
 */
export const PAIRING_MINT_PATH = '/v1/pair/code';

/** Whether a request address is the pairing mint route, or under it: its response body is never shown. Fails closed. */
export function isPairingMintAddress(address: string): boolean {
  try {
    const { pathname } = new URL(address, 'http://placeholder.invalid');
    return pathname === PAIRING_MINT_PATH || pathname.startsWith(`${PAIRING_MINT_PATH}/`);
  } catch {
    return address.includes(PAIRING_MINT_PATH);
  }
}

/**
 * The route a catalog share is minted at (`POST /v1/catalog-shares`): its response carries the share's CODE, its link and
 * its QR's text — a credential that lets a browser join without an existing member passkey. Catalogs owns the route;
 * the browser worker must recognise its address, so the path is spelled once here, and Catalogs' own tests pin it to this.
 */
export const CATALOG_SHARE_MINT_PATH = '/v1/catalog-shares';

/** Whether a request address is the catalog share route, or under it: its response body is never shown. Fails closed. */
export function isShareMintAddress(address: string): boolean {
  try {
    const { pathname } = new URL(address, 'http://placeholder.invalid');
    return pathname === CATALOG_SHARE_MINT_PATH || pathname.startsWith(`${CATALOG_SHARE_MINT_PATH}/`);
  } catch {
    return address.includes(CATALOG_SHARE_MINT_PATH);
  }
}

/** Whether a response from this address IS a live credential (a pairing code or a share invite): no tool shows its body. */
export function isCredentialMintAddress(address: string): boolean {
  return isPairingMintAddress(address) || isShareMintAddress(address);
}

/**
 * What an agent is told when it asks to run a script (`browser.eval`, or any tool that runs page script) on a page of a
 * Ferretry app origin. The rule has no exception — no live code, no history, no marker changes it — because a script shares
 * the document's DOM with the app, where its codes and its own evidence sit. The sentence names no content.
 */
export const APP_EVAL_REFUSAL = "eval is not available on Ferretry's own app pages";
