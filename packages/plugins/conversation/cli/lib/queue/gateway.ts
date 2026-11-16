import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  type FerretQueue,
  FerretQueueSchema,
  type QueuedMessage,
  QueuedMessageSchema,
} from '../../../contract/index.ts';
import type { QueueGateway } from './ports.ts';

/** Reads and changes the queue routes through the plugin client; replies are parsed against the contract. */
export class ClientQueueGateway implements QueueGateway {
  constructor(private readonly client: Pick<PluginClient, 'call'>) {}

  async messages(ferret: string): Promise<readonly QueuedMessage[]> {
    const answer = await this.client.call<FerretQueue>('GET /v1/ferrets/:ferretId/queue', {
      params: { ferretId: ferret },
    });
    return FerretQueueSchema.parse(answer).messages;
  }

  async edit(ferret: string, messageId: string, text: string): Promise<QueuedMessage> {
    return QueuedMessageSchema.parse(
      await this.client.call('PATCH /v1/ferrets/:ferretId/queue/:messageId', {
        params: { ferretId: ferret, messageId },
        body: { text },
      }),
    );
  }

  async cancel(ferret: string, messageId: string): Promise<QueuedMessage> {
    return QueuedMessageSchema.parse(
      await this.client.call('DELETE /v1/ferrets/:ferretId/queue/:messageId', {
        params: { ferretId: ferret, messageId },
      }),
    );
  }
}
