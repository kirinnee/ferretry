/**
 * The section that turned `quota auth!` from a dead end into a control.
 *
 * ## AGAINST A REAL DOCUMENT, and that is not a preference
 *
 * This section raises `OperatorUnlockDialog`, and a modal's contract is made of document facts — a focus
 * trap, an Escape stack, what the scrim does. A shallow tree cannot run any of them: the hook reads
 * `document.activeElement` and calls `focus()` on a ref that a renderable tree never fills. So the suite
 * runs against happy-dom, exactly as `operator-unlock-dialog.test.tsx` explains for the prompt itself.
 *
 * The client is a fake that answers by PATH and VERB rather than by call order, so a test says which route
 * it is about instead of counting requests — and every answer is parsed through the real shared schema on
 * the way in, so a fixture cannot be laxer than the daemon.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { OPERATOR_UNLOCK_HEADER, type UsageAccountView } from '@ferretry/protocol';
import type { z } from 'zod';

import type { FleetClient, FleetPermissions } from '../../../../src/features/fleet/fleet-api.ts';
import { FleetSignInSection, fleetSignInTab } from '../../../../src/features/fleet/fleet-sign-in-section.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../../support/dom.ts';
import {
  CLAUDE_ACCOUNT_ID,
  CLAUDE_URL,
  claudeFlow,
  claudeIdentity,
  CODEX_CODE,
  codexFlow,
  codexIdentity,
  keyedAccount,
  loginAccount,
  NOW,
  readiness,
  usageRow,
} from './harness-login-support.ts';

const daemon = daemonConnection({
  daemonId: 'sign-in-daemon',
  baseUrl: 'https://fleet.example.test',
  deviceToken: 'test-token',
});

const UNLOCK = `fy_unlock_${'A'.repeat(22)}`;

const permissions = (overrides: Partial<FleetPermissions> = {}): FleetPermissions => ({
  mayInspect: true,
  mayPropose: true,
  mayApply: true,
  applyRefusal: 'granted',
  confirmation: 'none',
  ...overrides,
});

interface Recorded {
  readonly path: string;
  readonly method: string;
  readonly body: string | undefined;
  readonly headers: Record<string, string>;
}

interface Answers {
  readonly readiness?: unknown;
  readonly permissions?: unknown;
  readonly usage?: unknown;
  readonly start?: unknown;
  readonly flow?: unknown;
  readonly submit?: unknown;
  readonly cancel?: unknown;
  readonly unlock?: unknown;
  /** `"<VERB> <path>"` → the value to throw, so a refusal path can be driven exactly. */
  readonly reject?: ReadonlyMap<string, unknown>;
}

const clientFor = (answers: Answers): { client: FleetClient; calls: Recorded[] } => {
  const calls: Recorded[] = [];
  const client: FleetClient = {
    // `<T,>` rather than `<T>`: in a .tsx file the parser reads a bare type parameter as a JSX tag.
    request: async <T,>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
      const method = init?.method ?? 'GET';
      calls.push({
        path,
        method,
        body: init?.body === undefined ? undefined : String(init.body),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      const rejection = answers.reject?.get(`${method} ${path}`);
      if (rejection !== undefined) throw rejection;
      const answer =
        path === '/v1/fleet/login' && method === 'GET'
          ? answers.readiness
          : path === '/v1/fleet/login' && method === 'POST'
            ? answers.start
            : path === '/v1/fleet/permissions'
              ? (answers.permissions ?? permissions())
              : path === '/v1/usage'
                ? (answers.usage ?? { stale: false, accounts: [] })
                : path === '/v1/grants/unlock'
                  ? answers.unlock
                  : method === 'POST'
                    ? answers.submit
                    : method === 'DELETE'
                      ? answers.cancel
                      : answers.flow;
      return schema.parse(answer);
    },
  };
  return { client, calls };
};

/** A failed test must not leave its mount attached, or the next one queries into two sections. */
let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  const teardown = cleanup;
  cleanup = null;
  if (teardown !== null) await teardown();
});

const open = async (
  answers: Answers,
  overrides: { readonly usage?: ReadonlyMap<string, UsageAccountView>; readonly pollMs?: number } = {},
): Promise<{ container: HTMLElement; calls: Recorded[] }> => {
  const { client, calls } = clientFor(answers);
  const mounted = await mount(
    <FleetSignInSection
      connection={daemon}
      createClient={async () => client}
      now={() => NOW}
      // Long, because the poll is driven explicitly where it is the subject; a short one would have the
      // fake answering in the background of every unrelated assertion.
      pollMs={100_000}
      {...overrides}
    />,
  );
  cleanup = mounted.unmount;
  return { container: mounted.container, calls };
};

const click = async (container: HTMLElement, label: string): Promise<void> => {
  const button = [...container.querySelectorAll('button')].find(node => (node.textContent ?? '').includes(label));
  await interact(() => must(button, `a button labelled "${label}"`).click());
};

const typeInto = async (field: HTMLElement, value: string): Promise<void> => {
  const prototype = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await interact(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('FleetSignInSection', () => {
  it('reads readiness, permissions and the cached usage feed on mount', async () => {
    const { calls } = await open({ readiness: readiness() });

    const reads = calls.map(call => `${call.method} ${call.path}`);
    expect(reads).toContain('GET /v1/fleet/login');
    expect(reads).toContain('GET /v1/fleet/permissions');
    expect(reads).toContain('GET /v1/usage');
  });

  it('offers Claude’s own panel for a Claude identity and Codex’s for a Codex one', async () => {
    const { container } = await open({ readiness: readiness([claudeIdentity(), codexIdentity()]) });

    expect(container.querySelector('[data-claude-login-identity="claude:studio"]')).not.toBeNull();
    expect(container.querySelector('[data-codex-login-identity="codex:studio"]')).not.toBeNull();
  });

  it('offers NO sign-in control to an account whose credential comes from a token file', async () => {
    const { container } = await open({
      readiness: readiness([{ ...claudeIdentity([keyedAccount()]), verdict: 'no-login' }]),
    });

    expect(container.querySelector('[data-claude-login]')).toBeNull();
    expect(container.querySelector('[data-codex-login]')).toBeNull();
  });

  it('says where that credential DOES come from, rather than saying nothing', async () => {
    const { container } = await open({
      readiness: readiness([{ ...claudeIdentity([keyedAccount()]), verdict: 'no-login' }]),
    });

    expect(container.querySelector('[data-fleet-sign-in-source="token-file"]')).not.toBeNull();
    const detail = must(container.querySelector('[data-fleet-sign-in-source-detail]'), 'the source sentence');
    expect(detail.textContent).toContain('ANTHROPIC_API_KEY');
    expect(detail.textContent).toContain('/etc/ferretry/secrets.sh');
    expect(detail.textContent).toContain('no sign-in to run');
  });

  it('says where the credential comes from for an environment variable too', async () => {
    const { container } = await open({
      readiness: readiness([
        {
          ...claudeIdentity([keyedAccount({ source: 'environment', variable: 'OPENAI_API_KEY' })]),
          verdict: 'no-login',
        },
      ]),
    });

    expect(container.querySelector('[data-fleet-sign-in-source="environment"]')).not.toBeNull();
    expect(must(container.querySelector('[data-fleet-sign-in-source-detail]'), 'the sentence').textContent).toContain(
      'OPENAI_API_KEY',
    );
  });

  it('offers NO sign-in for a harness that declares none, and carries the harness’s own reason', async () => {
    const { container } = await open({
      readiness: readiness([
        {
          ...codexIdentity(),
          verdict: 'no-login',
          accounts: [
            loginAccount({
              kind: 'codex',
              wrapper: 'codex-studio',
              login: {
                applies: false,
                because: 'harness-has-no-login',
                harnessReason: 'this build of Codex authenticates from a service account',
              },
            }),
          ],
        },
      ]),
    });

    expect(container.querySelector('[data-codex-login]')).toBeNull();
    expect(must(container.querySelector('[data-fleet-sign-in-source-detail]'), 'the reason').textContent).toBe(
      'this build of Codex authenticates from a service account',
    );
  });

  it('renders 5-hour and weekly usage with the direction stated', async () => {
    const { container } = await open(
      { readiness: readiness([claudeIdentity([loginAccount()])]) },
      { usage: new Map([['claude-studio', usageRow({ usageBased: true, fiveHourPercent: 42, weeklyPercent: 13 })]]) },
    );

    const usage = must(container.querySelector('[data-fleet-sign-in-usage="windows"]'), 'the usage line');
    expect(usage.textContent).toContain('5h 42% used');
    expect(usage.textContent).toContain('weekly 13% used');
  });

  it('renders unknown, never zero, for an account nothing measured', async () => {
    const { container } = await open(
      { readiness: readiness([claudeIdentity([loginAccount()])]) },
      { usage: new Map([['claude-studio', usageRow({ authOk: true })]]) },
    );

    const usage = must(container.querySelector('[data-fleet-sign-in-usage="unknown"]'), 'the usage line');
    expect(usage.textContent).toContain('Usage unknown');
    expect(usage.textContent).not.toContain('0%');
  });

  it('renders a token-based account with no window rather than a zero one', async () => {
    const { container } = await open(
      { readiness: readiness([claudeIdentity([loginAccount()])]) },
      { usage: new Map([['claude-studio', usageRow({ usageBased: false })]]) },
    );

    const usage = must(container.querySelector('[data-fleet-sign-in-usage="token-based"]'), 'the usage line');
    expect(usage.textContent).toBe('Token-based — no quota window to report');
  });

  it('joins the usage feed it fetched onto its own rows, by wrapper name', async () => {
    const { container } = await open({
      readiness: readiness([claudeIdentity([loginAccount()])]),
      usage: { stale: false, accounts: [usageRow({ agent: 'claude-studio', usageBased: true, weeklyPercent: 7 })] },
    });

    expect(must(container.querySelector('[data-fleet-sign-in-usage]'), 'the usage line').textContent).toContain(
      'weekly 7% used',
    );
  });

  it('keeps saying unknown when the usage scrape itself failed', async () => {
    const { container } = await open({
      readiness: readiness([claudeIdentity([loginAccount()])]),
      reject: new Map([['GET /v1/usage', new Error('the feed is warming up')]]),
    });

    const usage = must(container.querySelector('[data-fleet-sign-in-usage="unknown"]'), 'the usage line');
    expect(usage.textContent).not.toContain('0%');
    // A failed scrape must not be reported as a sign-in refusal: the readiness read succeeded.
    expect(container.querySelector('[data-fleet-sign-in-refusal]')).toBeNull();
  });

  it('starts a sign-in and shows the link the daemon published', async () => {
    const { container, calls } = await open({
      readiness: readiness([claudeIdentity()]),
      start: claudeFlow('awaiting-code'),
    });

    await click(container, 'Sign in to Claude Code');

    const start = calls.find(call => call.method === 'POST' && call.path === '/v1/fleet/login');
    expect(JSON.parse(String(start?.body))).toEqual({ accountId: CLAUDE_ACCOUNT_ID });
    expect(container.textContent).toContain(CLAUDE_URL);
  });

  it('forwards a pasted code and never puts it in the path', async () => {
    const { container, calls } = await open({
      readiness: readiness([claudeIdentity()]),
      start: claudeFlow('awaiting-code'),
      submit: { outcome: 'accepted', flow: claudeFlow('complete') },
    });
    await click(container, 'Sign in to Claude Code');

    await typeInto(must(container.querySelector('[name="claude-login-code"]'), 'the code field'), 'the-code');
    await click(container, 'Finish sign-in');

    const submit = calls.find(call => call.method === 'POST' && call.path.endsWith('/flow-one'));
    expect(JSON.parse(String(submit?.body))).toEqual({ code: 'the-code' });
    expect(submit?.path).not.toContain('the-code');
    expect(container.textContent).toContain('The credential was verified and copied to 1 sibling wrapper.');
    // And the value is nowhere in the document afterwards.
    expect(container.innerHTML).not.toContain('the-code');
  });

  it('shows a refusal from the daemon rather than a silent failure', async () => {
    const { container } = await open({
      readiness: readiness([claudeIdentity()]),
      reject: new Map([['POST /v1/fleet/login', new Error('there is no sign-in to run for this account')]]),
    });

    await click(container, 'Sign in to Claude Code');

    const refusal = must(container.querySelector('[data-fleet-sign-in-refusal]'), 'the refusal');
    expect(refusal.textContent).toContain('no sign-in to run');
  });

  it('reports a submission the daemon refused, in the daemon’s own words', async () => {
    const { container } = await open({
      readiness: readiness([claudeIdentity()]),
      start: claudeFlow('awaiting-code'),
      submit: { outcome: 'unconfirmed', reason: 'the harness was no longer reading' },
    });
    await click(container, 'Sign in to Claude Code');
    await typeInto(must(container.querySelector('[name="claude-login-code"]'), 'the code field'), 'the-code');
    await click(container, 'Finish sign-in');

    expect(must(container.querySelector('[data-fleet-sign-in-refusal]'), 'the refusal').textContent).toContain(
      'no longer reading',
    );
  });

  it('shows Codex’s device code and offers nowhere to bring one back', async () => {
    const { container } = await open({
      readiness: readiness([codexIdentity()]),
      start: codexFlow('awaiting-approval'),
    });

    await click(container, 'Sign in to Codex');

    expect(must(container.querySelector('[data-codex-login-user-code]'), 'the code').textContent).toBe(CODEX_CODE);
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
  });

  it('ends a Codex sign-in on cancel too, from its own panel', async () => {
    // Codex has no submit, so cancel is the ONLY control it offers once the grant is published — which
    // makes it the one that must not be left unwired.
    const { container, calls } = await open({
      readiness: readiness([codexIdentity()]),
      start: codexFlow('awaiting-approval'),
      cancel: codexFlow('failed'),
    });
    await click(container, 'Sign in to Codex');
    await click(container, 'Cancel');

    expect(calls.some(call => call.method === 'DELETE')).toBe(true);
    expect(container.textContent).toContain('ran out of time');
  });

  it('ends a sign-in on cancel', async () => {
    const { container, calls } = await open({
      readiness: readiness([claudeIdentity()]),
      start: claudeFlow('awaiting-code'),
      cancel: claudeFlow('failed'),
    });
    await click(container, 'Sign in to Claude Code');
    await click(container, 'Cancel');

    expect(calls.some(call => call.method === 'DELETE')).toBe(true);
    expect(container.textContent).toContain('fy fleet login');
  });

  it('asks for the operator password through the SHARED dialog, and starts nothing until it is answered', async () => {
    const { container, calls } = await open({
      readiness: readiness([claudeIdentity()]),
      permissions: permissions({ confirmation: 'operator-password' }),
      start: claudeFlow('awaiting-code'),
    });

    await click(container, 'Sign in to Claude Code');

    expect(document.querySelector('[data-operator-unlock-dialog="confirm"]')).not.toBeNull();
    expect(must(document.querySelector('[data-operator-unlock-purpose]'), 'the purpose').textContent).toContain(
      'operator password once',
    );
    // The panel itself has no password field of its own, which is the rule this reuses the dialog for.
    expect(container.querySelector('[data-claude-login] input[type="password"]')).toBeNull();
    expect(calls.some(call => call.method === 'POST' && call.path === '/v1/fleet/login')).toBe(false);
  });

  it('sends the typed password as the per-sign-in confirmation', async () => {
    const { container, calls } = await open({
      readiness: readiness([claudeIdentity()]),
      permissions: permissions({ confirmation: 'operator-password' }),
      start: claudeFlow('awaiting-code'),
    });
    await click(container, 'Sign in to Claude Code');

    await typeInto(
      must(document.querySelector<HTMLElement>('[data-grant-unlock-field]'), 'the password field'),
      'the password',
    );
    await interact(() =>
      must(document.querySelector<HTMLElement>('[data-operator-unlock-submit]'), 'the submit').click(),
    );

    const start = calls.find(call => call.method === 'POST' && call.path === '/v1/fleet/login');
    expect(JSON.parse(String(start?.body)).operatorPassword).toBe('the password');
    // No unlock was minted: a `confirm` caller is not locked, and minting one would spend an attempt for
    // nothing and hand this screen five ungoverned minutes it was never granted.
    expect(calls.some(call => call.path === '/v1/grants/unlock')).toBe(false);
  });

  it('mints an unlock first for a LOCKED caller, then carries it in the header', async () => {
    const { container, calls } = await open({
      readiness: readiness([claudeIdentity()]),
      permissions: permissions({ mayApply: false, applyRefusal: 'locked', confirmation: 'operator-password' }),
      unlock: { token: UNLOCK, expiresAt: new Date(NOW + 300_000).toISOString(), ttlSeconds: 300 },
      start: claudeFlow('awaiting-code'),
    });
    await click(container, 'Sign in to Claude Code');

    expect(document.querySelector('[data-operator-unlock-dialog="unlock"]')).not.toBeNull();
    await typeInto(
      must(document.querySelector<HTMLElement>('[data-grant-unlock-field]'), 'the password field'),
      'the password',
    );
    await interact(() =>
      must(document.querySelector<HTMLElement>('[data-operator-unlock-submit]'), 'the submit').click(),
    );

    expect(calls.some(call => call.path === '/v1/grants/unlock')).toBe(true);
    const start = calls.find(call => call.method === 'POST' && call.path === '/v1/fleet/login');
    expect(start?.headers[OPERATOR_UNLOCK_HEADER]).toBe(UNLOCK);
  });

  it('keeps a wrong password in the dialog, where it can be retyped', async () => {
    const refusal = Object.assign(new Error('that is not this machine’s operator password'), {
      code: 'grant_unlock_failed',
      attemptsRemaining: 4,
    });
    const { container } = await open({
      readiness: readiness([claudeIdentity()]),
      permissions: permissions({ mayApply: false, applyRefusal: 'locked', confirmation: 'operator-password' }),
      reject: new Map([['POST /v1/grants/unlock', refusal]]),
    });
    await click(container, 'Sign in to Claude Code');
    await typeInto(
      must(document.querySelector<HTMLElement>('[data-grant-unlock-field]'), 'the password field'),
      'wrong',
    );
    await interact(() =>
      must(document.querySelector<HTMLElement>('[data-operator-unlock-submit]'), 'the submit').click(),
    );

    expect(document.querySelector('[data-operator-unlock-dialog]')).not.toBeNull();
    expect(document.querySelector('[data-grant-unlock-failure]')).not.toBeNull();
  });

  it('closes the prompt without starting anything when it is dismissed', async () => {
    const { container, calls } = await open({
      readiness: readiness([claudeIdentity()]),
      permissions: permissions({ confirmation: 'operator-password' }),
    });
    await click(container, 'Sign in to Claude Code');

    await interact(() =>
      must(document.querySelector<HTMLElement>('[aria-label="Cancel the operator password"]'), 'the scrim').click(),
    );

    expect(document.querySelector('[data-operator-unlock-dialog]')).toBeNull();
    expect(calls.some(call => call.method === 'POST' && call.path === '/v1/fleet/login')).toBe(false);
  });

  it('reports a readiness read that failed rather than rendering an empty fleet', async () => {
    const { container } = await open({
      reject: new Map([['GET /v1/fleet/login', new Error('the daemon did not answer')]]),
    });

    expect(must(container.querySelector('[data-fleet-sign-in-refusal]'), 'the refusal').textContent).toContain(
      'the daemon did not answer',
    );
    expect(container.querySelector('[data-fleet-sign-in-identity]')).toBeNull();
  });

  it('reports a client this browser could not even build', async () => {
    const mounted = await mount(
      <FleetSignInSection
        connection={daemon}
        createClient={async () => {
          throw new Error('this daemon is not paired');
        }}
        now={() => NOW}
      />,
    );
    cleanup = mounted.unmount;

    expect(must(mounted.container.querySelector('[data-fleet-sign-in-refusal]'), 'the refusal').textContent).toContain(
      'not paired',
    );
  });

  it('says so plainly when this daemon publishes no account at all', async () => {
    const { container } = await open({ readiness: readiness([]) });

    expect(container.textContent).toContain('No account is published on this daemon');
  });

  it('re-reads on request', async () => {
    const { container, calls } = await open({ readiness: readiness() });
    const before = calls.filter(call => call.path === '/v1/fleet/login').length;

    await click(container, 'Re-read');

    expect(calls.filter(call => call.path === '/v1/fleet/login').length).toBeGreaterThan(before);
  });

  it('polls a live sign-in, and reads the flow it has rather than starting another', async () => {
    const { container, calls } = await open(
      {
        readiness: readiness([claudeIdentity()]),
        start: claudeFlow('awaiting-code'),
        flow: claudeFlow('complete'),
      },
      { pollMs: 1 },
    );
    await click(container, 'Sign in to Claude Code');

    // The interval is the section's own, so the wait is a real one and short.
    await interact(async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
    });

    expect(calls.some(call => call.method === 'GET' && call.path.endsWith('/flow-one'))).toBe(true);
  });

  it('greys the sign-in out when the operator switched fleet configuration off', async () => {
    const { container } = await open({
      readiness: readiness([claudeIdentity()]),
      permissions: permissions({ mayApply: false, applyRefusal: 'not-granted' }),
    });

    const button = [...container.querySelectorAll('button')].find(node =>
      (node.textContent ?? '').includes('Sign in to Claude Code'),
    );
    expect(must(button, 'the sign-in button').disabled).toBe(true);
  });

  it('mounts as a settings tab of its own, beside Fleet', async () => {
    // The definition the composition root uses, exercised rather than merely exported: a tab nobody
    // renders is a control nobody can reach, which is the class of defect this whole feature removes.
    const { client } = clientFor({ readiness: readiness([claudeIdentity()]) });
    const tab = fleetSignInTab(async () => client);

    expect(tab.id).toBe('fleet-sign-in');
    expect(tab.label).toBe('Sign-in');
    const mounted = await mount(<tab.Surface connection={daemon} />);
    cleanup = mounted.unmount;

    expect(mounted.container.querySelector('[data-fleet-sign-in]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-claude-login]')).not.toBeNull();
  });

  it('carries the identity’s verdict and its reason rather than flattening them', async () => {
    const { container } = await open({
      readiness: readiness([
        {
          ...claudeIdentity(),
          verdict: 'indeterminate',
          reason: 'no usable credential was found, and 1 of 2 could not be read — refusing to decide',
        },
      ]),
    });

    expect(container.textContent).toContain('indeterminate');
    expect(container.textContent).toContain('refusing to decide');
  });
});
