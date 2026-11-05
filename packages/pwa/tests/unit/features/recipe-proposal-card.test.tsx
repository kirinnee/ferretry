import { afterEach, describe, expect, it } from 'bun:test';
import { type AgendaRecipeProposalRef, AccountListSchema } from '@ferretry/protocol';
import { RecipeProposalCard } from '../../../src/features/input-request/recipe-proposal-card.tsx';
import { RecipeProposalHost } from '../../../src/features/input-request/recipe-proposal-host.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import {
  RECIPE_APPROVED_WORDS,
  RECIPE_DECLINED_WORDS,
  RECIPE_GONE_WORDS,
  RECIPE_STALE_WORDS,
  RECIPE_UNREAD_WORDS,
  recipeDecideFailureWords,
  recipeProposalView,
} from '../../../src/lib/recipe-proposal-card.ts';
import { type Mounted, mount } from '../../support/dom.ts';
import { click, settle } from '../../support/dom-form.ts';
import { type Call, fakeClient } from '../../support/input-fixtures.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const AT = '2026-11-05T10:00:00.000Z';
const SIGN_IN = 'si_00000000000000a1';
const PROPOSAL = 'rp_00000000000000b1';
const REF: AgendaRecipeProposalRef = { signIn: SIGN_IN, proposal: PROPOSAL };
const connection = daemonConnection({ daemonId: 'workshop', baseUrl: 'https://workshop.example.test', deviceId: 't1' });

const list = (over: { readonly recipe?: string; readonly proposals?: boolean } = {}) =>
  AccountListSchema.parse({
    v: 1,
    health: 'ready',
    accounts: [
      {
        id: 'GITHUB_DEMO',
        label: 'GitHub',
        username: 'demo-user',
        fields: { password: true, totp: false },
        factors: [],
        signIns: [SIGN_IN],
        createdAt: AT,
        updatedAt: AT,
      },
    ],
    signIns: [
      {
        id: SIGN_IN,
        account: 'GITHUB_DEMO',
        place: { kind: 'site', domains: ['github.com'], match: [] },
        method: { kind: 'password' },
        recipe: over.recipe ?? 'Open github.com\nClick Sign in',
        recipeVersion: 2,
        ...(over.proposals === false
          ? {}
          : {
              proposals: [
                {
                  id: PROPOSAL,
                  recipe: 'Open github.com\nClick Continue with Google',
                  base: 'Open github.com\nClick Sign in',
                  why: 'the button moved',
                  sessionId: 's1',
                  proposedAt: AT,
                },
              ],
            }),
        createdAt: AT,
        updatedAt: AT,
      },
    ],
  });

describe('what a recipe card offers', () => {
  it('should offer Approve when the proposal was made against the recipe as it stands', () => {
    const view = recipeProposalView(list(), REF);
    expect(view.kind).toBe('ready');
    if (view.kind !== 'gone') expect(view.account?.label).toBe('GitHub');
  });

  it('should offer only Decline once the recipe moved, and nothing when no proposal waits', () => {
    expect(recipeProposalView(list({ recipe: 'Someone edited this' }), REF).kind).toBe('stale');
    expect(recipeProposalView(list({ proposals: false }), REF).kind).toBe('gone');
    expect(recipeProposalView(list(), { ...REF, signIn: 'si_00000000000000ff' }).kind).toBe('gone');
  });

  it('should word the daemon’s refusals', () => {
    expect(recipeDecideFailureWords({ code: 'stale_proposal' })).toBe(RECIPE_STALE_WORDS);
    expect(recipeDecideFailureWords({ code: 'unknown_proposal' })).toBe(RECIPE_GONE_WORDS);
    expect(recipeDecideFailureWords(new Error('not allowed from this device'))).toBe('not allowed from this device');
  });
});

interface Served {
  readonly recipe?: string;
  readonly proposals?: boolean;
  readonly failRead?: boolean;
  readonly failDecide?: unknown;
}

const draw = async (over: Served = {}) => {
  const machine = fakeClient((call: Call) => {
    if (call.path === '/v1/accounts') {
      if (over.failRead === true) throw new Error('offline');
      return list(over);
    }
    if (over.failDecide !== undefined) throw over.failDecide;
    const [signIn] = list(over).signIns;
    return { ...signIn, proposals: undefined };
  });
  const view = await mount(
    <RecipeProposalHost
      connection={connection}
      createClient={async () => machine.client}
      item={{ recipeProposal: REF }}
    />,
  );
  mounted.push(view);
  for (let tries = 0; tries < 4; tries += 1) await settle();
  const q = (selector: string) => view.container.querySelector<HTMLElement>(selector);
  const decides = () => machine.calls.filter(call => call.method === 'POST');
  return { q, decides };
};

describe('the recipe card on the agenda', () => {
  it('should show who, where, the ferret’s words and the whole diff, all from the accounts read', async () => {
    const card = await draw();

    expect(card.q('[data-recipe-subject]')?.textContent).toBe('Change how ferrets sign in to github.com?');
    expect(card.q('[data-recipe-account]')?.textContent).toContain('GitHub');
    expect(card.q('[data-recipe-why]')?.textContent).toBe('The ferret says: the button moved');
    const ops = [...(card.q('[data-accounts-diff]')?.querySelectorAll('[data-diff-op]') ?? [])].map(line =>
      line.getAttribute('data-diff-op'),
    );
    expect(ops).toEqual([' ', '-', '+']);
    expect((card.q('[data-recipe-approve]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('should approve through the owner’s decide route, for exactly this proposal', async () => {
    const card = await draw();

    await click(card.q('[data-recipe-approve]'));
    for (let tries = 0; tries < 3; tries += 1) await settle();

    expect(card.decides()).toEqual([
      {
        path: `/v1/accounts/sign-ins/${SIGN_IN}/recipe/proposals/${PROPOSAL}`,
        method: 'POST',
        body: { decision: 'approve' },
      },
    ]);
    expect(card.q('[data-recipe-done]')?.textContent).toBe(RECIPE_APPROVED_WORDS);
  });

  it('should decline through the same route', async () => {
    const card = await draw();

    await click(card.q('[data-recipe-decline]'));
    for (let tries = 0; tries < 3; tries += 1) await settle();

    expect(card.decides().map(call => call.body)).toEqual([{ decision: 'decline' }]);
    expect(card.q('[data-recipe-done]')?.textContent).toBe(RECIPE_DECLINED_WORDS);
  });

  it('should not offer Approve on a stale proposal, and still let it be declined', async () => {
    const card = await draw({ recipe: 'Someone edited this' });

    expect(card.q('[data-recipe-stale]')?.textContent).toBe(RECIPE_STALE_WORDS);
    expect((card.q('[data-recipe-approve]') as HTMLButtonElement).disabled).toBe(true);
    await click(card.q('[data-recipe-approve]'));
    expect(card.decides()).toEqual([]);
    expect((card.q('[data-recipe-decline]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('should turn a stale refusal from the daemon into Decline only', async () => {
    const card = await draw({ failDecide: Object.assign(new Error('stale'), { code: 'stale_proposal' }) });

    await click(card.q('[data-recipe-approve]'));
    for (let tries = 0; tries < 3; tries += 1) await settle();

    expect(card.q('[data-recipe-failed]')?.textContent).toBe(RECIPE_STALE_WORDS);
    expect((card.q('[data-recipe-approve]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('should say when the proposal is no longer waiting, and when it cannot be read', async () => {
    const gone = await draw({ proposals: false });
    expect(gone.q('[data-recipe-state="gone"]')?.textContent).toBe(RECIPE_GONE_WORDS);
    expect(gone.q('[data-recipe-approve]')).toBeNull();

    const unread = await draw({ failRead: true });
    expect(unread.q('[data-recipe-state="unread"]')?.textContent).toContain(RECIPE_UNREAD_WORDS);
    expect(unread.q('[data-recipe-approve]')).toBeNull();
  });
});

describe('the recipe card’s link to Settings', () => {
  it('should open Settings › Accounts when the link is pressed, and draw none without one', async () => {
    const opened: string[] = [];
    const view = recipeProposalView(list(), REF);
    const linked = await mount(
      <RecipeProposalCard
        onApprove={() => undefined}
        onDecline={() => undefined}
        phase={{ kind: 'open', view }}
        settings={{ href: '/d/workshop/settings#accounts', onOpen: to => opened.push(to) }}
      />,
    );
    mounted.push(linked);
    const link = linked.container.querySelector<HTMLElement>('[data-recipe-settings]');

    await click(link);

    expect(link?.getAttribute('href')).toBe('/d/workshop/settings#accounts');
    expect(opened).toEqual(['/d/workshop/settings#accounts']);

    const bare = await mount(
      <RecipeProposalCard onApprove={() => undefined} onDecline={() => undefined} phase={{ kind: 'open', view }} />,
    );
    mounted.push(bare);
    expect(bare.container.querySelector('[data-recipe-settings]')).toBeNull();
  });
});
