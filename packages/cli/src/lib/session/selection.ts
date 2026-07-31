import type { SessionView } from '@ferretry/protocol';
import { TERMINAL_STATUSES } from './display.ts';

export interface SessionFilter {
  /** Include terminal sessions (completed/failed/stalled/stopped) as well as live ones. */
  readonly all?: boolean;
  /** Only sessions started under this exact ownership label. */
  readonly label?: string;
}

export interface SessionSelection {
  readonly sessions: readonly SessionView[];
  /** What to say when the selection is empty — states which filter emptied it. */
  readonly emptyMessage?: string;
}

/**
 * Applies the `ps` filters and explains an empty result.
 *
 * "Running" means "not in a terminal status", the same semantic the fleet counts use, so a session
 * that is parked or rate-limited still shows without `--all`.
 */
export function selectSessions(views: readonly SessionView[], filter: SessionFilter = {}): SessionSelection {
  const labelled = filter.label === undefined ? views : views.filter(view => view.config.label === filter.label);
  const sessions =
    filter.all === true ? labelled : labelled.filter(view => !TERMINAL_STATUSES.includes(view.state.status));
  if (sessions.length > 0) return { sessions };
  if (filter.label !== undefined && labelled.length === 0)
    return { sessions, emptyMessage: `no sessions with label "${filter.label}"` };
  if (labelled.length > 0) return { sessions, emptyMessage: 'no running sessions (use -a to show terminal ones)' };
  return { sessions, emptyMessage: 'no sessions' };
}
