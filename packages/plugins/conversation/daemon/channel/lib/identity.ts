import type { SendRecord } from '../../delivery/lib/types.ts';

/** What the channel tag's `from` attribute says for the daemon's own words. */
const CHANNEL_DAEMON_NAME = 'Ferretry';

/** The part of a send request that says who is speaking: a ferret (its session), the daemon's notice, or Agenda. */
interface Speaker {
  readonly senderSessionId?: string | undefined;
  readonly notice?: true;
  readonly agenda?: true;
}

/** The sender as the channel tag names it: the ferret's name (else its id), or Ferretry for the daemon; none for neither. */
export function channelSenderName(speaker: Speaker, fromName: string | undefined): string | undefined {
  if (speaker.senderSessionId !== undefined) return fromName ?? speaker.senderSessionId;
  return speaker.notice === true || speaker.agenda === true ? CHANNEL_DAEMON_NAME : undefined;
}

/**
 * Who spoke, read back off a channel send's ledger row, for typing it again as the same speaker: the row keeps the
 * sending ferret (`from`) or the daemon feature (`by.feature`), and nothing else about it.
 */
export function channelOrigin(record: Pick<SendRecord, 'from' | 'by'>): Speaker {
  if (record.from !== undefined) return { senderSessionId: record.from };
  return record.by?.feature === 'Agenda' ? { agenda: true } : { notice: true };
}
