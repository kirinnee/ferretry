import { PENDING_READING_ATTRIBUTE } from '../hypermedia/plain-fallback.tsx';

/**
 * AN OLDER PAGE GOES ON SCREEN ONLY ONCE ITS ROWS ARE THEIR FINAL HEIGHT.
 *
 * A message is drawn as its plain text until the Durian worker has read it (`hypermedia-prose.tsx`), and the read document is
 * usually shorter, by about a line. Rows that shrink ABOVE the reader are held still by the browser's scroll anchoring, but a
 * row half above the reader's top edge is not: when it shrinks the reader's own message moves up with it. Under load a page of
 * a hundred rows shrinks one by one over half a second while the reader scrolls back through it, and every half-visible row
 * that shrinks is one more jump (measured: 8–34 px, 4 of 4 under two busy cores).
 *
 * So the rows of an older page are rendered at once, mounted and read, but hidden: every row of the transcript before the
 * staging marker is `display: none` (`chat.css`). When none of them is still waiting for its reading — or
 * {@link STAGING_PATIENCE_MS} after the first was staged, whichever is first — the marker goes and the whole batch appears in
 * ONE layout, which the transcript's prepend restore holds still. Nothing is remounted: the rows were already where they will
 * be, only hidden. While rows are staged the history row still says it is loading, because to the reader it still is.
 */

/** The class of the marker after the staged rows: every transcript row before it is hidden (`chat.css`). */
export const STAGED_MARKER_CLASS = 'fy-transcript-staged';

/**
 * The longest an older page is held back for its readings. Each message is read in turn with a 500 ms budget of its own, so a
 * page of slow messages could otherwise be held for many seconds; past this the page goes on screen as it is, and a row still
 * reading may then change height once, as before.
 */
export const STAGING_PATIENCE_MS = 2_000;

/** The staging marker of `content`, if rows are staged. */
const markerOf = (content: ParentNode): Element | null => content.querySelector(`:scope > .${STAGED_MARKER_CLASS}`);

/** Is `node` one of the rows held back (before the marker), so not on screen yet? */
export const isStaged = (node: Node, content: ParentNode): boolean => {
  const marker = markerOf(content);
  return marker !== null && (marker.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
};

/** Is a staged row still waiting for its message to be read? */
export const stagedReadingPending = (content: ParentNode): boolean =>
  [...content.querySelectorAll(`[${PENDING_READING_ATTRIBUTE}]`)].some(element => isStaged(element, content));

/**
 * Calls `settled` once no staged row of `content` is waiting for its reading, or when the patience that began at `since`
 * (`performance.now()`) runs out. Returns the stop.
 */
export const watchStagedReadings = (content: HTMLElement, since: number, settled: () => void): (() => void) => {
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    settled();
  };
  const check = (): void => {
    if (!stagedReadingPending(content)) finish();
  };
  const observer = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(check);
  observer?.observe(content, {
    attributes: true,
    attributeFilter: [PENDING_READING_ATTRIBUTE],
    childList: true,
    subtree: true,
  });
  const deadline = setTimeout(finish, Math.max(0, STAGING_PATIENCE_MS - (performance.now() - since)));
  check();
  return () => {
    done = true;
    observer?.disconnect();
    clearTimeout(deadline);
  };
};
