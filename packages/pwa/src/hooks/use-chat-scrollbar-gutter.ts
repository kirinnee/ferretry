/**
 * THE TRANSCRIPT'S SCROLLBAR WIDTH, published to the chat surface as `--fy-chat-gutter`.
 *
 * The conversation measure (`.kt-chat-surface` in `styles/index.css`) centres the transcript's text
 * column inside its SCROLLER, whose client box is narrower than the pane by the scrollbar. The
 * composer under it centres inside the plain pane. Without this the two columns sit half a scrollbar
 * apart, and in Full a whole one — the misaligned right edges the conversation-width setting existed
 * to remove. The composer's row reserves the same strip on its right, so both centre on one axis.
 *
 * Measured rather than assumed: `scrollbar-width: thin` is a different number per engine and
 * platform, an overlay scrollbar (a phone, macOS) is zero, and a transcript too short to scroll has no
 * scrollbar at all until the first long answer arrives — so the content box is observed too.
 */

import { type RefObject, useLayoutEffect } from 'react';

/** The selectors the measure reads, owned by `components/transcript.tsx`. */
const TRANSCRIPT_SCROLLER = '.fy-transcript';
const TRANSCRIPT_CONTENT = '.fy-transcript-content';
/** The custom property the composer's row reads. */
export const CHAT_GUTTER_PROPERTY = '--fy-chat-gutter';

/** The geometry a scroller exposes about its own scrollbar. */
export interface ScrollerBox {
  readonly offsetWidth: number;
  readonly clientWidth: number;
  /** The left border; the right one is assumed equal, as it is on the transcript. */
  readonly clientLeft: number;
}

/** The vertical scrollbar's width: what the box spends that its client area does not. Never negative. */
export const scrollbarGutter = (box: ScrollerBox): number =>
  Math.max(0, box.offsetWidth - box.clientWidth - 2 * box.clientLeft);

/** The slice of `ResizeObserver` this hook uses, so a test can drive it. */
interface GutterObserver {
  observe(target: Element): void;
  disconnect(): void;
}
export type GutterObserverFactory = (callback: () => void) => GutterObserver | null;

const browserObserver: GutterObserverFactory = callback =>
  typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(callback);

/**
 * Keeps `--fy-chat-gutter` on `surface` equal to the transcript scrollbar's width.
 *
 * `key` re-reads the targets when the transcript under the surface is replaced (another session), so
 * the observer never watches a detached scroller.
 */
export function useChatScrollbarGutter(
  surface: RefObject<HTMLElement | null>,
  key: string,
  createObserver: GutterObserverFactory = browserObserver,
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the re-read trigger, by design.
  useLayoutEffect(() => {
    const element = surface.current;
    if (element === null) return;
    const update = (): void => {
      const scroller = element.querySelector<HTMLElement>(TRANSCRIPT_SCROLLER);
      element.style.setProperty(CHAT_GUTTER_PROPERTY, `${scroller === null ? 0 : scrollbarGutter(scroller)}px`);
    };
    update();
    const observer = createObserver(update);
    if (observer === null) return;
    observer.observe(element);
    for (const selector of [TRANSCRIPT_SCROLLER, TRANSCRIPT_CONTENT]) {
      const target = element.querySelector(selector);
      if (target !== null) observer.observe(target);
    }
    return () => observer.disconnect();
  }, [surface, key, createObserver]);
}
