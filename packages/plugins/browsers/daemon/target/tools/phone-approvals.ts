/**
 * `browser_request_input push:true` ("Approve on your phone"): Browsers names the page and nothing else. The Vault's
 * `raisePhoneApproval` hands the raise to Accounts, which owns the approval, the number's three gates and the card; so
 * what a ferret learns here is the approval's id and that it should wait, and never a number, a host or an account.
 * With the Vault not offering the raise, the refusal is its one fixed sentence (fail closed).
 */
import type { VaultApi } from '@ferretry/core-vault/contract';
import { PHONE_APPROVAL_UNAVAILABLE } from '@ferretry/core-vault/contract';
import type { PageApprovals } from './index.ts';

export class VaultPageApprovals implements PageApprovals {
  constructor(private readonly vault: () => Pick<VaultApi, 'raisePhoneApproval'>) {}

  async raise(...[caller, page, push]: Parameters<PageApprovals['raise']>): ReturnType<PageApprovals['raise']> {
    const raise = this.vault().raisePhoneApproval;
    if (raise === undefined) return { ok: false, message: PHONE_APPROVAL_UNAVAILABLE };
    // The page is named by the name the ferret gave it (the Vault looks it up under that name), never by an element.
    const key = page.name ?? push.name;
    const raised = await raise(caller.ferret, {
      target: { kind: 'browser', key },
      ...(push.secretHint === undefined ? {} : { secretHint: push.secretHint }),
      ...(push.factor === undefined ? {} : { factor: push.factor }),
      ...(push.waitSeconds === undefined ? {} : { waitSeconds: push.waitSeconds }),
    });
    if (!raised.ok) return { ok: false, message: raised.error };
    const { id } = raised.value;
    return {
      ok: true,
      summary: `Asked the owner to approve the sign-in on their phone (${id}) for %browser:${key}. Wait with input_wait on ${id}; never tell the owner a number.`,
    };
  }
}
