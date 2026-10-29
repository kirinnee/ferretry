/**
 * THE ONE PILL THAT SAYS WHERE AN AGENDA ITEM STANDS — "Blocking now", "Needs you", "Will block: the deploy",
 * "Needed by 17:00", "With Johnnie" — drawn the same on the row, the full card and the Inbox. The words come
 * from `agendaStatus`; a tone only colours the pill, so nothing rests on colour alone.
 */

import type { AgendaStatus } from '../../lib/agenda-status.ts';

export function AgendaStatusPill({ status }: { readonly status: AgendaStatus }) {
  return (
    <span
      className="fy-agenda-pill"
      data-agenda-status=""
      data-overdue={status.overdue || undefined}
      data-tone={status.tone}
    >
      {status.label}
      {status.overdue ? <span className="sr-only"> (overdue)</span> : null}
      {status.deadline === null ? null : <span className="fy-agenda-pill__when"> · {status.deadline}</span>}
    </span>
  );
}
