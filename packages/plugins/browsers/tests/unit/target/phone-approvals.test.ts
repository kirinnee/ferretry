import { describe, expect, test } from 'bun:test';
import { PHONE_APPROVAL_UNAVAILABLE, type PhoneApprovalAsk } from '@ferretry/core-vault/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import { err, ok } from '@ferretry/std';
import type { PageCaller, ResolvedPage } from '../../../daemon/target/tools/index.ts';
import { VaultPageApprovals } from '../../../daemon/target/tools/phone-approvals.ts';

/** `browser_request_input push:true` as Browsers hands it to the Vault: the page's name and nothing the page shows. */

const CALLER: PageCaller = { kind: 'agent', ferret: 'f1' as FerretId, name: 'kit' };
const PAGE: ResolvedPage = { id: 'pg-1', name: 'login' };
const ID = 'pa_0123456789abcdef01234567';

describe('the page tool’s push approval', () => {
  test('raises on the page’s name alone and tells the ferret the id, never a number or a host', async () => {
    const asked: [string, PhoneApprovalAsk][] = [];
    const approvals = new VaultPageApprovals(() => ({
      raisePhoneApproval: async (ferret, ask) => {
        asked.push([ferret, ask]);
        return ok({ id: ID, state: 'waiting' });
      },
    }));

    const answer = await approvals.raise(CALLER, PAGE, {
      push: true,
      name: 'login',
      secretHint: 'OKTA_PASSWORD' as never,
      factor: 'Okta Verify',
      waitSeconds: 90,
    });

    expect(asked).toEqual([
      [
        'f1',
        {
          target: { kind: 'browser', key: 'login' },
          secretHint: 'OKTA_PASSWORD',
          factor: 'Okta Verify',
          waitSeconds: 90,
        },
      ],
    ]);
    expect(answer).toEqual({
      ok: true,
      summary: `Asked the owner to approve the sign-in on their phone (${ID}) for %browser:login. Wait with input_wait on ${ID}; never tell the owner a number.`,
    });
  });

  test('hands the Vault’s refusal on as the ferret’s answer', async () => {
    const approvals = new VaultPageApprovals(() => ({
      raisePhoneApproval: async () => err('there is no page named login in this session'),
    }));

    expect(await approvals.raise(CALLER, PAGE, { push: true, name: 'login' })).toEqual({
      ok: false,
      message: 'there is no page named login in this session',
    });
  });

  test('fails closed in one fixed sentence when the Vault does not offer the raise', async () => {
    const approvals = new VaultPageApprovals(() => ({}));

    expect(await approvals.raise(CALLER, PAGE, { push: true, name: 'login' })).toEqual({
      ok: false,
      message: PHONE_APPROVAL_UNAVAILABLE,
    });
  });
});
