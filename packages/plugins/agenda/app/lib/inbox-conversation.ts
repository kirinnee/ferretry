/**
 * WHAT THE INBOX READS OF A CARD'S CONVERSATION: the chat rows that name the open ask, for its History. The card may be
 * another machine's (the Inbox lists every machine), so the read goes through the client of the CARD's machine: the page's
 * own for its machine, the fleet's for any other. A card with no client to reach, or the machine agenda's (no ferret, so
 * no conversation), reads nothing: History then shows the words stored on the item, as it does when no host reads.
 */

import { isMachineAgendaId } from '@ferretry/core-asks/contract';
import type { AgendaCall } from './agenda-call.ts';
import type { AgendaFleet } from './agenda-fleet.ts';
import type { InboxCard } from './agenda-inbox.ts';
import { conversationClientOf, itemSince, readItemConversation } from './item-conversation.ts';
import type { DaemonId } from './machine.ts';
import type { TranscriptEntry } from './transcript.ts';

export const inboxConversationReader =
  (page: { readonly daemon: DaemonId; readonly client: AgendaCall }, fleet?: AgendaFleet) =>
  async (card: InboxCard): Promise<readonly TranscriptEntry[]> => {
    const sessionId = card.view.config.id;
    if (isMachineAgendaId(sessionId)) return [];
    const client = card.daemonId === page.daemon ? page.client : fleet?.clientOf(card.daemonId);
    if (client === undefined) return [];
    return readItemConversation(conversationClientOf(client), sessionId, card.item.id, itemSince(card.item));
  };
