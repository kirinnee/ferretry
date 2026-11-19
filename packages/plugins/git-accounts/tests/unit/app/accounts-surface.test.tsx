/**
 * B2: the GitHub accounts screen, driven through the real surface over a scripted daemon (fake data, no network): the
 * list, the consent words BEFORE any code is asked for, the code card with its countdown and copy, the poll to done /
 * expired / denied, and Remove. Nothing in what is drawn can carry a token.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { AccountsSurface } from '../../../app/features/accounts/accounts-surface.tsx';
import { buttonNamed, click, interact, mount, q, settle, settleUntil } from '../../support/app-dom.ts';
import {
  EXPIRES,
  FAKE_USER_CODE,
  type Call,
  hubot,
  NOW,
  octo,
  type ScriptOptions,
  scriptedGithub,
  stepUpRefusal,
} from '../../support/scripted-github.ts';

const mounts: Array<{ unmount: () => Promise<void> }> = [];
afterEach(async () => {
  while (mounts.length > 0) await mounts.pop()?.unmount();
});

async function open(options: ScriptOptions = {}) {
  const script = scriptedGithub(options);
  const mounted = await mount(<AccountsSurface client={script.client} pollDelay={() => 5} now={() => NOW} />);
  mounts.push(mounted);
  await settle();
  return { ...script, root: mounted.container };
}

const posted = (calls: readonly { route: string }[]) =>
  calls.filter(c => c.route === 'POST /v1/git-accounts/github/device');

describe('the accounts list', () => {
  it('says there are none, with a Connect button', async () => {
    const { root } = await open();
    expect(q(root, '[data-testid="git-accounts-empty"]').textContent).toContain('No GitHub account');
    expect(buttonNamed(root, 'Connect a GitHub account')).toBeTruthy();
  });

  it('lists each account by login with which keys it has, and offers another connection', async () => {
    const { root } = await open({ accounts: [octo, hubot] });
    const first = q(root, `[data-account="${octo.id}"]`);
    expect(first.textContent).toContain('@octo-fake');
    expect(first.querySelector('[data-key-chip="SSH key"]')?.getAttribute('data-on')).toBe('yes');
    expect(first.querySelector('[data-key-chip="Signing key"]')?.getAttribute('data-on')).toBe('yes');
    const second = q(root, `[data-account="${hubot.id}"]`);
    expect(second.querySelector('[data-key-chip="SSH key"]')?.getAttribute('data-on')).toBe('no');
    expect(buttonNamed(root, 'Connect another GitHub account')).toBeTruthy();
    // No remote image is drawn (the app's CSP allows none), only a letter.
    expect(root.querySelector('img')).toBeNull();
  });

  it('says a failed read is a failed read, not an empty list', async () => {
    const { root } = await open({ failures: { 'GET /v1/git-accounts': new Error('daemon said no') } });
    expect(root.textContent).toContain('GitHub accounts unavailable');
    expect(root.textContent).toContain('daemon said no');
    expect(root.querySelector('[data-testid="git-accounts-empty"]')).toBeNull();
  });

  it('offers the passkey button when the read wants the step-up', async () => {
    const { root } = await open({
      failures: {
        'GET /v1/git-accounts': Object.assign(new Error('step up'), { status: 403, code: 'grant_step_up_required' }),
      },
    });
    expect(root.textContent).toContain('Confirm it’s you to see this');
  });

  it('refuses a list that carries a token field rather than draw any of it', async () => {
    const { root } = await open({ accounts: [{ ...octo, accessToken: 'gho_FAKE' } as never] });
    expect(root.textContent).toContain('GitHub accounts unavailable');
    expect(root.innerHTML).not.toContain('gho_FAKE');
  });
});

describe('connecting an account', () => {
  it('shows the consent words first and asks GitHub for nothing until Continue', async () => {
    const { root, calls } = await open();
    await click(buttonNamed(root, 'Connect a GitHub account'));
    const consent = q(root, '[data-testid="git-consent"]');
    expect(consent.textContent).toContain('What Ferretry asks GitHub for');
    for (const scope of ['read:user', 'user:email', 'write:public_key', 'write:ssh_signing_key', 'repo', 'read:org'])
      expect(consent.textContent, scope).toContain(scope);
    expect(consent.textContent).toContain('every repository you can reach');
    expect(posted(calls)).toHaveLength(0);
    expect(root.querySelector('[data-testid="git-user-code"]')).toBeNull();

    await click(buttonNamed(root, 'Cancel'));
    expect(root.querySelector('[data-testid="git-consent"]')).toBeNull();
    expect(posted(calls)).toHaveLength(0);
  });

  it('shows the code large with Copy code, the github link and a countdown, then connects on done', async () => {
    const copied: string[] = [];
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
    const { root, accounts } = await open({
      polls: [
        { status: 'pending', interval: 1 },
        { status: 'slow_down', interval: 2 },
        { status: 'done', accountId: hubot.id, login: hubot.login },
      ],
      connects: hubot,
    });
    await click(buttonNamed(root, 'Connect a GitHub account'));
    await click(buttonNamed(root, 'Continue to GitHub'));
    await settle();

    expect(q(root, '[data-testid="git-user-code"]').textContent).toBe(FAKE_USER_CODE);
    expect(q(root, '[data-testid="git-countdown"]').textContent).toBe('15:00');
    expect(q<HTMLAnchorElement>(root, 'a').getAttribute('href')).toBe('https://github.com/login/device');
    expect(q(root, 'a').textContent).toBe('Open github.com/login/device');

    await click(buttonNamed(root, 'Copy code'));
    await settle();
    expect(copied).toEqual([FAKE_USER_CODE]);
    expect(root.textContent).toContain('Copied');

    await settleUntil(() => root.querySelector('[data-testid="git-done"]') !== null);
    expect(q(root, '[data-testid="git-done"]').textContent).toContain('Connected @hubot-fake');
    expect(accounts.map(each => each.id)).toEqual([hubot.id]);
    expect(q(root, `[data-account="${hubot.id}"]`).textContent).toContain('@hubot-fake');
    // The page only ever held the user code, never GitHub's device code or a token.
    expect(root.innerHTML).not.toMatch(/device_code|gho_|access_token/u);
  });

  it('does not link an address that is not github.com, and says where to go instead', async () => {
    const { root } = await open({ verificationUri: 'https://github.com.evil.example/login/device' });
    await click(buttonNamed(root, 'Connect a GitHub account'));
    await click(buttonNamed(root, 'Continue to GitHub'));
    await settle();
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toContain('github.com/login/device');
  });

  it('says so when the code expires and offers to try again', async () => {
    const { root } = await open({ polls: [{ status: 'expired' }] });
    await click(buttonNamed(root, 'Connect a GitHub account'));
    await click(buttonNamed(root, 'Continue to GitHub'));
    await settleUntil(() => root.querySelector('[data-testid="git-expired"]') !== null);
    expect(q(root, '[data-testid="git-expired"]').textContent).toContain('ran out of time');
    expect(buttonNamed(root, 'Try again')).toBeTruthy();
  });

  it('says so when GitHub denies it, and connects nothing', async () => {
    const { root, accounts } = await open({ polls: [{ status: 'denied' }] });
    await click(buttonNamed(root, 'Connect a GitHub account'));
    await click(buttonNamed(root, 'Continue to GitHub'));
    await settleUntil(() => root.querySelector('[data-testid="git-denied"]') !== null);
    expect(q(root, '[data-testid="git-denied"]').textContent).toContain('said no');
    expect(accounts).toHaveLength(0);
  });

  it('shows a refusal to start in the page’s words', async () => {
    const { root } = await open({
      failures: {
        'POST /v1/git-accounts/github/device': Object.assign(new Error('x'), { code: 'provider_unreachable' }),
      },
    });
    await click(buttonNamed(root, 'Connect a GitHub account'));
    await click(buttonNamed(root, 'Continue to GitHub'));
    await settle();
    expect(q(root, '[data-testid="git-error"]').textContent).toContain('could not reach GitHub');
  });

  it('stops waiting when the code’s own clock has run out, without asking the daemon again', async () => {
    const script = scriptedGithub();
    let clock = NOW;
    const mounted = await mount(<AccountsSurface client={script.client} pollDelay={() => 5} now={() => clock} />);
    mounts.push(mounted);
    await settle();
    await click(buttonNamed(mounted.container, 'Connect a GitHub account'));
    await click(buttonNamed(mounted.container, 'Continue to GitHub'));
    clock = Date.parse(EXPIRES) + 1;
    await settleUntil(() => mounted.container.querySelector('[data-testid="git-expired"]') !== null);
    expect(mounted.container.querySelector('[data-testid="git-expired"]')).not.toBeNull();
    expect(script.calls.filter(c => c.route.startsWith('GET /v1/git-accounts/github/device'))).toHaveLength(0);
  });
});

const polls = (calls: readonly Call[]) => calls.filter(c => c.route === 'GET /v1/git-accounts/github/device/:flowId');

/** Opens the code card on a daemon that wants the passkey for every unattended poll, and waits for the button. */
async function waitForStepUp(options: ScriptOptions) {
  const opened = await open({ pollNeedsPress: true, ...options });
  await click(buttonNamed(opened.root, 'Connect a GitHub account'));
  await click(buttonNamed(opened.root, 'Continue to GitHub'));
  await settleUntil(() => opened.root.querySelector('[data-testid="git-step-up"]') !== null);
  return opened;
}

describe('failures along the way', () => {
  it('says a failed poll in the page’s words, not as a lost step-up', async () => {
    const { root } = await open({
      failures: {
        'GET /v1/git-accounts/github/device/:flowId': Object.assign(new Error('x'), { code: 'provider_refused' }),
      },
    });
    await click(buttonNamed(root, 'Connect a GitHub account'));
    await click(buttonNamed(root, 'Continue to GitHub'));
    await settleUntil(() => root.querySelector('[data-testid="git-error"]') !== null);
    expect(q(root, '[data-testid="git-error"]').textContent).toContain('GitHub refused');
    expect(root.querySelector('[data-testid="git-step-up"]')).toBeNull();
  });

  it('says so when the clipboard is blocked', async () => {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => Promise.reject(new Error('blocked')) },
    });
    const { root } = await open();
    await click(buttonNamed(root, 'Connect a GitHub account'));
    await click(buttonNamed(root, 'Continue to GitHub'));
    await click(buttonNamed(root, 'Copy code'));
    await settle();
    expect(root.textContent).toContain('Copy was blocked');
  });

  it('says a failed re-read after connecting as a failure, not an empty list', async () => {
    const { root } = await open({
      listReadsBeforeFailing: 1,
      polls: [{ status: 'done', accountId: hubot.id, login: hubot.login }],
      connects: hubot,
    });
    await click(buttonNamed(root, 'Connect a GitHub account'));
    await click(buttonNamed(root, 'Continue to GitHub'));
    await settleUntil(() => root.textContent?.includes('GitHub accounts unavailable') === true);
    expect(root.textContent).toContain('list gone');
  });

  it('says a failed removal', async () => {
    const { root } = await open({
      accounts: [octo],
      failures: { 'DELETE /v1/git-accounts/:id': new Error('could not remove') },
    });
    await click(buttonNamed(root, 'Remove @octo-fake'));
    await click(buttonNamed(root, 'Remove @octo-fake'));
    await settle();
    expect(q(root, '[role="alert"]').textContent).toContain('could not remove');
  });
});

describe('a daemon that wants the passkey for every step (per-action confirmation)', () => {
  it('keeps the code on screen, stops polling, and finishes the SAME flow on a press', async () => {
    const { root, calls, accounts } = await waitForStepUp({
      polls: [{ status: 'done', accountId: hubot.id, login: hubot.login }],
      connects: hubot,
    });
    // The unattended poll was refused: the code, its countdown and the one button are still there.
    expect(q(root, '[data-testid="git-user-code"]').textContent).toBe(FAKE_USER_CODE);
    expect(root.querySelector('[data-testid="git-error"]')).toBeNull();
    expect(buttonNamed(root, 'Confirm with your passkey to finish')).toBeTruthy();
    expect(buttonNamed(root, 'Copy code')).toBeTruthy();

    // Polling has stopped: no second unattended poll, however long the page waits, and no passkey dialog was asked.
    await settle(40);
    expect(polls(calls)).toHaveLength(1);
    expect(polls(calls)[0]?.init?.quiet).toBeUndefined();

    await click(buttonNamed(root, 'Confirm with your passkey to finish'));
    await settleUntil(() => root.querySelector('[data-testid="git-done"]') !== null);
    expect(q(root, '[data-testid="git-done"]').textContent).toContain('Connected @hubot-fake');
    // One flow, ever: the press polled the flow it had, it never started another.
    expect(posted(calls)).toHaveLength(1);
    expect(polls(calls)).toHaveLength(2);
    expect(polls(calls)[1]?.init).toEqual({ params: { flowId: 'flow_0123456789abcdef' }, quiet: false });
    expect(accounts.map(each => each.id)).toEqual([hubot.id]);
  });

  it('keeps polling the same flow after the press while GitHub is still waiting', async () => {
    const { root, calls } = await waitForStepUp({ polls: [{ status: 'pending', interval: 1 }] });
    await click(buttonNamed(root, 'Confirm with your passkey to finish'));
    await settle();
    // The press was answered `pending`: the button goes, the code stays, and unattended polling resumes.
    expect(root.querySelector('[data-testid="git-step-up"]')).toBeNull();
    expect(q(root, '[data-testid="git-user-code"]').textContent).toBe(FAKE_USER_CODE);
    await settleUntil(() => polls(calls).length >= 3);
    expect(posted(calls)).toHaveLength(1);
  });

  it('leaves the code and the button where they were when the prompt is cancelled', async () => {
    const { root, calls } = await waitForStepUp({
      cancelledPresses: 1,
      polls: [{ status: 'done', accountId: hubot.id, login: hubot.login }],
      connects: hubot,
    });
    await click(buttonNamed(root, 'Confirm with your passkey to finish'));
    await settle();
    expect(q(root, '[data-testid="git-user-code"]').textContent).toBe(FAKE_USER_CODE);
    expect(buttonNamed(root, 'Confirm with your passkey to finish')).toBeTruthy();
    expect(root.querySelector('[data-testid="git-error"]')).toBeNull();
    await click(buttonNamed(root, 'Confirm with your passkey to finish'));
    await settleUntil(() => root.querySelector('[data-testid="git-done"]') !== null);
    expect(posted(calls)).toHaveLength(1);
  });

  it('says a failed press in the page’s words', async () => {
    const { root } = await waitForStepUp({
      pressedFailure: Object.assign(new Error('x'), { code: 'provider_unreachable' }),
    });
    await click(buttonNamed(root, 'Confirm with your passkey to finish'));
    await settleUntil(() => root.querySelector('[data-testid="git-error"]') !== null);
    expect(q(root, '[data-testid="git-error"]').textContent).toContain('could not reach GitHub');
  });

  it('ignores a press that answers after the person cancelled the connection', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const { root } = await waitForStepUp({
      pressedGate: gate,
      polls: [{ status: 'done', accountId: hubot.id, login: hubot.login }],
      connects: hubot,
    });
    await click(buttonNamed(root, 'Confirm with your passkey to finish'));
    await click(buttonNamed(root, 'Cancel'));
    release();
    await settle(10);
    expect(root.querySelector('[data-testid="git-done"]')).toBeNull();
    expect(root.querySelector('[data-testid="git-code-card"]')).toBeNull();
  });

  it('ignores a press that FAILS after the person cancelled the connection', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const { root } = await waitForStepUp({ pressedGate: gate, pressedFailure: stepUpRefusal() });
    await click(buttonNamed(root, 'Confirm with your passkey to finish'));
    await click(buttonNamed(root, 'Cancel'));
    release();
    await settle(10);
    expect(root.querySelector('[data-testid="git-step-up"]')).toBeNull();
    expect(root.querySelector('[data-testid="git-error"]')).toBeNull();
  });

  it('drops the code at its own expiry while the page waits for the press', async () => {
    let clock = NOW;
    const script = scriptedGithub({ pollNeedsPress: true });
    const mounted = await mount(<AccountsSurface client={script.client} pollDelay={() => 5} now={() => clock} />);
    mounts.push(mounted);
    await settle();
    await click(buttonNamed(mounted.container, 'Connect a GitHub account'));
    // The code is good for another 60ms when it arrives.
    clock = Date.parse(EXPIRES) - 60;
    await click(buttonNamed(mounted.container, 'Continue to GitHub'));
    await settleUntil(() => mounted.container.querySelector('[data-testid="git-step-up"]') !== null, 5);
    await settleUntil(() => mounted.container.querySelector('[data-testid="git-expired"]') !== null);
    expect(mounted.container.querySelector('[data-testid="git-user-code"]')).toBeNull();
    expect(mounted.container.querySelector('[data-testid="git-step-up"]')).toBeNull();
    expect(q(mounted.container, '[data-testid="git-expired"]').textContent).toContain('ran out of time');
    expect(buttonNamed(mounted.container, 'Try again')).toBeTruthy();
  });
});

describe('a code that expires between two polls', () => {
  it('goes at its own expiry, not at the next scheduled poll, and offers Try again', async () => {
    let clock = NOW;
    const script = scriptedGithub();
    // The poll interval (an hour) far outlasts the code's last 50ms.
    const mounted = await mount(
      <AccountsSurface client={script.client} pollDelay={() => 3_600_000} now={() => clock} />,
    );
    mounts.push(mounted);
    await settle();
    await click(buttonNamed(mounted.container, 'Connect a GitHub account'));
    clock = Date.parse(EXPIRES) - 50;
    await click(buttonNamed(mounted.container, 'Continue to GitHub'));
    expect(mounted.container.querySelector('[data-testid="git-user-code"]')).not.toBeNull();
    await settleUntil(() => mounted.container.querySelector('[data-testid="git-expired"]') !== null);
    expect(mounted.container.querySelector('[data-testid="git-user-code"]')).toBeNull();
    expect(q(mounted.container, '[data-testid="git-expired"]').textContent).toContain('ran out of time');
    expect(buttonNamed(mounted.container, 'Try again')).toBeTruthy();
    expect(polls(script.calls)).toHaveLength(0);
  });
});

describe('removing an account', () => {
  it('asks twice, says what it deletes, then removes it and says how to revoke the app', async () => {
    const { root, calls, accounts } = await open({ accounts: [octo, hubot], keysLeftOnProvider: ['Ferretry laptop'] });
    await click(buttonNamed(root, 'Remove @octo-fake'));
    expect(root.textContent).toContain('deletes the keys Ferretry registered');
    expect(calls.some(c => c.route === 'DELETE /v1/git-accounts/:id')).toBe(false);

    await click(buttonNamed(root, 'Keep it'));
    expect(root.textContent).not.toContain('deletes the keys Ferretry registered');

    await click(buttonNamed(root, 'Remove @octo-fake'));
    await interact(async () => {
      buttonNamed(root, 'Remove @octo-fake').click();
    });
    await settle();
    const removed = q(root, '[data-testid="git-removed"]');
    expect(removed.textContent).toContain('Removed @octo-fake');
    expect(removed.textContent).toContain('Ferretry laptop');
    expect(removed.textContent).toContain('github.com/settings/applications');
    expect(accounts.map(each => each.id)).toEqual([hubot.id]);
    expect(root.querySelector(`[data-account="${octo.id}"]`)).toBeNull();
    expect(calls.find(c => c.route === 'DELETE /v1/git-accounts/:id')?.init?.params).toEqual({ id: octo.id });
  });
});
