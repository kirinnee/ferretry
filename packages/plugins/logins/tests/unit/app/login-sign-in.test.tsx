import { describe, expect, it } from 'bun:test';
import { LoginSignIn } from '../../../app/features/login-sign-in.tsx';
import type { HarnessLoginFlow } from '../../../contract/index.ts';
import { login as loginFixture } from '../cli/fakes.ts';
import { interact, mount, must } from '../support/dom.ts';
import { type Call, scripted } from './support/client.ts';
import { claudeFlow as baseClaudeFlow } from './support/harness-login.ts';

const LOGIN = 'POST /v1/logins/sign-in';
const FLOW_GET = 'GET /v1/logins/sign-in/:flowId';
const FLOW_POST = 'POST /v1/logins/sign-in/:flowId';
const FLOW_DELETE = 'DELETE /v1/logins/sign-in/:flowId';
const GRANTS = 'GET /v1/grants';
const OPEN = { capabilities: [{ capability: 'fleet', use: true, configure: true, configureRefusal: 'granted' }] };

/** A refusal as the shell's client throws it: a status and a code, the daemon's sentence as the message. */
const refusal = (message: string, status: number, code: string): Error =>
  Object.assign(new Error(message), { status, code });

/** A login as the list gives it, by the fields these suites vary. */
const login = (overrides: Record<string, unknown> = {}) =>
  loginFixture({ id: 'claude-work', label: 'work', usedBy: ['claude-work'], ...overrides });

const WORK = login();
const CODEX = login({
  id: 'codex',
  label: undefined,
  harness: 'codex',
  harnesses: ['codex'],
  usedBy: ['codex-default'],
});

/** The daemon's Claude flow, for the login these suites sign in. */
const claudeFlow = (state: Parameters<typeof baseClaudeFlow>[0]): HarnessLoginFlow =>
  ({ ...baseClaudeFlow(state), loginId: 'claude-work' }) as unknown as HarnessLoginFlow;

const codexFlow = (state: 'awaiting-approval' | 'complete', loginId = 'codex'): HarnessLoginFlow => {
  const base = {
    harness: 'codex' as const,
    flowId: 'flow-1',
    loginId,
    identity: 'codex:you@example.com',
    startedAt: '2026-10-13T08:00:00.000Z',
    expiresAt: '2026-10-13T08:10:00.000Z',
  };
  return (state === 'complete'
    ? { ...base, state }
    : {
        ...base,
        state,
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: '0IER-FFQW6',
      }) as unknown as HarnessLoginFlow;
};

// One act per slice: a state change inside an act only commits (and so re-arms the poll) when that act ends.
const wait = async (ms: number): Promise<void> => {
  for (let elapsed = 0; elapsed < ms; elapsed += 10)
    await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
};

const settle = async (): Promise<void> => {
  await wait(30);
};

const type = async (field: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

/** A click waits for the button to be offered: a change button is held until the grants say what this caller may do. */
const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  for (let elapsed = 0; elapsed < 2_000 && (target as HTMLButtonElement).disabled; elapsed += 10) await wait(10);
  await interact(() => target.click());
};

const button = (container: HTMLElement, label: string): HTMLButtonElement =>
  must(
    Array.from(container.querySelectorAll('button')).find(candidate => candidate.textContent?.trim() === label),
    `the "${label}" button`,
  );

const text = (container: HTMLElement, selector: string): string | undefined =>
  container.querySelector(selector)?.textContent ?? undefined;

const state = (container: HTMLElement): string | null | undefined =>
  container.querySelector('[data-login-sign-in]')?.getAttribute('data-login-sign-in');

interface OpenProps {
  readonly login?: ReturnType<typeof login>;
  readonly pollMs?: number;
}

const open = async (routes: Record<string, unknown>, props: OpenProps = {}) => {
  const calls: Call[] = [];
  const signedIn: string[] = [];
  const client = scripted({ [GRANTS]: OPEN, ...routes }, calls);
  const view = await mount(
    <LoginSignIn
      login={props.login ?? WORK}
      machineName="studio-mac"
      client={client}
      onSignedIn={() => signedIn.push('signed-in')}
      {...(props.pollMs === undefined ? {} : { pollMs: props.pollMs })}
    />,
  );
  await settle();
  return { view, calls, signedIn };
};

const only = (calls: readonly Call[], key: string): Call[] => calls.filter(call => call.route === key);

describe('LoginSignIn', () => {
  it('says why a sign-in does not apply, and offers none', async () => {
    const env = login({
      id: 'claude-env',
      signIn: {
        available: false,
        reason: 'This login comes from an environment variable, so there is nothing to sign in to.',
      },
    });
    const { view } = await open({}, { login: env });
    expect(state(view.container)).toBe('unavailable');
    expect(view.container.textContent).toBe(
      'This login comes from an environment variable, so there is nothing to sign in to.',
    );
    expect(view.container.querySelector('button')).toBeNull();
    await view.unmount();
  });

  it('starts with nothing owed, takes the code back, and tells the caller once', async () => {
    const { view, calls, signedIn } = await open({
      [LOGIN]: claudeFlow('awaiting-code'),
      [FLOW_POST]: { outcome: 'accepted', flow: claudeFlow('complete') },
    });
    expect(state(view.container)).toBe('start');
    expect(text(view.container, 'p.font-semibold')).toBe('Sign in to Claude Code');
    expect(view.container.textContent).toContain(
      'The login is kept on studio-mac. Every runtime that uses it (1 runtime) can launch once it is done.',
    );
    expect(view.container.querySelector('[data-change-step-up]')).toBeNull();
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');
    expect(only(calls, LOGIN)).toHaveLength(1);
    expect(only(calls, LOGIN)[0]?.body).toEqual({ loginId: 'claude-work' });

    expect(state(view.container)).toBe('awaiting-code');
    expect(view.container.textContent).toContain('https://claude.com/cai/oauth/authorize?code=true');
    expect(
      view.container.querySelector('[data-claude-login-identity]')?.getAttribute('data-claude-login-identity'),
    ).toBe('claude-work');
    expect(view.container.querySelector('h3')?.textContent).toBe('you@example.com (work)');
    const field = must(view.container.querySelector<HTMLTextAreaElement>('textarea'), 'the code field');
    await type(field, 'the-code-on-the-page');
    await click(button(view.container, 'Finish sign-in'), 'Finish sign-in');

    expect(only(calls, FLOW_POST)).toHaveLength(1);
    expect(only(calls, FLOW_POST)[0]?.body).toEqual({ code: 'the-code-on-the-page' });
    expect(state(view.container)).toBe('complete');
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe('Signed in. 1 runtime can launch now.');
    expect(view.container.textContent).not.toContain('the-code-on-the-page');
    expect(signedIn).toEqual(['signed-in']);
    await view.unmount();
  });

  it('names how many runtimes one sign-in fixes, and shows a refused code and a conflict as the daemon worded them', async () => {
    const shared = login({ id: 'claude-work', usedBy: ['claude-a', 'claude-b', 'claude-c'] });
    let answer: unknown = { outcome: 'refused', reason: 'Claude didn’t take that code. Copy all of it.' };
    const { view, signedIn } = await open(
      { [LOGIN]: claudeFlow('awaiting-code'), [FLOW_POST]: () => answer },
      { login: shared },
    );
    expect(view.container.textContent).toContain('(3 runtimes)');
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');
    const field = must(view.container.querySelector<HTMLTextAreaElement>('textarea'), 'the code field');
    await type(field, 'wrong');
    await click(button(view.container, 'Finish sign-in for 3 runtimes'), 'the finish button');
    expect(text(view.container, '[role="alert"]')).toBe('Claude didn’t take that code. Copy all of it.');
    expect(state(view.container)).toBe('awaiting-code');
    expect(field.value).toBe('');

    answer = { outcome: 'conflict', reason: 'Another sign-in already finished this login.' };
    await type(field, 'again');
    await click(button(view.container, 'Finish sign-in for 3 runtimes'), 'the finish button');
    expect(text(view.container, '[role="alert"]')).toBe('Another sign-in already finished this login.');

    answer = refusal('This machine could not reach Claude.', 502, 'fleet_login_failed');
    await type(field, 'third');
    await click(button(view.container, 'Finish sign-in for 3 runtimes'), 'the finish button');
    expect(text(view.container, '[role="alert"]')).toBe('This machine could not reach Claude.');
    expect(signedIn).toEqual([]);
    await view.unmount();
  });

  it('says a start that fails, and starts again from the harness’s own failed panel', async () => {
    let answer: unknown = refusal('Claude Code is not installed on studio-mac.', 409, 'fleet_login_unavailable');
    const { view, calls } = await open({ [LOGIN]: () => answer });
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');
    expect(state(view.container)).toBe('start');
    expect(text(view.container, '[data-change-refusal]')).toBe('Claude Code is not installed on studio-mac.');

    answer = claudeFlow('failed');
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');
    expect(only(calls, LOGIN)).toHaveLength(2);
    expect(state(view.container)).toBe('failed');
    expect(view.container.textContent).toContain(
      'this host’s claude did not offer a sign-in that can be driven from a browser',
    );
    expect(view.container.textContent).toContain('sign this login in on the host');
    await click(button(view.container, 'Start a new sign-in'), 'Start a new sign-in');
    expect(state(view.container)).toBe('start');
    expect(text(view.container, '[data-change-refusal]')).toBeUndefined();
    await view.unmount();
  });

  describe('a sign-in that finished but whose login was not found', () => {
    const NOT_FOUND = 'the sign-in finished, but no usable login was found for this credential.';
    const missing = (finding: string): HarnessLoginFlow =>
      ({
        harness: 'claude-code',
        flowId: 'flow-1',
        loginId: 'claude-work',
        identity: 'claude:you@example.com',
        startedAt: '2026-10-13T08:00:00.000Z',
        expiresAt: '2026-10-13T08:10:00.000Z',
        state: 'failed',
        reason: `${NOT_FOUND} Checked ${finding}.`,
        remedy: 'Run fy credential signin claude-work.',
        recheck: true,
      }) as unknown as HarnessLoginFlow;
    const ITEM = 'the keychain item "Claude Code-credentials" (account "sam") — nothing there';

    it('says where it looked, and finishes on a second look that finds the login', async () => {
      const { view, calls, signedIn } = await open({
        [LOGIN]: missing(ITEM),
        [FLOW_POST]: { outcome: 'accepted', flow: claudeFlow('complete') },
      });
      await click(view.container.querySelector('[data-change-submit]'), 'the start button');
      expect(state(view.container)).toBe('failed');
      expect(view.container.textContent).toContain(ITEM);

      await click(view.container.querySelector('[data-sign-in-recheck]'), 'Look for the login again');

      expect(only(calls, FLOW_POST)[0]?.body).toEqual({ method: 'recheck' });
      expect(only(calls, LOGIN)).toHaveLength(1);
      expect(state(view.container)).toBe('complete');
      expect(signedIn).toEqual(['signed-in']);
      await view.unmount();
    });

    it('says a second look found nothing again, and shows what that look found', async () => {
      const LATER = 'the file /Users/sam/.claude/.credentials.json — nothing there';
      const { view, calls } = await open({
        [LOGIN]: missing(ITEM),
        [FLOW_POST]: { outcome: 'refused', reason: `${NOT_FOUND} Checked ${LATER}.` },
        [FLOW_GET]: missing(LATER),
      });
      await click(view.container.querySelector('[data-change-submit]'), 'the start button');

      await click(view.container.querySelector('[data-sign-in-recheck]'), 'Look for the login again');

      expect(only(calls, FLOW_GET)).toHaveLength(1);
      expect(state(view.container)).toBe('failed');
      expect(view.container.textContent).toContain('Looked again just now, and there is still no usable login.');
      expect(view.container.textContent).toContain(LATER);
      expect(view.container.querySelector('[data-sign-in-recheck]')).not.toBeNull();
      await view.unmount();
    });

    it('says a second look the machine could not answer', async () => {
      const { view } = await open({
        [LOGIN]: missing(ITEM),
        [FLOW_POST]: refusal('This machine could not look.', 500, 'internal'),
      });
      await click(view.container.querySelector('[data-change-submit]'), 'the start button');

      await click(view.container.querySelector('[data-sign-in-recheck]'), 'Look for the login again');

      expect(view.container.textContent).toContain('This machine could not look.');
      expect(state(view.container)).toBe('failed');
      await view.unmount();
    });

    it('offers no second look on any other ending', async () => {
      const { view } = await open({ [LOGIN]: claudeFlow('failed') });
      await click(view.container.querySelector('[data-change-submit]'), 'the start button');

      expect(view.container.querySelector('[data-sign-in-recheck]')).toBeNull();
      await view.unmount();
    });

    it('offers a second look on a Codex sign-in too', async () => {
      const { view } = await open(
        {
          [LOGIN]: { ...missing(ITEM), harness: 'codex', loginId: 'codex', identity: 'codex:you@example.com' },
          [FLOW_POST]: { outcome: 'accepted', flow: codexFlow('complete') },
        },
        { login: CODEX },
      );
      await click(view.container.querySelector('[data-change-submit]'), 'the start button');

      await click(view.container.querySelector('[data-sign-in-recheck]'), 'Look for the login again');

      expect(state(view.container)).toBe('complete');
      await view.unmount();
    });
  });

  it('shows Codex’s link and device code, re-reads while it waits, and finishes by itself', async () => {
    let reads = 0;
    const { view, calls, signedIn } = await open(
      {
        [LOGIN]: codexFlow('awaiting-approval'),
        [FLOW_GET]: () => {
          reads += 1;
          return reads === 1 ? codexFlow('awaiting-approval') : codexFlow('complete');
        },
      },
      { login: CODEX, pollMs: 5 },
    );
    expect(text(view.container, 'p.font-semibold')).toBe('Sign in to Codex');
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');
    expect(only(calls, LOGIN)[0]?.body).toEqual({ loginId: 'codex' });
    expect(text(view.container, '[data-codex-login-user-code]')).toBe('0IER-FFQW6');
    expect(view.container.textContent).toContain('https://auth.openai.com/codex/device');
    expect(view.container.textContent).toContain('Waiting for the provider.');
    expect(view.container.querySelector('textarea')).toBeNull();

    await wait(80);
    expect(only(calls, FLOW_GET)).toHaveLength(2);
    expect(state(view.container)).toBe('complete');
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe('Signed in. 1 runtime can launch now.');
    expect(signedIn).toEqual(['signed-in']);

    await wait(40);
    expect(only(calls, FLOW_GET)).toHaveLength(2);
    expect(signedIn).toEqual(['signed-in']);
    await view.unmount();
  });

  it('a read that fails while waiting says so and leaves the panel where it was', async () => {
    const { view, calls, signedIn } = await open(
      {
        [LOGIN]: codexFlow('awaiting-approval'),
        [FLOW_GET]: refusal('This machine lost the sign-in.', 404, 'fleet_login_unknown'),
      },
      { login: CODEX, pollMs: 5 },
    );
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');
    await wait(40);
    expect(only(calls, FLOW_GET)).toHaveLength(1);
    expect(state(view.container)).toBe('awaiting-approval');
    expect(text(view.container, '[role="alert"]')).toBe('This machine lost the sign-in.');
    expect(signedIn).toEqual([]);
    await view.unmount();
  });

  it('cancel ends the flow on the machine and goes back to the start, even when the machine does not answer', async () => {
    const { view, calls } = await open({
      [LOGIN]: claudeFlow('awaiting-code'),
      [FLOW_DELETE]: claudeFlow('failed'),
    });
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');
    await click(button(view.container, 'Cancel'), 'Cancel');
    expect(only(calls, FLOW_DELETE)).toHaveLength(1);
    expect(state(view.container)).toBe('start');
    await view.unmount();

    const silent = await open({ [LOGIN]: claudeFlow('awaiting-code') });
    await click(silent.view.container.querySelector('[data-change-submit]'), 'the start button');
    await click(button(silent.view.container, 'Cancel'), 'Cancel');
    expect(only(silent.calls, FLOW_DELETE)).toHaveLength(1);
    expect(state(silent.view.container)).toBe('start');
    await silent.view.unmount();
  });
});

const LINK_URL =
  'https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=s';
const ADDRESS = 'http://localhost:1455/auth/callback?code=code-TESTONLY&state=s';

const codexLink = (state: 'awaiting-callback' | 'finishing' | 'failed', extra: Record<string, unknown> = {}) =>
  ({
    ...codexFlow('complete'),
    state,
    ...(state === 'awaiting-callback' ? { verificationUrl: LINK_URL } : {}),
    ...(state === 'failed' ? { reason: 'the sign-in exited with code 1', remedy: 'try again' } : {}),
    ...extra,
  }) as unknown as HarnessLoginFlow;

describe('LoginSignIn with a Codex link', () => {
  it('offers a link on the start screen and starts with one when chosen', async () => {
    const { view, calls } = await open({ [LOGIN]: codexLink('awaiting-callback') }, { login: CODEX });
    expect(view.container.textContent).toContain('Device code didn’t work?');
    await click(button(view.container, 'Sign in with a link instead'), 'the link choice');
    expect(view.container.textContent).toContain('Sign in to Codex with a link');
    await click(button(view.container, 'Use a device code instead'), 'the device choice');
    expect(view.container.querySelector('[data-login-sign-in-method]')?.getAttribute('data-login-sign-in-method')).toBe(
      'device-code',
    );
    await click(button(view.container, 'Sign in with a link instead'), 'the link choice');
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');

    expect(only(calls, LOGIN)[0]?.body).toEqual({ loginId: 'codex', method: 'link' });
    expect(state(view.container)).toBe('awaiting-callback');
    await view.unmount();
  });

  it('never offers a link for Claude, and never sends a method for it', async () => {
    const { view, calls } = await open({ [LOGIN]: claudeFlow('awaiting-code') });
    expect(view.container.querySelector('[data-login-sign-in-method]')).toBeNull();
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');
    expect(only(calls, LOGIN)[0]?.body).toEqual({ loginId: 'claude-work' });
    await view.unmount();
  });

  it('moves a device code to a link in the same flow, then hands the address over and finishes', async () => {
    // The daemon's answer to a re-read follows what was sent, so the poll can never run ahead of the person.
    let stage: HarnessLoginFlow = codexFlow('awaiting-approval');
    let delivered = 0;
    const { view, calls, signedIn } = await open(
      {
        [LOGIN]: codexFlow('awaiting-approval'),
        [FLOW_POST]: (call: Call) => {
          stage = 'method' in (call.body as object) ? codexLink('awaiting-callback') : codexLink('finishing');
          return { outcome: 'accepted', flow: stage };
        },
        [FLOW_GET]: () => {
          if (stage.state === 'finishing') delivered += 1;
          return delivered > 1 ? codexFlow('complete') : stage;
        },
      },
      { login: CODEX, pollMs: 5 },
    );
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');
    await click(button(view.container, 'Sign in with a link instead'), 'the switch');
    expect(only(calls, FLOW_POST)[0]?.body).toEqual({ method: 'link' });
    expect(state(view.container)).toBe('awaiting-callback');

    await type(must(view.container.querySelector('textarea'), 'the address field'), ADDRESS);
    await click(button(view.container, 'Finish sign-in'), 'Finish sign-in');
    expect(only(calls, FLOW_POST)[1]?.body).toEqual({ code: ADDRESS });
    expect(view.container.textContent).toContain('Codex is finishing the sign-in…');
    expect(view.container.innerHTML).not.toContain('code-TESTONLY');

    // Waits for the outcome rather than for a fixed time, so a slow machine cannot outrun it.
    for (let slice = 0; slice < 300 && state(view.container) !== 'complete'; slice += 1) await wait(10);
    expect(state(view.container)).toBe('complete');
    expect(signedIn).toEqual(['signed-in']);
    await view.unmount();
  });

  it('shows a refused or failed switch in the daemon’s words', async () => {
    const refused = await open(
      {
        [LOGIN]: codexFlow('awaiting-approval'),
        [FLOW_POST]: { outcome: 'conflict', reason: 'this sign-in is already using a link' },
      },
      { login: CODEX },
    );
    await click(refused.view.container.querySelector('[data-change-submit]'), 'the start button');
    await click(button(refused.view.container, 'Sign in with a link instead'), 'the switch');
    expect(refused.view.container.textContent).toContain('this sign-in is already using a link');
    await refused.view.unmount();

    const broken = await open(
      {
        [LOGIN]: codexFlow('awaiting-approval'),
        [FLOW_POST]: refusal('This machine could not switch.', 500, 'internal'),
      },
      { login: CODEX },
    );
    await click(broken.view.container.querySelector('[data-change-submit]'), 'the start button');
    await click(button(broken.view.container, 'Sign in with a link instead'), 'the switch');
    expect(broken.view.container.querySelector('[role="alert"]')).not.toBeNull();
    await broken.view.unmount();
  });

  it('keeps a link for the next start once a flow moved to one by itself, or a device code failed', async () => {
    const moved = await open(
      {
        [LOGIN]: codexLink('awaiting-callback', { deviceCode: 'unavailable' }),
        [FLOW_DELETE]: codexLink('failed'),
      },
      { login: CODEX },
    );
    await click(moved.view.container.querySelector('[data-change-submit]'), 'the start button');
    expect(moved.view.container.textContent).toContain('This account doesn’t allow device codes');
    await click(button(moved.view.container, 'Cancel'), 'Cancel');
    expect(moved.view.container.textContent).toContain('Sign in to Codex with a link');
    await moved.view.unmount();

    const failed = await open({ [LOGIN]: codexLink('failed') }, { login: CODEX });
    await click(failed.view.container.querySelector('[data-change-submit]'), 'the start button');
    await click(button(failed.view.container, 'Sign in with a link instead'), 'the link restart');
    expect(state(failed.view.container)).toBe('start');
    expect(failed.view.container.textContent).toContain('Sign in to Codex with a link');
    await failed.view.unmount();
  });

  it('picks up a sign-in already running, says so, and starts it over in one press', async () => {
    let started = 0;
    const { view, calls } = await open({
      [LOGIN]: () => {
        started += 1;
        return started === 1
          ? { ...claudeFlow('awaiting-code'), resumed: true }
          : {
              ...claudeFlow('awaiting-code'),
              flowId: 'flow-2',
              verificationUrl: 'https://claude.ai/oauth/authorize?code=fresh',
            };
      },
      [FLOW_DELETE]: claudeFlow('failed'),
    });
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');
    expect(state(view.container)).toBe('awaiting-code');
    expect(text(view.container, '[data-sign-in-resumed]')).toBe(
      'You started this sign-in earlier, so it carries on from where you left it.',
    );
    expect(view.container.textContent).not.toContain('flow-1');

    await click(button(view.container, 'Start over'), 'Start over');
    expect(only(calls, FLOW_DELETE)).toHaveLength(1);
    expect(only(calls, LOGIN).map(call => call.body)).toEqual([
      { loginId: 'claude-work' },
      { loginId: 'claude-work', restart: true },
    ]);
    expect(view.container.textContent).toContain('https://claude.ai/oauth/authorize?code=fresh');
    expect(view.container.querySelector('[data-sign-in-resumed]')).toBeNull();
    await view.unmount();
  });

  it('says a start-over the machine refused, and leaves the running sign-in on screen', async () => {
    let started = 0;
    const { view } = await open({
      [LOGIN]: () => {
        started += 1;
        return started === 1
          ? claudeFlow('awaiting-code')
          : refusal('This machine is stopping.', 409, 'fleet_login_unavailable');
      },
      [FLOW_DELETE]: refusal('gone', 409, 'fleet_login_unknown'),
    });
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');
    await click(button(view.container, 'Start over'), 'Start over');
    expect(text(view.container, '[role="alert"]')).toBe('This machine is stopping.');
    expect(state(view.container)).toBe('awaiting-code');
    await view.unmount();
  });

  it('starts over after a sign-in failed, so a leftover holding the port is cleared on the way', async () => {
    let started = 0;
    const { view, calls } = await open({
      [LOGIN]: () => {
        started += 1;
        return started === 1 ? claudeFlow('failed') : claudeFlow('awaiting-code');
      },
    });
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');
    await click(button(view.container, 'Start a new sign-in'), 'Start a new sign-in');
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');
    expect(only(calls, LOGIN).map(call => call.body)).toEqual([
      { loginId: 'claude-work' },
      { loginId: 'claude-work', restart: true },
    ]);
    expect(only(calls, FLOW_DELETE)).toHaveLength(0);
    expect(state(view.container)).toBe('awaiting-code');
    await view.unmount();
  });

  it('offers a link sign-in as a real outlined button, never a bare ghost', async () => {
    const { view } = await open({ [LOGIN]: codexFlow('awaiting-approval') }, { login: CODEX });
    expect(button(view.container, 'Sign in with a link instead').getAttribute('data-variant')).toBeNull();
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');
    expect(button(view.container, 'Sign in with a link instead').getAttribute('data-variant')).toBeNull();
    expect(button(view.container, 'Start over').getAttribute('data-variant')).toBeNull();
    await view.unmount();
  });
});
