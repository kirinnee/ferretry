import type { FerretId } from '../../../../contract/index.ts';
import type { FerretHarness, HarnessDeliveryFailure } from '../../../../contract/port.ts';
import type { SessionSendService } from '../../../lib/session/peers/send.ts';

/** Why a wake typed nothing, in the closed words the harness seam answers with. Never the screen, never the draft. */
function reason(failure: HarnessDeliveryFailure): string {
  return 'refused' in failure ? failure.refused : 'unconfirmed';
}

/**
 * A woken ferret is told its wait is over through the harness seam Ferrets already owns: one `deliver`, and when the
 * pane is visibly at work, the same text put into the pane's own queue, so the wake lands the moment the turn ends.
 *
 * THE SEND SLICE ITSELF IS CONVERSATION'S, which core cannot import, so this is the part of it a wake needs and no more:
 * every refusal the harness seam makes applies (a dialog, a held pane, a composer holding a person's own draft), and each
 * one is a thrown failure the tick records against that session instead of a keystroke typed past it. A message typed
 * that nothing proved landed (`unconfirmed`) is NEVER typed again, so it too is a failure, not a retry.
 *
 * THE KEY IS THE PARK'S, so a wake that is retried after a restart is the same queued file, not a second one.
 */
export class FerretMonitorSend implements Pick<SessionSendService, 'send'> {
  constructor(private readonly harness: (ferret: FerretId) => Promise<FerretHarness | undefined>) {}

  async send(request: Parameters<SessionSendService['send']>[0]): Promise<void> {
    const harness = await this.harness(request.id as unknown as FerretId);
    if (harness === undefined) throw new Error('the ferret is not held, so it cannot be woken');
    const delivered = await harness.deliver({ text: request.message });
    if (delivered.ok) return;
    const failure = delivered.error;
    if (!('refused' in failure) || failure.refused !== 'not_ready' || failure.why !== 'busy')
      throw new Error(`the wake was not typed: ${reason(failure)}`);
    const queued = await harness.queue(request.message, { sendId: request.sendId });
    if (!queued.ok) throw new Error(`the wake was not queued: ${reason(queued.error)}`);
  }
}
