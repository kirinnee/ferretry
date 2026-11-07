/**
 * WHERE THE OPEN ASK'S CONVERSATION GOES: the `agenda.conversation` slot this half offers (contract/slots.ts, lead
 * decision Q9), mounted where today's ask page drew the ferret's transcript and composer. Conversation contributes
 * the panel; until it does, or on a machine without it, the slot is simply empty and the ask is answered with its own
 * buttons.
 */

import { AGENDA_CONVERSATION_SLOT, type AgendaConversationSlotProps } from '../../../contract/slots.ts';
import { PanelSlot } from '../../shell.ts';

export function AgendaConversationSlot({
  daemon,
  ferret,
  ask,
}: {
  readonly daemon: string;
} & AgendaConversationSlotProps) {
  const props: AgendaConversationSlotProps = { ferret, ask };
  return <PanelSlot daemon={daemon} props={{ ...props }} slot={AGENDA_CONVERSATION_SLOT} subject={ferret} />;
}
