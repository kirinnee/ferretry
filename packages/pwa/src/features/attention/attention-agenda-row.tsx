/**
 * ONE ROW OF A FERRET'S AGENDA, in the drawer above the composer (and the docked panel on a wide screen): the
 * item's title, a status pill (whose turn, what it blocks), its quick option chips and "＋ reply", which adds a
 * removable "re: <title>" chip to the composer. Tapping the title opens the item's full card. A ferret's-turn row
 * is dimmed.
 *
 * CONTRACT STUB — Unit B fills it in; the signature is what the chat builds against.
 */

import type { AttentionItem } from '@ferretry/protocol';
import type { InboxAction } from '../../lib/attention-answers.ts';

export interface AttentionAgendaRowProps {
  readonly item: AttentionItem;
  /** The ferret's name, for "with Johnnie" on a ferret's-turn row. */
  readonly ferret: string;
  readonly now?: number;
  /** An answer for it is on its way. */
  readonly busy?: boolean;
  /** Already referenced by the composer (its "re:" chip is there). */
  readonly referenced: boolean;
  /** A quick option chip: the host attaches the composer's text (`withComposerNote`) and sends it. */
  readonly onAct: (action: InboxAction) => void;
  /** "＋ reply": add this item's "re:" chip to the composer. */
  readonly onAddReply: () => void;
  /** The title: open the item's full card (the drawer closes). */
  readonly onOpen: () => void;
}

export function AttentionAgendaRow({ item, onOpen }: AttentionAgendaRowProps) {
  return (
    <button data-attention-agenda-row={item.id} onClick={onOpen} type="button">
      {item.title ?? item.subject}
    </button>
  );
}
