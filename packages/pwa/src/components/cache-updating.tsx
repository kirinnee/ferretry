/**
 * "UPDATING…" — said only while a screen shows this device's cached copy (`lib/session-cache.ts`) and
 * the live read that confirms or replaces it has not answered yet. Quiet on purpose: the content under
 * it is the last thing this device saw, not an error, and it disappears the moment the daemon answers.
 * A polite status, so a screen reader hears it once rather than on every change underneath.
 */

import { Spinner } from './spinner.tsx';

export interface CacheUpdatingProps {
  /** Placement from the host: the pill has no position of its own. */
  readonly className?: string;
}

export function CacheUpdating({ className }: CacheUpdatingProps) {
  return (
    <p
      aria-live="polite"
      className={`pointer-events-none m-0 inline-flex w-fit items-center gap-xs rounded-full border border-border-strong bg-surface px-sm py-xs text-meta text-muted shadow-panel${className === undefined ? '' : ` ${className}`}`}
      data-cache-updating=""
      role="status"
    >
      <Spinner size={12} />
      Updating…
    </p>
  );
}
