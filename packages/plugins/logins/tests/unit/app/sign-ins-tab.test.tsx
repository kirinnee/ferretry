import { describe, expect, it } from 'bun:test';
import { AddLoginPanel } from '../../../app/features/add-login-panel.tsx';
import { LoginSignInPanel } from '../../../app/features/login-sign-in-panel.tsx';
import { QuotaReadout } from '../../../app/features/quota-readout.tsx';
import { SignInsTab } from '../../../app/features/sign-ins-tab.tsx';
import { login, loginList } from '../cli/fakes.ts';
import { interact, mount, must } from '../support/dom.ts';
import { type Call, scripted } from './support/client.ts';
import { CLAUDE_URL, claudeFlow } from './support/harness-login.ts';

const LIST = 'GET /v1/logins';
const START = 'POST /v1/logins/sign-in';
const SUBMIT = 'POST /v1/logins/sign-in/:flowId';

const until = async (shown: () => boolean, what: string): Promise<void> => {
  for (let elapsed = 0; elapsed < 2_000 && !shown(); elapsed += 10)
    await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
  if (!shown()) throw new Error(`never shown: ${what}`);
};

const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
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
    expect(c.querySelector('[data-login-changes-note]')?.textContent).toContain('not available from this screen yet');
    await click(c.querySelector('[data-login-row="claude-you"]'), 'the row');
    expect(c.querySelector('[data-login-page="claude-you"]')).not.toBeNull();
    await click(c.querySelector('[data-page-back]'), 'back');
    expect(c.querySelector('[data-logins-tab]')).not.toBeNull();
    expect(calls.map(call => call.route)).toEqual([LIST]);
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
    const client = scripted({ [LIST]: loginList(login()), 'POST /v1/logins/:loginId/check': login() }, calls);
    const view = await mount(<SignInsTab client={client} />);
    await until(() => view.container.querySelector('[data-login-row]') !== null, 'the row');
    await click(view.container.querySelector('[data-login-row]'), 'the row');
    await click(view.container.querySelector('[data-login-check]'), 'Check now');
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

describe('the add-login panel and the readout', () => {
  it('lists the offered presets and says adding is not available here yet', async () => {
    const preset = {
      id: 'zai-glm',
      label: 'GLM / Z.ai',
      harness: 'claude-code',
      summary: 'Claude Code on GLM.',
      docs: 'https://docs.example.test',
      origin: 'built-in',
      variables: [],
      models: [],
      test: { available: true, spends: 'nothing', note: 'Free.' },
      quota: { source: 'none', note: 'n/a' },
      unverified: [],
      verified: '2026-10-16',
      offered: { available: true },
      halves: [{ harness: 'claude-code', offered: { available: true }, models: [] }],
    };
    const client = scripted({ 'GET /v1/logins/presets': { presets: [preset] } });
    const view = await mount(<AddLoginPanel client={client} />);
    await until(() => view.container.querySelector('[data-add-login-preset]') !== null, 'the preset');
    expect(view.container.querySelector('[data-add-login-note]')?.textContent).toContain(
      'not available from this screen yet',
    );
    expect(view.container.querySelector('[data-add-login-preset="zai-glm"]')?.textContent).toContain('GLM / Z.ai');
    await view.unmount();
  });

  it('reads out how many logins are ready, or that some need signing in', async () => {
    const view = await mount(<QuotaReadout client={scripted({ [LIST]: loginList(login(), needsSignIn('b')) })} />);
    await until(() => view.container.querySelector('[data-quota-readout]') !== null, 'the readout');
    expect(view.container.textContent).toContain('1 login needs sign-in');
    await view.unmount();
  });
});
