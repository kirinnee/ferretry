import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { ConversationStageSource } from '../kinds.ts';

/** The one key `conversation.stage` is provided under: the owner's past conversations have exactly one lister. */
export const CONVERSATION_STAGE_KEY = 'conversation';

/**
 * "Continue a past conversation": a start that names a harness conversation REQUIRES that transcript. The conversations
 * of the owner's own computer are indexed by Conversation (it alone knows where one lies), so before the launch Ferrets
 * asks it to stage the transcript into the harness's shared pool (the existing copy-on-link, `Harness.importConversation`).
 * ONE named plugin provides it, so a second taker refuses the build. A refusal refuses the start with the reason. With no
 * provider nothing is staged: a transcript already in the pool is resumed, and one the harness proves absent refuses the
 * launch, so a continue never quietly becomes a fresh conversation.
 */
export const ConversationStage = defineHook('conversation.stage', {
  mode: 'provide',
  key: z.literal(CONVERSATION_STAGE_KEY),
  value: z.custom<ConversationStageSource>(),
  takers: ['conversation'],
});
