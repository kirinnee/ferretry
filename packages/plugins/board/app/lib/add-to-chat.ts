/**
 * "ADD TO CHAT" is Conversation's action (S15): the card's reference goes in the message box of the ferret the tab belongs
 * to, through the shared `conversation.add-to-chat` app hook. Board owns no delivery of its own; with Conversation
 * absent or paused on that machine the tab says so in words instead of doing nothing.
 */

import { useAppHook, useViewPlace } from '@ferretry/app';
import {
  CONVERSATION_ADD_TO_CHAT_HOOK,
  CONVERSATION_PROVIDED_APP_HOOKS,
  type ConversationAddToChat,
} from '@ferretry/plugin-conversation/contract';

/** Said when no Conversation can take the reference on this machine. */
export const NO_ADD_TO_CHAT = 'Adding to the chat needs Conversation on this machine.';

/** The sentence for an Add to chat of `reference` into `ferret`, from the hook's value (or its absence). */
export const addToChatMessage = (hook: unknown, ferret: string, reference: string): string => {
  if (!CONVERSATION_PROVIDED_APP_HOOKS[CONVERSATION_ADD_TO_CHAT_HOOK](hook)) return NO_ADD_TO_CHAT;
  return (hook as ConversationAddToChat).add(ferret, reference).message;
};

/** The Add to chat of the machine this view is drawn for: `(ferret, reference) → the sentence to show`. */
export function useAddToChat(): (ferret: string, reference: string) => string {
  const hook = useAppHook(useViewPlace()?.daemon, CONVERSATION_ADD_TO_CHAT_HOOK);
  return (ferret, reference) => addToChatMessage(hook, ferret, reference);
}
