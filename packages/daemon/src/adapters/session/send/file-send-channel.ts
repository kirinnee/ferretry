import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SessionId } from '../../../lib/session-id.ts';
import type { InboundMessage, OutboundMessage, SendChannel } from '../../../lib/session/send/types.ts';

/**
 * The append-only conversation logs beside each session.
 *
 * TWO FILES, ANSWERING TWO QUESTIONS. `inbox.jsonl` is what this session was told, in order, and it
 * is what a human reads to understand what an agent was working from. `outbox.jsonl` is what this
 * session ASKED to say, recorded without the attribution banner the receiver needs — a sender's own
 * log full of preambles addressed to somebody else is unreadable.
 *
 * `FileSignalArtifacts` already writes questions into the same outbox, and deliberately so: a
 * question a session asked and a message it sent are both things it said, and splitting them would
 * make the order of a conversation unrecoverable.
 *
 * Absent fields are OMITTED rather than nulled. These lines are read back by tools that treat a
 * missing `from` as "a human sent this", and a `null` there is a third state nothing was written to
 * understand.
 */
export class FileSendChannel implements SendChannel {
  constructor(private readonly sessionDirectory: (id: SessionId) => string) {}

  async recordInbound(id: SessionId, entry: InboundMessage): Promise<void> {
    await this.append(join(this.sessionDirectory(id), 'channel', 'inbox.jsonl'), {
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
    });
  }

  async recordOutbound(id: SessionId, entry: OutboundMessage): Promise<void> {
    await this.append(join(this.sessionDirectory(id), 'channel', 'outbox.jsonl'), {
      at: entry.at,
      type: 'message',
      from: entry.from,
      ...(entry.fromName === undefined ? {} : { fromName: entry.fromName }),
      to: entry.to,
      disposition: entry.disposition,
      message: entry.message,
    });
  }

  private async append(file: string, entry: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }
}
