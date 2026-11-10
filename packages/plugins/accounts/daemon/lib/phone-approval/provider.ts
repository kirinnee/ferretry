import type { FerretId } from '@ferretry/kernel/contract';
import type { PhoneApprovalAgentView, PhoneApprovalAsk, PhoneApprovalProvider } from '@ferretry/core-vault/contract';
import { err, ok, type Result } from '@ferretry/std';
import { PhoneApprovalRaiseSchema } from '../../../contract/routes/index.ts';
import { PhoneApprovalError } from './errors.ts';
import type { PhoneApprovalService } from './service.ts';

/** The one sentence a raise that cannot be read is refused with. It repeats nothing of the input. */
export const PHONE_APPROVAL_BAD_RAISE =
  'a phone approval names the page or terminal, and at most which account and push key; nothing else';

/**
 * What Accounts PROVIDES under the Vault's `input.phone-approval` hook (`PhoneApprovalProvider`): the ferret's
 * `push: true` raise and its `input_wait` on a `pa_` id, handed to the approval service. The ferret is the caller's
 * credential (the Vault takes it from the call, never from a body), the raise is parsed again with Accounts' own
 * strict contract (an input it cannot parse fails closed), and a refusal comes back as the sentence the ferret reads.
 */
export class PhoneApprovalHook implements PhoneApprovalProvider {
  constructor(private readonly service: PhoneApprovalService) {}

  async raise(ferret: FerretId, ask: PhoneApprovalAsk): Promise<Result<PhoneApprovalAgentView, string>> {
    const raise = PhoneApprovalRaiseSchema.safeParse(ask);
    if (!raise.success) return err(PHONE_APPROVAL_BAD_RAISE);
    return await this.answered(async () => await this.service.raise(ferret, ferret, raise.data));
  }

  async agentView(ferret: FerretId, id: string, waitMs: number): Promise<Result<PhoneApprovalAgentView, string>> {
    return await this.answered(async () => await this.service.agentView(ferret, id, waitMs));
  }

  private async answered(work: () => Promise<PhoneApprovalAgentView>): Promise<Result<PhoneApprovalAgentView, string>> {
    try {
      return ok(await work());
    } catch (error) {
      if (error instanceof PhoneApprovalError) return err(error.message);
      throw error;
    }
  }
}
