import {
  type QueuedMessage,
  QueuedMessageSchema,
  QueueEditRequestSchema,
  SessionQueueSchema,
} from '@ferretry/protocol';
import type { IQueueGateway, QueueApiClient } from './ports.ts';

/** The route that reads one session's durable queue. A ferret's name is an address the daemon resolves. */
export function queuePath(ferret: string): string {
  return `/v1/sessions/${encodeURIComponent(ferret)}/queue`;
}

/** One message in that queue. */
function messagePath(ferret: string, messageId: string): string {
  return `${queuePath(ferret)}/${encodeURIComponent(messageId)}`;
}

/** Reads and changes the queue routes through the protocol client; requests and replies are both parsed. */
export class ProtocolQueueGateway implements IQueueGateway {
  constructor(private readonly client: QueueApiClient) {}

  async messages(ferret: string): Promise<readonly QueuedMessage[]> {
    return (await this.client.request(queuePath(ferret), SessionQueueSchema)).messages;
  }

  async edit(ferret: string, messageId: string, text: string): Promise<QueuedMessage> {
    return await this.client.request(messagePath(ferret, messageId), QueuedMessageSchema, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(QueueEditRequestSchema.parse({ text })),
    });
  }

  async cancel(ferret: string, messageId: string): Promise<QueuedMessage> {
    return await this.client.request(messagePath(ferret, messageId), QueuedMessageSchema, { method: 'DELETE' });
  }
}
