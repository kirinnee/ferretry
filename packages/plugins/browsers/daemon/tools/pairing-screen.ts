import { PAIRING_SCREEN_REFUSAL } from '@ferretry/std/pairing-screen';
import { pairingScreenGuard as guardWith } from '../pages/pairing-screen-guard.ts';
import type { BrowserActGuard } from '../pages/service.ts';
import { BrowserToolError } from './service.ts';
import type { BrowserToolCall } from './wire.ts';

/**
 * Page tools that hand an AGENT what a page shows (its words, markup, picture, log or script result): refused outright
 * while the page carries the pairing-screen marker (docs/pairing.md, "Never show it to an agent"). `browser.navigate`,
 * `browser.close` and the rest carry no page content, so an agent can always leave such a page.
 * `browser.wait_for` is guarded only for what it waits ON ({@link readsPage}).
 */
const PAIRING_SCREEN_GUARDED: ReadonlySet<BrowserToolCall['tool']> = new Set([
  'browser.read',
  'browser.eval',
  'browser.screenshot',
  'browser.highlight',
  'browser.pdf',
  'browser.console',
  'browser.network',
]);

/**
 * Whether a call asks something of the page's CONTENT. A wait on text, on text gone or on an element (a ref or a
 * selector) answers yes or no about what the page shows — a boolean that depends on a hidden code is the code, one
 * question at a time — so it is a read. A wait on the address, on the load state or for a time reads nothing.
 */
function readsPage(call: BrowserToolCall): boolean {
  if (call.tool !== 'browser.wait_for') return PAIRING_SCREEN_GUARDED.has(call.tool);
  return (
    call.text !== undefined || call.textGone !== undefined || call.selector !== undefined || call.ref !== undefined
  );
}

/** The guard an AGENT's call runs (see `../pages/pairing-screen-guard.ts`); none for a call that reads nothing. */
export function pairingScreenGuard(call: BrowserToolCall | undefined): BrowserActGuard | undefined {
  if (call === undefined || !readsPage(call)) return undefined;
  return guardWith(() => new BrowserToolError('forbidden', PAIRING_SCREEN_REFUSAL));
}
