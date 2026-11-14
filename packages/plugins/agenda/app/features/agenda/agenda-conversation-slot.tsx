/**
 * WHERE THE OPEN ASK'S CONVERSATION GOES: the `agenda.conversation` slot this half offers (contract/slots.ts, lead
 * decision Q9), mounted where today's ask page drew the ferret's transcript and composer. Conversation contributes
 * the panel; until it does, or on a machine without it, the slot is simply empty and the ask is answered with its own
 * buttons.
 */

import { AGENDA_CONVERSATION_SLOT, type AgendaConversationSlotProps } from '../../../contract/slots.ts';
import type { AgendaInbox } from '../../hooks/use-agenda-inbox.ts';
import type { InboxCard } from '../../lib/agenda-inbox.ts';
import { PanelSlot } from '../../shell.ts';

function AgendaConversationSlot({
  daemon,
  ferret,
  ask,
  onReplied,
  restore,
  onRestored,
}: {
  readonly daemon: string;
} & AgendaConversationSlotProps) {
  const props: AgendaConversationSlotProps = {
    ferret,
    ask,
    ...(onReplied === undefined ? {} : { onReplied }),
    ...(restore === undefined ? {} : { restore }),
    ...(onRestored === undefined ? {} : { onRestored }),
  };
  return <PanelSlot daemon={daemon} props={{ ...props }} slot={AGENDA_CONVERSATION_SLOT} subject={ferret} />;
}

/**
 * THE CONVERSATION UNDER ONE INBOX CARD: the slot above, told what the Inbox needs to hear. A message about the card that
 * the conversation accepted marks the item replied at once (`lib/agenda-replied.ts`), and the words of a reply the owner
 * took back with Undo go into the box once. The reference (`!A5`) and the item's own draft are the conversation's, from the ask.
 */
export function AgendaCardConversation({
  daemon,
  card,
  inbox,
}: {
  readonly daemon: string;
  readonly card: InboxCard;
  readonly inbox: Pick<AgendaInbox, 'replied' | 'repliedState'>;
}) {
  const restore = inbox.repliedState.restores.find(each => each.key === card.key)?.text;
  return (
    <AgendaConversationSlot
      ask={card.item.id}
      daemon={daemon}
      ferret={card.view.config.id}
      onReplied={sent => void inbox.replied.mark(card, sent)}
      onRestored={() => void inbox.replied.takeRestore(card.key)}
      {...(restore === undefined ? {} : { restore })}
    />
  );
}
