import type { FerretId } from '../../../../contract/index.ts';
import type { WakeDelivery } from '../../../../contract/hooks/ferret-wake.hook.ts';
import type { SessionSendService } from '../../../lib/session/peers/send.ts';

/**
 * A wake goes through the Mailbox when one is provided: the wake is a queued message, so it is on disk before the answer,
 * retried while the pane is not ready, and visible on the queue screen. The Mailbox may be built after Ferrets, so the
 * provider is read on EVERY send and never cached.
 *
 * With no Mailbox (`'unavailable'`: a daemon composed without one) the wake goes through `fallback`, today's harness
 * seam (`FerretMonitorSend`), so a ferret is still woken. A refusal from the Mailbox is NOT then sent through the
 * fallback: the Mailbox answered, so a second route would double the wake. It throws, and the tick records it against
 * the session as it does any failed wake.
 */
export class MailboxMonitorSend implements Pick<SessionSendService, 'send'> {
  constructor(
    private readonly provider: () => WakeDelivery | 'unavailable',
    private readonly fallback: Pick<SessionSendService, 'send'>,
  ) {}

  async send(request: Parameters<SessionSendService['send']>[0]): Promise<void> {
    const mailbox = this.provider();
    if (mailbox === 'unavailable') {
      await this.fallback.send(request);
      return;
    }
    const receipt = await mailbox.wake(request.id as unknown as FerretId, {
      key: request.sendId,
      text: request.message,
    });
    if (receipt.kind === 'refused') throw new Error(`the wake was not accepted: ${receipt.reason}`);
  }
}
