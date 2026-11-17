import type { FerretHarness } from '../../../contract/port.ts';
import type { BackstopPorts } from './jobs-handover.ts';

/** The one thing the binding needs of the monitor's send: deliver the text, or queue it when the pane is busy. */
export interface BackstopSend {
  send(request: { readonly id: string; readonly sendId: string; readonly message: string }): Promise<void>;
}

/**
 * Binds the completion backstop's `askAgent` to the send Ferrets already owns for the monitor's wakes (it types the message
 * when the pane is idle, and queues it under the job's own id when the pane is busy).
 *
 * A ferret that is not held right now (stopped, between runs) cannot be told: that is `'not-held'`, a quiet skip that marks
 * NOTHING told, so the next pass tries again once it is back, without a warning every pass. Any other failure (a dialog on
 * the pane, a draft in the composer) throws and is logged by the pass. THIS IS NOT the move's `askAgent`: binding that one
 * would also switch on the ask-to-stop-jobs route.
 */
export function bindBackstopAsk(
  harness: (ferret: string) => Promise<FerretHarness | undefined>,
  send: BackstopSend,
): BackstopPorts['askAgent'] {
  return async (ferret, message) => {
    if ((await harness(ferret)) === undefined) return 'not-held';
    await send.send({ id: ferret, sendId: message.id, message: message.text });
    return true;
  };
}
