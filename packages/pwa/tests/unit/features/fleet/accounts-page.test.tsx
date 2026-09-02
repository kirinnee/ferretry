/**
 * THE ACCOUNTS PAGE, WIRED. What it reads, what it sends, and what it never spends.
 *
 * ## WHAT THIS SUITE INHERITED
 *
 * It carries the guarantees of the deleted `fleet-sign-in-section.test.tsx` — the shared operator
 * prompt, the mint-then-start ordering for a locked caller, the per-sign-in confirmation for a caller
 * who is merely asked, a refusal in the daemon's own words, the poll of a live flow, and a readiness
 * read that failed never rendering as an empty fleet. Those properties did not stop mattering because
 * the surface moved from a settings sub-tab to a route.
 *
 * Three are NEW, and they are the reason the move happened:
 *
 * 1. `POST /v1/fleet/login` carries the ROW'S OWN `accountId`. The deleted tab sent the login's first
 *    applicable member, so somebody fixing one account signed a different one in.
 * 2. The stored health snapshot is read on mount and is a READ — `GET /v1/fleet/health` — while the only
 *    collecting call on the page sits behind the explicit control.
 * 3. A damaged health snapshot leaves the roster standing, because what is broken is the evidence beside
 *    it rather than the list of accounts.
 *
 * ## AGAINST A REAL DOCUMENT, and that is not a preference
 *
 * The page raises `OperatorUnlockDialog`, whose contract is made of document facts — a focus trap, an
 * Escape stack, what the scrim does. A renderable tree can run none of them.
 *
 * The client is a fake that answers by PATH and VERB rather than by call order, so a test says which
 * route it is about instead of counting requests, and every answer is parsed through the real shared
 * schema on the way in — so a fixture cannot be laxer than the daemon.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { OPERATOR_UNLOCK_HEADER, type UsageAccountView } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { z } from 'zod';

import { AccountsPage } from '../../../../src/features/fleet/accounts-page.tsx';
import type { FleetClient, FleetPermissions } from '../../../../src/features/fleet/fleet-api.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../../support/dom.ts';
import {
  CLAUDE_ACCOUNT_ID,
  CLAUDE_SIBLING_ID,
  CLAUDE_URL,
  claudeFlow,
  claudeIdentity,
  CODEX_ACCOUNT_ID,
  codexFlow,
  codexIdentity,
  healthRow,
  keyedAccount,
  loginAccount,
  NOW,
  readiness,
  usageRow,
} from './harness-login-support.ts';

const daemon = daemonConnection({
  daemonId: 'accounts-daemon',
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

/** A stored snapshot as `GET /v1/fleet/health` publishes one. */
const snapshot = (accounts: readonly ReturnType<typeof healthRow>[] = [healthRow()]) => ({
  at: NOW,
  accounts,
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
  readonly health?: unknown;
  readonly check?: unknown;
  readonly start?: unknown;
  readonly flow?: unknown;
  readonly submit?: unknown;
  readonly cancel?: unknown;
  /** What `POST /v1/fleet/renew` answers. Keyed by PATH, because a renewal is not a flow's submit. */
  readonly renew?: unknown;
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
              : path === '/v1/fleet/health'
                ? (answers.health ?? snapshot())
                : path === '/v1/fleet/health/check'
                  ? (answers.check ?? snapshot())
                  : path === '/v1/usage'
                    ? (answers.usage ?? { stale: false, accounts: [] })
                    : path === '/v1/fleet/renew'
                      ? answers.renew
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

/** A failed test must not leave its mount attached, or the next one queries into two pages. */
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
    <AccountsPage
      connection={daemon}
      createClient={async () => client}
      now={() => NOW}
      // Long, because the poll is driven explicitly where it is the subject; a short one would have
      // the fake answering in the background of every unrelated assertion.
      pollMs={100_000}
      onAddAccount={() => undefined}
      {...overrides}
    />,
  );
  cleanup = mounted.unmount;
  return { container: mounted.container, calls };
};

const rowFor = (container: HTMLElement, accountId: string): HTMLElement =>
  must(container.querySelector<HTMLElement>(`[data-account-row="${accountId}"]`), `the row for ${accountId}`);

const signIn = async (container: HTMLElement, accountId: string): Promise<void> => {
  await interact(() =>
    must(
      rowFor(container, accountId).querySelector<HTMLButtonElement>('[data-account-sign-in]'),
      `the control on ${accountId}`,
    ).click(),
  );
};

const renewNow = async (container: HTMLElement, accountId: string): Promise<void> => {
  await interact(() =>
    must(
      rowFor(container, accountId).querySelector<HTMLButtonElement>('[data-account-renew]'),
      `the renew control on ${accountId}`,
    ).click(),
  );
};

const click = async (root: ParentNode, label: string): Promise<void> => {
  const button = [...root.querySelectorAll('button')].find(node => (node.textContent ?? '').includes(label));
  await interact(() => must(button, `a button labelled "${label}"`).click());
};

const typeInto = async (field: HTMLElement, value: string): Promise<void> => {
  const prototype = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await interact(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const typePassword = async (value: string): Promise<void> => {
  await typeInto(must(document.querySelector<HTMLElement>('[data-grant-unlock-field]'), 'the password field'), value);
  await interact(() =>
    must(document.querySelector<HTMLElement>('[data-operator-unlock-submit]'), 'the submit').click(),
  );
};

describe('AccountsPage', () => {
  it('reads readiness, permissions, the stored health snapshot and the cached usage feed on mount', async () => {
    const { calls } = await open({ readiness: readiness() });

    const reads = calls.map(call => `${call.method} ${call.path}`);
    expect(reads).toContain('GET /v1/fleet/login');
    expect(reads).toContain('GET /v1/fleet/permissions');
    expect(reads).toContain('GET /v1/fleet/health');
    expect(reads).toContain('GET /v1/usage');
    // THE PROPERTY THAT KEEPS THIS PAGE FREE. Opening it collects nothing: the collecting verb is a
    // POST on a different path, and it happens only from the control.
    expect(reads).not.toContain('POST /v1/fleet/health/check');
  });

  it('renders one row per account, each with its own control', async () => {
    const { container } = await open({ readiness: readiness([claudeIdentity(), codexIdentity()]) });

    expect(
      [...container.querySelectorAll('[data-account-row]')].map(node => node.getAttribute('data-account-row')),
    ).toEqual([CLAUDE_ACCOUNT_ID, CLAUDE_SIBLING_ID, CODEX_ACCOUNT_ID]);
  });

  it('shows the stored verdict it read, without having checked anything', async () => {
    const { container } = await open({
      readiness: readiness([claudeIdentity()]),
      health: snapshot([healthRow({ verdict: 'needs_relogin', reason: 'oauth_token_rejected' })]),
    });

    expect(rowFor(container, CLAUDE_ACCOUNT_ID).textContent).toContain('Needs re-login');
    expect(rowFor(container, CLAUDE_ACCOUNT_ID).textContent).toContain('Checked 4m ago');
    // The account with no row in the snapshot is UNREAD, which is a different fact from a verdict of
    // unknown that somebody arrived at.
    expect(rowFor(container, CLAUDE_SIBLING_ID).textContent).toContain('Never checked');
  });

  /**
   * THE CONFLATION THIS PAGE EXISTS TO END.
   *
   * The deleted tab grouped by provider login and sent the login's first applicable member, so a person
   * pressing the control beside the sibling started the first account's sign-in and nothing said so.
   */
  it('sends the clicked row’s OWN accountId, never its login’s first member', async () => {
    const { container, calls } = await open({
      readiness: readiness([claudeIdentity()]),
      start: { ...claudeFlow('awaiting-code'), accountId: CLAUDE_SIBLING_ID },
    });

    await signIn(container, CLAUDE_SIBLING_ID);

    const start = calls.find(call => call.method === 'POST' && call.path === '/v1/fleet/login');
    expect(JSON.parse(String(start?.body))).toEqual({ accountId: CLAUDE_SIBLING_ID });
  });

  it('shows the link the daemon published, under the row it belongs to', async () => {
    const { container } = await open({
      readiness: readiness([claudeIdentity()]),
      start: claudeFlow('awaiting-code'),
    });

    await signIn(container, CLAUDE_ACCOUNT_ID);

    expect(rowFor(container, CLAUDE_ACCOUNT_ID).textContent).toContain(CLAUDE_URL);
    expect(rowFor(container, CLAUDE_SIBLING_ID).querySelector('[data-claude-login]')).toBeNull();
  });

  it('forwards a pasted code and never puts it in the path', async () => {
    const { container, calls } = await open({
      readiness: readiness([claudeIdentity()]),
      start: claudeFlow('awaiting-code'),
      submit: { outcome: 'accepted', flow: claudeFlow('complete') },
    });
    await signIn(container, CLAUDE_ACCOUNT_ID);

    const row = rowFor(container, CLAUDE_ACCOUNT_ID);
    await typeInto(must(row.querySelector<HTMLElement>('[name="claude-login-code"]'), 'the code field'), 'the-code');
    await click(row, 'Finish sign-in');

    const submit = calls.find(call => call.method === 'POST' && call.path.endsWith('/flow-one'));
    expect(JSON.parse(String(submit?.body))).toEqual({ code: 'the-code' });
    expect(submit?.path).not.toContain('the-code');
    expect(container.textContent).toContain('The credential was verified and copied to 1 sibling wrapper.');
    // And the value is nowhere in the document afterwards.
    expect(container.innerHTML).not.toContain('the-code');
  });

  it('reports a submission the daemon refused, in the daemon’s own words', async () => {
    const { container } = await open({
      readiness: readiness([claudeIdentity()]),
      start: claudeFlow('awaiting-code'),
      submit: { outcome: 'unconfirmed', reason: 'the harness was no longer reading' },
    });
    await signIn(container, CLAUDE_ACCOUNT_ID);

    const row = rowFor(container, CLAUDE_ACCOUNT_ID);
    await typeInto(must(row.querySelector<HTMLElement>('[name="claude-login-code"]'), 'the code field'), 'the-code');
    await click(row, 'Finish sign-in');

    expect(must(container.querySelector('[data-accounts-refusal]'), 'the refusal').textContent).toContain(
      'no longer reading',
    );
  });

  it('reports a submission the transport never delivered', async () => {
    const { container } = await open({
      readiness: readiness([claudeIdentity()]),
      start: claudeFlow('awaiting-code'),
      reject: new Map([['POST /v1/fleet/login/flow-one', new Error('the daemon closed the connection')]]),
    });
    await signIn(container, CLAUDE_ACCOUNT_ID);

    const row = rowFor(container, CLAUDE_ACCOUNT_ID);
    await typeInto(must(row.querySelector<HTMLElement>('[name="claude-login-code"]'), 'the code field'), 'the-code');
    await click(row, 'Finish sign-in');

    expect(must(container.querySelector('[data-accounts-refusal]'), 'the refusal').textContent).toContain(
      'closed the connection',
    );
  });

  it('ends a sign-in on cancel', async () => {
    const { container, calls } = await open({
      readiness: readiness([claudeIdentity()]),
      start: claudeFlow('awaiting-code'),
      cancel: claudeFlow('failed'),
    });
    await signIn(container, CLAUDE_ACCOUNT_ID);

    await click(rowFor(container, CLAUDE_ACCOUNT_ID), 'Cancel');

    expect(calls.some(call => call.method === 'DELETE')).toBe(true);
    expect(container.textContent).toContain('fy fleet login');
  });

  it('reports a cancel the daemon refused rather than leaving a dead panel', async () => {
    const { container } = await open({
      readiness: readiness([claudeIdentity()]),
      start: claudeFlow('awaiting-code'),
      reject: new Map([['DELETE /v1/fleet/login/flow-one', new Error('that flow is already gone')]]),
    });
    await signIn(container, CLAUDE_ACCOUNT_ID);

    await click(rowFor(container, CLAUDE_ACCOUNT_ID), 'Cancel');

    expect(must(container.querySelector('[data-accounts-refusal]'), 'the refusal').textContent).toContain(
      'already gone',
    );
  });

  it('ends a Codex sign-in on cancel too, from its own panel', async () => {
    // Codex has no submit, so cancel is the ONLY control it offers once the grant is published — which
    // makes it the one that must not be left unwired.
    const { container, calls } = await open({
      readiness: readiness([codexIdentity()]),
      start: codexFlow('awaiting-approval'),
      cancel: codexFlow('failed'),
    });
    await signIn(container, CODEX_ACCOUNT_ID);

    await click(rowFor(container, CODEX_ACCOUNT_ID), 'Cancel');

    expect(calls.some(call => call.method === 'DELETE')).toBe(true);
    expect(container.textContent).toContain('ran out of time');
  });

  it('shows a refusal from the daemon rather than a silent failure', async () => {
    const { container } = await open({
      readiness: readiness([claudeIdentity()]),
      reject: new Map([['POST /v1/fleet/login', new Error('there is no sign-in to run for this account')]]),
    });

    await signIn(container, CLAUDE_ACCOUNT_ID);

    expect(must(container.querySelector('[data-accounts-refusal]'), 'the refusal').textContent).toContain(
      'no sign-in to run',
    );
  });

  it('asks for the operator password through the SHARED dialog, and starts nothing until it is answered', async () => {
    const { container, calls } = await open({
      readiness: readiness([claudeIdentity()]),
      permissions: permissions({ confirmation: 'operator-password' }),
      start: claudeFlow('awaiting-code'),
    });

    await signIn(container, CLAUDE_ACCOUNT_ID);

    expect(document.querySelector('[data-operator-unlock-dialog="confirm"]')).not.toBeNull();
    const purpose = must(document.querySelector('[data-operator-unlock-purpose]'), 'the purpose');
    // The purpose names the ACCOUNT, because this password is spent on one sign-in and a person about
    // to type it is entitled to know which.
    expect(purpose.textContent).toContain('Studio Claude');
    expect(purpose.textContent).toContain('operator password once');
    // The ROSTER has no password field of its own — every one on screen belongs to the shared dialog,
    // which is the rule this page reuses it for.
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(1);
    expect(container.querySelector('[data-accounts-surface] input[type="password"]')).toBeNull();
    expect(calls.some(call => call.method === 'POST' && call.path === '/v1/fleet/login')).toBe(false);
  });

  it('sends the typed password as the per-sign-in confirmation', async () => {
    const { container, calls } = await open({
      readiness: readiness([claudeIdentity()]),
      permissions: permissions({ confirmation: 'operator-password' }),
      start: claudeFlow('awaiting-code'),
    });
    await signIn(container, CLAUDE_ACCOUNT_ID);

    await typePassword('the password');

    const start = calls.find(call => call.method === 'POST' && call.path === '/v1/fleet/login');
    expect(JSON.parse(String(start?.body))).toEqual({
      accountId: CLAUDE_ACCOUNT_ID,
      operatorPassword: 'the password',
    });
    // No unlock was minted: a `confirm` caller is not locked, and minting one would spend an attempt
    // for nothing and hand this screen five ungoverned minutes it was never granted.
    expect(calls.some(call => call.path === '/v1/grants/unlock')).toBe(false);
  });

  it('mints an unlock first for a LOCKED caller, then carries it in the header', async () => {
    const { container, calls } = await open({
      readiness: readiness([claudeIdentity()]),
      permissions: permissions({ mayApply: false, applyRefusal: 'locked', confirmation: 'operator-password' }),
      unlock: { token: UNLOCK, expiresAt: new Date(NOW + 300_000).toISOString(), ttlSeconds: 300 },
      start: claudeFlow('awaiting-code'),
    });
    await signIn(container, CLAUDE_ACCOUNT_ID);

    expect(document.querySelector('[data-operator-unlock-dialog="unlock"]')).not.toBeNull();
    await typePassword('the password');

    expect(calls.some(call => call.path === '/v1/grants/unlock')).toBe(true);
    const start = calls.find(call => call.method === 'POST' && call.path === '/v1/fleet/login');
    expect(start?.headers[OPERATOR_UNLOCK_HEADER]).toBe(UNLOCK);
  });

  it('spends one typed password on both the mint and the sign-in it was typed for', async () => {
    // `locked` and `confirm` are not alternatives: a remote caller on a machine with an operator
    // password is locked AND owes a per-sign-in confirmation, so the value arrives once and is used
    // twice rather than prompting the same person twice for the same secret.
    const { container, calls } = await open({
      readiness: readiness([claudeIdentity()]),
      permissions: permissions({ mayApply: false, applyRefusal: 'locked', confirmation: 'operator-password' }),
      unlock: { token: UNLOCK, expiresAt: new Date(NOW + 300_000).toISOString(), ttlSeconds: 300 },
      start: claudeFlow('awaiting-code'),
    });
    await signIn(container, CLAUDE_ACCOUNT_ID);
    await typePassword('the password');

    const start = calls.find(call => call.method === 'POST' && call.path === '/v1/fleet/login');
    expect(JSON.parse(String(start?.body)).operatorPassword).toBe('the password');
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
    await signIn(container, CLAUDE_ACCOUNT_ID);

    await typePassword('wrong');

    expect(document.querySelector('[data-operator-unlock-dialog]')).not.toBeNull();
    expect(document.querySelector('[data-grant-unlock-failure]')).not.toBeNull();
  });

  it('keeps a password the DAEMON rejected in the dialog too', async () => {
    // A start refused as unauthorized is a password problem, so it belongs where the password was
    // typed. Tracked rather than inferred: a throw from the mint and a throw from the start are shown
    // in two different places.
    // A REAL `FyHttpError`, because `fleetRefusal` carries a `code` only off one: a hand-shaped object
    // with a `code` property reaches the page as an ordinary unreachable error and takes the OTHER
    // branch, so a fixture like that would pass this test for the wrong reason.
    const refusal = new FyHttpError('that password was not accepted for this sign-in', 403, 'fleet_login_unauthorized');
    const { container } = await open({
      readiness: readiness([claudeIdentity()]),
      permissions: permissions({ confirmation: 'operator-password' }),
      reject: new Map([['POST /v1/fleet/login', refusal]]),
    });
    await signIn(container, CLAUDE_ACCOUNT_ID);

    await typePassword('the password');

    expect(document.querySelector('[data-operator-unlock-dialog]')).not.toBeNull();
    expect(document.querySelector('[data-grant-unlock-failure]')).not.toBeNull();
    expect(container.querySelector('[data-accounts-refusal]')).toBeNull();
  });

  it('closes the prompt over a refusal a password cannot fix, and says so on the page', async () => {
    const { container } = await open({
      readiness: readiness([claudeIdentity()]),
      permissions: permissions({ confirmation: 'operator-password' }),
      reject: new Map([['POST /v1/fleet/login', new Error('this account has no sign-in to run')]]),
    });
    await signIn(container, CLAUDE_ACCOUNT_ID);

    await typePassword('the password');

    // A dialog left open over a refusal a password cannot fix is theatre.
    expect(document.querySelector('[data-operator-unlock-dialog]')).toBeNull();
    expect(must(container.querySelector('[data-accounts-refusal]'), 'the refusal').textContent).toContain(
      'no sign-in to run',
    );
  });

  it('closes the prompt without starting anything when it is dismissed', async () => {
    const { container, calls } = await open({
      readiness: readiness([claudeIdentity()]),
      permissions: permissions({ confirmation: 'operator-password' }),
    });
    await signIn(container, CLAUDE_ACCOUNT_ID);

    await interact(() =>
      must(document.querySelector<HTMLElement>('[aria-label="Cancel the operator password"]'), 'the scrim').click(),
    );

    expect(document.querySelector('[data-operator-unlock-dialog]')).toBeNull();
    expect(calls.some(call => call.method === 'POST' && call.path === '/v1/fleet/login')).toBe(false);
  });

  it('greys every control out when the operator switched fleet configuration off', async () => {
    const { container } = await open({
      readiness: readiness([claudeIdentity()]),
      permissions: permissions({ mayApply: false, applyRefusal: 'not-granted' }),
    });

    expect(
      must(
        rowFor(container, CLAUDE_ACCOUNT_ID).querySelector<HTMLButtonElement>('[data-account-sign-in]'),
        'the control',
      ).disabled,
    ).toBe(true);
  });

  it('reports a readiness read that failed rather than rendering an empty fleet', async () => {
    const { container } = await open({
      reject: new Map([['GET /v1/fleet/login', new Error('the daemon did not answer')]]),
    });

    expect(container.textContent).toContain('the daemon did not answer');
    expect(container.querySelector('[data-account-row]')).toBeNull();
    expect(container.textContent).not.toContain('publishes no account yet');
  });

  it('reports a client this browser could not even build', async () => {
    const mounted = await mount(
      <AccountsPage
        connection={daemon}
        createClient={async () => {
          throw new Error('this daemon is not paired');
        }}
        now={() => NOW}
        onAddAccount={() => undefined}
      />,
    );
    cleanup = mounted.unmount;

    expect(mounted.container.textContent).toContain('not paired');
  });

  it('says so plainly when this daemon publishes no account at all', async () => {
    const { container } = await open({ readiness: readiness([]) });

    expect(container.textContent).toContain('This daemon publishes no account yet');
  });

  /**
   * A DAMAGED SNAPSHOT DOES NOT TAKE THE ROSTER DOWN.
   *
   * What is broken is the evidence beside the accounts, not the list of accounts, and the status is
   * reported as an error rather than as `ready` so nothing on screen claims a check just ran.
   */
  it('keeps every row when the health snapshot could not be read at all', async () => {
    const { container } = await open({
      readiness: readiness([claudeIdentity()]),
      reject: new Map([['GET /v1/fleet/health', new Error('the health file is unreadable')]]),
    });

    expect(container.querySelectorAll('[data-account-row]')).toHaveLength(2);
    expect(rowFor(container, CLAUDE_ACCOUNT_ID).textContent).toContain('Never checked');
    expect(
      must(container.querySelector<HTMLElement>('[data-picker-health]'), 'the check block').dataset.pickerHealth,
    ).toBe('error');
    expect(container.textContent).toContain('unreadable');
  });

  it('reports an ambiguous snapshot as damaged evidence rather than as a fresh check', async () => {
    const { container } = await open({
      readiness: readiness([claudeIdentity()]),
      health: snapshot([healthRow(), healthRow()]),
    });

    expect(
      must(container.querySelector<HTMLElement>('[data-picker-health]'), 'the check block').dataset.pickerHealth,
    ).toBe('error');
    expect(container.textContent).toContain('ambiguous health rows');
    // The duplicated account is removed rather than resolved last-one-wins, so it reads as unread.
    expect(rowFor(container, CLAUDE_ACCOUNT_ID).textContent).toContain('Never checked');
  });

  it('keeps saying unknown when the usage scrape itself failed', async () => {
    const { container } = await open({
      readiness: readiness([claudeIdentity()]),
      reject: new Map([['GET /v1/usage', new Error('the feed is warming up')]]),
    });

    const usage = must(rowFor(container, CLAUDE_ACCOUNT_ID).querySelector('[data-account-usage]'), 'the usage line');
    expect(usage.getAttribute('data-account-usage')).toBe('unknown');
    expect(usage.textContent).not.toContain('0%');
    // A failed scrape must not be reported as a sign-in refusal: the readiness read succeeded.
    expect(container.querySelector('[data-accounts-refusal]')).toBeNull();
  });

  it('joins the usage feed it fetched onto its own rows, by wrapper name', async () => {
    const { container } = await open({
      readiness: readiness([claudeIdentity()]),
      usage: { stale: false, accounts: [usageRow({ agent: 'claude-studio', usageBased: true, weeklyPercent: 7 })] },
    });

    expect(rowFor(container, CLAUDE_ACCOUNT_ID).textContent).toContain('weekly 7% used');
  });

  it('prefers an injected feed, so a fixture pins the row rather than whenever the suite ran', async () => {
    const { container } = await open(
      { readiness: readiness([claudeIdentity()]) },
      { usage: new Map([['claude-studio', usageRow({ usageBased: true, fiveHourPercent: 42 })]]) },
    );

    expect(rowFor(container, CLAUDE_ACCOUNT_ID).textContent).toContain('5h 42% used');
  });

  it('says where a credential comes from when there is no sign-in to offer', async () => {
    const { container } = await open({
      readiness: readiness([{ ...claudeIdentity([keyedAccount()]), verdict: 'no-login' }]),
    });

    const row = must(container.querySelector<HTMLElement>('[data-account-row]'), 'the keyed row');
    expect(row.querySelector('[data-account-sign-in]')).toBeNull();
    expect(row.textContent).toContain('ANTHROPIC_API_KEY');
    expect(row.textContent).toContain('/etc/ferretry/secrets.sh');
  });

  it('re-reads on request', async () => {
    const { container, calls } = await open({ readiness: readiness() });
    const before = calls.filter(call => call.path === '/v1/fleet/login').length;

    await click(container, 'Re-read');

    expect(calls.filter(call => call.path === '/v1/fleet/login').length).toBeGreaterThan(before);
  });

  it('collects the free evidence only from its own control, and says how many rows came back', async () => {
    const { container, calls } = await open({ readiness: readiness([claudeIdentity()]) });

    await click(container, 'Check now');

    expect(calls.some(call => call.method === 'POST' && call.path === '/v1/fleet/health/check')).toBe(true);
    expect(
      must(container.querySelector<HTMLElement>('[data-picker-health]'), 'the check block').dataset.pickerHealth,
    ).toBe('ready');
  });

  it('reports a check that came back ambiguous as an error rather than as a verdict', async () => {
    const { container } = await open({
      readiness: readiness([claudeIdentity()]),
      check: snapshot([healthRow(), healthRow()]),
    });

    await click(container, 'Check now');

    expect(
      must(container.querySelector<HTMLElement>('[data-picker-health]'), 'the check block').dataset.pickerHealth,
    ).toBe('error');
    expect(container.textContent).toContain('ambiguous health rows');
  });

  it('reports a check the daemon refused, in the daemon’s own words', async () => {
    const { container } = await open({
      readiness: readiness([claudeIdentity()]),
      reject: new Map([['POST /v1/fleet/health/check', new Error('this caller may not collect evidence')]]),
    });

    await click(container, 'Check now');

    expect(
      must(container.querySelector<HTMLElement>('[data-picker-health]'), 'the check block').dataset.pickerHealth,
    ).toBe('error');
    expect(container.textContent).toContain('may not collect evidence');
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
    await signIn(container, CLAUDE_ACCOUNT_ID);

    // The interval is the page's own, so the wait is a real one and short.
    await interact(async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
    });

    expect(calls.some(call => call.method === 'GET' && call.path.endsWith('/flow-one'))).toBe(true);
    expect(calls.filter(call => call.method === 'POST' && call.path === '/v1/fleet/login')).toHaveLength(1);
  });

  it('stops polling once a flow has settled, and survives a poll the daemon refused', async () => {
    const { container, calls } = await open(
      {
        readiness: readiness([claudeIdentity()]),
        start: claudeFlow('awaiting-code'),
        reject: new Map([['GET /v1/fleet/login/flow-one', new Error('that flow expired')]]),
      },
      { pollMs: 1 },
    );
    await signIn(container, CLAUDE_ACCOUNT_ID);
    await interact(async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    const polled = calls.filter(call => call.method === 'GET' && call.path.endsWith('/flow-one')).length;

    // A poll that failed is swallowed rather than turned into a page refusal: the flow may well still
    // be live on the host, and the person is acting somewhere this browser cannot see.
    expect(polled).toBeGreaterThan(0);
    expect(container.querySelector('[data-accounts-refusal]')).toBeNull();
  });

  it('polls nothing once every flow it knows about is terminal', async () => {
    const { container, calls } = await open(
      {
        readiness: readiness([claudeIdentity()]),
        start: claudeFlow('complete'),
      },
      { pollMs: 1 },
    );
    await signIn(container, CLAUDE_ACCOUNT_ID);
    await interact(async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
    });

    expect(calls.some(call => call.method === 'GET' && call.path.endsWith('/flow-one'))).toBe(false);
  });

  /**
   * ADDING AN ACCOUNT IS A MOVE TO THE SIBLING PANEL, not a form of this panel's own and no longer a
   * navigation.
   *
   * This asserted an `href` before: Accounts was a route, so "Add an account" was a `RouteLink` to
   * `…/settings#daemons` and the test pinned the pathname the router built. There is no pathname to
   * pin now — Accounts is Fleet's child panel in the daemon settings frame, and the frame answers
   * "show me Fleet" directly — so what is asserted is the CALL, which is the whole contract that
   * survived: pressing it hands off to the panel where a change is reviewed, and nothing on this
   * panel writes a fleet.
   */
  it('hands off to the Fleet panel to add an account rather than offering a form of its own', async () => {
    const opened: number[] = [];
    const { client } = clientFor({ readiness: readiness([claudeIdentity()]) });
    const mounted = await mount(
      <AccountsPage
        connection={daemon}
        createClient={async () => client}
        now={() => NOW}
        onAddAccount={() => opened.push(1)}
      />,
    );
    cleanup = mounted.unmount;

    const add = must(mounted.container.querySelector<HTMLButtonElement>('[data-accounts-add]'), 'the add control');
    // A BUTTON, not a link: there is no address for a panel, and an anchor with a made-up `href`
    // would be the "control that does nothing" this replaced.
    expect(add.tagName).toBe('BUTTON');
    await interact(() => add.click());

    expect(opened).toEqual([1]);
  });
});

/**
 * THE CHEAP HALF OF THIS SURFACE, wired.
 *
 * A renewal is not a small sign-in. It opens no browser, publishes no URL, mints no flow and has
 * nothing to poll, so every property below is about the two things that ARE shared — the password and
 * the roster — and about the one thing that is not: a refusal here arrives as a `200` with a reason,
 * because a renewal that correctly declined to spend a rotating refresh token is the outcome the
 * host's gate exists to produce rather than a failure.
 *
 * `refreshable` on the row is not decoration: `accountRenewOffer` puts the control on that state and
 * no other, so a fixture in any other state would test that the button is absent.
 */
describe('AccountsPage — renewing a credential', () => {
  const REFRESHABLE = readiness([claudeIdentity([loginAccount({ credential: { state: 'refreshable' } })])]);

  const RENEWED = {
    identity: 'claude:studio',
    status: 'renewed',
    accountId: CLAUDE_ACCOUNT_ID,
    reason: 'the harness renewed it, and no browser was opened',
    ran: true,
  } as const;

  const confirming = permissions({ confirmation: 'operator-password' });
  const lockedAndConfirming = permissions({
    mayApply: false,
    applyRefusal: 'locked',
    confirmation: 'operator-password',
  });

  it('renews the row’s own account and starts no sign-in', async () => {
    const { container, calls } = await open({ readiness: REFRESHABLE, renew: RENEWED });

    await renewNow(container, CLAUDE_ACCOUNT_ID);

    const renewal = calls.find(call => call.method === 'POST' && call.path === '/v1/fleet/renew');
    expect(JSON.parse(String(renewal?.body))).toEqual({ accountId: CLAUDE_ACCOUNT_ID });
    // Nothing was signed in and nobody was sent anywhere: that is the whole saving.
    expect(calls.some(call => call.method === 'POST' && call.path === '/v1/fleet/login')).toBe(false);
    expect(container.querySelector('[data-accounts-refusal]')).toBeNull();
  });

  it('re-reads the roster afterwards, because the reading it acted on may have moved', async () => {
    // A rotation the provider REFUSES leaves the home with nothing, so the row's credential sentence
    // and its own offer are both derived from a reading this call may have changed in either
    // direction. Leaving the old roster up would show a renewable account that is now signed out.
    const { container, calls } = await open({ readiness: REFRESHABLE, renew: RENEWED });

    await renewNow(container, CLAUDE_ACCOUNT_ID);

    const renewedAt = calls.findIndex(call => call.method === 'POST' && call.path === '/v1/fleet/renew');
    const reads = calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.method === 'GET' && call.path === '/v1/fleet/login')
      .map(({ index }) => index);
    expect(renewedAt).toBeGreaterThanOrEqual(0);
    expect(reads.some(index => index > renewedAt)).toBe(true);
  });

  it('shows the host’s own sentence when the renewal correctly fired nothing', async () => {
    // EVERY ENDING IS A VALUE. `not-expired` is a `200`, not an error, and the sentence is the host's
    // because only it knows which of the four nothings happened. It also pins the ORDER: the re-read
    // clears the roster's error slot, so a sentence set before it would be wiped by the read that is
    // supposed to accompany it.
    const { container } = await open({
      readiness: REFRESHABLE,
      renew: {
        identity: 'claude:studio',
        status: 'not-expired',
        accountId: CLAUDE_ACCOUNT_ID,
        reason: 'a home in this identity already holds a valid access token',
        ran: false,
      },
    });

    await renewNow(container, CLAUDE_ACCOUNT_ID);

    expect(must(container.querySelector('[data-accounts-refusal]'), 'the refusal').textContent).toContain(
      'already holds a valid access token',
    );
  });

  it('says nothing extra when a refusal arrived with no reason to show', async () => {
    const { container } = await open({
      readiness: REFRESHABLE,
      renew: { identity: 'claude:studio', status: 'not-renewable', ran: false },
    });

    await renewNow(container, CLAUDE_ACCOUNT_ID);

    expect(container.querySelector('[data-accounts-refusal]')).toBeNull();
  });

  it('asks for the operator password in the RENEWAL’s own words, and renews nothing until it is answered', async () => {
    // The two acts spend the same password against the same budget and mean different things: one
    // re-points every agent on this account at whichever provider account is approved, the other
    // rotates the credential already there. Somebody deciding whether to type a password is entitled
    // to be told which — so this prompt must not borrow the sign-in's sentence.
    const { container, calls } = await open({ readiness: REFRESHABLE, permissions: confirming, renew: RENEWED });

    await renewNow(container, CLAUDE_ACCOUNT_ID);

    const purpose = must(document.querySelector('[data-operator-unlock-purpose]'), 'the purpose');
    expect(purpose.textContent).toContain('Renewing');
    expect(purpose.textContent).toContain('Studio Claude');
    expect(purpose.textContent).toContain('against this one renewal');
    expect(purpose.textContent).not.toContain('sign-in');
    expect(must(document.querySelector('[data-operator-unlock-submit]'), 'the submit').textContent).toContain(
      'Renew now',
    );
    expect(calls.some(call => call.method === 'POST' && call.path === '/v1/fleet/renew')).toBe(false);
  });

  it('spends one typed password on both the mint and the renewal it was typed for', async () => {
    const { container, calls } = await open({
      readiness: REFRESHABLE,
      permissions: lockedAndConfirming,
      unlock: { token: UNLOCK, expiresAt: new Date(NOW + 300_000).toISOString(), ttlSeconds: 300 },
      renew: RENEWED,
    });
    await renewNow(container, CLAUDE_ACCOUNT_ID);

    await typePassword('the password');

    expect(calls.some(call => call.path === '/v1/grants/unlock')).toBe(true);
    const renewal = calls.find(call => call.method === 'POST' && call.path === '/v1/fleet/renew');
    expect(JSON.parse(String(renewal?.body)).operatorPassword).toBe('the password');
    expect(renewal?.headers[OPERATOR_UNLOCK_HEADER]).toBe(UNLOCK);
    // The prompt closes on success, and the roster is read again with the unlock it just minted.
    expect(document.querySelector('[data-operator-unlock-dialog]')).toBeNull();
  });

  it('keeps a wrong password in the renewal dialog, where it can be retyped', async () => {
    const refusal = Object.assign(new Error('that is not this machine’s operator password'), {
      code: 'grant_unlock_failed',
      attemptsRemaining: 4,
    });
    const { container, calls } = await open({
      readiness: REFRESHABLE,
      permissions: lockedAndConfirming,
      reject: new Map([['POST /v1/grants/unlock', refusal]]),
    });
    await renewNow(container, CLAUDE_ACCOUNT_ID);

    await typePassword('wrong');

    expect(document.querySelector('[data-operator-unlock-dialog]')).not.toBeNull();
    expect(document.querySelector('[data-grant-unlock-failure]')).not.toBeNull();
    // The mint failed, so nothing was ever fired at a credential.
    expect(calls.some(call => call.method === 'POST' && call.path === '/v1/fleet/renew')).toBe(false);
  });

  it('keeps a password the DAEMON rejected in the renewal dialog too', async () => {
    // A REAL `FyHttpError`: `fleetRefusal` carries a `code` only off one, so a hand-shaped object with
    // a `code` property would reach the page as an ordinary error and take the OTHER branch — passing
    // this test for the wrong reason.
    const refusal = new FyHttpError('that password was not accepted for this renewal', 403, 'fleet_login_unauthorized');
    const { container } = await open({
      readiness: REFRESHABLE,
      permissions: confirming,
      reject: new Map([['POST /v1/fleet/renew', refusal]]),
    });
    await renewNow(container, CLAUDE_ACCOUNT_ID);

    await typePassword('the password');

    expect(document.querySelector('[data-operator-unlock-dialog]')).not.toBeNull();
    expect(document.querySelector('[data-grant-unlock-failure]')).not.toBeNull();
    expect(container.querySelector('[data-accounts-refusal]')).toBeNull();
  });

  it('closes the renewal prompt over a refusal a password cannot fix, and says so on the page', async () => {
    const { container } = await open({
      readiness: REFRESHABLE,
      permissions: confirming,
      reject: new Map([['POST /v1/fleet/renew', new Error('this daemon is not configured to renew credentials')]]),
    });
    await renewNow(container, CLAUDE_ACCOUNT_ID);

    await typePassword('the password');

    expect(document.querySelector('[data-operator-unlock-dialog]')).toBeNull();
    expect(must(container.querySelector('[data-accounts-refusal]'), 'the refusal').textContent).toContain(
      'not configured to renew credentials',
    );
  });

  it('reports a renewal the daemon refused outright, with no prompt in the way', async () => {
    const { container } = await open({
      readiness: REFRESHABLE,
      reject: new Map([['POST /v1/fleet/renew', new Error('a sign-in is already running for this login')]]),
    });

    await renewNow(container, CLAUDE_ACCOUNT_ID);

    expect(must(container.querySelector('[data-accounts-refusal]'), 'the refusal').textContent).toContain(
      'already running',
    );
  });

  it('closes the renewal prompt without renewing anything when it is dismissed', async () => {
    const { container, calls } = await open({ readiness: REFRESHABLE, permissions: confirming, renew: RENEWED });
    await renewNow(container, CLAUDE_ACCOUNT_ID);

    await interact(() =>
      must(document.querySelector<HTMLElement>('[aria-label="Cancel the operator password"]'), 'the scrim').click(),
    );

    expect(document.querySelector('[data-operator-unlock-dialog]')).toBeNull();
    expect(calls.some(call => call.method === 'POST' && call.path === '/v1/fleet/renew')).toBe(false);
  });
});
