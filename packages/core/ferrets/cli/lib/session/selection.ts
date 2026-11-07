import type { FerretSummary } from '../../../contract/index.ts';
import { TERMINAL_STATUSES } from './display.ts';

export interface SessionFilter {
  /** Include stopped ferrets as well as live ones. */
  readonly all?: boolean;
  /** Only ferrets in this pack. */
  readonly pack?: string;
}

export interface SessionSelection<View extends FerretSummary = FerretSummary> {
  readonly sessions: readonly View[];
  /** What to say when the selection is empty — states which filter emptied it. */
  readonly emptyMessage?: string;
}

/**
 * Applies the `ps` filters and explains an empty result. "Running" means "not stopped", the same semantic the fleet
 * counts use, so a ferret that is idle still shows without `--all`.
 */
export function selectSessions<View extends FerretSummary>(
  views: readonly View[],
  filter: SessionFilter = {},
): SessionSelection<View> {
  const packed = filter.pack === undefined ? views : views.filter(view => view.pack === filter.pack);
  const sessions = filter.all === true ? packed : packed.filter(view => !TERMINAL_STATUSES.includes(view.state));
  if (sessions.length > 0) return { sessions };
  if (filter.pack !== undefined && packed.length === 0)
    return { sessions, emptyMessage: `no ferrets in pack "${filter.pack}"` };
  if (packed.length > 0) return { sessions, emptyMessage: 'no running ferrets (use -a to show stopped ones)' };
  return { sessions, emptyMessage: 'no ferrets' };
}
