/**
 * THE "NEEDS YOU" GROUP at the top of the sessions bar: every session with open Attention, newest
 * `latestAt` first. One machine's list passes its own sessions; the all-machines list also passes the
 * parked-on-a-person ones after them, each naming its machine (nothing around a pinned row does).
 * A row appears here INSTEAD of in its project group, never in both: the same ferret twice in one column
 * reads as two ferrets.
 *
 * A ROW IS ONLY A WAY IN. It says what was asked (the "!" line) and how many (the count badge), and the
 * whole row opens the conversation at its first open item — where the item is read and answered. Nothing
 * here answers, clears or hides an item: a Done or Dismiss on a row could not say which item it meant, and
 * nobody should settle an ask without reading it.
 */

import type { SessionView } from '@ferretry/protocol';
import type { DaemonId } from '../lib/daemon-connection.ts';
import { SessionsBarRow } from './sessions-bar-row.tsx';

export interface NeedsYouRow {
  readonly daemonId: DaemonId;
  readonly view: SessionView;
  /** Names the machine on the row. Absent on a single machine's list, where the heading says it. */
  readonly machine?: string;
}

export function SessionsBarNeedsYou({
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
    <section aria-label="Needs you" className="fy-sbar__group fy-sbar__needs" data-sbar-needs-you-group="">
      <h2 className="fy-sbar__project">
        <span className="truncate">Needs you</span>
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
