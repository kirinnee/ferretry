import type { BrowserElementTarget, CopyElementPart } from '@ferretry/protocol';

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
    }
  | { readonly ok: false; readonly reason: 'missing' | 'empty' };

export interface BrowserCopyPort {
  copyRead(
    pageId: string,
    target: BrowserElementTarget,
    part: CopyElementPart,
    attribute?: string,
  ): Promise<BrowserCopyRead>;
}

/**
 * The worker's JSON-line method behind the port: `copyRead` `{ pageId, target, part, attribute? }` answers
 * `{ read }`. The answer is parsed by the daemon before it is believed.
 */
export const BROWSER_COPY_WORKER_METHODS = { read: 'copyRead' } as const;
