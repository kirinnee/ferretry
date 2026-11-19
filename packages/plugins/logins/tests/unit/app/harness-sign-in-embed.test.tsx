/** A harness's sign-in drawn inside that harness's first-run segment: which login it works on, and the one-press add. */
import { describe, expect, it } from 'bun:test';
import { HarnessSignInEmbed, harnessSignIn } from '../../../app/features/harness-sign-in-embed.tsx';
import { HARNESS_SIGN_IN_SLOTS } from '../../../contract/index.ts';
import { login, loginList } from '../cli/fakes.ts';
import { interact, mount, must } from '../support/dom.ts';
import { claudeFlow } from './support/harness-login.ts';
import { type Call, scripted } from './support/client.ts';

const LIST = 'GET /v1/logins';
const GRANTS = 'GET /v1/grants';
const STAGE = 'POST /v1/logins/changes';
const APPLY = 'POST /v1/logins/changes/:changeId/apply';
const START = 'POST /v1/logins/sign-in';
const OPEN = { capabilities: [{ capability: 'fleet', use: true, configure: true, configureRefusal: 'granted' }] };
const NEEDS = {
  word: 'needs_sign_in',
  label: 'Needs sign-in',
  reason: 'not_checked_yet',
  explanation: 'Sign in.',
  lastCheckInconclusive: false,
};

const settle = async (): Promise<void> => {
  for (let elapsed = 0; elapsed < 300; elapsed += 10)
    await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
};

describe('the harness sign-in embed', () => {
  it('names the two slots by the literals the harnesses write', () => {
    expect([...HARNESS_SIGN_IN_SLOTS]).toEqual(['claude-code.sign-in', 'codex.sign-in']);
  });

  it('works on the login of its own harness that needs signing in, and starts nothing on its own', async () => {
    const calls: Call[] = [];
    const client = scripted(
      {
        [LIST]: loginList(
          login({ id: 'codex', harness: 'codex', harnesses: ['codex'], status: NEEDS }),
          login({ id: 'claude-you', status: NEEDS }),
        ),
        [GRANTS]: OPEN,
      },
      calls,
    );
    const view = await mount(<HarnessSignInEmbed client={client} harness="claude-code" />);
    await settle();
    expect(view.container.querySelector('[data-login-sign-in]')?.getAttribute('data-login-sign-in')).toBe('start');
    expect(calls.some(call => call.route === START)).toBe(false);
    await view.unmount();
  });

  it('says it is signed in when the harness has a login and none needs a sign-in', async () => {
    const client = scripted({ [LIST]: loginList(login()), [GRANTS]: OPEN });
    const view = await mount(<HarnessSignInEmbed client={client} harness="claude-code" />);
    await settle();
    expect(view.container.querySelector('[data-harness-sign-in="done"]')).not.toBeNull();
    await view.unmount();
  });

  it('on a machine with no login of the harness, one press adds one and starts its sign-in', async () => {
    const calls: Call[] = [];
    let added = false;
    const client = scripted(
      {
        [LIST]: () => (added ? loginList(login({ id: 'claude-login', status: NEEDS })) : loginList()),
        [GRANTS]: OPEN,
        [STAGE]: (call: Call) => ({
          id: 'chg1',
          change: call.body,
          summary: 'Add',
          consequences: [],
          expiresAt: '2026-11-01T10:15:00.000Z',
          state: 'pending',
        }),
        [APPLY]: () => {
          added = true;
          return { outcome: 'applied' };
        },
        [START]: { ...claudeFlow('awaiting-code'), loginId: 'claude-login' },
      },
      calls,
    );
    const view = await mount(<HarnessSignInEmbed client={client} harness="claude-code" />);
    await settle();
    const press = must(view.container.querySelector<HTMLButtonElement>('[data-change-submit]'), 'the sign-in button');
    expect(press.textContent).toBe('Sign in to Claude Code');
    await interact(() => press.click());
    await settle();
    expect(calls.find(call => call.route === STAGE)?.body).toEqual({
      kind: 'login.add',
      id: 'claude-login',
      harness: 'claude-code',
    });
    expect(calls.filter(call => call.route === START)).toHaveLength(1);
    await view.unmount();
  });

  it('tells the page what the first read found, once: a usable login lets it skip, otherwise it is shown', async () => {
    for (const [logins, expected] of [
      [loginList(login()), ['already']],
      [loginList(login({ status: NEEDS })), ['shown']],
      [loginList(), ['shown']],
    ] as const) {
      const told: string[] = [];
      const view = await mount(
        <HarnessSignInEmbed
          client={scripted({ [LIST]: logins, [GRANTS]: OPEN })}
          harness="claude-code"
          onShown={() => told.push('shown')}
          onAlreadySignedIn={() => told.push('already')}
        />,
      );
      await settle();
      expect(told).toEqual([...expected]);
      await view.unmount();
    }
  });

  it('as a slot panel it checks its untyped props and still draws without a callback', () => {
    const client = scripted({});
    expect(harnessSignIn(client, 'codex', {}).props).toMatchObject({ harness: 'codex' });
    expect(
      (harnessSignIn(client, 'codex', { onSignedIn: () => undefined }).props as { onSignedIn?: unknown }).onSignedIn,
    ).toBeFunction();
  });
});
