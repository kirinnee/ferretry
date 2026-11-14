/**
 * THE OPEN ASK'S CONVERSATION (`panels['agenda-conversation']`, slot `agenda.conversation`, Agenda's contract/slots.ts,
 * lead decision Q9). Agenda's ask page hands `{ ferret, ask }`; this draws that ferret's conversation and composer under
 * the ask, as today's ask page did — the conversation ALONE (`embedded`): not the ferret's toolbar or side panels
 * (terminals, browser, files, Warden…), so viewing an item opens no terminal and asks for no passkey. Conversation imports nothing of Agenda's (Agenda already uses Conversation), so the
 * two props are narrowed here.
 */

import type { PanelProps } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import { ChatScreen } from '../chat/chat-screen.tsx';
import type { AskReply } from '../chat/session-chat-page.tsx';

/**
 * What the slot's page hands its panels: the ferret whose conversation it is, and the ask open above it — and, when the
 * page keeps track of replies, what to tell it (a receipt when a message about the ask was accepted) and the words of a
 * reply it took back.
 */
export interface AgendaConversationProps {
  readonly ferret: string;
  readonly ask: string;
  readonly onReplied?: AskReply['onReplied'];
  readonly restore?: string;
  readonly onRestored?: () => void;
}

export function isAgendaConversationProps(props: unknown): props is AgendaConversationProps {
  if (typeof props !== 'object' || props === null) return false;
  const candidate = props as Record<string, unknown>;
  return typeof candidate['ferret'] === 'string' && typeof candidate['ask'] === 'string';
}

export function AgendaConversationPanel(props: PanelProps): ReactNode {
  if (!isAgendaConversationProps(props) || props.ferret.trim() === '') return null;
  const { ask, onReplied, restore, onRestored } = props;
  return (
    <ChatScreen
      ask={{
        id: ask,
        ...(typeof onReplied === 'function' ? { onReplied } : {}),
        ...(typeof restore === 'string' ? { restore } : {}),
        ...(typeof onRestored === 'function' ? { onRestored } : {}),
      }}
      embedded
      params={{ ferret: props.ferret }}
    />
  );
}
