import type { IFyApiClient, QueuedMessage } from '@ferretry/protocol';

/** Presentation port for `fy queue`: one line at a time; failures travel as thrown errors. */
export interface IQueueOutput {
  report(message: string): void;
}

/** The daemon calls `fy queue` needs; the command never sees a URL or a status code. */
export interface IQueueGateway {
  /** Every message the ferret's durable queue holds, oldest first. */
  messages(ferret: string): Promise<readonly QueuedMessage[]>;
  /** New words for a message that is still waiting. */
  edit(ferret: string, messageId: string, text: string): Promise<QueuedMessage>;
  /** Takes back a message that is still waiting. */
  cancel(ferret: string, messageId: string): Promise<QueuedMessage>;
}

/** The only client capability the queue gateway consumes. */
export type QueueApiClient = Pick<IFyApiClient, 'request'>;
