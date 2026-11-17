/**
 * "Set up automatic codes" under a code card: what Accounts draws in the Vault's `vault.input-card-codes` slot. It offers
 * only accounts the daemon matches to the card's place, stages a seed once and bound to the card's request, empties the
 * field at once, and saves only with the passkey bound to that stage.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { INPUT_CARD_CODES_SLOT } from '@ferretry/core-vault/contract';
import { InputCodesPanel } from '../../../app/features/two-factor/input-codes-panel.tsx';
import { padInputValue, type TwoFactorStageId } from '../../../contract/routes/index.ts';
import { list } from '../../support/app/accounts-fixtures.ts';
import { interact, type Mounted, mount } from '../../support/app/dom.ts';
import { click, settle, typeInto } from '../../support/app/dom-form.ts';
import { type Call, fakeClient } from '../../support/app/fake-client.ts';
import { codesSlot, REQUEST_ID, savedPrimary, savedTwo } from '../../support/app/input-card-fixtures.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

// RFC 6238's test key: never a real seed.
const SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const STAGE = `st_${'a'.repeat(24)}`;
const AT = '2026-10-31T10:00:00.000Z';

const answers =
  (read: () => unknown = list) =>
  (call: Call): unknown => {
    if (call.route === 'GET /v1/accounts') return read();
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

interface Given {
  readonly slot?: unknown;
  readonly addKey?: ((stage: TwoFactorStageId, words: string) => Promise<boolean>) | null;
  readonly read?: () => unknown;
}

const draw = async (given: Given = {}) => {
  const fake = fakeClient(answers(given.read));
  const refreshed: string[] = [];
  const slot = 'slot' in given ? given.slot : codesSlot({ refresh: () => refreshed.push('refresh') });
  const addKey = given.addKey === null ? undefined : (given.addKey ?? (async () => true));
  const view = await mount(
    <InputCodesPanel client={fake.client} slot={slot} {...(addKey === undefined ? {} : { addKey })} />,
  );
  mounted.push(view);
  await settle();
  const q = (selector: string) => view.container.querySelector<HTMLElement>(selector);
  return { view, q, calls: fake.calls, refreshed, html: () => view.container.innerHTML };
};

/** Types the key, ticks the warning and presses Save. */
const save = async (shown: Awaited<ReturnType<typeof draw>>): Promise<void> => {
  await typeInto(shown.q('[data-codes-seed]'), SEED);
  await click(shown.q('[data-codes-warning-tick]'));
  await click(shown.q('[data-codes-save]'));
  await settle();
  await settle();
};

describe('the "Set up automatic codes" panel under a code card', () => {
  it('fills the Vault’s slot by the name the Vault owns', () => {
    expect(INPUT_CARD_CODES_SLOT).toBe('vault.input-card-codes');
  });

  it('offers only the accounts the daemon matches to the card’s place, the one-tap choice first and already picked', async () => {
    const shown = await draw({ slot: codesSlot({ saved: savedPrimary('GITHUB_WORK') }) });
    const options = [...shown.view.container.querySelectorAll<HTMLOptionElement>('[data-codes-account] option')];
    // Vercel and Google do not sign in at github.com: they are not offered.
    expect(options.map(each => each.value)).toEqual(['', 'GITHUB_WORK', 'GITHUB']);
    expect((shown.q('[data-codes-account]') as HTMLSelectElement).value).toBe('GITHUB_WORK');
    expect(shown.q('[data-codes-heading]')?.textContent).toBe(
      'Set up automatic codes for GitHub (work) · kirin@work.test',
    );
  });

  it('never guesses: several accounts and no one-tap choice leaves the pick to the owner', async () => {
    const shown = await draw({ slot: codesSlot({ saved: savedTwo() }) });
    expect((shown.q('[data-codes-account]') as HTMLSelectElement).value).toBe('');
    expect(shown.q('[data-codes-heading]')?.textContent).toBe('Set up automatic codes');
  });

  it('draws nothing when no account signs in at the card’s place', async () => {
    const shown = await draw({ slot: codesSlot({ saved: savedTwo({ match: 'nowhere.test' }) }) });
    expect(shown.html()).toBe('');
  });

  it('draws nothing where no passkey can be asked, and nothing when the accounts cannot be read', async () => {
    expect((await draw({ addKey: null })).html()).toBe('');
    const unreadable = await draw({
      read: () => {
        throw Object.assign(new Error('no'), { status: 403, code: 'grant_device_withheld' });
      },
    });
    expect(unreadable.html()).toBe('');
  });

  it('draws nothing, and reads nothing, for props the card would never hand over', async () => {
    for (const slot of [null, 'x', {}, codesSlot({ requestId: '' }), codesSlot({ saved: { offers: 'no' } })]) {
      const shown = await draw({ slot });
      expect(shown.html()).toBe('');
      expect(shown.calls).toEqual([]);
    }
  });

  it('stages the key ONCE, padded, naming this card’s request, and empties the field at once', async () => {
    const shown = await draw();
    await save(shown);
    const staged = shown.calls.filter(call => call.route === 'POST /v1/accounts/:id/factors/seed');
    expect(staged).toHaveLength(1);
    expect(staged[0]?.path).toBe('/v1/accounts/GITHUB/factors/seed');
    expect(staged[0]?.body).toMatchObject({ request: REQUEST_ID, padded: padInputValue(SEED), totpAcknowledged: true });
    // Nowhere else in any call, and nowhere in the page.
    expect(JSON.stringify(shown.calls.filter(call => call !== staged[0]))).not.toContain(SEED);
    expect(JSON.stringify(shown.calls.filter(call => call !== staged[0]))).not.toContain(padInputValue(SEED));
    expect((shown.q('[data-codes-seed]') as HTMLInputElement | null)?.value ?? '').toBe('');
    expect(shown.html()).not.toContain(SEED);
  });

  it('empties the field when the page is hidden', async () => {
    const shown = await draw();
    const field = () => shown.q('[data-codes-seed]') as HTMLInputElement;
    await typeInto(field(), SEED);
    expect(field().value).toBe(SEED);
    expect(shown.html()).not.toContain(SEED);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      await interact(() => document.dispatchEvent(new Event('visibilitychange')));
      expect(field().value).toBe('');
    } finally {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    }
  });

  it('commits only with the passkey bound to that stage, tells the card to read its request again, and reads the accounts again', async () => {
    const asked: string[] = [];
    const shown = await draw({
      addKey: async stage => {
        asked.push(stage);
        return true;
      },
    });
    await save(shown);
    expect(asked).toEqual([STAGE]);
    const commit = shown.calls.find(call => call.route === 'POST /v1/accounts/:id/factors/seed/:stage/commit');
    expect(commit?.body).toBeUndefined();
    expect(shown.refreshed).toEqual(['refresh']);
    expect(shown.calls.filter(call => call.route === 'GET /v1/accounts')).toHaveLength(2);
    expect(shown.q('[data-codes-saved]')?.textContent).toContain('Saved.');
  });

  it('drops the stage and saves nothing when the passkey is dismissed, and does not refresh the card', async () => {
    const shown = await draw({ addKey: async () => false });
    await save(shown);
    expect(shown.calls.some(call => call.route === 'DELETE /v1/accounts/:id/factors/seed/:stage')).toBe(true);
    expect(shown.calls.some(call => call.route.endsWith('/commit'))).toBe(false);
    expect(shown.refreshed).toEqual([]);
    expect(shown.q('[data-codes-failed]')?.textContent).toBe(
      'You did not confirm with your passkey, so nothing was saved.',
    );
  });
});
