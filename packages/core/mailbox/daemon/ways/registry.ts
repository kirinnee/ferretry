import type { Contribution } from '@ferretry/kernel/contract';
import type { DeliveryWay } from '../../contract/index.ts';

/** The delivery ways every plugin has contributed to `mailbox.delivery-way`, read at each use (a plugin turned on later counts). */
export type DeliveryWaySource = () => readonly Contribution<DeliveryWay>[];

/** The `fy doctor` answer for the slot: which ways are registered, or the cause when none is (nothing can be delivered). */
export function waysDoctor(source: DeliveryWaySource): { readonly state: 'ok' | 'fail'; readonly detail: string } {
  const ids = source().map(way => way.id);
  return ids.length === 0
    ? { state: 'fail', detail: 'no delivery way is registered with the Mailbox, so no message can reach a ferret' }
    : { state: 'ok', detail: `delivery ways: ${ids.join(', ')}` };
}
