/**
 * THE UNREAD COUNT (copied from today's `shell/unread-badge.tsx` and `AgendaCountBadge`): a filled accent pill with a
 * white number, the way a chat app marks a conversation you have not answered. It is the one place a list says "a
 * ferret filed something for you", so every Agenda place that carries the count draws it with this.
 *
 * The number is capped at "99+" (`badgeText`) so it never widens a row. The pill itself is decoration; what a screen
 * reader hears is "3 open Inbox items". A host whose link already names the count passes `announce={false}`.
 */

import { badgeText } from '../lib/agenda-inbox.ts';
import { cn } from '../shell.ts';

/** What a screen reader hears for the count. */
export const agendaWords = (count: number): string => `${count} open Inbox ${count === 1 ? 'item' : 'items'}`;

export function UnreadBadge({
  count,
  className,
  announce = true,
}: {
  readonly count: number;
  readonly className?: string;
  /** Say "N open Inbox items" to a screen reader. Off where the surrounding link's label already does. */
  readonly announce?: boolean;
}) {
  return (
    <span className={cn('fy-unread-badge', className)} data-unread-badge="" data-count={count}>
      <span aria-hidden="true">{badgeText(count)}</span>
      {announce ? <span className="sr-only">{agendaWords(count)}</span> : null}
    </span>
  );
}

/** The Inbox count on a PLACE (a tab, a heading): the unread pill, and nothing at zero — a calm place is good news. */
export function AgendaCountBadge({ count, className }: { readonly count: number; readonly className?: string }) {
  return count <= 0 ? null : <UnreadBadge count={count} {...(className === undefined ? {} : { className })} />;
}
