import { ASK_DELIVERY_KEY, type AskDelivery, AskNotTypedError } from '../../contract/index.ts';
import { AgendaNotTyped, type AgendaDeliveryPorts, type AgendaMessenger } from '../lib/agenda/index.ts';

/** Where the delivery is read from: the `ask.delivery:ferret` provider, or none while Conversation is off. */
export type AskDeliverySource = (key: typeof ASK_DELIVERY_KEY) => AskDelivery | 'unavailable';

/**
 * The reply batcher's messenger and delivery ports over `ask.delivery` (read at each send, so a Conversation that
 * starts later is used from then on). With no provider nothing is typed: the batch stays held in the ferret's outbox,
 * exactly as today when the composer could not take it.
 */
export function askDelivery(source: AskDeliverySource): {
  readonly messenger: AgendaMessenger;
  readonly ports: Omit<AgendaDeliveryPorts, 'undelivered'>;
} {
  const provider = (): AskDelivery | undefined => {
    const found = source(ASK_DELIVERY_KEY);
    return found === 'unavailable' ? undefined : found;
  };
  return {
    messenger: {
      send: async (ferret, message, sendId) => {
        const delivery = provider();
        if (delivery === undefined)
          throw new AgendaNotTyped('nothing can type into a ferret yet (Conversation is off)');
        try {
          await delivery.send(ferret, message, sendId);
        } catch (error) {
          if (error instanceof AskNotTypedError) throw new AgendaNotTyped(error.message);
          throw error;
        }
      },
    },
    ports: {
      composer: { state: async ferret => (await provider()?.composer?.(ferret)) ?? 'empty' },
      receipts: {
        receipt: async (ferret, sendId) => {
          const delivery = provider();
          if (delivery === undefined) return { state: 'pending' };
          return delivery.receipt === undefined ? { state: 'delivered' } : await delivery.receipt(ferret, sendId);
        },
      },
    },
  };
}
