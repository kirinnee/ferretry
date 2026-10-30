import { type QueuedMessage, SessionQueueSchema } from '@ferretry/protocol';
import type { IQueueGateway, QueueApiClient } from './ports.ts';

/** The route that reads one session's durable queue. A ferret's name is an address the daemon resolves. */
export function queuePath(ferret: string): string {
  return `/v1/sessions/${encodeURIComponent(ferret)}/queue`;
}

/** Reads the queue route through the protocol client, parsed. */
export class ProtocolQueueGateway implements IQueueGateway {
  constructor(private readonly client: QueueApiClient) {}

  async messages(ferret: string): Promise<readonly QueuedMessage[]> {
    return (await this.client.request(queuePath(ferret), SessionQueueSchema)).messages;
  }
}
