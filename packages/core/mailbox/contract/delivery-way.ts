import { defineHook } from '@ferretry/kernel/contract';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import { z } from 'zod';

/**
 * One way a message reaches a ferret's agent. The Mailbox decides WHEN and HOW a message goes; a delivery way is the
 * hand that does it: it opens the seam for ONE ferret, or answers `undefined` when that ferret is not one it can reach.
 * `Facade` is the way's own seam (Ferrets' pane way opens its `FerretHarness`); the Mailbox chooses between ways and
 * never reads a way's insides.
 *
 * Opening is also the access check: a way refuses a `caller` ferret that may not touch `ferret` (it throws a 403), so who
 * may type into a pane stays decided where the pane is.
 */
export interface DeliveryWay<Facade = unknown> {
  readonly open: (ferret: FerretId, caller?: FerretId) => Promise<Facade | undefined>;
}

const isDeliveryWay = (value: unknown): value is DeliveryWay =>
  typeof value === 'object' && value !== null && typeof (value as { open?: unknown }).open === 'function';

/**
 * `mailbox.delivery-way`: the Mailbox's slot for delivery ways. A plugin contributes one by id (Ferrets contributes
 * `pane`, the ferret's terminal; a harness plugin adds its own protocol way beside it), and the Mailbox chooses.
 */
export const DeliveryWays = defineHook('mailbox.delivery-way', {
  mode: 'contribute',
  item: z.custom<DeliveryWay>(isDeliveryWay, 'a delivery way has an open(ferret, caller) function'),
});
