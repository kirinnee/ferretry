import { RefreshCw } from 'lucide-react';
import { cn } from '../../lib/class-names.ts';
import { relativeTime } from '../../lib/session-screens.ts';
import { Button } from '../../shell/primitives.tsx';

/** The daemon-derived portion of the learning status used by the header. */
export interface LearningStatusSummary {
  readonly enabled: boolean;
  readonly lastRunAt?: string;
  readonly pending: {
    readonly total: number;
    readonly strong: number;
  };
}

/**
 * The compact learning status strip from the source Learning page. It remains
 * presentation-only until the learning transport is ported, so callers own the
 * paired-daemon request and pass its current result in explicitly.
 */
export function LearningHeader({
  status,
  failed,
  busy,
  canRun,
  now,
  onRunNow,
}: {
  readonly status: LearningStatusSummary | null;
  readonly failed: boolean;
  readonly busy: boolean;
  readonly canRun: boolean;
  readonly now?: number;
  readonly onRunNow: () => void;
}) {
  return (
    <fieldset
      aria-label="Learning status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border-soft bg-surface-2 px-3 py-2 text-[12px]"
    >
      <span className="inline-flex items-center gap-1.5 font-medium text-fg-soft">Learning</span>
      <span aria-hidden="true" className="text-border">
        ·
      </span>
      <span className={cn('mono', status?.enabled ? 'text-ok' : 'text-muted')}>
        {status?.enabled ? 'enabled' : 'disabled'}
      </span>
      <span aria-hidden="true" className="text-border">
        ·
      </span>
      <span className="mono text-muted">last run {status?.lastRunAt ? relativeTime(status.lastRunAt, now) : '—'}</span>
      <span aria-hidden="true" className="text-border">
        ·
      </span>
      <span className="mono text-muted">{status?.pending.total ?? 0} pending</span>
      {status && status.pending.strong > 0 && (
        <>
          <span aria-hidden="true" className="text-border">
            ·
          </span>
          <span className="mono text-accent">{status.pending.strong} strong</span>
        </>
      )}
      {failed && (
        <>
          <span aria-hidden="true" className="text-border">
            ·
          </span>
          <span className="mono text-warn">unavailable on this daemon</span>
        </>
      )}
      <Button
        size="sm"
        variant="outline"
        className="ml-auto min-h-[44px] items-center gap-xs"
        onClick={onRunNow}
        disabled={busy || !canRun}
        aria-label="Run a learning scan now"
      >
        <RefreshCw
          size={13}
          aria-hidden="true"
          className={busy ? 'animate-spin motion-reduce:animate-none' : undefined}
        />
        Run now
      </Button>
    </fieldset>
  );
}
