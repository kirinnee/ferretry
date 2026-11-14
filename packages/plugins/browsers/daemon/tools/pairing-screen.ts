import { APP_EVAL_REFUSAL, PAIRING_SCREEN_REFUSAL } from '@ferretry/std/pairing-screen';
import { type ProtectionWindows, pairingScreenGuard as guardWith } from '../pages/pairing-screen-guard.ts';
import type { BrowserActGuard } from '../pages/service.ts';
import { BrowserToolError } from './service.ts';
import type { BrowserToolCall } from './wire.ts';

/**
 * Page tools that hand an AGENT what a page shows (its words, markup, picture, log, dialog text or script result): refused
 * outright while a credential is live and the page, or one it can reach, is on an app origin (docs/pairing.md, "Never
 * show it to an agent"). `browser.navigate`, `browser.close` and the rest that carry no page content leave a page
 * freely. `browser.dialog` is NOT here, on purpose: a page with a dialog open is frozen, so no DevTools query can answer
 * for it and a guard that asked would break the tool (a declared GAP: a dialog's own message text). `browser.wait_for` and the element-addressed acts are guarded for what they ask of the page ({@link readsPage}).
 */
const PAIRING_SCREEN_GUARDED: ReadonlySet<BrowserToolCall['tool']> = new Set([
  'browser.read',
  'browser.eval',
  'browser.screenshot',
  'browser.highlight',
  'browser.pdf',
  'browser.console',
  'browser.network',
  'browser.fill_form',
]);

/** The members of a call that name an element of the page by what it IS or SAYS, rather than where it is. */
const ELEMENT_MEMBERS = ['selector', 'ref', 'fromSelector', 'fromRef', 'toSelector', 'toRef'] as const;

/**
 * Whether a call answers a question about the page's CONTENT. A read does. So does a wait on text, on text gone or on an
 * element, and so does ANY act that finds its element by a selector, a ref or the text it shows — a click, hover, drag,
 * select, check, type, press or upload that resolves a selector, and a scroll to text — because "found it" and "did not
 * find it" (or the error that says why) is a boolean about hidden content, and a boolean that depends on a code is the
 * code, one question at a time. An act at a coordinate, a scroll by distance, a wait on a time, an address or a load,
 * and navigating, opening and closing read nothing.
 */
function readsPage(call: BrowserToolCall): boolean {
  if (PAIRING_SCREEN_GUARDED.has(call.tool)) return true;
  const named = call as unknown as Readonly<Record<string, unknown>>;
  if (ELEMENT_MEMBERS.some(member => named[member] !== undefined)) return true;
  // The text a scroll goes looking for, and what a wait is for.
  if (call.tool === 'browser.scroll') return named.text !== undefined;
  if (call.tool === 'browser.wait_for') return named.text !== undefined || named.textGone !== undefined;
  return false;
}

/** The guard an AGENT's call runs (see `../pages/pairing-screen-guard.ts`); none for a call that reads nothing. */
export function pairingScreenGuard(
  call: BrowserToolCall | undefined,
  windows: ProtectionWindows,
): BrowserActGuard | undefined {
  if (call === undefined || !readsPage(call)) return undefined;
  return guardWith(
    () => new BrowserToolError('forbidden', PAIRING_SCREEN_REFUSAL),
    windows,
    call.tool === 'browser.eval' ? 'script' : 'content',
    () => new BrowserToolError('forbidden', APP_EVAL_REFUSAL),
  );
}
