import type { BrowserElementTarget } from '../../contract/wire/target.ts';
/** The longest value a secure copy holds, in UTF-8 bytes (today's `COPY_VALUE_MAX_BYTES`; the Vault's copy keeps the same cap). */
export const COPY_VALUE_MAX_BYTES = 16_384;
/** What part of an element is read: its visible text, a form field's current value, or one attribute. */
export type CopyElementPart = 'text' | 'value' | 'attribute';

/**
 * SECURE COPY'S SEAM INTO THE AGENT BROWSER (docs/secure-copy.md, "Capturing").
 *
 * One call, on ONE page, in that page's own queue so no agent act lands in the middle:
 * {@link BrowserCopyPort.copyRead} reads one element's text, a field's value or one attribute, and answers it
 * with where it was read: the page's origin, the origin of the frame the element is in, and the document (the
 * main frame's loader id) as the BROWSER reports them. The agent's pointer (a ref or a selector) only says
 * where to look.
 *
 * THE VALUE CROSSES THIS SEAM ONLY IN `copyRead`'s answer, once. It is never logged, never in an error message,
 * and the daemon seals it before anything else is awaited. A worker cuts it at one character over the copy's
 * byte cap, so an oversized read is refused without carrying the whole of it.
 */

/** What a read found: the value and where it came from, or why there is nothing (the element is gone, or empty). */
export type BrowserCopyRead =
  | {
      readonly ok: true;
      readonly value: string;
      /** `scheme://host[:port]` of the page. */
      readonly origin: string;
      /** `scheme://host[:port]` of the frame the element is in: the page's own, or a frame from another site. */
      readonly frameOrigin: string;
      /** The document the value was read from: it changes with every navigation. */
      readonly navigationId: string;
      /** The element is editable (a contenteditable one, or inside one): its text is whatever was typed there. */
      readonly editable?: true;
    }
  | { readonly ok: false; readonly reason: 'missing' | 'empty' | 'changed' };

export interface BrowserCopyPort {
  copyRead(
    pageId: string,
    target: BrowserElementTarget,
    part: CopyElementPart,
    attribute?: string,
  ): Promise<BrowserCopyRead>;
  /** What the browser's clipboard holds now, read by the worker in a context of its own and emptied. */
  copyClipboard(pageId: string): Promise<BrowserClipboardRead>;
  /** Empties the browser's clipboard; `true` only when it was CONFIRMED empty. A real window on this computer's own clipboard: `true` (nothing of Ferretry's is on it). */
  clearClipboard(): Promise<boolean>;
}

/**
 * The worker's JSON-line method behind the port: `copyRead` `{ pageId, target, part, attribute? }` answers
 * `{ read }`. The answer is parsed by the daemon before it is believed.
 */
export const BROWSER_COPY_WORKER_METHODS = { read: 'copyRead' } as const;

/**
 * What the agent browser's clipboard held, read in the WORKER's own context (never an agent page's: no agent page is ever
 * granted clipboard-read) and then emptied. Where it was read is the page the agent named, as for {@link BrowserCopyRead}.
 * `shared`: this browser's clipboard is this computer's own (a real window on a desktop), so nothing was read.
 */
export type BrowserClipboardRead = (
  | Extract<BrowserCopyRead, { readonly ok: true }>
  | { readonly ok: false; readonly reason: 'missing' | 'empty' | 'changed' | 'shared' }
) & {
  /**
   * Set when the clipboard could NOT be confirmed empty after the read: it may still hold what was on it, however the read
   * went. The caller keeps the browser's clipboard paths and the page closed until a clear is confirmed.
   */
  readonly kept?: true;
};

/** The worker's JSON-line method for the clipboard: `clipboardRead` `{ pageId }` answers `{ read }`. */
export const BROWSER_CLIPBOARD_WORKER_METHOD = 'clipboardRead' as const;
/** The worker's JSON-line method that empties the clipboard: `clipboardClear` answers `{ cleared }`, true only when confirmed. */
export const BROWSER_CLIPBOARD_CLEAR_WORKER_METHOD = 'clipboardClear' as const;
