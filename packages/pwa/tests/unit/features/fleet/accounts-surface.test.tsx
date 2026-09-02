/**
 * THE ACCOUNTS PAGE AS PIXELS, against a real document.
 *
 * ## WHY THIS SUITE EXISTS AT ALL
 *
 * `accounts-model.test.ts` pins the sentences. It cannot pin that any of them reach a screen, which is
 * the defect class this page was built to remove: the surface it replaced grouped by provider login and
 * offered one control per group, so a person clicking beside `claude-auto-default` started
 * `claude-default`'s sign-in and nothing said so. That is a DOM fact — which control carries which
 * `accountId` — and no projection test can see it.
 *
 * ## AGAINST happy-dom RATHER THAN A RENDERABLE TREE
 *
 * The assertions are `querySelector` on the attributes the surface deliberately publishes
 * (`data-account-row`, `data-account-sign-in`, `data-account-no-sign-in`, `data-account-health`), so a
 * test says WHICH row it is about instead of matching a substring of a serialised tree and hoping the
 * match came from the row it meant. A `<time dateTime>` is also a document fact.
 *
 * The roster is always built by the page's own `accountsRoster` from the shared readiness fixtures —
 * never hand-shaped — so a copy edit in the model cannot leave this suite asserting a sentence the
 * product no longer says.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { HarnessLoginFlow } from '@ferretry/protocol';

import { accountsRoster } from '../../../../src/features/fleet/accounts-model.ts';
import { type AccountsReadState, AccountsSurface } from '../../../../src/features/fleet/accounts-surface.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../../support/dom.ts';
import {
  CLAUDE_ACCOUNT_ID,
  CLAUDE_SIBLING_ID,
  claudeFlow,
  claudeIdentity,
  CODEX_ACCOUNT_ID,
  CODEX_CODE,
  codexFlow,
  codexIdentity,
  healthMap,
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

const ADD_HREF = '/d/accounts-daemon/settings#daemons';

/** A failed test must not leave its mount attached, or the next one queries into two surfaces. */
let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  const teardown = cleanup;
  cleanup = null;
  if (teardown !== null) await teardown();
});

interface Handled {
  readonly started: string[];
  readonly renewed: string[];
  readonly submitted: { readonly flowId: string; readonly code: string }[];
  readonly cancelled: string[];
  readonly navigated: string[];
  readonly reRead: number[];
  readonly checked: number[];
}

interface Options {
  readonly flows?: Readonly<Record<string, HarnessLoginFlow>>;
  readonly refusal?: string | null;
  readonly busy?: boolean;
  readonly mayStart?: boolean;
  /** Omitted deliberately in one test: a surface with no navigator must still render its link. */
  readonly withNavigate?: boolean;
}

const open = async (
  state: AccountsReadState,
  options: Options = {},
): Promise<{ container: HTMLElement; handled: Handled }> => {
  const handled: Handled = {
    started: [],
    renewed: [],
    submitted: [],
    cancelled: [],
    navigated: [],
    reRead: [],
    checked: [],
  };
  const navigate = { onNavigate: (to: string) => handled.navigated.push(to) };
  const mounted = await mount(
    <AccountsSurface
      daemonId={daemon.daemonId}
      state={state}
      flows={options.flows ?? {}}
      refusal={options.refusal ?? null}
      busy={options.busy ?? false}
      mayStart={options.mayStart ?? true}
      healthCheck={{
        status: 'idle',
        error: null,
        checked: 0,
        onCheck: () => handled.checked.push(1),
      }}
      addAccountHref={ADD_HREF}
      {...(options.withNavigate === false ? {} : navigate)}
      onReRead={() => handled.reRead.push(1)}
      onStart={row => handled.started.push(row.accountId)}
      onRenew={row => handled.renewed.push(row.accountId)}
      onSubmitCode={(flow, code) => handled.submitted.push({ flowId: flow.flowId, code })}
      onCancel={flow => handled.cancelled.push(flow.flowId)}
    />,
  );
  cleanup = mounted.unmount;
  return { container: mounted.container, handled };
};

/** The projection the live page renders, so nothing here is a hand-shaped lookalike of it. */
const ready = (
  identities: Parameters<typeof readiness>[0],
  health: ReadonlyMap<string, ReturnType<typeof healthRow>> = new Map(),
  usage?: ReadonlyMap<string, ReturnType<typeof usageRow>>,
): AccountsReadState => ({
  kind: 'ready',
  roster: accountsRoster(readiness(identities), health, usage, NOW),
});

const rowFor = (container: HTMLElement, accountId: string): HTMLElement =>
  must(container.querySelector<HTMLElement>(`[data-account-row="${accountId}"]`), `the row for ${accountId}`);

const click = async (root: ParentNode, label: string): Promise<void> => {
  const button = [...root.querySelectorAll('button')].find(node => (node.textContent ?? '').includes(label));
  await interact(() => must(button, `a button labelled "${label}"`).click());
};

describe('AccountsSurface', () => {
  it('says it is reading, and claims nothing about how many accounts there are', async () => {
    const { container } = await open({ kind: 'reading' });

    expect(
      must(container.querySelector<HTMLElement>('[data-accounts-surface]'), 'the surface').dataset.accountsSurface,
    ).toBe('reading');
    expect(container.textContent).toContain('Reading the accounts on this daemon');
    expect(container.querySelectorAll('[data-account-row]')).toHaveLength(0);
  });

  it('keeps a read that failed distinct from a daemon with no accounts', async () => {
    const { container } = await open({ kind: 'unavailable', reason: 'The daemon did not answer.' });

    // A read that failed is never rendered as zero accounts: a daemon that could not answer still has
    // whatever accounts it has, and an empty roster is a claim nothing established.
    expect(container.textContent).toContain('The daemon did not answer.');
    expect(container.textContent).not.toContain('publishes no account yet');
    expect(container.querySelectorAll('[data-account-row]')).toHaveLength(0);
  });

  it('says a positively-read empty daemon is empty, and where to go next', async () => {
    const { container } = await open(ready([]));

    expect(container.textContent).toContain('This daemon publishes no account yet');
    expect(container.querySelectorAll('[data-accounts-harness]')).toHaveLength(0);
  });

  it('renders one row per ACCOUNT and names the daemon it is about', async () => {
    const { container } = await open(ready([claudeIdentity()]));

    expect(
      [...container.querySelectorAll('[data-account-row]')].map(node => node.getAttribute('data-account-row')),
    ).toEqual([CLAUDE_ACCOUNT_ID, CLAUDE_SIBLING_ID]);
    expect(
      must(container.querySelector('[data-accounts-daemon-id]'), 'the surface').getAttribute('data-accounts-daemon-id'),
    ).toBe('accounts-daemon');
    expect(rowFor(container, CLAUDE_ACCOUNT_ID).textContent).toContain('claude-studio');
  });

  it('groups by harness and counts each group in words a reader can check', async () => {
    const { container } = await open(ready([claudeIdentity(), codexIdentity()]));

    expect(
      [...container.querySelectorAll('[data-accounts-harness]')].map(node =>
        node.getAttribute('data-accounts-harness'),
      ),
    ).toEqual(['claude', 'codex']);
    const claude = must(container.querySelector('[data-accounts-harness="claude"]'), 'the Claude group');
    const codex = must(container.querySelector('[data-accounts-harness="codex"]'), 'the Codex group');
    expect(claude.textContent).toContain('2 accounts');
    // Singular, because "1 accounts" is the tell that a count was interpolated without being read.
    expect(codex.textContent).toContain('1 account');
    expect(codex.textContent).not.toContain('1 accounts');
  });

  /**
   * SAID ON THE PAGE, not in a document.
   *
   * The spike settled that a Claude login can be substituted at launch and a Codex one cannot. This is
   * the screen where somebody is about to assume the wrong one of the two, so both sentences are here.
   */
  it('says on the page which harness can share a login and which cannot', async () => {
    const { container } = await open(ready([claudeIdentity(), codexIdentity()]));

    const claude = must(container.querySelector('[data-accounts-sharing="claude"]'), 'the Claude note');
    const codex = must(container.querySelector('[data-accounts-sharing="codex"]'), 'the Codex note');
    expect(claude.textContent).toBe('One Claude login can serve several accounts.');
    expect(codex.textContent).toBe('A Codex login is signed in per account.');
    const claudeGroup = must(container.querySelector('[data-accounts-harness="claude"]'), 'the Claude group');
    const codexGroup = must(container.querySelector('[data-accounts-harness="codex"]'), 'the Codex group');
    expect(claudeGroup.textContent).toContain('inference only');
    expect(codexGroup.textContent).toContain('API key is different auth');
  });

  it('prints the verdict, its relative label AND the exact instant behind it', async () => {
    const { container } = await open(
      ready([claudeIdentity()], healthMap([healthRow({ verdict: 'needs_relogin', reason: 'oauth_token_rejected' })])),
    );

    const row = rowFor(container, CLAUDE_ACCOUNT_ID);
    expect(must(row.querySelector<HTMLElement>('[data-account-health]'), 'the health line').dataset.accountHealth).toBe(
      'bad',
    );
    expect(row.textContent).toContain('Needs re-login');
    expect(row.textContent).toContain('Checked 4m ago');
    // The relative label is what a person reads; the machine-readable instant is what makes it a TIME.
    // `Healthy` with no expiry beside it is a claim the host's fifteen-minute horizon does not support.
    expect(must(row.querySelector('time'), 'the instant').getAttribute('dateTime')).toBe(
      new Date(NOW - 240_000).toISOString(),
    );
    expect(row.textContent).toContain('The provider rejected this token.');
  });

  it('renders an account nobody has checked as unread, with no time invented for it', async () => {
    const { container } = await open(ready([claudeIdentity()]));

    const row = rowFor(container, CLAUDE_ACCOUNT_ID);
    expect(must(row.querySelector<HTMLElement>('[data-account-health]'), 'the health line').dataset.accountHealth).toBe(
      'muted',
    );
    expect(row.textContent).toContain('Never checked');
    // No `<time>`: there is no instant, and an element with an empty `dateTime` is a fabricated one.
    expect(row.querySelector('time')).toBeNull();
  });

  it('paints a 403 as healthy and keeps the reason the headline does not carry', async () => {
    const { container } = await open(
      ready([claudeIdentity()], healthMap([healthRow({ verdict: 'healthy', reason: 'usage_scope_unavailable' })])),
    );

    const row = rowFor(container, CLAUDE_ACCOUNT_ID);
    expect(must(row.querySelector<HTMLElement>('[data-account-health]'), 'the health line').dataset.accountHealth).toBe(
      'ok',
    );
    expect(row.textContent).toContain('Healthy');
    expect(row.textContent).toContain('quota is not measurable');
    // The one reading that must never appear for a 403: it sends somebody to re-login forever on a
    // working account.
    expect(container.textContent).not.toContain('Needs re-login');
  });

  it('drops a reason that only restates its own verdict, and keeps one that does not', async () => {
    const implied = await open(ready([claudeIdentity()], healthMap([healthRow()])));

    // `provider_accepted` IS `Healthy`; printing it spends a line saying the same thing twice.
    expect(rowFor(implied.container, CLAUDE_ACCOUNT_ID).textContent).not.toContain('The provider accepted');
    expect(rowFor(implied.container, CLAUDE_ACCOUNT_ID).textContent).toContain('Healthy');
  });

  it('says when the newest attempt to re-prove a live verdict failed', async () => {
    const { container } = await open(
      ready(
        [claudeIdentity()],
        healthMap([healthRow({ lastCheckInconclusive: true, lastCheckedAt: NOW - 60_000, verdictAt: NOW - 600_000 })]),
      ),
    );

    const row = rowFor(container, CLAUDE_ACCOUNT_ID);
    // Hiding this is how a fleet reads healthy while every provider call is failing.
    expect(row.textContent).toContain('Confirmed 10m ago');
    expect(row.textContent).toContain('was inconclusive');
  });

  /**
   * THE WHOLE REASON THIS PAGE EXISTS IN THIS SHAPE.
   *
   * The control on a row carries that row's own `accountId` and hands back that row. The surface this
   * replaced offered one button per provider login and started whichever member was listed first.
   */
  it('gives every row its own control, and starts the account that was clicked', async () => {
    const { container, handled } = await open(ready([claudeIdentity()]));

    expect(
      [...container.querySelectorAll('[data-account-sign-in]')].map(node => node.getAttribute('data-account-sign-in')),
    ).toEqual([CLAUDE_ACCOUNT_ID, CLAUDE_SIBLING_ID]);
    await interact(() =>
      must(
        rowFor(container, CLAUDE_SIBLING_ID).querySelector<HTMLButtonElement>('[data-account-sign-in]'),
        'the sibling’s control',
      ).click(),
    );

    expect(handled.started).toEqual([CLAUDE_SIBLING_ID]);
  });

  it('offers a renewal only on the row whose token can renew itself, and hands back that row', async () => {
    // The cheap answer, offered exactly where a person would otherwise reach for the expensive one. A
    // valid credential has nothing to gain and a rotating refresh token to lose, so its row must not
    // carry the button at all — a control the host would refuse is still a control that misleads.
    const { container, handled } = await open(
      ready([
        claudeIdentity([
          loginAccount({ credential: { state: 'refreshable' } }),
          loginAccount({ accountId: CLAUDE_SIBLING_ID, wrapper: 'claude-auto', credential: { state: 'valid' } }),
        ]),
      ]),
    );

    expect(
      [...container.querySelectorAll('[data-account-renew]')].map(node => node.getAttribute('data-account-renew')),
    ).toEqual([CLAUDE_ACCOUNT_ID]);
    // And the sign-in is still there beside it: a renewal that fails still leaves somebody needing one.
    expect(rowFor(container, CLAUDE_ACCOUNT_ID).querySelector('[data-account-sign-in]')).not.toBeNull();

    await interact(() =>
      must(
        rowFor(container, CLAUDE_ACCOUNT_ID).querySelector<HTMLButtonElement>('[data-account-renew]'),
        'the renew control',
      ).click(),
    );

    expect(handled.renewed).toEqual([CLAUDE_ACCOUNT_ID]);
    expect(handled.started).toEqual([]);
  });

  it('labels the control by whether there is already a credential to replace', async () => {
    const { container } = await open(
      ready([
        claudeIdentity([
          loginAccount({ credential: { state: 'missing' } }),
          loginAccount({ accountId: CLAUDE_SIBLING_ID, wrapper: 'claude-auto', credential: { state: 'valid' } }),
        ]),
      ]),
    );

    expect(rowFor(container, CLAUDE_ACCOUNT_ID).textContent).toContain('Sign in');
    expect(rowFor(container, CLAUDE_SIBLING_ID).textContent).toContain('Sign in again');
  });

  it('offers no control for a credential that is not a login, and says where it comes from', async () => {
    const { container } = await open(ready([{ ...claudeIdentity([keyedAccount()]), verdict: 'no-login' }]));

    const row = must(container.querySelector<HTMLElement>('[data-account-row]'), 'the keyed row');
    expect(row.querySelector<HTMLElement>('[data-account-sign-in]')).toBeNull();
    expect(
      must(row.querySelector<HTMLElement>('[data-account-no-sign-in]'), 'the reason').dataset.accountNoSignIn,
    ).toBe('elsewhere');
    // The daemon's own discriminator on the DOM, so "configured" and "broken" stay distinguishable.
    expect(must(row.querySelector('[data-account-source]'), 'the badge').getAttribute('data-account-source')).toBe(
      'token-file',
    );
    expect(row.textContent).toContain('From a file');
    expect(row.textContent).toContain('ANTHROPIC_API_KEY');
    expect(row.textContent).toContain('/etc/ferretry/secrets.sh');
  });

  it('names an environment variable as an environment variable', async () => {
    const { container } = await open(
      ready([
        {
          ...claudeIdentity([keyedAccount({ source: 'environment', variable: 'OPENAI_API_KEY' })]),
          verdict: 'no-login',
        },
      ]),
    );

    const row = must(container.querySelector<HTMLElement>('[data-account-row]'), 'the keyed row');
    expect(must(row.querySelector('[data-account-source]'), 'the badge').getAttribute('data-account-source')).toBe(
      'environment',
    );
    expect(row.textContent).toContain('OPENAI_API_KEY');
  });

  it('prefers the harness’s own reason when the harness is what declined', async () => {
    const { container } = await open(
      ready([
        {
          ...codexIdentity(),
          verdict: 'no-login',
          accounts: [
            loginAccount({
              accountId: CODEX_ACCOUNT_ID,
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
    );

    expect(rowFor(container, CODEX_ACCOUNT_ID).textContent).toContain(
      'this build of Codex authenticates from a service account',
    );
  });

  it('refuses an unavailable account its own way, and marks the row', async () => {
    const { container } = await open(ready([claudeIdentity([loginAccount({ available: false })])]));

    const row = rowFor(container, CLAUDE_ACCOUNT_ID);
    expect(row.textContent).toContain('Unavailable');
    expect(
      must(row.querySelector<HTMLElement>('[data-account-no-sign-in]'), 'the reason').dataset.accountNoSignIn,
    ).toBe('unavailable');
    // Never a greyed control with no explanation: a sign-in here would succeed and still leave a
    // wrapper no session can launch.
    expect(row.querySelector('[data-account-sign-in]')).toBeNull();
    expect(row.textContent).toContain('unable to run');
  });

  it('reports usage in the provider’s own windows, with the direction stated', async () => {
    const { container } = await open(
      ready(
        [claudeIdentity()],
        new Map(),
        new Map([['claude-studio', usageRow({ usageBased: true, fiveHourPercent: 42, weeklyPercent: 13 })]]),
      ),
    );

    const usage = must(rowFor(container, CLAUDE_ACCOUNT_ID).querySelector('[data-account-usage]'), 'the usage line');
    expect(usage.getAttribute('data-account-usage')).toBe('windows');
    expect(usage.textContent).toContain('5h 42% used');
    expect(usage.textContent).toContain('weekly 13% used');
  });

  it('says unknown, never zero, for an account nothing measured', async () => {
    const { container } = await open(
      ready([claudeIdentity()], new Map(), new Map([['claude-studio', usageRow({ authOk: true })]])),
    );

    const usage = must(rowFor(container, CLAUDE_ACCOUNT_ID).querySelector('[data-account-usage]'), 'the usage line');
    expect(usage.getAttribute('data-account-usage')).toBe('unknown');
    expect(usage.textContent).toContain('Usage unknown');
    // A confident zero is the one reading that turns "nobody looked" into "nothing is running".
    expect(container.textContent).not.toContain('0% used');
  });

  it('gives a token-based account a sentence rather than a window of zero', async () => {
    const { container } = await open(
      ready([claudeIdentity()], new Map(), new Map([['claude-studio', usageRow({ usageBased: false })]])),
    );

    const usage = must(rowFor(container, CLAUDE_ACCOUNT_ID).querySelector('[data-account-usage]'), 'the usage line');
    expect(usage.getAttribute('data-account-usage')).toBe('token-based');
    expect(usage.textContent).toBe('Token-based — no quota window to report');
  });

  it('says what one login covers, and what the fleet decided about it', async () => {
    const { container } = await open(
      ready([{ ...claudeIdentity(), verdict: 'sync', reason: 'the auto home has no credential' }]),
    );

    const line = must(rowFor(container, CLAUDE_ACCOUNT_ID).querySelector('[data-account-login]'), 'the login line');
    expect(line.getAttribute('data-account-login')).toBe('claude:studio');
    expect(line.textContent).toContain('This login covers 2 accounts, this one included.');
    expect(line.textContent).toContain('has no credential of its own yet');
    expect(line.textContent).toContain('The auto home has no credential.');
    // The configuration schema's own word, which a reader would have to learn first — the same defect
    // as the lane and layer badges that were removed from every screen.
    expect(line.textContent).not.toContain('sync');
  });

  it('spends no line on a login that is complete', async () => {
    const { container } = await open(ready([{ ...claudeIdentity(), verdict: 'complete' }]));

    const line = must(rowFor(container, CLAUDE_ACCOUNT_ID).querySelector('[data-account-login]'), 'the login line');
    expect(line.textContent).toBe('claude:studio · This login covers 2 accounts, this one included.');
  });

  it('shows a refusal beside a roster that still rendered', async () => {
    const { container } = await open(ready([claudeIdentity()]), { refusal: 'there is no sign-in to run' });

    const refusal = must(container.querySelector('[data-accounts-refusal]'), 'the refusal');
    expect(refusal.getAttribute('role')).toBe('alert');
    expect(refusal.textContent).toContain('there is no sign-in to run');
    // The roster is not taken down with it: the read succeeded and only the action failed.
    expect(container.querySelectorAll('[data-account-row]')).toHaveLength(2);
  });

  it('puts a live Claude sign-in under the row it belongs to, and forwards the pasted code', async () => {
    const { container, handled } = await open(ready([claudeIdentity()]), {
      flows: { [CLAUDE_ACCOUNT_ID]: claudeFlow('awaiting-code') },
    });

    const row = rowFor(container, CLAUDE_ACCOUNT_ID);
    expect(
      must(row.querySelector('[data-claude-login-identity]'), 'the panel').getAttribute('data-claude-login-identity'),
    ).toBe('claude:studio');
    // And nowhere else: the account on screen and the account being signed in are the same one.
    expect(rowFor(container, CLAUDE_SIBLING_ID).querySelector('[data-claude-login]')).toBeNull();

    const field = must(row.querySelector<HTMLElement>('[name="claude-login-code"]'), 'the code field');
    await interact(() => {
      const prototype = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, 'the-code');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(row, 'Finish sign-in');

    expect(handled.submitted).toEqual([{ flowId: 'flow-one', code: 'the-code' }]);
  });

  it('puts a live Codex sign-in under its own row, with a device code and nowhere to bring one back', async () => {
    const { container, handled } = await open(ready([codexIdentity()]), {
      flows: { [CODEX_ACCOUNT_ID]: codexFlow('awaiting-approval') },
    });

    const row = rowFor(container, CODEX_ACCOUNT_ID);
    expect(must(row.querySelector('[data-codex-login-user-code]'), 'the device code').textContent).toBe(CODEX_CODE);
    // Codex has no return trip, so a code field here would be a control that can never be answered.
    expect(row.querySelector('textarea')).toBeNull();

    await click(row, 'Cancel');

    expect(handled.cancelled).toEqual(['flow-one']);
  });

  it('cancels a Claude sign-in from its own panel too', async () => {
    const { container, handled } = await open(ready([claudeIdentity()]), {
      flows: { [CLAUDE_ACCOUNT_ID]: claudeFlow('awaiting-code') },
    });

    await click(rowFor(container, CLAUDE_ACCOUNT_ID), 'Cancel');

    expect(handled.cancelled).toEqual(['flow-one']);
  });

  it('says so instead of vanishing when this caller may inspect and not act', async () => {
    const { container } = await open(ready([claudeIdentity()]), { mayStart: false });

    const button = must(
      rowFor(container, CLAUDE_ACCOUNT_ID).querySelector<HTMLButtonElement>('[data-account-sign-in]'),
      'the control',
    );
    // Present and disabled, rather than absent: a missing control reads as "this account cannot be
    // signed in", which is a claim about the ACCOUNT rather than about this caller.
    expect(button.disabled).toBe(true);
  });

  it('disables the controls a request is already in flight for', async () => {
    const { container } = await open(ready([claudeIdentity()]), { busy: true });

    expect(
      must(
        rowFor(container, CLAUDE_ACCOUNT_ID).querySelector<HTMLButtonElement>('[data-account-sign-in]'),
        'the control',
      ).disabled,
    ).toBe(true);
    const reRead = [...container.querySelectorAll('button')].find(node => (node.textContent ?? '').includes('Re-read'));
    expect(must(reRead, 'the re-read control').disabled).toBe(true);
  });

  it('sends a person to add an account through the router rather than a page load', async () => {
    const { container, handled } = await open(ready([claudeIdentity()]));

    const link = must(container.querySelector<HTMLAnchorElement>('[data-accounts-add]'), 'the add link');
    expect(link.getAttribute('href')).toBe(ADD_HREF);
    await interact(() => link.click());

    expect(handled.navigated).toEqual([ADD_HREF]);
    // What adding one actually does is said beside the control, because it is a review step and not a
    // write: nothing on the other side of this link changes a fleet on its own.
    expect(container.textContent).toContain('reviewed before anything is written');
  });

  it('still renders the add link where the host wired no navigator', async () => {
    const { container } = await open(ready([claudeIdentity()]), { withNavigate: false });

    // A real `<a href>` either way, so "open in a new tab" keeps working and the destination is
    // inspectable even when this host handles navigation itself.
    expect(
      must(container.querySelector<HTMLAnchorElement>('[data-accounts-add]'), 'the add link').getAttribute('href'),
    ).toBe(ADD_HREF);
  });

  it('re-reads on request', async () => {
    const { container, handled } = await open(ready([claudeIdentity()]));

    await click(container, 'Re-read');

    expect(handled.reRead).toHaveLength(1);
  });

  it('offers the shared check control, and says it spends no inference quota', async () => {
    const { container, handled } = await open(ready([claudeIdentity()]));

    await click(container, 'Check now');

    expect(handled.checked).toHaveLength(1);
    // The sentence exists because a reader who used the old button has every reason to assume this one
    // still bills them.
    expect(container.textContent).toContain('uses no inference quota');
  });
});
