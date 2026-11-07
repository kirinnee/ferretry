import { definePort } from '@ferretry/kernel/contract';
import type { FerretId } from './core.ts';

/** What other plugins may ask Conversation (grown by the port; Warden, Usage and Lessons need the token). */
export interface ConversationApi {
  /** The id of the turn a ferret is in the middle of, if any. */
  currentTurn(ferret: FerretId): Promise<string | undefined>;
}

export const ConversationPort = definePort<ConversationApi>('conversation');
