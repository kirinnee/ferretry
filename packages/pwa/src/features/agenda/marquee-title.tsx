import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { type Marquee, marqueeOf } from '../../lib/title-marquee.ts';

/**
 * The open item's title on ONE line. One that fits is plain text; one that does not scrolls to its end and back
 * (`fy-item-view__title[data-marquee]`). Under `prefers-reduced-motion` it does not move: it ends in an ellipsis, and a
 * tap shows the whole title (and a second tap folds it again).
 */
export function MarqueeTitle({
  title,
  wrap,
}: {
  readonly title: string;
  /** Draws the words as something else (a link). A tap then belongs to that, so the title cannot be tapped open. */
  readonly wrap?: (text: string) => ReactNode;
}) {
  const box = useRef<HTMLHeadingElement | null>(null);
  const text = useRef<HTMLSpanElement | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [expanded, setExpanded] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: measure again whenever the title changes
  useEffect(() => {
    const outer = box.current;
    const inner = text.current;
    if (outer === null || inner === null) return undefined;
    const measure = (): void => {
      // An expanded title wraps, so its width says nothing about the one-line row: keep what was measured.
      if (outer.dataset.expanded !== undefined) return;
      const next = marqueeOf(inner.getBoundingClientRect().width, outer.clientWidth);
      setMarquee(previous =>
        previous?.distance === next?.distance && previous?.seconds === next?.seconds ? previous : next,
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const watch = new ResizeObserver(measure);
    watch.observe(outer);
    return () => watch.disconnect();
  }, [title]);

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
      {...(marquee === null ? {} : { 'data-marquee': '' })}
      {...(expanded ? { 'data-expanded': '' } : {})}
      onClick={wrap !== undefined || (marquee === null && !expanded) ? undefined : () => setExpanded(open => !open)}
      ref={box}
      style={style}
    >
      <span className="fy-item-view__title-text" ref={text}>
        {wrap === undefined ? title : wrap(title)}
      </span>
    </h2>
  );
}
