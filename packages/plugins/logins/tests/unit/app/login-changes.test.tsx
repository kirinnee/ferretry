import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SignInsTab } from '../../../app/features/sign-ins-tab.tsx';
import { login, loginList } from '../cli/fakes.ts';
import { interact, mount, must } from '../support/dom.ts';
import { type Call, scripted } from './support/client.ts';

// Opening a login writes its address, so the window's hash is reset around every test here: the
// tab must never start on a page a previous test happened to leave behind, nor leave one behind.
beforeEach(() => {
  window.history.pushState({}, '', '/');
});
afterEach(() => {
  window.location.hash = '';
  window.history.pushState({}, '', '/');
});

const LIST = 'GET /v1/logins';
const GRANTS = 'GET /v1/grants';
const STAGE = 'POST /v1/logins/changes';
const APPLY = 'POST /v1/logins/changes/:changeId/apply';
const OPEN = { capabilities: [{ capability: 'fleet', use: true, configure: true, configureRefusal: 'granted' }] };
const STEP_UP = {
  capabilities: [{ capability: 'fleet', use: true, configure: false, configureRefusal: 'step-up-required' }],
};
const NOT_GRANTED = {
  capabilities: [{ capability: 'fleet', use: true, configure: false, configureRefusal: 'not-granted' }],
};

const staged = (change: unknown, extra: Record<string, unknown> = {}) => ({
  id: 'chg1',
  change,
  summary: 'Do it',
  consequences: [],
  expiresAt: '2026-11-01T10:15:00.000Z',
  state: 'pending',
  ...extra,
});

const until = async (shown: () => boolean, what: string): Promise<void> => {
  for (let elapsed = 0; elapsed < 2_000 && !shown(); elapsed += 10)
    await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
  if (!shown()) throw new Error(`never shown: ${what}`);
};

const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await until(() => !(target as HTMLButtonElement).disabled, `${what} to be enabled`);
  await interact(() => target.click());
};

const type = async (element: Element | null, value: string): Promise<void> => {
  const input = must(element as HTMLInputElement | null, 'the field');
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const openPage = async (routes: Record<string, unknown>, calls: Call[] = []) => {
  // Start from the list: a remount inside one test must not open on the page the address still
  // names from the round before.
  window.history.pushState({}, '', '/');
  const view = await mount(
    <SignInsTab client={scripted(routes, calls)} now={() => Date.parse('2026-11-01T10:00:00.000Z')} />,
  );
  await until(() => view.container.querySelector('[data-login-row]') !== null, 'the row');
  await click(view.container.querySelector('[data-login-row]'), 'the row');
  return view;
};

describe('changing a login from its page', () => {
  it('saves a label as one staged, applied change, and clears it with an empty one', async () => {
    const calls: Call[] = [];
    const view = await openPage(
      {
        [LIST]: loginList(login({ label: 'work' })),
        [GRANTS]: OPEN,
        [STAGE]: staged({ kind: 'login.label', id: 'claude-you', label: 'Home' }),
        [APPLY]: { outcome: 'applied' },
      },
      calls,
    );
    await type(view.container.querySelector('#login-label-claude-you'), 'Home');
    await click(view.container.querySelector('[data-login-label] [data-change-submit]'), 'Save label');
    await until(() => calls.some(call => call.route === APPLY), 'the apply');
    expect(calls.find(call => call.route === STAGE)?.body).toEqual({
      kind: 'login.label',
      id: 'claude-you',
      label: 'Home',
    });
    await type(view.container.querySelector('#login-label-claude-you'), '');
    await click(view.container.querySelector('[data-login-label] [data-change-submit]'), 'Save label');
    await until(() => calls.filter(call => call.route === STAGE).length === 2, 'the second stage');
    expect(calls.filter(call => call.route === STAGE)[1]?.body).toEqual({
      kind: 'login.label',
      id: 'claude-you',
      label: null,
    });
    await view.unmount();
  });

  it('switches a login off with a reason and a wait, and back on', async () => {
    const calls: Call[] = [];
    const routes = {
      [LIST]: loginList(login()),
      [GRANTS]: OPEN,
      [STAGE]: staged({ kind: 'login.enable', id: 'claude-you' }),
      [APPLY]: { outcome: 'applied' },
    };
    const view = await openPage(routes, calls);
    await type(view.container.querySelector('#login-disable-reason-claude-you'), 'over budget');
    const select = must(view.container.querySelector<HTMLSelectElement>('[data-login-disable] select'), 'the wait');
    await interact(() => {
      select.value = '1d';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click(view.container.querySelector('[data-login-disable="on"] [data-change-submit]'), 'Switch off');
    await until(() => calls.some(call => call.route === STAGE), 'the stage');
    expect(calls.find(call => call.route === STAGE)?.body).toEqual({
      kind: 'login.disable',
      id: 'claude-you',
      reason: 'over budget',
      until: '2026-11-02T10:00:00.000Z',
    });
    await view.unmount();

    const offCalls: Call[] = [];
    const off = await openPage(
      {
        ...routes,
        [LIST]: loginList(login({ disabled: { reason: 'quota', source: 'login' } })),
      },
      offCalls,
    );
    expect(off.container.querySelector('[data-login-disabled-note]')?.textContent).toContain('Switched off: quota');
    await click(off.container.querySelector('[data-login-disable="off"] [data-change-submit]'), 'Switch back on');
    await until(() => offCalls.some(call => call.route === STAGE), 'the stage');
    expect(offCalls.find(call => call.route === STAGE)?.body).toEqual({ kind: 'login.enable', id: 'claude-you' });
    await off.unmount();
  });

  it('asks before signing out with the daemon’s own sentence, and changes nothing on "Keep signed in"', async () => {
    const calls: Call[] = [];
    const view = await openPage(
      {
        [LIST]: loginList(login()),
        [GRANTS]: OPEN,
        [STAGE]: staged({ kind: 'login.signout', id: 'claude-you' }),
        [APPLY]: { outcome: 'signed-out', login: login() },
      },
      calls,
    );
    await click(view.container.querySelector('[data-login-sign-out-ask]'), 'Sign out…');
    expect(view.container.querySelector('[data-login-sign-out]')?.textContent).toContain('Sign out?');
    await click(view.container.querySelector('[data-sign-out-keep]'), 'Keep signed in');
    expect(view.container.querySelector('[data-login-sign-out]')).toBeNull();
    expect(calls.some(call => call.route === STAGE)).toBe(false);
    await click(view.container.querySelector('[data-login-sign-out-ask]'), 'Sign out…');
    await click(view.container.querySelector('[data-login-sign-out] [data-change-submit]'), 'Sign out');
    await until(() => calls.some(call => call.route === APPLY), 'the apply');
    expect(calls.find(call => call.route === STAGE)?.body).toEqual({ kind: 'login.signout', id: 'claude-you' });
    await view.unmount();
  });

  it('says a failed sign-out failed, in the harness’s words', async () => {
    const view = await openPage({
      [LIST]: loginList(login()),
      [GRANTS]: OPEN,
      [STAGE]: staged({ kind: 'login.signout', id: 'claude-you' }),
      [APPLY]: { outcome: 'sign-out-failed', reason: 'the harness could not sign out', login: login() },
    });
    await click(view.container.querySelector('[data-login-sign-out-ask]'), 'Sign out…');
    await click(view.container.querySelector('[data-login-sign-out] [data-change-submit]'), 'Sign out');
    await until(() => view.container.querySelector('[data-change-refusal]') !== null, 'the failure');
    expect(view.container.querySelector('[data-login-sign-out] [data-change-refusal]')?.textContent).toBe(
      'Could not sign out: the harness could not sign out',
    );
    await view.unmount();
  });

  it('says a held change is held for the owner, and names what it loosens', async () => {
    const view = await openPage({
      [LIST]: loginList(login()),
      [GRANTS]: OPEN,
      [STAGE]: staged({ kind: 'login.signout', id: 'claude-you' }),
      [APPLY]: { outcome: 'held', sentences: ['raises the budget', 'widens a model'] },
    });
    await click(view.container.querySelector('[data-login-sign-out-ask]'), 'Sign out…');
    await click(view.container.querySelector('[data-login-sign-out] [data-change-submit]'), 'Sign out');
    await until(() => view.container.querySelector('[data-change-refusal]') !== null, 'the hold');
    expect(view.container.querySelector('[data-login-sign-out] [data-change-refusal]')?.textContent).toBe(
      'Saved, but this loosens something, so the owner has to confirm it before it takes effect. The tighter version stays in effect until then: raises the budget; widens a model.',
    );
    await view.unmount();
  });

  it('stages a removal first and shows the daemon’s consequences before it is confirmed', async () => {
    const calls: Call[] = [];
    const view = await openPage(
      {
        [LIST]: loginList(login()),
        [GRANTS]: OPEN,
        [STAGE]: staged(
          { kind: 'login.remove', id: 'claude-you' },
          { summary: 'Remove login claude-you', consequences: ['1 saved secret (ZAI_KEY) stays in the secret store.'] },
        ),
        [APPLY]: { outcome: 'applied' },
      },
      calls,
    );
    await click(view.container.querySelector('[data-login-remove-ask]'), 'Remove this login…');
    await until(() => view.container.querySelector('[data-login-remove]') !== null, 'the confirm card');
    expect(view.container.querySelector('[data-login-remove]')?.textContent).toContain('ZAI_KEY');
    expect(calls.some(call => call.route === APPLY)).toBe(false);
    await click(view.container.querySelector('[data-login-remove] [data-change-submit]'), 'Remove');
    await until(() => calls.some(call => call.route === APPLY), 'the apply');
    expect(calls.find(call => call.route === APPLY)?.params).toEqual({ changeId: 'chg1' });
    await until(() => view.container.querySelector('[data-logins-tab]') !== null, 'back at the list');
    await view.unmount();
  });

  it('shows a remote caller that needs a passkey the sentence, and still offers the button', async () => {
    const view = await openPage({ [LIST]: loginList(login()), [GRANTS]: STEP_UP });
    await until(() => view.container.querySelector('[data-change-step-up]') !== null, 'the passkey sentence');
    expect(view.container.querySelector('[data-change-step-up]')?.textContent).toBe(
      'box will ask you to confirm with your passkey when you save.',
    );
    await view.unmount();
  });

  it('disables every change button and gives the grant guidance for a caller that is not granted', async () => {
    const view = await openPage({ [LIST]: loginList(login()), [GRANTS]: NOT_GRANTED });
    await until(() => view.container.querySelector('[data-change-grant-refused]') !== null, 'the guidance');
    expect(view.container.querySelector('[data-change-grant-refused]')?.textContent).toContain(
      'switched off the agent fleet for paired devices',
    );
    const buttons = Array.from(view.container.querySelectorAll<HTMLButtonElement>('[data-change-submit]'));
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every(button => button.disabled)).toBe(true);
    await view.unmount();
  });
});

const openList = async (routes: Record<string, unknown>, calls: Call[] = []) => {
  window.history.pushState({}, '', '/');
  const view = await mount(
    <SignInsTab client={scripted(routes, calls)} now={() => Date.parse('2026-11-01T10:00:00.000Z')} />,
  );
  await until(() => view.container.querySelector('[data-login-card-wrap]') !== null, 'the card');
  return view;
};

describe('changing a login from its card on the list', () => {
  it('shows the on/off switch and Remove on the card, beside the row that opens the page', async () => {
    const view = await openList({ [LIST]: loginList(login()), [GRANTS]: OPEN });
    const card = must(view.container.querySelector('[data-login-card-wrap="claude-you"]'), 'the card');
    expect(card.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
    expect(card.querySelector('[data-login-card-remove="claude-you"]')?.textContent).toBe('Remove');
    // Nothing interactive sits inside the row button.
    expect(card.querySelector('[data-login-row] button')).toBeNull();
    await view.unmount();
  });

  it('asks for a reason and a wait before switching off, and stages the same change as the page', async () => {
    const calls: Call[] = [];
    const view = await openList(
      {
        [LIST]: loginList(login()),
        [GRANTS]: OPEN,
        [STAGE]: staged({ kind: 'login.disable', id: 'claude-you' }),
        [APPLY]: { outcome: 'applied' },
      },
      calls,
    );
    await click(view.container.querySelector('[data-login-switch] button'), 'the switch');
    await click(view.container.querySelector('[data-login-disable="on"] [data-change-submit]'), 'Switch off');
    await until(() => calls.some(call => call.route === STAGE), 'the stage');
    expect(calls.find(call => call.route === STAGE)?.body).toEqual({ kind: 'login.disable', id: 'claude-you' });
    await view.unmount();
  });

  it('switches a login that is off back on at once', async () => {
    const calls: Call[] = [];
    const view = await openList(
      {
        [LIST]: loginList(login({ disabled: { source: 'login', reason: 'over budget' } })),
        [GRANTS]: OPEN,
        [STAGE]: staged({ kind: 'login.enable', id: 'claude-you' }),
        [APPLY]: { outcome: 'applied' },
      },
      calls,
    );
    const toggle = must(view.container.querySelector('[data-login-switch] button'), 'the switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await click(toggle, 'the switch');
    await until(() => calls.some(call => call.route === APPLY), 'the apply');
    expect(calls.find(call => call.route === STAGE)?.body).toEqual({ kind: 'login.enable', id: 'claude-you' });
    await view.unmount();
  });

  it('shows the daemon’s consequences first when Remove is pressed, then removes on the second press', async () => {
    const calls: Call[] = [];
    const view = await openList(
      {
        [LIST]: loginList(login()),
        [GRANTS]: OPEN,
        [STAGE]: staged(
          { kind: 'login.remove', id: 'claude-you' },
          { summary: 'Remove login claude-you', consequences: ['Its saved sign-in stays on this machine.'] },
        ),
        [APPLY]: { outcome: 'applied' },
      },
      calls,
    );
    await click(view.container.querySelector('[data-login-card-remove]'), 'Remove');
    await until(() => view.container.querySelector('[data-login-remove]') !== null, 'the confirm card');
    expect(calls.find(call => call.route === STAGE)?.body).toEqual({ kind: 'login.remove', id: 'claude-you' });
    expect(calls.some(call => call.route === APPLY)).toBe(false);
    expect(view.container.querySelector('[data-login-remove]')?.textContent).toContain('saved sign-in stays');
    await click(view.container.querySelector('[data-login-remove] [data-change-submit]'), 'Remove');
    await until(() => calls.some(call => call.route === APPLY), 'the apply');
    await view.unmount();
  });

  it('folds the confirmation away when the login is kept', async () => {
    const view = await openList({
      [LIST]: loginList(login()),
      [GRANTS]: OPEN,
      [STAGE]: staged({ kind: 'login.remove', id: 'claude-you' }),
    });
    await click(view.container.querySelector('[data-login-card-remove]'), 'Remove');
    await until(() => view.container.querySelector('[data-login-remove]') !== null, 'the confirm card');
    await click(view.container.querySelector('[data-login-remove-keep]'), 'Keep it');
    await until(() => view.container.querySelector('[data-login-card-remove]') !== null, 'the Remove button again');
    expect(view.container.querySelector('[data-login-remove]')).toBeNull();
    await view.unmount();
  });
});

describe('the card acts are one at a time, honest about authority, and close when they are done', () => {
  const two = loginList(login(), login({ id: 'second', email: 'b@example.com' }));
  const wrap = (view: { container: Element }, id: string) =>
    must(view.container.querySelector(`[data-login-card-wrap="${id}"]`), `the ${id} card`);

  it('lets only one card act at a time, scopes a refusal to the card that asked, and cancels in every state', async () => {
    const calls: Call[] = [];
    const view = await openList(
      {
        [LIST]: two,
        [GRANTS]: OPEN,
        [STAGE]: (call: Call) =>
          (call.body as { id: string }).id === 'second'
            ? new Error('second cannot be removed')
            : staged(call.body, { summary: 'Remove login claude-you', consequences: ['It is forgotten.'] }),
      },
      calls,
    );
    // Remove the first: its confirmation opens, and the other card's controls wait.
    await click(wrap(view, 'claude-you').querySelector('[data-login-card-remove]'), 'Remove (first)');
    await until(() => wrap(view, 'claude-you').querySelector('[data-login-remove]') !== null, 'the confirmation');
    const secondRemove = wrap(view, 'second').querySelector<HTMLButtonElement>('[data-login-card-remove]');
    const secondSwitch = wrap(view, 'second').querySelector<HTMLButtonElement>('[data-login-switch] button');
    expect(secondRemove?.disabled).toBe(true);
    expect(secondSwitch?.disabled).toBe(true);
    // Keeping it frees the other card.
    await click(wrap(view, 'claude-you').querySelector('[data-login-remove-keep]'), 'Keep it');
    await until(() => wrap(view, 'claude-you').querySelector('[data-login-card-remove]') !== null, 'the button back');
    // The second is refused: the refusal shows under IT only, and it can still be cancelled.
    await click(wrap(view, 'second').querySelector('[data-login-card-remove]'), 'Remove (second)');
    await until(() => wrap(view, 'second').querySelector('[data-change-refusal]') !== null, 'the refusal');
    expect(wrap(view, 'claude-you').querySelector('[data-change-refusal]')).toBeNull();
    expect(wrap(view, 'claude-you').querySelector<HTMLButtonElement>('[data-login-card-remove]')?.disabled).toBe(true);
    await click(wrap(view, 'second').querySelector('[data-login-remove-keep]'), 'Keep it');
    await until(() => wrap(view, 'second').querySelector('[data-login-card-remove]') !== null, 'the button back');
    expect(wrap(view, 'second').querySelector('[data-change-refusal]')).toBeNull();
    expect(calls.some(call => call.route === APPLY)).toBe(false);
    await view.unmount();
  });

  it('keeps Remove off, and says why, for a caller the operator has not allowed — and stages nothing', async () => {
    const calls: Call[] = [];
    const view = await openList({ [LIST]: loginList(login()), [GRANTS]: NOT_GRANTED }, calls);
    await until(() => view.container.querySelector('[data-login-card-locked]') !== null, 'the explanation');
    const remove = must(view.container.querySelector<HTMLButtonElement>('[data-login-card-remove]'), 'Remove');
    expect(remove.disabled).toBe(true);
    expect(view.container.querySelector('[data-login-card-locked]')?.textContent).toContain('Remove is off here');
    await interact(() => remove.click());
    expect(calls.some(call => call.route === STAGE)).toBe(false);
    await view.unmount();
  });

  it('keeps Remove on for a caller who only needs a passkey, which the carrier asks for when it applies', async () => {
    const view = await openList({ [LIST]: loginList(login()), [GRANTS]: STEP_UP });
    await until(() => view.container.querySelector('[data-login-card-remove]') !== null, 'Remove');
    expect(view.container.querySelector<HTMLButtonElement>('[data-login-card-remove]')?.disabled).toBe(false);
    expect(view.container.querySelector('[data-login-card-locked]')).toBeNull();
    await view.unmount();
  });

  it('closes the switch-off form once it has applied, and does not bring it back on switching on again', async () => {
    let off = false;
    let kind = '';
    const view = await openList({
      [LIST]: () => loginList(login(off ? { disabled: { source: 'login', reason: 'over budget' } } : {})),
      [GRANTS]: OPEN,
      [STAGE]: (call: Call) => {
        kind = (call.body as { kind: string }).kind;
        return staged(call.body);
      },
      [APPLY]: () => {
        off = kind === 'login.disable';
        return { outcome: 'applied' };
      },
    });
    const state = () => view.container.querySelector('[data-login-switch]')?.getAttribute('data-login-switch-state');
    // On: the form opens on a tap, and is gone once the switch-off has applied.
    await click(view.container.querySelector('[data-login-switch] button'), 'the switch');
    await until(() => view.container.querySelector('[data-login-disable="on"]') !== null, 'the form');
    await click(view.container.querySelector('[data-login-disable="on"] [data-change-submit]'), 'Switch off');
    await until(() => state() === 'off', 'the switch to read off');
    expect(view.container.querySelector('[data-login-disable]')).toBeNull();
    // Off -> on: switched back on at once, and no form appears.
    await click(view.container.querySelector('[data-login-switch] button'), 'the switch');
    await until(() => state() === 'on', 'the switch to read on');
    expect(view.container.querySelector('[data-login-disable]')).toBeNull();
    await view.unmount();
  });
});
