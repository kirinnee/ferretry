/**
 * Mobile pull-to-find host for the app shell.
 *
 * Mounted ONCE around the page area rather than per page, and the scroll port is
 * discovered from the touch, so every destination — including ones added after
 * this was written — answers the gesture without being listed anywhere. The
 * surfaces that already own a downward pull decline it by name instead.
 *
 * Listeners are passive and nothing is cancelled, and the hook refuses any pull
 * that starts below the top of its scroller, so ordinary scrolling stays exactly
 * what the browser would have done.
 */

import { Search } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { usePullToPalette } from '../hooks/use-pull-to-palette.ts';

export interface PullToPaletteRegionProps {
  readonly children: ReactNode;
  readonly className: string;
  readonly enabled: boolean;
  readonly onOpen: () => void;
}

export function PullToPaletteRegion({ children, className, enabled, onOpen }: PullToPaletteRegionProps) {
  const root = useRef<HTMLDivElement>(null);
  const pull = usePullToPalette(root, { enabled, onOpen });
  const visible = pull.distance > 0;

  return (
    <div ref={root} className={className} data-pull-to-palette-region="">
      <div
        aria-atomic="true"
        aria-hidden={!visible}
        aria-live="polite"
        role="status"
        className="pointer-events-none absolute inset-x-0 top-2 z-40 flex justify-center transition-opacity duration-150 motion-reduce:transition-none"
        data-pull-to-palette-indicator={pull.armed ? 'armed' : 'pulling'}
        style={{ opacity: visible ? 1 : 0, transform: `translateY(${Math.round(pull.progress * 10)}px)` }}
      >
        <span className="inline-flex items-center gap-xs rounded-full border border-border-soft bg-surface/95 px-sm py-xs text-meta font-semibold text-muted shadow-panel backdrop-blur">
          <Search size={13} aria-hidden="true" className={pull.armed ? 'text-accent' : 'text-faint'} />
          {pull.armed ? 'Release to find' : 'Pull to find'}
        </span>
      </div>
      {children}
    </div>
  );
}
