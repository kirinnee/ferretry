import type { ReopenDelivery, ReopenMessenger } from '../../lib/board/index.ts';
import type { SessionSendService } from '../../lib/session/send/service.ts';
import { SendUnconfirmed } from '../../lib/session/send/types.ts';
import { tryParseSessionId } from '../../lib/session-id.ts';

/**
 * A reopen's line through the ORDINARY send path, as an owner message (no `from`): the send service types
 * it into a live ferret or queues it behind its turn, revives a stopped or finished one with it as its
 * turn, and holds it for an explicit revive when the relaunch is refused. Its disposition is read back as
 * which of those happened, so the ladder knows whether to try the card's owner too.
 */
export class SendReopenMessenger implements ReopenMessenger {
  constructor(private readonly sends: Pick<SessionSendService, 'send'>) {}

  async deliver(sessionId: string, message: string, key: string): Promise<ReopenDelivery> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return 'absent';
    try {
      const outcome = await this.sends.send({ id, sendId: key, message });
      if (outcome.disposition === 'revived') return 'resumed';
      if (outcome.disposition === 'queued-for-revive') return 'held';
      return 'delivered';
    } catch (error) {
      // Typed, and not yet proven to have landed: its receipt decides, and nothing would type it twice.
      if (error instanceof SendUnconfirmed) return 'delivered';
      return 'absent';
    }
  }
}
