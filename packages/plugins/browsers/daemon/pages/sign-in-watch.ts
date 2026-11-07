import type { BrowserAction } from '@ferretry/protocol';

/**
 * Told when an act on a page MAY have changed who the page signs in without the daemon reading who: the record of who
 * it is signing in (input-requests/typed-identities.ts) is then dropped. Told by the browser runtime itself, so every
 * caller is covered — the agent tools, the `POST /v1/sessions/:id/browser` toolbar (a ferret's `fy browser` and the
 * owner's address bar, Back, Forward and Reload), a press in the live view, and an act that failed partway. A missing
 * record is the safe state; only the agent tools ever put one back, from what they saw an agent's act do.
 */
export interface BrowserSignInWatch {
  /** Who page `pageId` of session `sessionId` signs in is no longer known. */
  cleared(sessionId: string, pageId: string): void;
  /** Nothing is known any more about who any page of session `sessionId` signs in. */
  forget(sessionId: string): void;
}

/** The keys that submit or move focus and type nothing: pressing them leaves who a page signs in. */
export const NON_TYPING_KEYS: ReadonlySet<string> = new Set([
  'Enter',
  'Tab',
  'Shift+Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/** The acts that read a page or move nothing on it: they never change who it signs in. */
const READS: ReadonlySet<string> = new Set(['read', 'screenshot', 'resize']);

/** The acts an AGENT's sign-in goes on through (the agent tools keep or name who signs in after them). */
const AGENT_KEEPS: ReadonlySet<string> = new Set([...READS, 'hover', 'scroll', 'highlight', 'select', 'check']);

/**
 * Whether an act through the agent tools' page queue (`actOnPage`) leaves who the page signs in: a read, a hover, a
 * scroll, Enter or Tab, or a click on a named element (an account tile's email is read by the agent tools after it).
 * Everything else — a navigation, typing, a fill, a key that types, raw mouse, a drag, a click at a bare point — may
 * have changed it.
 */
export function pageActLeavesSignIn(action: BrowserAction): boolean {
  if (AGENT_KEEPS.has(action.action)) return true;
  if (action.action === 'press') return action.keys.every(key => NON_TYPING_KEYS.has(key));
  if (action.action === 'click') return action.ref !== undefined || action.selector !== undefined;
  return false;
}

/**
 * Whether a person's toolbar act (`act`, posted to `POST /v1/sessions/:id/browser`) leaves who the page signs in: only a
 * read, a picture or the viewport's size. Who posts it is not known (the owner's address bar or a ferret's
 * `fy browser`), so any other act clears.
 */
export function toolbarActLeavesSignIn(action: BrowserAction): boolean {
  return READS.has(action.action) || action.action === 'start' || action.action === 'activate-page';
}
