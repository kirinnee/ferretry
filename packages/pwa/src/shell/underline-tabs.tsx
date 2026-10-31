/**
 * The level-three navigation: underlined tabs in sentence case (`.kt-utabs`, index.css).
 *
 * They switch which VIEW of one thing is shown, so they look like tabs and never like buttons — the
 * owner's complaint was a row of boxed buttons that read exactly like the actions under them.
 *
 * Each tab changes the address, so the semantics are navigation (`aria-current="page"`), not a WAI-ARIA
 * tablist: there is no roving tabindex to honour and no panel element owned by the strip.
 *
 * ON A PHONE THE STRIP SCROLLS SIDEWAYS, and two things make that obvious without arrow buttons:
 *
 * - the selected tab is scrolled to the CENTRE on arrival and whenever it changes — instantly the first
 *   time, smoothly afterwards unless the reader asked for reduced motion — so the current view is never
 *   the one hidden off the edge;
 * - an edge fades out on any side that has more tabs beyond it, and a chevron sits on that edge: a fade
 *   alone read as a clipped label ("Ma…"), and a chevron both says "more this way" and scrolls there.
 *
 * The strip is scrolled by setting its own `scrollLeft`. `scrollIntoView` was not used because it also
 * scrolls every scrolling ANCESTOR, and the fixed app shell must never scroll.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../lib/class-names.ts';

interface UnderlineTab<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly icon?: ReactNode;
}

export interface UnderlineTabsProps<T extends string> {
  readonly tabs: readonly UnderlineTab<T>[];
  readonly current: T;
  readonly onSelect: (id: T) => void;
  /** The navigation landmark's accessible name. */
  readonly label: string;
  /** The `data-*` attribute every tab carries, e.g. `data-machine-tab`. */
  readonly marker: string;
  readonly className?: string;
}

/** The first pass is instant: arriving on a page should not animate a scroll the reader never asked for. */
const prefersReducedMotion = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** Where the strip has to be scrolled to put `tab` in its middle, clamped to what it can scroll. */
export const centredScrollLeft = (
  strip: { readonly clientWidth: number; readonly scrollWidth: number },
  tab: { readonly offsetLeft: number; readonly offsetWidth: number },
): number =>
  Math.max(
    0,
    Math.min(strip.scrollWidth - strip.clientWidth, tab.offsetLeft - (strip.clientWidth - tab.offsetWidth) / 2),
  );

/** Which edges have tabs beyond them. One pixel of slack absorbs sub-pixel layout. */
export const stripOverflow = (strip: {
  readonly scrollLeft: number;
  readonly clientWidth: number;
  readonly scrollWidth: number;
}): { readonly start: boolean; readonly end: boolean } => ({
  start: strip.scrollLeft > 1,
  end: strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1,
});

export function UnderlineTabs<T extends string>({
  tabs,
  current,
  onSelect,
  label,
  marker,
  className,
}: UnderlineTabsProps<T>) {
  const strip = useRef<HTMLUListElement>(null);
  const tabRefs = useRef(new Map<T, HTMLButtonElement>());
  const arrived = useRef(false);
  const [more, setMore] = useState({ start: false, end: false });

  const measure = useCallback((): void => {
    const element = strip.current;
    if (element === null) return;
    const next = stripOverflow(element);
    setMore(previous => (previous.start === next.start && previous.end === next.end ? previous : next));
  }, []);

  useLayoutEffect(() => {
    const element = strip.current;
    const tab = tabRefs.current.get(current);
    if (element === null || tab === undefined) return;
    const left = centredScrollLeft(element, tab);
    const smooth = arrived.current && !prefersReducedMotion();
    arrived.current = true;
    if (typeof element.scrollTo === 'function') element.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
    else element.scrollLeft = left;
    measure();
  }, [current, measure]);

  useLayoutEffect(() => {
    const element = strip.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);

  const page = (direction: 1 | -1): void => {
    const element = strip.current;
    if (element === null) return;
    const left = Math.max(0, element.scrollLeft + direction * element.clientWidth * 0.7);
    if (typeof element.scrollTo === 'function')
      element.scrollTo({ left, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    else element.scrollLeft = left;
  };

  return (
    <nav
      aria-label={label}
      className={cn('kt-utabs', className)}
      data-more-start={more.start}
      data-more-end={more.end}
      data-underline-tabs=""
    >
      <ul ref={strip} className="kt-utabs__strip relative" onScroll={measure}>
        {tabs.map(tab => {
          const selected = tab.id === current;
          return (
            <li key={tab.id} className="shrink-0">
              <button
                ref={element => {
                  if (element) tabRefs.current.set(tab.id, element);
                  else tabRefs.current.delete(tab.id);
                }}
                type="button"
                {...{ [marker]: tab.id }}
                aria-current={selected ? 'page' : undefined}
                onClick={() => onSelect(tab.id)}
                className="kt-utab"
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {more.start ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Show earlier ${label}`}
          className="kt-utabs__more kt-utabs__more--start"
          data-utabs-more="start"
          onClick={() => page(-1)}
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
      ) : null}
      {more.end ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Show more ${label}`}
          className="kt-utabs__more kt-utabs__more--end"
          data-utabs-more="end"
          onClick={() => page(1)}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      ) : null}
    </nav>
  );
}
