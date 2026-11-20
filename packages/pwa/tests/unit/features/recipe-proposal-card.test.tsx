import { afterEach, describe, expect, it } from 'bun:test';
import { AccountListSchema, type AgendaRecipeProposalRef, type SignInRuleView } from '@ferretry/protocol';
import { RecipeProposalCard } from '../../../src/features/input-request/recipe-proposal-card.tsx';
import { RecipeProposalHost } from '../../../src/features/input-request/recipe-proposal-host.tsx';
import { DaemonResponseError } from '../../../src/lib/runtime-models.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSettingsPath } from '../../../src/lib/pages/routes.ts';
import {
  RECIPE_APPROVED_WORDS,
  RECIPE_DECLINED_WORDS,
  RECIPE_GONE_WORDS,
  RECIPE_STALE_WORDS,
  RECIPE_UNREAD_WORDS,
  RECIPE_REFUSED_WHERE,
  classifyRecipeDecideFailure,
  recipeProposalView,
} from '../../../src/lib/recipe-proposal-card.ts';
import { RouterProvider } from '../../../src/lib/router.tsx';
import { suspendWarning } from '../../../src/lib/sign-in-rules.ts';
import { type Mounted, mount } from '../../support/dom.ts';
import { click, settle } from '../../support/dom-form.ts';
import { type Call, fakeClient } from '../../support/input-fixtures.ts';
import { pageRule, ruleList, suspendedRule } from '../../support/sign-in-rule-fixtures.ts';

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

  it('should sort a failed decision by what the owner can do about it', () => {
    expect(classifyRecipeDecideFailure({ code: 'stale_proposal' })).toEqual({
      kind: 'decline-only',
      words: RECIPE_STALE_WORDS,
    });
    expect(classifyRecipeDecideFailure({ code: 'unknown_proposal' })).toEqual({
      kind: 'gone',
      words: RECIPE_GONE_WORDS,
    });
    const refusal = (cause: unknown) => classifyRecipeDecideFailure(cause);
    expect(refusal(new DaemonResponseError(403, 'This device may not change accounts.'))).toEqual({
      kind: 'refused',
      words: `This device may not change accounts. ${RECIPE_REFUSED_WHERE}`,
    });
    expect(refusal(new DaemonResponseError(401, '')).kind).toBe('refused');
    expect(refusal(new DaemonResponseError(400, 'no', 'not_permitted')).kind).toBe('refused');
    expect(refusal(new DaemonResponseError(403, 'no', 'grant_forbidden')).kind).toBe('refused');
    expect(refusal(new DaemonResponseError(403, '')).words).toBe(
      `This device may not answer this. ${RECIPE_REFUSED_WHERE}`,
    );
  });

  it('should keep a transient failure retryable, in the daemon’s words when it gave any', () => {
    expect(classifyRecipeDecideFailure(new Error('not allowed from this device'))).toEqual({
      kind: 'retry',
      words: 'not allowed from this device',
    });
    expect(classifyRecipeDecideFailure(new DaemonResponseError(503, 'machine busy')).kind).toBe('retry');
    expect(classifyRecipeDecideFailure(new TypeError('Failed to fetch')).kind).toBe('retry');
    expect(classifyRecipeDecideFailure('boom')).toEqual({
      kind: 'retry',
      words: 'That did not go through. Try again, or answer it in Settings › Accounts.',
    });
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

  it('should take both buttons when this device is refused, and say where to answer', async () => {
    const card = await draw({ failDecide: new DaemonResponseError(403, 'This device may not change accounts.') });

    await click(card.q('[data-recipe-approve]'));
    for (let tries = 0; tries < 3; tries += 1) await settle();

    expect(card.q('[data-recipe-failed]')?.textContent).toBe(
      `This device may not change accounts. ${RECIPE_REFUSED_WHERE}`,
    );
    expect((card.q('[data-recipe-approve]') as HTMLButtonElement).disabled).toBe(true);
    expect((card.q('[data-recipe-decline]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('should keep both buttons for a failure that may pass, such as the network', async () => {
    const card = await draw({ failDecide: new TypeError('Failed to fetch') });

    await click(card.q('[data-recipe-approve]'));
    for (let tries = 0; tries < 3; tries += 1) await settle();

    expect(card.q('[data-recipe-failed]')?.textContent).toBe('Failed to fetch');
    expect((card.q('[data-recipe-approve]') as HTMLButtonElement).disabled).toBe(false);
    expect((card.q('[data-recipe-decline]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('should say the proposal is gone when the daemon no longer knows it at the moment of the answer', async () => {
    const card = await draw({ failDecide: Object.assign(new Error('gone'), { code: 'unknown_proposal' }) });

    await click(card.q('[data-recipe-decline]'));
    for (let tries = 0; tries < 3; tries += 1) await settle();

    expect(card.q('[data-recipe-done]')?.textContent).toBe(RECIPE_GONE_WORDS);
    expect(card.q('[data-recipe-decline]')).toBeNull();
  });

  it('should link the host’s card to this machine’s Settings › Accounts inside the app router', async () => {
    const machine = fakeClient((call: Call) => (call.path === '/v1/accounts' ? list() : {}));
    const view = await mount(
      <RouterProvider>
        <RecipeProposalHost
          connection={connection}
          createClient={async () => machine.client}
          item={{ recipeProposal: REF }}
        />
      </RouterProvider>,
    );
    mounted.push(view);
    for (let tries = 0; tries < 4; tries += 1) await settle();

    expect(view.container.querySelector('[data-recipe-settings]')?.getAttribute('href')).toBe(
      `${daemonSettingsPath(connection.daemonId)}#accounts`,
    );
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

describe('a decision in flight', () => {
  /** A client whose decide answer waits until the test lets it go, and which counts every accounts read. */
  const deferred = () => {
    const calls: Call[] = [];
    let release: (outcome: 'ok' | Error) => void = () => undefined;
    const client = {
      request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ path, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
        if (method === 'GET') return schema.parse(list());
        const outcome = await new Promise<'ok' | Error>(resolve => {
          release = resolve;
        });
        if (outcome !== 'ok') throw outcome;
        const [signIn] = list().signIns;
        return schema.parse({ ...signIn, proposals: undefined });
      },
    };
    return {
      client: client as never,
      create: async () => client as never,
      calls,
      release: (outcome: 'ok' | Error = 'ok') => release(outcome),
      reads: () => calls.filter(call => call.method === 'GET' && call.path === '/v1/accounts').length,
      decides: () => calls.filter(call => call.method === 'POST').length,
    };
  };

  /** `stable`: the app hands one client factory for good; otherwise each render brings a new one, as a harness may. */
  const host = (machine: ReturnType<typeof deferred>, ref: AgendaRecipeProposalRef, stable = true) => (
    <RecipeProposalHost
      connection={connection}
      createClient={stable ? machine.create : async () => machine.client}
      item={{ recipeProposal: ref }}
    />
  );
  const settleAll = async () => {
    for (let tries = 0; tries < 4; tries += 1) await settle();
  };

  it('should send one decision and keep the buttons off when the agenda is parsed again with an equal pointer', async () => {
    const machine = deferred();
    const view = await mount(host(machine, { ...REF }));
    mounted.push(view);
    await settleAll();
    const q = (selector: string) => view.container.querySelector<HTMLButtonElement>(selector);
    expect(machine.reads()).toBe(1);

    await click(q('[data-recipe-approve]'));
    await settleAll();
    expect(machine.decides()).toBe(1);
    expect(q('[data-recipe-approve]')?.disabled).toBe(true);
    expect(q('[data-recipe-decline]')?.disabled).toBe(true);

    // The same ids in a new object: a snapshot parsed again. It must not read, nor re-enable anything.
    await view.render(host(machine, { ...REF }));
    await settleAll();
    expect(machine.reads()).toBe(1);
    expect(q('[data-recipe-approve]')?.disabled).toBe(true);
    expect(q('[data-recipe-decline]')?.disabled).toBe(true);
    await click(q('[data-recipe-approve]'));
    await click(q('[data-recipe-decline]'));
    expect(machine.decides()).toBe(1);

    machine.release();
    await settleAll();
    expect(machine.decides()).toBe(1);
    expect(view.container.querySelector('[data-recipe-done]')?.textContent).toBe(RECIPE_APPROVED_WORDS);

    // And once it is done, a later snapshot does not bring the buttons back.
    await view.render(host(machine, { ...REF }));
    await settleAll();
    expect(view.container.querySelector('[data-recipe-done]')?.textContent).toBe(RECIPE_APPROVED_WORDS);
    expect(q('[data-recipe-approve]')).toBeNull();
  });

  it('should never let a background read re-enable the buttons, even when every render brings a new client factory', async () => {
    const machine = deferred();
    const view = await mount(host(machine, { ...REF }, false));
    mounted.push(view);
    await settleAll();
    const q = (selector: string) => view.container.querySelector<HTMLButtonElement>(selector);

    await click(q('[data-recipe-approve]'));
    await settleAll();
    await view.render(host(machine, { ...REF }, false));
    await settleAll();

    expect(q('[data-recipe-approve]')?.disabled).toBe(true);
    expect(q('[data-recipe-decline]')?.disabled).toBe(true);
    await click(q('[data-recipe-approve]'));
    expect(machine.decides()).toBe(1);
    machine.release();
    await settleAll();
    expect(machine.decides()).toBe(1);
    expect(view.container.querySelector('[data-recipe-done]')?.textContent).toBe(RECIPE_APPROVED_WORDS);
  });

  it('should let the owner try again after a refusal, and only then', async () => {
    const machine = deferred();
    const view = await mount(host(machine, { ...REF }));
    mounted.push(view);
    await settleAll();
    const q = (selector: string) => view.container.querySelector<HTMLButtonElement>(selector);

    await click(q('[data-recipe-decline]'));
    await settleAll();
    machine.release(new Error('not allowed from this device'));
    await settleAll();
    expect(view.container.querySelector('[data-recipe-failed]')?.textContent).toBe('not allowed from this device');

    await click(q('[data-recipe-decline]'));
    await settleAll();
    expect(machine.decides()).toBe(2);
    machine.release();
    await settleAll();
    expect(view.container.querySelector('[data-recipe-done]')?.textContent).toBe(RECIPE_DECLINED_WORDS);
  });

  it('should read again for another proposal', async () => {
    const machine = deferred();
    const view = await mount(host(machine, { ...REF }));
    mounted.push(view);
    await settleAll();

    await view.render(host(machine, { ...REF, proposal: 'rp_00000000000000b2' }));
    await settleAll();

    expect(machine.reads()).toBe(2);
    expect(view.container.querySelector('[data-recipe-state="gone"]')?.textContent).toBe(RECIPE_GONE_WORDS);
  });
});

describe('the recipe card and standing rules', () => {
  const drawWithRules = async (over: { readonly offered: boolean; readonly rules?: readonly SignInRuleView[] }) => {
    const machine = fakeClient((call: Call) => {
      if (call.path === '/v1/accounts') return list();
      if (call.path === '/v1/sign-in-rules') return ruleList({ rules: [...(over.rules ?? [])] });
      throw new Error(`unexpected ${call.path}`);
    });
    const view = await mount(
      <RecipeProposalHost
        connection={connection}
        createClient={async () => machine.client}
        item={{ recipeProposal: REF }}
        offered={over.offered}
      />,
    );
    mounted.push(view);
    for (let tries = 0; tries < 5; tries += 1) await settle();
    return { view, calls: machine.calls };
  };

  it('should warn that approving suspends an active rule on this sign-in', async () => {
    const { view } = await drawWithRules({ offered: true, rules: [pageRule({ signIn: SIGN_IN })] });

    expect(view.container.querySelector('[data-rule-edit-warning]')?.textContent).toBe(suspendWarning(1));
  });

  it('should say nothing for a rule on another sign-in, a suspended one, or no rules at all', async () => {
    const other = await drawWithRules({ offered: true, rules: [pageRule({ signIn: 'si_00000000000000ff' })] });
    expect(other.view.container.querySelector('[data-rule-edit-warning]')).toBeNull();
    const suspended = await drawWithRules({ offered: true, rules: [{ ...suspendedRule(), signIn: SIGN_IN }] });
    expect(suspended.view.container.querySelector('[data-rule-edit-warning]')).toBeNull();
    const none = await drawWithRules({ offered: true });
    expect(none.view.container.querySelector('[data-rule-edit-warning]')).toBeNull();
  });

  it('should not even ask for rules on a machine that does not report them', async () => {
    const { view, calls } = await drawWithRules({ offered: false, rules: [pageRule({ signIn: SIGN_IN })] });

    expect(view.container.querySelector('[data-rule-edit-warning]')).toBeNull();
    expect(calls.some(call => call.path === '/v1/sign-in-rules')).toBe(false);
    expect(view.container.querySelector('[data-recipe-approve]')).not.toBeNull();
  });
});
