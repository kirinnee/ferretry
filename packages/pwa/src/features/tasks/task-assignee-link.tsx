/**
 * Who is on this task, and is that still true?
 *
 * Ported from kteam `ui/src/components/TaskAssigneeLink.tsx`.
 *
 * MULTI-DAEMON FIX. kteam built the assignee's destination as
 * `/session/<id>` from the session id alone (survey `pwa-shape.md` §4, "task/DAG
 * assignee … deep-link to /session/:id"). The same session id can exist on two
 * paired daemons, so that link would silently open the WRONG daemon's session.
 * The daemon is now a required prop and the path comes from
 * `daemonSessionPath`, which cannot be built without one.
 */

import type { DaemonId } from '../../lib/daemon-connection.ts';
import { daemonSessionPath } from '../../lib/pages/routes.ts';
import { cn } from '../../lib/class-names.ts';
import { RouteLink } from '../../shell/route-link.tsx';
import { type TaskAssigneeSource, taskAssigneePresentation } from './task-presentation.ts';

/**
 * The original liveness encoding, lifted intact. `animate-pulse` is paired with
 * `motion-reduce:animate-none` because a permanently breathing dot is a
 * vestibular trigger, not a status.
 */
export function TaskLivenessDot({ task }: { readonly task: TaskAssigneeSource }) {
  const tone = task.live.staleness ? 'bg-warn' : task.live.assigneeHealth === 'active' ? 'bg-ok' : 'bg-muted';
  return (
    <span
      aria-hidden="true"
      className={cn(
        'h-2 w-2 shrink-0 rounded-full',
        tone,
        task.live.staleness && 'animate-pulse motion-reduce:animate-none',
      )}
    />
  );
}

export interface TaskAssigneeLinkProps {
  readonly daemonId: DaemonId;
  readonly task: TaskAssigneeSource;
  readonly className?: string;
  /** Compact cards can show just dot + name; detail surfaces keep the state. */
  readonly showStatus?: boolean;
  readonly onNavigate?: (to: string) => void;
}

export function TaskAssigneeLink({ daemonId, task, className, showStatus = true, onNavigate }: TaskAssigneeLinkProps) {
  const identity = taskAssigneePresentation(task);
  const href = identity.sessionId === null ? null : daemonSessionPath(daemonId, identity.sessionId);
  return (
    <span
      data-task-assignee={identity.sessionId ?? (identity.assigned ? 'unresolved' : 'unassigned')}
      // `text-xs` is the Tailwind default 0.75rem here, exactly as in kteam:
      // the role ramp in tailwind.config.ts defines `2xs`/`meta`/… and never an
      // `xs`, so this class resolves identically in both codebases.
      className={cn('flex min-w-0 items-center gap-1 text-xs text-muted', className)}
      title={identity.sessionId ? `${identity.label}\nSession ${identity.sessionId}` : identity.label}
    >
      <TaskLivenessDot task={task} />
      {href !== null ? (
        <RouteLink
          to={href}
          onNavigate={onNavigate}
          aria-label={`Open ${identity.name}'s session`}
          className="min-w-0 truncate font-semibold text-accent hover:underline"
        >
          {identity.name}
        </RouteLink>
      ) : (
        <span className="min-w-0 truncate font-semibold text-fg-soft">{identity.name}</span>
      )}
      {showStatus && identity.status !== null && (
        <>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate">{identity.status}</span>
        </>
      )}
    </span>
  );
}
