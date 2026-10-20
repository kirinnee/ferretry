/**
 * EVERY PAGE RETURNS WHERE IT WAS LEFT — Settings, Insights, the sessions list, Continue — without any
 * page knowing about it.
 *
 * The shell owns the region every page renders into, so it hears every scroll inside it (a scroll does
 * not bubble, but it is captured). Each scroller is filed under the history entry on screen and its
 * path from the region, in `ScrollMemory`. When an entry is shown again — Back, Forward, a reload — the
 * saved offsets are put back, and because a page usually builds its content after it mounts (a list
 * that is read, a section that lays out late) a restore waits for the content to grow tall enough,
 * then clamps once it stops. The reader always wins: any scroll input of theirs ends the restore.
 *
 * A LANDED OFFSET IS HELD UNTIL THE PAGE GOES QUIET. Content tall enough to hold the offset is not
 * content that has finished arriving: a section above it can still grow, and the browser's scroll
 * anchoring then moves the scroller by that much to keep the half-built view still — measured on the
 * phone's Settings, a reload landed 95px off the offset it had saved. So each restored scroller opts out
 * of anchoring until the region has been quiet for {@link SCROLL_RESTORE_QUIET_MS}, and the saved
 * offset, which was taken over the finished page, is what the reader sees once it is finished again.
 *
 * The chat transcript is NOT restored here: it has its own follow model (`useStickToBottom`) and a
 * position per session rather than per entry, so this hook ignores it, and anything else marked
 * `data-scroll-memory="off"`.
 */

import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';
import { elementAtPath, elementPath, restorableTop, type ScrollMemory } from '../lib/scroll-memory.ts';

/** How long a restore keeps waiting for content to arrive before it settles for the nearest offset. */
export const SCROLL_RESTORE_PATIENCE_MS = 4_000;

/** How long the region must go without a change before a landed offset stops being held. */
export const SCROLL_RESTORE_QUIET_MS = 500;

/** Scrollers this hook leaves alone: the chat's own follow model, and anything that opts out. */
export const SCROLL_MEMORY_IGNORED = '.fy-transcript, [data-scroll-memory="off"]';

const READER_INPUT = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

export function useRouteScrollMemory(
  regionRef: RefObject<HTMLElement | null>,
  entryKey: string,
  memory: ScrollMemory,
): void {
  const keyRef = useRef(entryKey);
  keyRef.current = entryKey;

  // ---- REMEMBER: every scroll inside the region, once per frame per scroller ----------------------
  useEffect(() => {
    const region = regionRef.current;
    if (region === null) return;
    const queued = new Map<Element, string>();
    let frame: number | null = null;
    const flush = (): void => {
      frame = null;
      for (const [element, key] of queued) {
        const path = elementPath(region, element);
        if (path !== null) memory.rememberPage(key, path, element.scrollTop);
      }
      queued.clear();
    };
    const onScroll = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest(SCROLL_MEMORY_IGNORED) !== null) return;
      queued.set(target, keyRef.current);
      frame ??= requestAnimationFrame(flush);
    };
    region.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      region.removeEventListener('scroll', onScroll, { capture: true });
      if (frame !== null) cancelAnimationFrame(frame);
      flush();
    };
  }, [memory, regionRef]);

  // ---- RESTORE: the entry on screen, as soon as its content can hold the offset --------------------
  // A layout effect, so a page whose content is already there is put back before it is ever painted at
  // the top.
  useLayoutEffect(() => {
    const region = regionRef.current;
    const saved = memory.page(entryKey);
    if (region === null || saved === null) return;
    const pending = new Map(Object.entries(saved));
    /** Each landed scroller, with the anchoring it had before the restore opted it out. */
    const held = new Map<HTMLElement, string>();
    let quiet: ReturnType<typeof setTimeout> | null = null;
    const attempt = (final: boolean): void => {
      for (const [path, top] of pending) {
        const element = elementAtPath(region, path);
        if (element === null) continue;
        const target = restorableTop(top, element, final);
        if (target === undefined) continue;
        element.scrollTop = target;
        pending.delete(path);
        if (element instanceof HTMLElement && !held.has(element)) {
          held.set(element, element.style.overflowAnchor);
          element.style.overflowAnchor = 'none';
        }
      }
      if (final) stop();
      else if (pending.size === 0) {
        if (quiet !== null) clearTimeout(quiet);
        quiet = setTimeout(stop, SCROLL_RESTORE_QUIET_MS);
      }
    };
    const observer = new MutationObserver(() => attempt(false));
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => attempt(false));
    const deadline = setTimeout(() => attempt(true), SCROLL_RESTORE_PATIENCE_MS);
    const byReader = (): void => stop();
    let stopped = false;
    function stop(): void {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
      resize?.disconnect();
      clearTimeout(deadline);
      if (quiet !== null) clearTimeout(quiet);
      for (const [element, anchoring] of held) element.style.overflowAnchor = anchoring;
      for (const type of READER_INPUT) region?.removeEventListener(type, byReader, { capture: true });
    }
    observer.observe(region, { childList: true, subtree: true, characterData: true });
    resize?.observe(region);
    for (const type of READER_INPUT) region.addEventListener(type, byReader, { capture: true, passive: true });
    attempt(false);
    return stop;
  }, [entryKey, memory, regionRef]);
}
