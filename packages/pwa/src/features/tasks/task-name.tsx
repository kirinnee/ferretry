/**
 * The rendered task name, ported from kteam's `TaskName.tsx`.
 *
 * Keep the parser in the shell: task names also feed the command palette,
 * while this component owns only the task-facing visual treatment.
 */

import { cn } from '../../lib/class-names.ts';
import { parseTaskName } from '../../shell/task-name.ts';

export interface TaskNameProps {
  readonly name?: string | null;
  readonly teammate?: string;
  readonly className?: string;
  /** Hide an already-visible teammate identity to avoid repeating it in a row. */
  readonly showPrefix?: boolean;
  /** `sm` is for dense session rows; `md` is for task boards and details. */
  readonly size?: 'sm' | 'md';
}

/**
 * A session's task, with its optional bracketed teammate prefix treated as
 * context instead of the headline. The stable prefix yields before the task,
 * and the full value remains available as the accessible hover title.
 */
export function TaskName({ name, teammate, className = '', showPrefix = true, size = 'md' }: TaskNameProps) {
  const { prefix, task } = parseTaskName(name);
  const title = [prefix ? `[${prefix}]` : null, task].filter(Boolean).join(' ');

  if (!task) {
    return (
      <span className={cn('text-faint', className)} title="this session was launched without a --name">
        —
      </span>
    );
  }

  const chipVisible = showPrefix && prefix && prefix.toLowerCase() !== (teammate ?? '').trim().toLowerCase();

  return (
    <span className={cn('inline-flex min-w-0 max-w-full items-baseline gap-sm', className)} title={title}>
      {chipVisible && (
        <span
          className={cn(
            'shrink-0 rounded-badge border border-border-soft bg-surface-3 px-xs font-medium text-muted',
            size === 'sm' ? 'text-2xs' : 'text-meta',
          )}
        >
          {prefix}
        </span>
      )}
      <span className={cn('min-w-0 truncate text-fg', size === 'sm' ? 'text-ui' : 'text-row font-medium')}>{task}</span>
    </span>
  );
}
