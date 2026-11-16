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
