/** The compact, task-bearing identity used inside a constrained lineage row. */
import type { LineageLabel } from '../../lib/lineage.ts';
import { cn } from '../../lib/class-names.ts';

export interface LineageNameProps {
  readonly label: LineageLabel;
  readonly className?: string;
}

/** The task yields first; callsign remains visible as the stable identity. */
export function LineageName({ label, className = '' }: LineageNameProps) {
  const hasCallsign = Boolean(label.callsign);
  const hasTask = Boolean(label.task);
  return (
    <span className={cn('inline-flex min-w-0 max-w-full items-baseline', className)} title={label.full}>
      <span aria-hidden="true" className="inline-flex min-w-0 max-w-full items-baseline">
        {hasCallsign && <span className="shrink-0">{label.callsign}</span>}
        {hasCallsign && hasTask && <span className="shrink-0 text-faint"> · </span>}
        {hasTask ? (
          <span className="min-w-0 truncate">{label.task}</span>
        ) : !hasCallsign ? (
          <span className="mono min-w-0 truncate">{label.text}</span>
        ) : null}
      </span>
      <span className="sr-only">{label.full}</span>
    </span>
  );
}
