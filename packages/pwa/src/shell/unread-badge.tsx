/**
 * THE UNREAD COUNT: a filled accent pill with a white number, the way Telegram and WhatsApp mark a chat
 * you have not answered. It is the one place the list says "a ferret filed something for you", so it is
 * drawn by one component wherever a row, a card, a rail dot or the Inbox entry carries it.
 *
 * The number is capped at "99+" (`badgeText`) so it never widens a row. The pill itself is decoration;
 * what a screen reader hears is "3 open Inbox items", in the row's own accessible name. A host whose
 * link already names the count (the rail's dot) passes `announce={false}` so it is not read twice. Its
 * styles live in `sessions-bar.css`, which every surface that draws it already loads.
 */

import { badgeText } from '../lib/attention-inbox.ts';
import { cn } from '../lib/class-names.ts';
import { attentionWords } from './sessions-bar-model.ts';

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
      {announce ? <span className="sr-only">{attentionWords(count)}</span> : null}
    </span>
  );
}
