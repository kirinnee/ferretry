import type { FerretHarness, FerretsApi } from '@ferretry/core-ferrets/contract';
import type { Contribution } from '@ferretry/kernel/contract';
import type { DeliveryWay } from '../../contract/index.ts';

/** The id the ferret's terminal is contributed under in the `mailbox.delivery-way` slot. */
export const PANE_WAY = 'pane';

/**
 * The terminal way: the pane side of message delivery (deliver, queue, interrupt, the composer and question acts, the
 * transcript), through `FerretsApi.harness`. Ferrets keeps the pane, the runner and the "may this caller touch this
 * ferret" rule (`harness()` refuses a ferret caller that is neither the target nor its lead or helper with a 403); this
 * way only hands that seam to the Mailbox. With Ferrets' harness seam unbound it answers no ferret.
 */
export function paneWay(ferrets: Pick<FerretsApi, 'harness'>): DeliveryWay<FerretHarness> {
  return { open: async (ferret, caller) => await ferrets.harness?.(ferret, caller) };
}

/** What the Mailbox contributes to its own slot: the terminal way. A harness plugin adds its own way beside it (M3). */
export function paneWayContributions(ferrets: Pick<FerretsApi, 'harness'>): readonly Contribution<DeliveryWay>[] {
  return [{ id: PANE_WAY, item: paneWay(ferrets) }];
}
