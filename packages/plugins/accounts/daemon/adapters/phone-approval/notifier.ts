import type { AsksApi } from '@ferretry/core-asks/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import type { PhoneApprovalNotifier } from '../../lib/phone-approval/ports.ts';

/** The send id of the words about one approval: one tell per approval, however often it is asked (Asks dedupes by it). */
export const phoneApprovalTellSendId = (ferret: string, approvalId: string): string =>
  `phone-approval-refused-${ferret}-${approvalId}`;

/**
 * Tells the ferret the owner said "Not me", through Asks (`AsksApi.tell`: the same delivery an owner's answer uses,
 * held and retried while the ferret's composer is busy). Total: a ferret that cannot be told is simply not told, and
 * a build whose Asks view has no `tell` tells nobody. The words are the service's own and carry no number and no
 * account.
 */
export class AsksPhoneApprovalNotifier implements PhoneApprovalNotifier {
  constructor(private readonly asks: Pick<AsksApi, 'tell'>) {}

  async tell(ferret: string, approvalId: string, message: string): Promise<void> {
    await this.asks
      .tell?.(ferret as FerretId, message, phoneApprovalTellSendId(ferret, approvalId))
      .catch(() => undefined);
  }
}
