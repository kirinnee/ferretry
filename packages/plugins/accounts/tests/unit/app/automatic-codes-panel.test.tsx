/** "Set up automatic codes" as the owner uses it: ticks, the one staging, the emptied field, and the passkey. */
import { afterEach, describe, expect, it } from 'bun:test';
import { AutomaticCodesPanel } from '../../../app/features/two-factor/automatic-codes.tsx';
import type { CodesAccount } from '../../../app/lib/automatic-codes.ts';
import { padInputValue, type TwoFactorStageId } from '../../../contract/routes/index.ts';
import { type Mounted, mount } from '../../support/app/dom.ts';
import { click, settle, typeInto } from '../../support/app/dom-form.ts';
import { type Call, fakeClient } from '../../support/app/fake-client.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const SEED = 'JBSWY3DPEHPK3PXP';
const STAGE = `st_${'a'.repeat(24)}`;
const AT = '2026-10-31T10:00:00.000Z';
const github: CodesAccount = {
  id: 'GITHUB',
  label: 'GitHub',
  username: 'kirinnee',
  places: [{ kind: 'site', domains: ['github.com'], match: [] }],
  seeds: 0,
};

const answers = (call: Call): unknown => {
  if (call.route === 'POST /v1/accounts/:id/factors/seed')
    return {
      stage: STAGE,
      account: 'GITHUB',
      label: 'Authenticator app',
      expiresAt: AT,
      parsed: { params: { algorithm: 'SHA1', digits: 6, period: 30 } },
    };
  if (call.route === 'POST /v1/accounts/:id/factors/seed/:stage/commit')
    return {
      account: 'GITHUB',
      factor: {
        id: 'tf_0123456789ab',
        kind: 'totp',
        label: 'Authenticator app',
        params: { algorithm: 'SHA1', digits: 6, period: 30 },
        addedAt: AT,
        addedBy: 'owner',
        automatic: true,
      },
      mismatch: false,
    };
  if (call.route === 'DELETE /v1/accounts/:id/factors/seed/:stage') return { dropped: true };
  throw new Error(`the fake daemon has no answer for ${call.route}`);
};

const panel = async (given: { addKey: (stage: TwoFactorStageId, words: string) => Promise<boolean> }) => {
  const fake = fakeClient(answers);
  const saved: string[] = [];
  const view = await mount(
    <AutomaticCodesPanel
      accounts={[github]}
      addKey={given.addKey}
      client={fake.client}
      defaultOpen
      initial={github}
      onSaved={() => saved.push('saved')}
    />,
  );
  mounted.push(view);
  await settle();
  const q = (selector: string) => view.container.querySelector<HTMLElement>(selector);
  return { q, calls: fake.calls, saved, html: () => view.container.innerHTML };
};

describe('Appendix D: the seed panel', () => {
  it('I174 should start with its ticks off and Save disabled, stage the seed once and empty the field, send no body on the commit, and save nothing on a dismissed passkey', async () => {
    const asked: string[] = [];
    // A dismissed passkey: the stage is dropped and nothing is committed.
    const refused = await panel({
      addKey: async stage => {
        asked.push(stage);
        return false;
      },
    });
    const tick = () => refused.q('[data-codes-warning-tick]') as HTMLInputElement;
    const save = () => refused.q('[data-codes-save]') as HTMLButtonElement;
    expect(tick().checked).toBe(false);
    expect(save().disabled).toBe(true);
    await typeInto(refused.q('[data-codes-seed]'), SEED);
    expect(save().disabled).toBe(true);
    await click(tick());
    expect(save().disabled).toBe(false);
    await click(save());
    await settle();
    await settle();
    const staged = refused.calls.filter(call => call.route === 'POST /v1/accounts/:id/factors/seed');
    expect(staged).toHaveLength(1);
    expect(JSON.stringify(staged[0]?.body)).toContain(padInputValue(SEED));
    expect((refused.q('[data-codes-seed]') as HTMLInputElement | null)?.value ?? '').toBe('');
    expect(refused.html()).not.toContain(SEED);
    expect(asked).toEqual([STAGE]);
    expect(refused.calls.map(call => call.method)).toEqual(['POST', 'DELETE']);
    expect(refused.saved).toEqual([]);
    expect(JSON.stringify(refused.calls.slice(1))).not.toContain(SEED);

    // A given passkey: the commit goes with no body at all.
    const given = await panel({ addKey: async () => true });
    await typeInto(given.q('[data-codes-seed]'), SEED);
    await click(given.q('[data-codes-warning-tick]'));
    await click(given.q('[data-codes-save]'));
    await settle();
    await settle();
    const commit = given.calls.find(call => call.route === 'POST /v1/accounts/:id/factors/seed/:stage/commit');
    expect(commit).toBeDefined();
    expect(commit?.body).toBeUndefined();
    expect(given.saved).toEqual(['saved']);
    expect(JSON.stringify(given.calls)).toContain(padInputValue(SEED));
    expect(JSON.stringify(given.calls.slice(1))).not.toContain(padInputValue(SEED));
  });
});
