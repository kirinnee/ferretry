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

/**
 * A card head's title. On ONE line by default: one that fits is plain text; one that does not scrolls to its end and
 * back (`fy-item-view__title[data-marquee]`). Under `prefers-reduced-motion` it does not move: it ends at a WORD with
 * "…" (never half a word), and a tap shows the whole title (and a second tap folds it again). Every head draws its
 * title this way, the open agenda item's included (&F920: one line, never wrapped). Every title is measured again when
 * its box resizes and when a web font finishes loading.
 */
export function MarqueeTitle({
  title,
  wrap,
  wrapped = false,
}: {
  readonly title: string;
  /**
   * The title is a sentence the owner reads before they act (a notice about cards), so it is NEVER cut or scrolled: it
   * wraps onto as many lines as it needs. Every other title keeps its one line.
   */
  readonly wrapped?: boolean;
  /** Draws the words as something else (a link). A tap then belongs to that, so the title cannot be tapped open. */
  readonly wrap?: (text: string) => ReactNode;
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
    if (wrapped || outer === null || text.current === null) return undefined;
    const measure = (): void => {
      // Read the words' box each time: it moves into the toggle button once the title turns out too long.
      const inner = text.current;
      // An expanded title wraps, so its width says nothing about the one-line row: keep what was measured.
      if (inner === null || outer.dataset.expanded !== undefined) return;
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
    // A web face that arrives after the first paint can widen the words without the box changing size, so no resize
    // would say so: measure again once the page's fonts are in, and whenever another face loads.
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
  }, [title, reduced, wrapped]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new title starts folded
  useEffect(() => setExpanded(false), [title]);

  const style =
    marquee === null
      ? undefined
      : ({
          '--fy-marquee-distance': `${marquee.distance}px`,
          '--fy-marquee-seconds': `${marquee.seconds}s`,
        } as CSSProperties);

  // A title too long for its row opens to its whole words with a real button inside the heading, so a keyboard reaches
  // it (Tab, then Enter or Space) and a screen reader hears whether it is open. A linked title (`wrap`) keeps its tap.
  const expandable = wrap === undefined && (marquee !== null || expanded);
  const words = (
    <>
      <span className="fy-item-view__title-text" ref={text}>
        {wrap === undefined ? title : wrap(title)}
      </span>
      {cut === null ? null : (
        <span aria-hidden="true" className="fy-item-view__title-cut">
          {cut}
        </span>
      )}
    </>
  );

  return (
    <h2
      className="fy-item-view__title"
      data-agenda-title=""
      {...(marquee === null ? {} : { 'data-marquee': '' })}
      {...(expanded ? { 'data-expanded': '' } : {})}
      {...(wrapped ? { 'data-wrapped': '' } : {})}
      {...(cut === null ? {} : { 'data-cut': '' })}
      ref={box}
      style={style}
    >
      {expandable ? (
        <button
          aria-expanded={expanded}
          className="fy-item-view__title-toggle"
          data-agenda-title-toggle=""
          onClick={() => setExpanded(open => !open)}
          type="button"
        >
          {words}
        </button>
      ) : (
        words
      )}
      {reduced ? <span aria-hidden="true" className="fy-item-view__title-probe" ref={probe} /> : null}
    </h2>
  );
}
