import type { StatePort } from '@ferretry/kernel/contract';
import { INBOX_STATE, OUTBOX_STATE } from '../../../contract/index.ts';
import type { SessionId } from '../../seams/ferret-id.ts';
import type { InboundMessage, OutboundMessage, SendChannel } from '../lib/types.ts';

/** What reached a ferret (`inbox.jsonl`) and what it sent (`outbox.jsonl`), one line each, in its own state files. */
export class StateSendChannel implements SendChannel {
  constructor(private readonly state: StatePort) {}

  async recordInbound(id: SessionId, entry: InboundMessage): Promise<void> {
    await this.state.append<unknown>(
      INBOX_STATE,
      {
        at: entry.at,
        type: 'message',
        message: entry.message,
        ...(entry.turn === undefined ? {} : { turn: entry.turn }),
        ...(entry.queued === undefined ? {} : { queued: entry.queued }),
        ...(entry.queueId === undefined ? {} : { queueId: entry.queueId }),
        ...(entry.queuedForRevive === undefined ? {} : { queuedForRevive: entry.queuedForRevive }),
        ...(entry.reason === undefined ? {} : { reason: entry.reason }),
        ...(entry.from === undefined ? {} : { from: entry.from }),
        ...(entry.fromName === undefined ? {} : { fromName: entry.fromName }),
      },
      id,
    );
  }

  async recordOutbound(id: SessionId, entry: OutboundMessage): Promise<void> {
    await this.state.append<unknown>(
      OUTBOX_STATE,
      {
        at: entry.at,
        type: 'message',
        from: entry.from,
        ...(entry.fromName === undefined ? {} : { fromName: entry.fromName }),
        to: entry.to,
        disposition: entry.disposition,
        message: entry.message,
      },
      id,
    );
  }
}
