/**
 * "UPDATING…" — said only while a screen shows this device's cached copy (`lib/session-cache.ts`) and
 * the live read that confirms or replaces it has not answered yet. Quiet on purpose: the content under
 * it is the last thing this device saw, not an error, and it disappears the moment the daemon answers.
 * A polite status, so a screen reader hears it once rather than on every change underneath. It is a wait like any
 * other, so it holds back for the one loader threshold (300 ms): a confirm that answers inside it never flashes the pill.
 */

import { useRef } from 'react';
import { LOADING_GATE_CLASS } from './loading-gate.ts';
import { useLoadingHold } from './loading-hold.ts';
import { Spinner } from './spinner.tsx';

export interface CacheUpdatingProps {
  /** Placement from the host: the pill has no position of its own. */
  readonly className?: string;
}

export function CacheUpdating({ className }: CacheUpdatingProps) {
  const root = useRef<HTMLParagraphElement>(null);
  useLoadingHold(root); // answered a moment after it showed: it stays its minimum, not a blink
  return (
    <p
      aria-live="polite"
      className={`${LOADING_GATE_CLASS} pointer-events-none m-0 inline-flex w-fit items-center gap-xs rounded-full border border-border-strong bg-surface px-sm py-xs text-meta text-muted shadow-panel${className === undefined ? '' : ` ${className}`}`}
      data-cache-updating=""
      ref={root}
      role="status"
    >
      <Spinner size={12} />
      Updating…
    </p>
  );
}
