import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { AddLoginPanel } from '../../../app/features/add-login-panel.tsx';
import { LoginSignInPanel } from '../../../app/features/login-sign-in-panel.tsx';
import { SignInsTab } from '../../../app/features/sign-ins-tab.tsx';
import { login, loginList } from '../cli/fakes.ts';
import { interact, mount, must } from '../support/dom.ts';
import { type Call, scripted } from './support/client.ts';
import { CLAUDE_URL, claudeFlow } from './support/harness-login.ts';

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
const START = 'POST /v1/logins/sign-in';
const SUBMIT = 'POST /v1/logins/sign-in/:flowId';

const until = async (shown: () => boolean, what: string): Promise<void> => {
  for (let elapsed = 0; elapsed < 2_000 && !shown(); elapsed += 10)
    await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
  if (!shown()) throw new Error(`never shown: ${what}`);
};

/** What the grants say about this caller: the fleet may be configured, nothing more asked. */
const OPEN = { capabilities: [{ capability: 'fleet', use: true, configure: true, configureRefusal: 'granted' }] };
const GRANTS = 'GET /v1/grants';

/** A button is clicked once it can be: a change button waits for the grants read before it is offered. */
const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await until(() => !(target as HTMLButtonElement).disabled, `${what} to be enabled`);
  await interact(() => target.click());
};

const needsSignIn = (id = 'claude-you') =>
  login({
    id,
    status: {
      word: 'needs_sign_in',
      label: 'Needs sign-in',
      reason: 'not_signed_in',
      explanation: 'Sign in to use it.',
      lastCheckInconclusive: false,
    },
  });

describe('the Sign-ins tab', () => {
  it('lists the logins by harness with status, use and usage, and opens one on a click', async () => {
    const calls: Call[] = [];
    const client = scripted(
      {
        [LIST]: loginList(login(), login({ id: 'codex-you', harness: 'codex', harnesses: ['codex'], email: 'c@x.y' })),
      },
      calls,
    );
    const view = await mount(<SignInsTab client={client} now={() => Date.parse('2026-11-01T10:00:00.000Z')} />);
    await until(() => view.container.querySelector('[data-logins-tab]') !== null, 'the tab');
    const c = view.container;
    expect(c.querySelector('[data-logins-group="claude-code"]')?.textContent).toContain('you@example.com');
    expect(c.querySelector('[data-logins-group="codex"]')?.textContent).toContain('c@x.y');
    expect(c.textContent).toContain('Ready · Used by 1 runtime');
    expect(c.textContent).toContain('5h12% used');
    await click(c.querySelector('[data-login-row="claude-you"]'), 'the row');
    expect(c.querySelector('[data-login-page="claude-you"]')).not.toBeNull();
    await click(c.querySelector('[data-page-back]'), 'back');
    expect(c.querySelector('[data-logins-tab]')).not.toBeNull();
    expect(calls.map(call => call.route)).toEqual([LIST, 'GET /v1/grants']);
    await view.unmount();
  });

  it('says so when there are no logins, and shows a read that failed in the daemon’s words', async () => {
    const empty = await mount(<SignInsTab client={scripted({ [LIST]: loginList() })} />);
    await until(() => empty.container.querySelector('[data-logins-empty]') !== null, 'the empty state');
    expect(empty.container.textContent).toContain('No logins on box');
    await empty.unmount();

    const failing = await mount(
      <SignInsTab
        client={scripted({
          [LIST]: Object.assign(new Error('x'), {
            status: 503,
            code: 'plugin_unavailable',
            message: 'Logins is paused.',
          }),
        })}
      />,
    );
    await until(() => failing.container.querySelector('[data-logins-failed]') !== null, 'the failure');
    expect(failing.container.querySelector('[data-logins-failed]')?.textContent).toBe('Logins is paused.');
    await failing.unmount();
  });

  it('checks a login now through its own route and says what came of it', async () => {
    const calls: Call[] = [];
    const client = scripted(
      { [LIST]: loginList(login()), [GRANTS]: OPEN, 'POST /v1/logins/:loginId/check': login() },
      calls,
    );
    const view = await mount(<SignInsTab client={client} />);
    await until(() => view.container.querySelector('[data-login-row]') !== null, 'the row');
    await click(view.container.querySelector('[data-login-row]'), 'the row');
    await click(view.container.querySelector('[data-login-actions] [data-change-submit]'), 'Check now');
    await until(() => view.container.querySelector('[data-login-notice]') !== null, 'the notice');
    expect(view.container.querySelector('[data-login-notice]')?.textContent).toBe('Checked. The login works.');
    expect(calls.map(call => call.route)).toContain('POST /v1/logins/:loginId/check');
    await view.unmount();
  });

  it('offers the sign-in on a login that needs one, shows the page address once, and takes the code back', async () => {
    const calls: Call[] = [];
    const client = scripted(
      {
        [LIST]: loginList(needsSignIn()),
        [GRANTS]: OPEN,
        [START]: claudeFlow('awaiting-code'),
        [SUBMIT]: { outcome: 'accepted', flow: claudeFlow('complete') },
      },
      calls,
    );
    const view = await mount(<SignInsTab client={client} pollMs={60_000} />);
    await until(() => view.container.querySelector('[data-login-row]') !== null, 'the row');
    await click(view.container.querySelector('[data-login-row]'), 'the row');
    await click(
      Array.from(view.container.querySelectorAll('button')).find(
        button => button.textContent === 'Sign in to Claude Code',
      ) ?? null,
      'Sign in',
    );
    await until(() => view.container.querySelector('[data-claude-login="awaiting-code"]') !== null, 'the code step');
    expect(view.container.textContent).toContain(CLAUDE_URL);
    const field = must(view.container.querySelector('textarea') as HTMLTextAreaElement | null, 'the code field');
    await interact(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(field, 'the-pasted-code');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await interact(() => {
      field.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await until(() => calls.some(call => call.route === SUBMIT), 'the submission');
    expect(calls.find(call => call.route === START)?.body).toEqual({ loginId: 'claude-you' });
    expect(calls.find(call => call.route === SUBMIT)?.body).toEqual({ code: 'the-pasted-code' });
    // The code is never left in what the tree renders.
    expect(view.container.innerHTML).not.toContain('the-pasted-code');
    await view.unmount();
  });
});

describe('the page the address names', () => {
  /** Set the address the way a browser does, and tell the tab it changed. */
  const address = async (hash: string): Promise<void> => {
    await interact(() => {
      window.location.hash = hash;
      window.dispatchEvent(new Event('hashchange'));
    });
  };

  it('opens on the login a #machines/<m>/sign-ins/<loginId> link names, when the tab mounts', async () => {
    window.location.hash = '#machines/box/sign-ins/claude-you';
    const view = await mount(<SignInsTab client={scripted({ [LIST]: loginList(login()) })} />);
    await until(() => view.container.querySelector('[data-login-page="claude-you"]') !== null, 'the page');
    expect(view.container.querySelector('[data-login-page]')?.getAttribute('data-login-page')).toBe('claude-you');
    expect(view.container.querySelector('[data-logins-tab]')).toBeNull();
    await view.unmount();
  });

  it('follows the address while it is open, and a bare sign-ins address opens the list', async () => {
    window.location.hash = '#machines/box/sign-ins';
    const view = await mount(<SignInsTab client={scripted({ [LIST]: loginList(login()) })} />);
    await until(() => view.container.querySelector('[data-logins-tab]') !== null, 'the list');
    await address('#machines/box/sign-ins/claude-you');
    await until(() => view.container.querySelector('[data-login-page="claude-you"]') !== null, 'the page');
    await address('#machines/box/sign-ins');
    await until(() => view.container.querySelector('[data-logins-tab]') !== null, 'the list');
    expect(view.container.querySelector('[data-login-missing]')).toBeNull();
    // Another tab's address names no login: the list stays, and says nothing.
    await address('#machines/box/runtimes/claude-default');
    await until(() => view.container.querySelector('[data-login-page]') === null, 'no page');
    expect(view.container.querySelector('[data-logins-tab]')).not.toBeNull();
    expect(view.container.querySelector('[data-login-missing]')).toBeNull();
    await view.unmount();
  });

  it('keeps today’s notice when the address names a login that is not on the machine', async () => {
    window.location.hash = '#machines/box/sign-ins/claude-gone';
    const view = await mount(<SignInsTab client={scripted({ [LIST]: loginList(login()) })} />);
    await until(() => view.container.querySelector('[data-login-missing]') !== null, 'the notice');
    expect(view.container.querySelector('[data-login-missing]')?.textContent).toBe(
      'There is no login claude-gone on box any more.',
    );
    expect(view.container.querySelectorAll('[data-login-row]')).toHaveLength(1);
    await view.unmount();
  });

  it('writes the address when the tab itself opens a page, and closes it back to the list', async () => {
    window.location.hash = '#machines/box/sign-ins';
    const view = await mount(<SignInsTab client={scripted({ [LIST]: loginList(login()) })} />);
    await until(() => view.container.querySelector('[data-login-row]') !== null, 'the row');
    await click(view.container.querySelector('[data-login-row="claude-you"]'), 'the row');
    expect(window.location.hash).toBe('#machines/box/sign-ins/claude-you');
    await click(view.container.querySelector('[data-page-back]'), 'back');
    expect(window.location.hash).toBe('#machines/box/sign-ins');
    await view.unmount();
  });
});

describe('the sign-in panel mounted by itself', () => {
  it('draws the sign-in for the login its subject names, and refuses one of the other harness', async () => {
    const client = scripted({ [LIST]: loginList(needsSignIn()) });
    const view = await mount(<LoginSignInPanel client={client} harness="claude-code" subject="claude-you" />);
    await until(() => view.container.querySelector('[data-login-sign-in]') !== null, 'the sign-in');
    expect(view.container.querySelector('[data-login-sign-in="start"]')).not.toBeNull();
    await view.unmount();

    const other = await mount(<LoginSignInPanel client={client} harness="codex" subject="claude-you" />);
    await until(() => other.container.querySelector('[data-login-sign-in-panel="none"]') !== null, 'the refusal');
    expect(other.container.textContent).toContain('There is no Codex login claude-you on box.');
    await other.unmount();
  });
});

const STAGE = 'POST /v1/logins/changes';
const APPLY = 'POST /v1/logins/changes/:changeId/apply';
const staged = (change: unknown, extra: Record<string, unknown> = {}) => ({
  id: 'chg1',
  change,
  summary: 'Do it',
  consequences: ['It changes something.'],
  expiresAt: '2026-11-01T10:15:00.000Z',
  state: 'pending',
  ...extra,
});

const PRESET = {
  id: 'zai-glm',
  label: 'GLM / Z.ai',
  harness: 'claude-code',
  summary: 'Claude Code on GLM.',
  docs: 'https://docs.example.test',
  origin: 'built-in',
  variables: [
    {
      name: 'ZAI_KEY',
      kind: 'secret',
      secret: 'ZAI_KEY',
      required: true,
      allowEmpty: false,
      harnesses: ['claude-code'],
    },
  ],
  models: [],
  test: { available: true, spends: 'nothing', note: 'Free.' },
  quota: { source: 'none', note: 'n/a' },
  unverified: [],
  verified: '2026-10-16',
  offered: { available: true },
  halves: [{ harness: 'claude-code', offered: { available: true }, models: [] }],
};

describe('the add-login panel', () => {
  it('lists the offered presets, and says why one is not offered', async () => {
    const client = scripted({
      'GET /v1/logins/presets': {
        presets: [PRESET, { ...PRESET, id: 'nope', label: 'Nope', offered: { available: false, reason: 'not yet' } }],
      },
    });
    const view = await mount(<AddLoginPanel client={client} />);
    await until(() => view.container.querySelector('[data-add-login-preset]') !== null, 'the preset');
    expect(view.container.querySelector('[data-add-login-preset="zai-glm"]')?.textContent).toContain('GLM / Z.ai');
    expect(view.container.querySelector('[data-add-login-preset="nope"]')?.textContent).toContain(
      'Not offered: not yet',
    );
    await view.unmount();
  });

  it('adds a sign-in login through the change routes and tells the screen which one', async () => {
    const calls: Call[] = [];
    const added: string[] = [];
    const client = scripted(
      {
        'GET /v1/logins/presets': { presets: [] },
        [LIST]: loginList(login({ id: 'claude-login' })),
        [GRANTS]: OPEN,
        [STAGE]: staged({ kind: 'login.add', id: 'claude-login-2', harness: 'claude-code' }),
        [APPLY]: { outcome: 'applied' },
      },
      calls,
    );
    const view = await mount(<AddLoginPanel client={client} onAdded={id => added.push(id)} />);
    await click(view.container.querySelector('[data-add-login-sign-in] [data-change-submit]'), 'Add');
    await until(() => added.length > 0, 'the login to be added');
    expect(added).toEqual(['claude-login-2']);
    expect(calls.find(call => call.route === STAGE)?.body).toEqual({
      kind: 'login.add',
      id: 'claude-login-2',
      harness: 'claude-code',
    });
    expect(calls.find(call => call.route === APPLY)?.params).toEqual({ changeId: 'chg1' });
    await view.unmount();
  });

  it('adds a login from a provider with its secret as a reference, never a value', async () => {
    const calls: Call[] = [];
    const added: string[] = [];
    const client = scripted(
      {
        'GET /v1/logins/presets': { presets: [PRESET] },
        [LIST]: loginList(),
        [GRANTS]: OPEN,
        [STAGE]: staged({ kind: 'login.enable', id: 'x' }),
        [APPLY]: { outcome: 'applied' },
      },
      calls,
    );
    const view = await mount(<AddLoginPanel client={client} onAdded={id => added.push(id)} />);
    await until(() => view.container.querySelector('[data-add-login-use]') !== null, 'the provider');
    await click(view.container.querySelector('[data-add-login-use="zai-glm"]'), 'Use this provider');
    const field = must(
      view.container.querySelector<HTMLInputElement>('[data-add-login-form="zai-glm"] input'),
      'the secret variable',
    );
    expect(field.value).toBe('${secret:ZAI_KEY}');
    await click(view.container.querySelector('[data-add-login-form="zai-glm"] [data-change-submit]'), 'Add');
    await until(() => added.length > 0, 'the login to be added');
    expect(calls.find(call => call.route === STAGE)?.body).toEqual({
      kind: 'login.add',
      id: 'claude-zai-glm',
      harness: 'claude-code',
      store: 'environment',
      preset: 'zai-glm',
      env: { ZAI_KEY: '${secret:ZAI_KEY}' },
    });
    await view.unmount();
  });

  it('shows the daemon’s refusal in its own words and adds nothing when it refuses', async () => {
    const added: string[] = [];
    const refused = Object.assign(new Error('claude-login is already a login on this machine. Use claude-login-2?'), {
      status: 409,
      code: 'login_change_refused',
    });
    const client = scripted({
      'GET /v1/logins/presets': { presets: [] },
      [LIST]: loginList(),
      [GRANTS]: OPEN,
      [STAGE]: refused,
    });
    const view = await mount(<AddLoginPanel client={client} onAdded={id => added.push(id)} />);
    await click(view.container.querySelector('[data-add-login-sign-in] [data-change-submit]'), 'Add');
    await until(() => view.container.querySelector('[data-change-refusal]') !== null, 'the refusal');
    expect(view.container.querySelector('[data-change-refusal]')?.textContent).toContain('is already a login');
    expect(added).toEqual([]);
    await view.unmount();
  });
});
