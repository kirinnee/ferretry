/**
 * THE "PINNED" GROUP at the very top of the sessions bar, above Needs you: the ferrets the owner pinned,
 * in the order they pinned them. A pinned ferret is listed HERE and nowhere else in the bar, so it never
 * reads as two ferrets. Its row is the ordinary row — status, badges, and the machine's name when the list
 * spans machines — and a finished one stays, dimmed, until it is unpinned. Nothing renders when empty.
 */

import type { NeedsYouRow } from './sessions-bar-needs-you.tsx';
import { SessionsBarRow } from './sessions-bar-row.tsx';

export function SessionsBarPinned({
  rows,
  isActive,
  learns,
  onNavigate,
}: {
  readonly rows: readonly NeedsYouRow[];
  readonly isActive: (row: NeedsYouRow) => boolean;
  readonly learns: (row: NeedsYouRow) => boolean;
  readonly onNavigate: (to: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <section aria-label="Pinned" className="fy-sbar__group fy-sbar__pinned" data-sbar-pinned-group="">
      <h2 className="fy-sbar__project">
        <span className="truncate">Pinned</span>
        <span className="fy-sbar__count">{rows.length}</span>
      </h2>
      <ul>
        {rows.map(row => (
          <SessionsBarRow
            active={isActive(row)}
            daemonId={row.daemonId}
            key={`${row.daemonId}:${row.view.config.id}`}
            learningPassive={learns(row)}
            onNavigate={onNavigate}
            view={row.view}
            {...(row.machine === undefined ? {} : { machine: row.machine })}
          />
        ))}
      </ul>
    </section>
  );
}
