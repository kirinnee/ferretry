import { describe, it } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import should from 'should';
import { PHONE_APPROVAL_BAD_RAISE, PhoneApprovalHook } from '../../../../daemon/lib/phone-approval/provider.ts';
import { FERRET, OTHER_FERRET, phoneWorld } from './world.ts';

/** What Accounts provides to the Vault: a ferret's `push: true` raise and its `input_wait` on a `pa_` id. */

const ferret = (name: string): FerretId => name as FerretId;

async function hooked() {
  const w = await phoneWorld({ saved: true });
  return { ...w, hook: new PhoneApprovalHook(w.service) };
}

describe('the approval service as the Vault’s provider', () => {
  it('I196 should raise for the ferret named by the call and tell it only where the approval stands', async () => {
    const w = await hooked();

    const raised = await w.hook.raise(ferret(FERRET), { target: { kind: 'browser', key: 'login' } });

    should(raised).eql({ ok: true, value: { id: 'pa_000000000000000000000001', state: 'waiting' } });
    should(w.seen('pa_000000000000000000000001').sessionId).equal(FERRET);
    should(w.cards).have.length(1);
  });

  it('I196 should refuse a raise it cannot parse in one fixed sentence that repeats none of it', async () => {
    const w = await hooked();

    for (const bad of [
      { target: { kind: 'browser', key: 'login' }, prompt: 'Approve the sign-in for the owner' },
      { target: { kind: 'browser', key: 'login' }, number: '42' },
      { target: { kind: 'browser', key: 'login' }, waitSeconds: 5 },
      { target: { kind: 'sheet', key: 'login' } },
      { target: { kind: 'browser', key: 'login' }, secretHint: 'not a hint!' },
    ]) {
      const refused = await w.hook.raise(ferret(FERRET), bad as never);

      should(refused).eql({ ok: false, error: PHONE_APPROVAL_BAD_RAISE });
    }
    should(w.cards).have.length(0);
  });

  it('should hand the service’s own refusal to the ferret as a sentence, never as a throw', async () => {
    const w = await hooked();
    w.state.page = undefined;

    const refused = await w.hook.raise(ferret(FERRET), { target: { kind: 'browser', key: 'login' } });

    should(refused).eql({ ok: false, error: 'there is no page named login in this session' });
  });

  it('should answer a ferret’s wait only for the approval that ferret raised', async () => {
    const w = await hooked();
    await w.hook.raise(ferret(FERRET), { target: { kind: 'browser', key: 'login' } });

    const own = await w.hook.agentView(ferret(FERRET), 'pa_000000000000000000000001', 0);
    const other = await w.hook.agentView(ferret(OTHER_FERRET), 'pa_000000000000000000000001', 0);

    should(own).eql({ ok: true, value: { id: 'pa_000000000000000000000001', state: 'waiting' } });
    should(other).eql({ ok: false, error: 'no phone approval pa_000000000000000000000001 in this session' });
  });

  it('should let a bug through rather than word it as a refusal', async () => {
    const w = await hooked();
    const broken = new PhoneApprovalHook({
      raise: async () => {
        throw new Error('a genuine bug');
      },
    } as never);

    const thrown = await broken.raise(ferret(FERRET), { target: { kind: 'browser', key: 'login' } }).then(
      () => undefined,
      (error: unknown) => error,
    );

    should((thrown as Error).message).equal('a genuine bug');
    should(w.cards).have.length(0);
  });
});
