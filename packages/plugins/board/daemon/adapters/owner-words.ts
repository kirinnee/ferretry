import { FerretIdSchema } from '@ferretry/core-ferrets/contract';
import type { ConversationApi } from '@ferretry/plugin-conversation/contract';
import type { OwnerWords } from '../lib/board/index.ts';

/**
 * What the owner said to a ferret, as Conversation records it (the queue, the send ledger and who wrote each turn):
 * Board's reading of whether a card's ask is the owner's (`OwnerWords`). Read late (`current`), so Conversation turned on
 * or off is followed without a restart.
 *
 * BEST EFFORT answers with what could be read, and with nobody speaking when Conversation is off or refuses. A STRICT
 * read, the one a ferret's choice to hide a card needs, is refused in words when Conversation is off, refuses, or cannot
 * read a record: "nothing could be read" is never taken for "the owner said nothing" (F-0001).
 */
export class ConversationOwnerWords implements OwnerWords {
  constructor(private readonly conversation: () => Pick<ConversationApi, 'ownerWords'> | undefined) {}

  async said(ferret: string, options: { readonly strict?: boolean } = {}): Promise<readonly string[]> {
    const strict = options.strict === true;
    const conversation = this.conversation();
    if (conversation === undefined) {
      if (strict) throw new Error('Conversation is off, so what the owner said cannot be read');
      return [];
    }
    const id = FerretIdSchema.safeParse(ferret);
    if (!id.success) {
      if (strict) throw new Error(`${ferret} is not a ferret id`);
      return [];
    }
    const read = await conversation.ownerWords(id.data, { strict });
    if (read.ok) return read.value.words;
    if (strict) throw new Error(read.error.message);
    return [];
  }
}
