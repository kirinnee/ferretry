import type { MonitorNudge } from '../../../lib/session/monitor/types.ts';
import type { SessionSendService } from '../../../lib/session/send/service.ts';
import type { SessionId } from '../../../lib/session-id.ts';

/**
 * Telling a woken teammate that its wait is over, over the send the daemon already has.
 *
 * CLEARING THE RECORD IS NOT THE WAKE. The agent is sitting at an idle prompt with no reason to look
 * at its own state document, so a park that expires without this is a session that is running on
 * paper and doing nothing in the pane — the same silence the wait was declared into.
 *
 * IT GOES THROUGH THE SEND SLICE, not straight at tmux. Every refusal that slice makes applies to a
 * wake too: a quarantined harness, an unconfirmed kill, a composer that belongs to a structured
 * question. A wake typed past those is a keystroke into somebody else's form.
 *
 * THE KEY IS DERIVED FROM THE PARK, so a wake retried after a daemon restart is the same send and the
 * ledger recognises it — see `wakeSendId`. The daemon is the sender, so no `senderReference` is set:
 * this is not one teammate replying to another, and attributing it to a session would end that
 * session's own park.
 */
export class SendMonitorNudge implements MonitorNudge {
  constructor(private readonly sends: SessionSendService) {}

  async deliver(id: SessionId, sendId: string, message: string): Promise<void> {
    await this.sends.send({ id, sendId, message });
  }
}
