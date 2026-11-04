import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { type Marquee, marqueeOf, wordCut } from '../../lib/title-marquee.ts';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** Whether the reader asked for no motion; false where the browser cannot say. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => globalThis.matchMedia?.(REDUCED_MOTION).matches ?? false);
  useEffect(() => {
    const query = globalThis.matchMedia?.(REDUCED_MOTION);
    if (query === undefined) return undefined;
    const sync = (): void => setReduced(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return reduced;
}

/** Within this much of its box a two-line title is called whole: rounding is not overflow. */
const CLAMP_SLACK_PX = 1;

/**
 * A card head's title. On ONE line by default: one that fits is plain text; one that does not scrolls to its end and
 * back (`fy-item-view__title[data-marquee]`). Under `prefers-reduced-motion` it does not move: it ends at a WORD with
 * "…" (never half a word), and a tap shows the whole title (and a second tap folds it again).
 *
 * `twoLines` (the open agenda item's head) never moves and is never cut at a side: it wraps onto at most two lines
 * (`fy-item-view__title[data-wrap]`), and `onClamped` says whether even two lines could not hold it, so the host
 * can draw it whole as well. Every title is measured again when its box resizes and when a web font finishes loading.
 */
export function MarqueeTitle({
  title,
  wrap,
  twoLines = false,
  onClamped,
}: {
  readonly title: string;
  /** Draws the words as something else (a link). A tap then belongs to that, so the title cannot be tapped open. */
  readonly wrap?: (text: string) => ReactNode;
  /** Wraps the title onto at most two lines: it never scrolls, and it is never cut at a side. */
  readonly twoLines?: boolean;
  /** With `twoLines`: told, whenever the box is measured, whether the title is longer than its two lines. */
  readonly onClamped?: (clamped: boolean) => void;
}) {
  const box = useRef<HTMLHeadingElement | null>(null);
  const text = useRef<HTMLSpanElement | null>(null);
  const probe = useRef<HTMLSpanElement | null>(null);
  const reduced = useReducedMotion();
  const [cut, setCut] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const outer = box.current;
    const inner = text.current;
    if (outer === null || inner === null) return undefined;
    const measure = (): void => {
      if (twoLines) {
        setCut(null);
        setMarquee(null);
        onClamped?.(outer.scrollHeight > outer.clientHeight + CLAMP_SLACK_PX);
        return;
      }
      // An expanded title wraps, so its width says nothing about the one-line row: keep what was measured.
      if (outer.dataset.expanded !== undefined) return;
      const next = marqueeOf(inner.getBoundingClientRect().width, outer.clientWidth);
      const ruler = probe.current;
      setCut(
        next === null || !reduced || ruler === null
          ? null
          : wordCut(title, candidate => {
              ruler.textContent = candidate;
              return ruler.getBoundingClientRect().width <= outer.clientWidth;
            }),
      );
      setMarquee(previous =>
        previous?.distance === next?.distance && previous?.seconds === next?.seconds ? previous : next,
      );
    };
    measure();
    // A web face that arrives after the first paint can re-wrap the words without the clamped box changing size, so
    // no resize would say so: measure again once the page's fonts are in, and whenever another face loads.
    let live = true;
    const fonts = typeof document === 'undefined' ? undefined : document.fonts;
    const remeasure = (): void => {
      if (live) measure();
    };
    fonts?.ready.then(remeasure, () => undefined);
    fonts?.addEventListener('loadingdone', remeasure);
    const watch = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    watch?.observe(outer);
    return () => {
      live = false;
      fonts?.removeEventListener('loadingdone', remeasure);
      watch?.disconnect();
    };
  }, [title, reduced, twoLines, onClamped]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new title starts folded
  useEffect(() => setExpanded(false), [title]);

  const style =
    marquee === null
      ? undefined
      : ({
          '--fy-marquee-distance': `${marquee.distance}px`,
          '--fy-marquee-seconds': `${marquee.seconds}s`,
        } as CSSProperties);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a tap is a convenience for a title cut short; the whole title is always in the DOM and the ⓘ panel says the rest
    <h2
      className="fy-item-view__title"
      data-agenda-title=""
      {...(twoLines ? { 'data-wrap': '' } : {})}
      {...(marquee === null ? {} : { 'data-marquee': '' })}
      {...(expanded ? { 'data-expanded': '' } : {})}
      {...(cut === null ? {} : { 'data-cut': '' })}
      onClick={wrap !== undefined || (marquee === null && !expanded) ? undefined : () => setExpanded(open => !open)}
      ref={box}
      style={style}
    >
      <span className="fy-item-view__title-text" ref={text}>
        {wrap === undefined ? title : wrap(title)}
      </span>
      {reduced && !twoLines ? <span aria-hidden="true" className="fy-item-view__title-probe" ref={probe} /> : null}
      {cut === null ? null : (
        <span aria-hidden="true" className="fy-item-view__title-cut">
          {cut}
        </span>
      )}
    </h2>
  );
}
