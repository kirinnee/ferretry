/**
 * Marker — slim, low-emphasis rows for the transcript: status updates, tool
 * activity, system notes, and labeled separators.
 *
 * Ported from kteam `ui/src/components/Marker.tsx`. It implements the intent of
 * shadcn's `Marker` in-tree: only `message-scroller` ships as a headless
 * package, and the styled registry components require a full shadcn init that
 * would take over the CSS variables this repo's theme sheet owns. So these stay
 * hand-rolled to match the transcript's calm palette.
 */

import type { ReactNode } from 'react';
import { cn } from '../lib/class-names.ts';

export interface MarkerSeparatorProps {
  readonly children: ReactNode;
  readonly tone?: 'muted' | 'faint';
}

/** A labeled center divider, e.g. turn boundaries or date breaks. */
export function MarkerSeparator({ children, tone = 'muted' }: MarkerSeparatorProps) {
  return (
    <div className="flex select-none items-center gap-3 py-1">
      <span className="h-px flex-1 bg-border-soft" />
      <span
        // `.kt-label` owns the casing: Ember renders small caps instead of
        // shouted uppercase, Mission 0.14em mono caps, Neo 800 weight.
        className={cn('kt-label', tone === 'faint' ? 'text-faint' : 'text-muted')}
      >
        {children}
      </span>
      <span className="h-px flex-1 bg-border-soft" />
    </div>
  );
}

export interface MarkerLineProps {
  readonly icon?: ReactNode;
  readonly children: ReactNode;
  readonly onClick?: () => void;
  readonly title?: string;
  readonly className?: string;
}

/**
 * A single slim status line with a leading dot/icon. Used for the running tool
 * indicator, system notices, and the thinking summary.
 */
export function MarkerLine({ icon, children, onClick, title, className }: MarkerLineProps) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={title}
      className={cn(
        'group flex w-full items-center gap-sm rounded-control px-cell-x py-row-y text-left text-cell text-muted',
        onClick && 'transition-colors hover:bg-surface-2',
        className,
      )}
    >
      {icon && <span className="shrink-0 text-faint group-hover:text-muted">{icon}</span>}
      <span className="min-w-0 flex-1">{children}</span>
    </Comp>
  );
}
