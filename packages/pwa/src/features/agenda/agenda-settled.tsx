/**
 * WHERE AN ITEM STANDS WHEN IT CANNOT BE ANSWERED HERE — drawn in the item view's place for the quick replies.
 *
 * Every proved `!A5` opens the same item view (`agenda-item-view.tsx`), whatever state the item is in. An open item
 * gets its quick replies; the two states that cannot be answered get this line instead:
 *
 * - PARKED (#1043): the owner snoozed it, or replied and the ferret has not picked it up yet. The line says which, and
 *   "Back to my list" brings it back (`unsnooze`, which serves both, gated by the machine's `agenda.snooze.1`).
 * - RESOLVED: read-only. How it ended, who ended it and when — the same words the Inbox's Resolved filter uses.
 */

import type { AgendaItem, ResolvedAgendaItem } from '@ferretry/protocol';
import { CheckCheck, Clock } from 'lucide-react';
import { parkedWords } from '../../lib/agenda-status.ts';
import { describeResponse, resolutionBadge } from './agenda-board.tsx';
import { resolvedWhen } from './agenda-resolved.tsx';

/** A resolved record, told apart from an open item by its resolution. */
export const isResolved = (item: AgendaItem | ResolvedAgendaItem): item is ResolvedAgendaItem =>
  'resolvedAt' in item && typeof item.resolvedAt === 'string';

/** "Done by you · Oct 23, 8:54 AM": how it ended, in sentence case. */
const resolutionWords = (record: ResolvedAgendaItem, timeZone?: string): string => {
  const label = resolutionBadge(record).label;
  return `${label.charAt(0).toLocaleUpperCase()}${label.slice(1)} · ${resolvedWhen(record.resolvedAt, timeZone)}`;
};

export interface AgendaSettledProps {
  readonly item: AgendaItem | ResolvedAgendaItem;
  readonly ferret: string;
  readonly busy: boolean;
  readonly error: string | null;
  /** Bring a parked item back to the owner's list; absent: nothing can be sent from here. */
  readonly onBringBack?: () => void;
  readonly now?: number;
  readonly timeZone?: string;
}

export function AgendaSettled({ item, ferret, busy, error, onBringBack, now, timeZone }: AgendaSettledProps) {
  if (isResolved(item)) {
    return (
      <div className="fy-qr fy-settled" data-agenda-settled="resolved">
        <p className="fy-settled__line" role="status">
          <CheckCheck aria-hidden="true" size={15} />
          <span>{resolutionWords(item, timeZone)}</span>
        </p>
        {item.response === undefined ? null : (
          <p className="fy-settled__detail" data-agenda-settled-answer="">
            {describeResponse(item.response)}
          </p>
        )}
        {item.resolutionNote ? (
          <p className="fy-settled__detail" data-agenda-settled-note="">
            {item.resolutionNote}
          </p>
        ) : null}
      </div>
    );
  }
  if (item.parked === undefined) return null;
  return (
    <div className="fy-qr fy-settled" data-agenda-settled={item.parked.reason}>
      {error === null ? null : (
        <p className="fy-qr__error m-0" role="alert">
          {error}
        </p>
      )}
      <div className="fy-settled__row">
        <p className="fy-settled__line" role="status">
          <Clock aria-hidden="true" size={15} />
          <span>{parkedWords(item, ferret, now)}</span>
        </p>
        {onBringBack === undefined ? null : (
          <button
            className="kt-btn fy-settled__back"
            data-agenda-bring-back=""
            disabled={busy}
            onClick={onBringBack}
            type="button"
          >
            Back to my list
          </button>
        )}
      </div>
    </div>
  );
}
