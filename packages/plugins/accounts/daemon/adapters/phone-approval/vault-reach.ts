import type { FerretId } from '@ferretry/kernel/contract';
import { PHONE_APPROVAL_UNAVAILABLE, type VaultApi } from '@ferretry/core-vault/contract';
import { PhoneApprovalError } from '../../lib/phone-approval/errors.ts';
import type {
  PhoneApprovalObserver,
  PhoneApprovalPagePort,
  PhoneApprovalTerminalPort,
} from '../../lib/phone-approval/ports.ts';

type Looks = Pick<VaultApi, 'pushNumber' | 'observeTerminal' | 'tainted'>;

/**
 * WHAT AN APPROVAL LOOKS AT, through the Vault port (the page's push number, the terminal's prompt, and whether the
 * ferret could have steered either). The Vault hands these to Accounts alone and offers each only while it can answer
 * it; a member that is ABSENT fails the approval closed: a raise says so in one fixed sentence, and the question
 * whether a ferret steered a surface is answered "yes", so no number is shown and no fact is kept.
 */
export class VaultPhoneLooks implements PhoneApprovalPagePort, PhoneApprovalTerminalPort, PhoneApprovalObserver {
  constructor(private readonly vault: () => Looks) {}

  async look(ferret: string, key: string) {
    const page = this.vault().pushNumber;
    if (page === undefined) throw new PhoneApprovalError('unavailable', PHONE_APPROVAL_UNAVAILABLE);
    return await page(ferret as FerretId, key);
  }

  async observe(ferret: string, key: string) {
    const terminal = this.vault().observeTerminal;
    if (terminal === undefined) throw new PhoneApprovalError('unavailable', PHONE_APPROVAL_UNAVAILABLE);
    return await terminal(ferret as FerretId, key);
  }

  tainted(ferret: string, kind: 'browser' | 'terminal', since: number): boolean {
    return this.vault().tainted?.(ferret as FerretId, kind, since) ?? true;
  }
}
