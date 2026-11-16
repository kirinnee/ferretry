import type { Delivery } from '@ferretry/core-ferrets/contract';
import type { HarnessPart } from './context.ts';

/** Codex takes no delivery here: Conversation owns the send path. */
export const deliverPart: HarnessPart<'deliver'> = () => {
  const refused = (id: string, reason: string): Delivery => ({ status: 'refused', id, reason });

  return {
    async deliver(_ferret, _handle, message): Promise<Delivery> {
      return refused(message.id, 'Codex messages are sent through Conversation, which owns the send path');
    },
  };
};
