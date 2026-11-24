/**
 * The three Vault slot panels drawn under an input card in chat (set up automatic codes, "Always use for", "Don't ask
 * again") read the daemon on their own when they mount, which is not the owner acting. That read is QUIET (no passkey
 * prompt); a daemon that wants the step-up is answered by "Confirm it's you to see this" and no data, and the owner's
 * press reads again, not quiet. And when a quiet read relocks a card that was already showing data, the held data is
 * CLEARED, not only hidden.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { SignInRuleOffer } from '../../../app/features/secure-copy/sign-in-rule-offer.tsx';
import { SignInRuleSuggestionHost } from '../../../app/features/secure-copy/sign-in-rule-suggestion-host.tsx';
import { TaskPlanHost } from '../../../app/features/secure-copy/task-plan-host.tsx';
import { AlwaysUseLine } from '../../../app/features/accounts/always-use-line.tsx';
import { InputCodesPanel } from '../../../app/features/two-factor/input-codes-panel.tsx';
import { TwoFactorSeedHost } from '../../../app/features/two-factor/two-factor-seed-host.tsx';
import { CONFIRM_TO_SEE_WORDS } from '../../../app/lib/step-up-refusal.ts';
import { list as accountList, SI_GITHUB } from '../../support/app/accounts-fixtures.ts';
import { interact, mount, type Mounted, must } from '../../support/app/dom.ts';
import { click, settle } from '../../support/app/dom-form.ts';
import { boxNamed } from '../../support/app/select-box.ts';
import { codesSlot, savedPrimary, settledSlot } from '../../support/app/input-card-fixtures.ts';
import { suggestion } from '../../support/app/sign-in-rule-fixtures.ts';
import { mixedPlan, PLAN_ID, SESSION } from '../../support/app/task-plan-fixtures.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

interface Seen {
  readonly route: string;
  readonly quiet: boolean;
}

/**
 * A daemon that answers every route in `answers`, except that while `state.lock` is on a QUIET read is refused the way
 * the client hands a step-up refusal back (`403 grant_step_up_required`). A read that is not quiet is answered, as the
 * client does once the passkey was given.
 */
const daemon = (answers: Readonly<Record<string, unknown>>, lock = true) => {
  const seen: Seen[] = [];
  const state = { lock };
  const client = {
    call: async (route: string, init?: { readonly quiet?: boolean }) => {
      const quiet = init?.quiet === true;
      seen.push({ route, quiet });
      if (!(route in answers)) return {};
      if (quiet && state.lock)
        throw Object.assign(new Error('step-up required'), { status: 403, code: 'grant_step_up_required' });
      return answers[route];
    },
  };
  return { client: client as never, seen, state };
};

const CONFIRM = '[data-confirm-to-see] button';
const confirm = (container: ParentNode): HTMLElement => must(container.querySelector<HTMLElement>(CONFIRM), CONFIRM);
const reads = (seen: readonly Seen[], route: string): Seen[] => seen.filter(each => each.route === route);

const ACCOUNTS = { 'GET /v1/accounts': accountList() };

describe('the Vault slot panels read quietly on mount', () => {
  it('set up automatic codes: the mount read is quiet, shows no data, and the press reads for real', async () => {
    const { client, seen } = daemon(ACCOUNTS);
    const view = await mount(
      <InputCodesPanel addKey={async () => true} client={client} slot={codesSlot({ saved: savedPrimary('GITHUB') })} />,
    );
    mounted.push(view);
    await settle();
    expect(seen).toEqual([{ route: 'GET /v1/accounts', quiet: true }]);
    expect(view.container.textContent).toContain(CONFIRM_TO_SEE_WORDS);
    expect(boxNamed(view.container, 'Which account is this key for?')).toBeNull();
    await click(confirm(view.container));
    await settle();
    expect(seen.at(-1)).toEqual({ route: 'GET /v1/accounts', quiet: false });
    expect(view.container.querySelector(CONFIRM)).toBeNull();
    expect(boxNamed(view.container, 'Which account is this key for?')).not.toBeNull();
  });

  it('always use: the mount read is quiet, shows no data and holds nothing, and the press reads for real', async () => {
    const { client, seen } = daemon(ACCOUNTS);
    const holds: boolean[] = [];
    const view = await mount(
      <AlwaysUseLine client={client} slot={settledSlot({ hold: (holding: boolean) => holds.push(holding) })} />,
    );
    mounted.push(view);
    await settle();
    expect(seen).toEqual([{ route: 'GET /v1/accounts', quiet: true }]);
    expect(view.container.textContent).toContain(CONFIRM_TO_SEE_WORDS);
    expect(view.container.querySelector('[data-input-always-button]')).toBeNull();
    expect(holds).toEqual([]);
    await click(confirm(view.container));
    await settle();
    expect(seen.at(-1)).toEqual({ route: 'GET /v1/accounts', quiet: false });
    expect(view.container.querySelector(CONFIRM)).toBeNull();
    expect(view.container.querySelector('[data-input-always-button]')).not.toBeNull();
    expect(holds).toEqual([true]);
  });

  it('don’t ask again: the mount read is quiet, shows no data, and the press reads for real', async () => {
    const { client, seen } = daemon(ACCOUNTS);
    const view = await mount(<SignInRuleOffer client={client} slot={{ ...settledSlot(), signIn: SI_GITHUB }} />);
    mounted.push(view);
    await settle();
    expect(reads(seen, 'GET /v1/accounts')).toEqual([{ route: 'GET /v1/accounts', quiet: true }]);
    expect(view.container.textContent).toContain(CONFIRM_TO_SEE_WORDS);
    expect(view.container.querySelector('[data-rule-offer]')).toBeNull();
    await click(confirm(view.container));
    await settle();
    expect(reads(seen, 'GET /v1/accounts').at(-1)).toEqual({ route: 'GET /v1/accounts', quiet: false });
    expect(view.container.querySelector(CONFIRM)).toBeNull();
    expect(view.container.querySelector('[data-rule-offer="idle"]')).not.toBeNull();
  });

  it('a daemon that wants no step-up is read quietly and draws as before, with no button', async () => {
    const { client, seen } = daemon(ACCOUNTS, false);
    const view = await mount(<AlwaysUseLine client={client} slot={settledSlot()} />);
    mounted.push(view);
    await settle();
    expect(seen).toEqual([{ route: 'GET /v1/accounts', quiet: true }]);
    expect(view.container.querySelector(CONFIRM)).toBeNull();
    expect(view.container.querySelector('[data-input-always-button]')).not.toBeNull();
  });
});

describe('a quiet read that relocks a card clears what it held', () => {
  it('task plan: the plan is gone behind the button when a poll is refused, and the press draws it from a fresh read', async () => {
    const { client, seen, state } = daemon({ 'GET /v1/accounts/plans': { plans: [mixedPlan()] } }, false);
    // The 3 s poll is the thing under test: hold it, then fire it by hand once the unlock has run out. (Shrinking its
    // delay to 0 instead made the poll re-arm itself inside every act() and the act never settled on a loaded runner.)
    const real = globalThis.setTimeout;
    const held: Array<() => void> = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === undefined || ms < 1_000) return real(fn, ms, ...rest);
      held.push(() => fn(...(rest as [])));
      return 0;
    }) as unknown as typeof setTimeout;
    let view: Mounted;
    try {
      view = await mount(<TaskPlanHost client={client} ferret={SESSION} planId={PLAN_ID} />);
      mounted.push(view);
      // Shown while the unlock holds: the first read answers, and the next poll is the one the lock stops.
      expect(view.container.querySelector(`[data-task-plan="${PLAN_ID}"]`)).not.toBeNull();
      state.lock = true;
      await interact(async () => {
        for (const poll of held.splice(0)) poll();
      });
      await settle();
    } finally {
      globalThis.setTimeout = real;
    }
    expect(seen.length).toBeGreaterThan(1);
    expect(view.container.textContent).toContain(CONFIRM_TO_SEE_WORDS);
    expect(view.container.querySelector(`[data-task-plan="${PLAN_ID}"]`)).toBeNull();
    // The held plan is gone, not only hidden: the press reads again (not quiet) and the card is drawn from that read.
    const before = seen.length;
    await click(confirm(view.container));
    await settle();
    expect(seen.slice(before)[0]).toEqual({ route: 'GET /v1/accounts/plans', quiet: false });
    expect(view.container.querySelector(`[data-task-plan="${PLAN_ID}"]`)).not.toBeNull();
  });

  it('rule suggestion: the suggestion is dropped when a later quiet read is refused', async () => {
    const answers = {
      'GET /v1/sign-in-rules/suggestions': { suggestions: [suggestion({ signIn: SI_GITHUB })] },
      'GET /v1/accounts': accountList(),
    };
    const open = daemon(answers, false);
    const view = await mount(
      <SignInRuleSuggestionHost client={open.client} ferret={SESSION} suggestionId={suggestion().id} />,
    );
    mounted.push(view);
    await settle();
    expect(view.container.querySelector(CONFIRM)).toBeNull();
    expect(view.container.innerHTML).not.toBe('');
    // The same card on a client whose unlock has run out.
    const locked = daemon(answers, true);
    await view.render(
      <SignInRuleSuggestionHost client={locked.client} ferret={SESSION} suggestionId={suggestion().id} />,
    );
    await settle();
    expect(view.container.textContent).toContain(CONFIRM_TO_SEE_WORDS);
    // Nothing of the earlier read survives behind the button: a press that gets no suggestion draws nothing.
    locked.state.lock = false;
    const none = daemon({ ...answers, 'GET /v1/sign-in-rules/suggestions': { suggestions: [] } }, true);
    await view.render(
      <SignInRuleSuggestionHost client={none.client} ferret={SESSION} suggestionId={suggestion().id} />,
    );
    await settle();
    await click(confirm(view.container));
    await settle();
    expect(view.container.querySelector(CONFIRM)).toBeNull();
    expect(view.container.innerHTML).toBe('');
  });

  it('2FA seed: the account and the stage it read are dropped when a later quiet read is refused', async () => {
    const STAGE = 'st_0123456789abcdef01234567';
    const ACCOUNT = accountList().accounts[0]?.id ?? 'GITHUB';
    const stage = {
      stage: STAGE,
      account: ACCOUNT,
      label: 'Authenticator',
      state: 'waiting',
      mismatch: true,
      expiresAt: '2099-10-31T14:04:00.000Z',
    };
    const route = 'GET /v1/accounts/:id/factors/seed/:stage';
    const item = { twoFactorSeed: { stage: STAGE as never, account: ACCOUNT } };
    const open = daemon({ [route]: stage, ...ACCOUNTS }, false);
    const view = await mount(<TwoFactorSeedHost client={open.client} item={item} />);
    mounted.push(view);
    await settle();
    expect(view.container.querySelector('[data-seed-card]')).not.toBeNull();
    expect(view.container.querySelector('[data-seed-mismatch]')).not.toBeNull();
    // After the relock the daemon answers the owner's press with a stage it does not know, so nothing fresh is read.
    const locked = daemon({ ...ACCOUNTS }, true);
    await view.render(<TwoFactorSeedHost client={locked.client} item={item} />);
    await settle();
    expect(view.container.textContent).toContain(CONFIRM_TO_SEE_WORDS);
    expect(view.container.querySelector('[data-seed-card]')).toBeNull();
    await click(confirm(view.container));
    await settle();
    expect(locked.seen.filter(each => !each.quiet).length).toBeGreaterThan(0);
    // The earlier stage's mismatch flag did not outlive the relock: the card shows only what the press read.
    expect(view.container.querySelector('[data-seed-card]')).not.toBeNull();
    expect(view.container.querySelector('[data-seed-mismatch]')).toBeNull();
  });
});
