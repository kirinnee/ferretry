import { describe, expect, it } from 'bun:test';
import type { HarnessLoginFlow } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { CredentialSignIn } from '../../../../../src/features/fleet/credentials/credential-sign-in.tsx';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import type { CredentialLoginFlow } from '../../../../../src/features/fleet/harness-login-api.ts';
import { useAccountChanges } from '../../../../../src/features/fleet/shell/apply-change-panel.tsx';
import { interact, mount, must } from '../../../../support/dom.ts';
import { type Call, claudeFlow, credential, machineWith, READS, STUDIO, scripted } from '../account-support.ts';

const LOGIN = 'POST /v1/fleet/login';
const FLOW = '/v1/fleet/login/flow-1';

const WORK = credential({ id: 'claude-work', label: 'work', usedBy: ['claude-work'] });
const CODEX = credential({ id: 'codex', harness: 'codex', usedBy: ['codex-default'] });

const asCredentialFlow = (flow: HarnessLoginFlow): CredentialLoginFlow => ({
  ...flow,
  credentialId: flow.credentialId ?? 'claude-work',
});

const codexFlow = (state: 'awaiting-approval' | 'complete', credentialId = 'codex'): HarnessLoginFlow => {
  const base = {
    harness: 'codex' as const,
    flowId: 'flow-1',
    credentialId,
    identity: 'codex:you@example.com',
    startedAt: '2026-10-13T08:00:00.000Z',
    expiresAt: '2026-10-13T08:10:00.000Z',
  };
  return state === 'complete'
    ? { ...base, state }
    : { ...base, state, verificationUrl: 'https://auth.openai.com/codex/device', userCode: '0IER-FFQW6' };
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
};

// One act per slice: a state change inside an act only commits (and so re-arms the poll) when that act ends.
const wait = async (ms: number): Promise<void> => {
  for (let elapsed = 0; elapsed < ms; elapsed += 10)
    await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
};

const type = async (field: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
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
  container.querySelector('[data-credential-sign-in]')?.getAttribute('data-credential-sign-in');

interface HostProps {
  readonly credential: Parameters<typeof CredentialSignIn>[0]['credential'];
  readonly onSignedIn: () => void;
  readonly createClient: (connection: unknown) => Promise<FleetClient>;
  readonly initialFlow?: CredentialLoginFlow;
  readonly pollMs?: number;
}

function Host({ credential: login, onSignedIn, createClient, initialFlow, pollMs }: HostProps) {
  const changes = useAccountChanges({ connection: STUDIO, createClient });
  return (
    <CredentialSignIn
      credential={login}
      machineName="studio-mac"
      connection={STUDIO}
      createClient={createClient}
      changes={changes}
      onSignedIn={onSignedIn}
      {...(initialFlow === undefined ? {} : { initialFlow })}
      {...(pollMs === undefined ? {} : { pollMs })}
    />
  );
}

const open = async (
  routes: Record<string, unknown>,
  props: Partial<Pick<HostProps, 'credential' | 'initialFlow' | 'pollMs'>> = {},
) => {
  const calls: Call[] = [];
  const signedIn: string[] = [];
  const client = scripted({ ...READS(), ...routes }, calls);
  const createClient = async (): Promise<FleetClient> => client;
  const view = await mount(
    <Host
      credential={props.credential ?? WORK}
      onSignedIn={() => signedIn.push('signed-in')}
      createClient={createClient}
      {...(props.initialFlow === undefined ? {} : { initialFlow: props.initialFlow })}
      {...(props.pollMs === undefined ? {} : { pollMs: props.pollMs })}
    />,
  );
  await settle();
  return { view, calls, signedIn };
};

const only = (calls: readonly Call[], key: string): Call[] =>
  calls.filter(call => `${call.method} ${call.path}` === key);

describe('CredentialSignIn', () => {
  it('says why a sign-in does not apply, and offers none', async () => {
    const login = credential({
      id: 'claude-env',
      signIn: {
        available: false,
        reason: 'This login comes from an environment variable, so there is nothing to sign in to.',
      },
    });
    const { view } = await open({}, { credential: login });
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
      [`POST ${FLOW}`]: { outcome: 'accepted', flow: claudeFlow('complete') },
    });
    expect(state(view.container)).toBe('start');
    expect(text(view.container, 'p.font-semibold')).toBe('Sign in to Claude Code');
    expect(view.container.textContent).toContain(
      'The login is kept on studio-mac. Every runtime that uses it (1 runtime) can launch once it is done.',
    );
    expect(view.container.querySelector('[data-change-step-up]')).toBeNull();
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');
    expect(only(calls, LOGIN)).toHaveLength(1);
    expect(only(calls, LOGIN)[0]?.body).toEqual({ credentialId: 'claude-work' });

    expect(state(view.container)).toBe('awaiting-code');
    expect(view.container.textContent).toContain('https://claude.ai/oauth/authorize?code=true');
    expect(
      view.container.querySelector('[data-claude-login-identity]')?.getAttribute('data-claude-login-identity'),
    ).toBe('claude-work');
    expect(view.container.querySelector('h3')?.textContent).toBe('you@example.com (work)');
    const field = must(view.container.querySelector<HTMLTextAreaElement>('textarea'), 'the code field');
    await type(field, 'the-code-on-the-page');
    await click(button(view.container, 'Finish sign-in'), 'Finish sign-in');

    expect(only(calls, `POST ${FLOW}`)).toHaveLength(1);
    expect(only(calls, `POST ${FLOW}`)[0]?.body).toEqual({ code: 'the-code-on-the-page' });
    expect(state(view.container)).toBe('complete');
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe('Signed in. 1 runtime can launch now.');
    expect(view.container.textContent).not.toContain('the-code-on-the-page');
    expect(signedIn).toEqual(['signed-in']);
    await view.unmount();
  });

  it('names how many runtimes one sign-in fixes, and shows a refused code and a conflict as the daemon worded them', async () => {
    const shared = credential({ id: 'claude-work', usedBy: ['claude-a', 'claude-b', 'claude-c'] });
    let answer: unknown = { outcome: 'refused', reason: 'Claude didn’t take that code. Copy all of it.' };
    const { view, signedIn } = await open(
      { [LOGIN]: claudeFlow('awaiting-code'), [`POST ${FLOW}`]: () => answer },
      { credential: shared },
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

    answer = new FyHttpError('This machine could not reach Claude.', 502, 'fleet_login_failed');
    await type(field, 'third');
    await click(button(view.container, 'Finish sign-in for 3 runtimes'), 'the finish button');
    expect(text(view.container, '[role="alert"]')).toBe('This machine could not reach Claude.');
    expect(signedIn).toEqual([]);
    await view.unmount();
  });

  it('says a start that fails, and starts again from the harness’s own failed panel', async () => {
    let answer: unknown = new FyHttpError(
      'Claude Code is not installed on studio-mac.',
      409,
      'fleet_login_unavailable',
    );
    const { view, calls } = await open({ [LOGIN]: () => answer });
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');
    expect(state(view.container)).toBe('start');
    expect(text(view.container, '[data-change-refusal]')).toBe('Claude Code is not installed on studio-mac.');

    answer = claudeFlow('failed');
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');
    expect(only(calls, LOGIN)).toHaveLength(2);
    expect(state(view.container)).toBe('failed');
    expect(view.container.textContent).toContain('The sign-in ended.');
    expect(view.container.textContent).toContain('Run fy fleet login.');
    await click(button(view.container, 'Start a new sign-in'), 'Start a new sign-in');
    expect(state(view.container)).toBe('start');
    expect(text(view.container, '[data-change-refusal]')).toBeUndefined();
    await view.unmount();
  });

  it('shows Codex’s link and device code, re-reads while it waits, and finishes by itself', async () => {
    let reads = 0;
    const { view, calls, signedIn } = await open(
      {
        [LOGIN]: codexFlow('awaiting-approval'),
        [`GET ${FLOW}`]: () => {
          reads += 1;
          return reads === 1 ? codexFlow('awaiting-approval') : codexFlow('complete');
        },
      },
      { credential: CODEX, pollMs: 5 },
    );
    expect(text(view.container, 'p.font-semibold')).toBe('Sign in to Codex');
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');
    expect(only(calls, LOGIN)[0]?.body).toEqual({ credentialId: 'codex' });
    expect(text(view.container, '[data-codex-login-user-code]')).toBe('0IER-FFQW6');
    expect(view.container.textContent).toContain('https://auth.openai.com/codex/device');
    expect(view.container.textContent).toContain('Waiting for the provider.');
    expect(view.container.querySelector('textarea')).toBeNull();

    await wait(80);
    expect(only(calls, `GET ${FLOW}`)).toHaveLength(2);
    expect(state(view.container)).toBe('complete');
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe('Signed in. 1 runtime can launch now.');
    expect(signedIn).toEqual(['signed-in']);

    await wait(40);
    expect(only(calls, `GET ${FLOW}`)).toHaveLength(2);
    expect(signedIn).toEqual(['signed-in']);
    await view.unmount();
  });

  it('a read that fails while waiting says so and leaves the panel where it was', async () => {
    const { view, calls, signedIn } = await open(
      {
        [LOGIN]: codexFlow('awaiting-approval'),
        [`GET ${FLOW}`]: new FyHttpError('This machine lost the sign-in.', 404, 'fleet_login_unknown'),
      },
      { credential: CODEX, pollMs: 5 },
    );
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');
    await wait(40);
    expect(only(calls, `GET ${FLOW}`)).toHaveLength(1);
    expect(state(view.container)).toBe('awaiting-approval');
    expect(text(view.container, '[role="alert"]')).toBe('This machine lost the sign-in.');
    expect(signedIn).toEqual([]);
    await view.unmount();
  });

  it('cancel ends the flow on the machine and goes back to the start, even when the machine does not answer', async () => {
    const { view, calls } = await open({
      [LOGIN]: claudeFlow('awaiting-code'),
      [`DELETE ${FLOW}`]: claudeFlow('failed'),
    });
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');
    await click(button(view.container, 'Cancel'), 'Cancel');
    expect(only(calls, `DELETE ${FLOW}`)).toHaveLength(1);
    expect(state(view.container)).toBe('start');
    await view.unmount();

    const silent = await open({ [LOGIN]: claudeFlow('awaiting-code') });
    await click(silent.view.container.querySelector('[data-change-submit]'), 'the start button');
    await click(button(silent.view.container, 'Cancel'), 'Cancel');
    expect(only(silent.calls, `DELETE ${FLOW}`)).toHaveLength(1);
    expect(state(silent.view.container)).toBe('start');
    await silent.view.unmount();
  });

  it('says the passkey will be asked for, then starts the sign-in and carries it through to the end', async () => {
    const { view, calls, signedIn } = await open({
      'GET /v1/fleet/machine': machineWith({ mayApply: false, applyRefusal: 'step-up-required' }),
      [LOGIN]: claudeFlow('awaiting-code'),
      [`POST ${FLOW}`]: { outcome: 'accepted', flow: claudeFlow('complete') },
    });
    expect(text(view.container, '[data-change-step-up]')).toBe(
      'studio-mac will ask you to confirm with your passkey when you save.',
    );
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');
    expect(only(calls, LOGIN)[0]?.body).toEqual({ credentialId: 'claude-work' });

    const code = must(view.container.querySelector<HTMLTextAreaElement>('textarea'), 'the code field');
    await type(code, 'a-code');
    await click(button(view.container, 'Finish sign-in'), 'Finish sign-in');
    expect(only(calls, `POST ${FLOW}`)).toHaveLength(1);
    expect(signedIn).toEqual(['signed-in']);
    await view.unmount();
  });

  it('picks up a sign-in the caller already started and reads it back', async () => {
    const { view, calls, signedIn } = await open(
      { [`GET ${FLOW}`]: claudeFlow('complete') },
      { initialFlow: asCredentialFlow(claudeFlow('awaiting-code')), pollMs: 5 },
    );
    expect(state(view.container)).toBe('awaiting-code');
    expect(view.container.querySelector('[data-credential-sign-in="start"]')).toBeNull();
    await wait(60);
    expect(only(calls, `GET ${FLOW}`)).toHaveLength(1);
    expect(state(view.container)).toBe('complete');
    expect(signedIn).toEqual(['signed-in']);
    await view.unmount();
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
  }) as HarnessLoginFlow;

describe('CredentialSignIn with a Codex link', () => {
  it('offers a link on the start screen and starts with one when chosen', async () => {
    const { view, calls } = await open({ [LOGIN]: codexLink('awaiting-callback') }, { credential: CODEX });
    expect(view.container.textContent).toContain('Device code didn’t work?');
    await click(button(view.container, 'Sign in with a link instead'), 'the link choice');
    expect(view.container.textContent).toContain('Sign in to Codex with a link');
    await click(button(view.container, 'Use a device code instead'), 'the device choice');
    expect(
      view.container.querySelector('[data-credential-sign-in-method]')?.getAttribute('data-credential-sign-in-method'),
    ).toBe('device-code');
    await click(button(view.container, 'Sign in with a link instead'), 'the link choice');
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');

    expect(only(calls, LOGIN)[0]?.body).toEqual({ credentialId: 'codex', method: 'link' });
    expect(state(view.container)).toBe('awaiting-callback');
    await view.unmount();
  });

  it('never offers a link for Claude, and never sends a method for it', async () => {
    const { view, calls } = await open({ [LOGIN]: claudeFlow('awaiting-code') });
    expect(view.container.querySelector('[data-credential-sign-in-method]')).toBeNull();
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');
    expect(only(calls, LOGIN)[0]?.body).toEqual({ credentialId: 'claude-work' });
    await view.unmount();
  });

  it('moves a device code to a link in the same flow, then hands the address over and finishes', async () => {
    // The daemon's answer to a re-read follows what was sent, so the poll can never run ahead of the person.
    let stage: HarnessLoginFlow = codexFlow('awaiting-approval');
    let delivered = 0;
    const { view, calls, signedIn } = await open(
      {
        [LOGIN]: codexFlow('awaiting-approval'),
        [`POST ${FLOW}`]: (call: Call) => {
          stage = 'method' in (call.body as object) ? codexLink('awaiting-callback') : codexLink('finishing');
          return { outcome: 'accepted', flow: stage };
        },
        [`GET ${FLOW}`]: () => {
          if (stage.state === 'finishing') delivered += 1;
          return delivered > 1 ? codexFlow('complete') : stage;
        },
      },
      { credential: CODEX, pollMs: 5 },
    );
    await click(view.container.querySelector('[data-change-submit]'), 'the start button');
    await click(button(view.container, 'Sign in with a link instead'), 'the switch');
    expect(only(calls, `POST ${FLOW}`)[0]?.body).toEqual({ method: 'link' });
    expect(state(view.container)).toBe('awaiting-callback');

    await type(must(view.container.querySelector('textarea'), 'the address field'), ADDRESS);
    await click(button(view.container, 'Finish sign-in'), 'Finish sign-in');
    expect(only(calls, `POST ${FLOW}`)[1]?.body).toEqual({ code: ADDRESS });
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
        [`POST ${FLOW}`]: { outcome: 'conflict', reason: 'this sign-in is already using a link' },
      },
      { credential: CODEX },
    );
    await click(refused.view.container.querySelector('[data-change-submit]'), 'the start button');
    await click(button(refused.view.container, 'Sign in with a link instead'), 'the switch');
    expect(refused.view.container.textContent).toContain('this sign-in is already using a link');
    await refused.view.unmount();

    const broken = await open(
      {
        [LOGIN]: codexFlow('awaiting-approval'),
        [`POST ${FLOW}`]: new FyHttpError('This machine could not switch.', 500, 'internal'),
      },
      { credential: CODEX },
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
        [`DELETE ${FLOW}`]: codexLink('failed'),
      },
      { credential: CODEX },
    );
    await click(moved.view.container.querySelector('[data-change-submit]'), 'the start button');
    expect(moved.view.container.textContent).toContain('This account doesn’t allow device codes');
    await click(button(moved.view.container, 'Cancel'), 'Cancel');
    expect(moved.view.container.textContent).toContain('Sign in to Codex with a link');
    await moved.view.unmount();

    const failed = await open({ [LOGIN]: codexLink('failed') }, { credential: CODEX });
    await click(failed.view.container.querySelector('[data-change-submit]'), 'the start button');
    await click(button(failed.view.container, 'Sign in with a link instead'), 'the link restart');
    expect(state(failed.view.container)).toBe('start');
    expect(failed.view.container.textContent).toContain('Sign in to Codex with a link');
    await failed.view.unmount();
  });
});
