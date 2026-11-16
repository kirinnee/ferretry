import type { SessionId } from '../../../contract/index.ts';
import type { SendMessageRequest } from './service.ts';
import type { SendFailureNotifier } from './tracker.ts';
import { sendFailureNotice, sendStuckNotice } from '../../../contract/index.ts';
import type { LedgerRecord as SendRecord } from '../../../contract/index.ts';
import type { SendRepository } from '../../../contract/index.ts';

/**
 * Hands a failed peer send back to the agent that sent it, as a message in ITS session.
 *
 * An agent has nobody to press Retry for it, and its own `send` call returned long ago — so the
 * daemon tells it, through the same send every other message takes, and leaves the decision with it.
 * The notice is keyed by the failed send's id, so a restart that re-derives the failure cannot tell
 * the agent twice; and it is sent as the DAEMON, which nothing retries and which never notifies, so a
 * notice that itself cannot be delivered ends there instead of echoing.
 */
export class AgentSendFailureNotifier implements SendFailureNotifier {
  constructor(
    private readonly sends: { send(request: SendMessageRequest): Promise<unknown> },
    private readonly repository: Pick<SendRepository, 'read' | 'resolveSender'>,
    private readonly clientName: string,
  ) {}

  async notify(sender: string, recipient: SessionId, record: SendRecord): Promise<void> {
    const from = await this.repository.resolveSender(sender);
    if (from === undefined) return;
    const to = await this.repository.read(recipient);
    await this.sends.send({
      id: from.id,
      sendId: `send-failed:${recipient}:${record.sendId}`,
      message: sendFailureNotice(to?.teammate ?? recipient, record, this.clientName),
      origin: 'daemon',
      by: { kind: 'ferretry', feature: 'Delivery' },
    });
  }

  /**
   * Tells the agent that sent `record` it is STUCK (`sendStuckNotice`), once: keyed `send-stuck:<recipient>:<send id>`,
   * so the same send is never announced twice, and sent as the daemon, which nothing retries.
   */
  async notifyStuck(sender: string, recipient: SessionId, record: SendRecord, waitedMs: number): Promise<void> {
    const from = await this.repository.resolveSender(sender);
    if (from === undefined) return;
    const to = await this.repository.read(recipient);
    await this.sends.send({
      id: from.id,
      sendId: `send-stuck:${recipient}:${record.sendId}`,
      message: sendStuckNotice(to?.teammate ?? recipient, record, waitedMs),
      origin: 'daemon',
      by: { kind: 'ferretry', feature: 'Delivery' },
    });
  }
}
