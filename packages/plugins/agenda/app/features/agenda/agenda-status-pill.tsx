/**
 * THE ONE MARK THAT SAYS WHERE AN AGENDA ITEM STANDS — "Blocking now", "Needs you", "Will block: the deploy",
 * "Needed by 17:00", "With Johnnie" — drawn the same on the row, the full card and the Inbox: a small coloured dot
 * and the words in the ink colour, no box. The words come from `agendaStatus`; the dot only colours them, so
 * nothing rests on colour alone.
 */

import type { AgendaStatus } from '../../lib/agenda-status.ts';

export function AgendaStatusPill({
  status,
  plainNeedsYou = true,
}: {
  readonly status: AgendaStatus;
  /** Draw a plain "Needs you" too. Off where a heading or the row itself already says it (the rows, the Inbox). */
  readonly plainNeedsYou?: boolean;
}) {
  if (!plainNeedsYou && status.tone === 'needs-you') return null;
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
