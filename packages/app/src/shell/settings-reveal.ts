/**
 * A SETTINGS PAGE THE PERSON PICKED MUST BE SEEN. The Settings page lists every tab as links above the page itself
 * (about 650px at 1280x713, about three screens at 390x844), so choosing "Logins" left the same list on screen with the
 * page hidden below it and nothing looked like it had happened. Picking a tab scrolls the page's top to the head of its
 * scroller (and the page takes focus, see `DaemonSettingsPage`).
 *
 * Only when less than {@link SETTINGS_REVEAL_MIN_VISIBLE_PX} of the page is in sight: a page that already shows that much
 * is left where it is, so a tall screen (1920x1080) keeps its layout. Not `scrollIntoView`: that also scrolls every `overflow: hidden` ancestor (the
 * fixed shell), the sideways-shifted header this app already shipped once (see `revealInScroller`).
 */

/** How much of the page must already be in sight for it to be left where it is. */
const SETTINGS_REVEAL_MIN_VISIBLE_PX = 300;

/** Room left above the revealed page, so its first line is not on the scroller's edge. */
export const SETTINGS_REVEAL_MARGIN_PX = 16;

/** Returns whether any scroller moved. */
export const revealSettingsPage = (
  element: Element,
  overflowY: (node: Element) => string = node => getComputedStyle(node).overflowY,
): boolean => {
  let moved = false;
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const overflow = overflowY(node);
    if (overflow !== 'auto' && overflow !== 'scroll') continue;
    const offset = element.getBoundingClientRect().top - node.getBoundingClientRect().top;
    if (offset + SETTINGS_REVEAL_MIN_VISIBLE_PX <= node.getBoundingClientRect().height) continue;
    node.scrollTop += offset - SETTINGS_REVEAL_MARGIN_PX;
    moved = true;
  }
  return moved;
};

/** How long a revealed page keeps being brought back while its content arrives. */
const SETTINGS_REVEAL_PATIENCE_MS = 2_000;

/** The reader's own input ends the hold: they are scrolling now, and the reader always wins. */
const READER_INPUT = ['wheel', 'touchstart', 'keydown'] as const;

/**
 * Reveal the page now, and again each time it changes size, until it has been quiet or the reader scrolls. A page's body
 * arrives after it mounts (a deep link opens before the machine has answered), and a scroller cannot be scrolled past the
 * content it holds yet, so the first reveal alone lands short. Returns the cleanup.
 */
export const keepSettingsPageRevealed = (page: Element, overflowY?: (node: Element) => string): (() => void) => {
  revealSettingsPage(page, overflowY);
  const watcher =
    typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => revealSettingsPage(page, overflowY));
  watcher?.observe(page);
  const stop = (): void => {
    watcher?.disconnect();
    clearTimeout(timer);
    for (const type of READER_INPUT) document.removeEventListener(type, stop);
  };
  const timer = setTimeout(stop, SETTINGS_REVEAL_PATIENCE_MS);
  for (const type of READER_INPUT) document.addEventListener(type, stop, { passive: true });
  return stop;
};
