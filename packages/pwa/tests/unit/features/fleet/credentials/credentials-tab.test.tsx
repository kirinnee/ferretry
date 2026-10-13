import { afterEach, describe, expect, it } from 'bun:test';
import type { FleetCredentialList, FleetCredentialView, FleetMachineView } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { z } from 'zod';
import { CredentialsTab } from '../../../../../src/features/fleet/credentials/credentials-tab.tsx';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-api.ts';
import { interact, mount, must } from '../../../../support/dom.ts';
import {
  APPLIED,
  type Call,
  CHANGE_ID,
  CREDENTIALS,
  claudeFlow,
  credential,
  machine,
  NOW,
  PASSWORD,
  READS,
  STUDIO,
  scripted,
  stagedFrom,
  withStatus,
} from '../account-support.ts';

const CHANGES = 'POST /v1/fleet/changes';
const APPLY = `POST /v1/fleet/changes/${CHANGE_ID}/apply`;
const LOGIN = 'POST /v1/fleet/login';
const FLOW = '/v1/fleet/login/flow-1';
const LIST = 'GET /v1/fleet/credentials';
const HASH = '#machines/studio-mac/credentials';

afterEach(() => {
  window.location.hash = '';
});

const listOf = (credentials: readonly FleetCredentialView[]): FleetCredentialList => ({
  ...CREDENTIALS,
  credentials: [...credentials],
});

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

const text = (container: HTMLElement, selector: string): string | undefined =>
  container.querySelector(selector)?.textContent ?? undefined;

const button = (container: HTMLElement, label: string): HTMLButtonElement =>
  must(
    Array.from(container.querySelectorAll('button')).find(candidate => candidate.textContent?.trim() === label),
    `the "${label}" button`,
  );

const only = (calls: readonly Call[], key: string): Call[] =>
  calls.filter(call => `${call.method} ${call.path}` === key);

const changeBodies = (calls: readonly Call[]): unknown[] =>
  only(calls, CHANGES).map(call => (call.body as { change: unknown }).change);

const gated = (inner: FleetClient, held: string, gate: Promise<void>): FleetClient => ({
  request: async <T,>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
    if (path.endsWith(held)) await gate;
    return inner.request(path, schema, init);
  },
});

interface Options {
  readonly hash?: string;
  readonly machine?: FleetMachineView | null;
  readonly online?: boolean;
  readonly pollMs?: number;
  readonly wrap?: (client: FleetClient) => FleetClient;
}

const open = async (routes: Record<string, unknown> = {}, options: Options = {}) => {
  window.location.hash = options.hash ?? '';
  const calls: Call[] = [];
  const base = scripted({ ...READS(), [CHANGES]: stagedFrom, [APPLY]: APPLIED, ...routes }, calls);
  const client = options.wrap === undefined ? base : options.wrap(base);
  const createClient = async (): Promise<FleetClient> => client;
  const view = await mount(
    <CredentialsTab
      connection={STUDIO}
      machineName="studio-mac"
      machine={options.machine === undefined ? machine() : options.machine}
      online={options.online ?? true}
      checking={false}
      onRetry={() => undefined}
      createClient={createClient}
      now={() => NOW}
      {...(options.pollMs === undefined ? {} : { pollMs: options.pollMs })}
    />,
  );
  await settle();
  return { view, calls };
};

describe('CredentialsTab · the list', () => {
  it('groups logins by tool, with status, use, badges and the usage bars', async () => {
    const { view } = await open();
    const c = view.container;
    expect(text(c, '[data-credentials-tab] > div > p')).toBe('3 logins on studio-mac');
    const claude = must(c.querySelector('[data-credentials-group="claude"]'), 'the Claude group');
    const codex = must(c.querySelector('[data-credentials-group="codex"]'), 'the Codex group');
    expect(claude.querySelector('h4')?.textContent).toBe('Claude Code');
    expect(codex.querySelector('h4')?.textContent).toBe('Codex');
    expect(
      Array.from(claude.querySelectorAll('[data-credential-row]')).map(row => row.getAttribute('data-credential-row')),
    ).toEqual(['claude-personal', 'claude-work']);

    const personal = must(c.querySelector<HTMLElement>('[data-credential-row="claude-personal"]'), 'personal row');
    expect(personal.getAttribute('href')).toBe('#machines/studio-mac/credentials/claude-personal');
    expect(personal.textContent).toContain('you@example.com');
    expect(personal.querySelector('[data-credential-badges]')?.textContent).toBe(
      'personalShared with claude in your terminal',
    );
    expect(personal.textContent).toContain('Ready · Used by 3 runtimes');
    const bars = Array.from(personal.querySelectorAll('[role="img"]'));
    expect(bars.map(bar => bar.getAttribute('aria-label'))).toEqual([
      '5h: 38% used · resets in 2h',
      'Week: 83% used · resets in 3d',
    ]);
    expect(bars[0]?.querySelector('span')?.className).toContain('bg-accent');
    expect(bars[1]?.querySelector('span')?.className).toContain('bg-warn');
    expect(bars[1]?.querySelector('span')?.getAttribute('style')).toContain('83%');
    expect(personal.textContent).toContain('38% used · resets in 2h');

    const work = must(c.querySelector('[data-credential-row="claude-work"]'), 'work row');
    expect(work.textContent).toContain('Refresh due · Used by 1 runtime');
    expect(work.querySelector('[data-credential-usage]')).toBeNull();
    expect(work.querySelector('[data-credential-badges]')?.textContent).toBe('work');

    const codexRow = must(c.querySelector('[data-credential-row="codex"]'), 'codex row');
    expect(codexRow.textContent).toContain('Shared with codex in your terminal');
    expect(codexRow.querySelector('[data-credential-usage="unknown"]')?.textContent).toBe('Usage not measured yet');

    expect(text(c, '[data-credentials-labels-hint]')).toBe(
      'Two logins share an email, so each has a label you chose. Change a label from the login’s page.',
    );
    await view.unmount();
  });

  it('says what it cannot measure, copied slots, and a login whose email nobody told us', async () => {
    const empty = { ...credential({ id: 'claude-slot', clonedFrom: 'laptop', ...withStatus('needs_sign_in') }) };
    delete empty.email;
    const partial = credential({
      id: 'claude-half',
      email: 'half@example.com',
      usage: {
        fiveHour: { usedPercent: 12.4, resetsAt: '2026-10-13T07:00:00.000Z' },
        weekly: {},
        source: 'anthropic-usage',
        at: '2026-10-13T07:58:00.000Z',
      },
    });
    const { view } = await open({ [LIST]: listOf([empty, partial]) });
    const slot = must(view.container.querySelector('[data-credential-row="claude-slot"]'), 'slot row');
    expect(slot.textContent).toContain('Claude Code login');
    expect(slot.querySelector('[data-credential-badges]')?.textContent).toBe('Copied slot from laptop');
    expect(slot.textContent).toContain('Needs sign-in · Not used yet');
    const half = must(view.container.querySelector('[data-credential-row="claude-half"]'), 'half row');
    expect(Array.from(half.querySelectorAll('[role="img"]')).map(bar => bar.getAttribute('aria-label'))).toEqual([
      '5h: 12% used · resets now',
      'Week: not measured yet',
    ]);
    expect(half.textContent).toContain('not measured');
    expect(half.querySelector('[data-credential-badges]')).toBeNull();
    expect(view.container.querySelector('[data-credentials-labels-hint]')).toBeNull();
    expect(view.container.querySelector('[data-credentials-group="codex"]')).toBeNull();
    await view.unmount();
  });

  it('explains the labels when a login says it needs one, even before two share an email', async () => {
    const { view } = await open({
      [LIST]: listOf([credential({ id: 'claude-a', email: 'a@example.com', needsLabel: true })]),
    });
    expect(view.container.querySelector('[data-credentials-labels-hint]')).not.toBeNull();
    expect(text(view.container, '[data-credentials-tab] > div > p')).toBe('1 login on studio-mac');
    await view.unmount();
  });

  it('reads first, then lists; says when the machine would not answer', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const base = scripted(READS());
    const client: FleetClient = {
      request: async <T,>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
        await gate;
        return base.request(path, schema, init);
      },
    };
    const view = await mount(
      <CredentialsTab
        connection={STUDIO}
        machineName="studio-mac"
        machine={machine()}
        online
        checking={false}
        onRetry={() => undefined}
        createClient={async () => client}
        now={() => NOW}
      />,
    );
    expect(text(view.container, '[data-credentials-loading]')).toBe('Reading the logins on studio-mac…');
    release();
    await settle();
    expect(view.container.querySelector('[data-credentials-loading]')).toBeNull();
    expect(view.container.querySelector('[data-credentials-tab]')).not.toBeNull();
    await view.unmount();

    const failed = await open({
      [LIST]: new FyHttpError('This machine could not list its logins.', 500, 'fleet_credentials_unreadable'),
    });
    expect(text(failed.view.container, '[data-credentials-failed]')).toBe('This machine could not list its logins.');
    expect(failed.view.container.querySelector('[data-credentials-tab]')).toBeNull();
    await failed.view.unmount();
  });

  it('with no logins it says so and offers Add a login; stopping it returns to the list', async () => {
    const { view } = await open({ [LIST]: listOf([]) });
    expect(text(view.container, '[data-credentials-empty] h3')).toBe('No logins on studio-mac');
    expect(text(view.container, '[data-credentials-empty] p')).toBe(
      'A credential is one login to Claude Code or Codex. It belongs to this machine.',
    );
    await click(view.container.querySelector('[data-credentials-empty] [data-add-login]'), 'Add a login');
    expect(view.container.querySelector('[data-machine-stepper="add-login"]')).not.toBeNull();
    expect(text(view.container, '#machine-stepper-title')).toBe('Add a login');
    await click(view.container.querySelector('[data-stepper-cancel]'), 'Cancel');
    expect(text(view.container, '[data-stepper-confirm] p')).toBe('Stop adding a login?');
    await click(view.container.querySelector('[data-stepper-stop]'), 'Stop');
    expect(view.container.querySelector('[data-credentials-empty]')).not.toBeNull();
    await view.unmount();
  });

  it('a link to a login that is gone says so and still shows the list', async () => {
    const { view } = await open({}, { hash: `${HASH}/ghost` });
    expect(text(view.container, '[data-credential-missing]')).toBe('There is no login ghost on studio-mac any more.');
    expect(view.container.querySelectorAll('[data-credential-row]')).toHaveLength(3);
    await view.unmount();
  });
});

describe('CredentialsTab · a login’s page', () => {
  it('shows the status and its words, the usage, who uses it, and goes back to the list', async () => {
    const { view } = await open({}, { hash: `${HASH}/claude-personal` });
    const c = view.container;
    expect(c.querySelector('[data-credential-page]')?.getAttribute('data-credential-page')).toBe('claude-personal');
    expect(text(c, 'h3')).toBe('Claude Code login');
    expect(text(c, '[data-credential-page] p.font-mono')).toBe('you@example.com (personal)');
    expect(text(c, '[data-credential-badges]')).toBe('personalShared with claude in your terminal');
    expect(c.querySelector('[data-credential-status]')?.getAttribute('data-credential-status')).toBe('ready');
    expect(text(c, '[data-credential-status]')).toContain('Ready. Checked a few minutes ago.');
    expect(c.querySelectorAll('[data-credential-status] [role="img"]')).toHaveLength(2);
    expect(text(c, '[data-credential-label]')).toContain(
      'Only you see this. It tells logins with the same email apart.',
    );
    expect(c.querySelector('[data-credential-needs-label]')).toBeNull();
    expect(c.querySelector('[data-credential-sign-in]')).toBeNull();

    const links = Array.from(c.querySelectorAll<HTMLElement>('[data-credential-runtime]'));
    expect(links.map(link => link.getAttribute('data-credential-runtime'))).toEqual([
      'claude-default',
      'claude-agent',
      'claude-review',
    ]);
    expect(links[0]?.getAttribute('href')).toBe('#machines/studio-mac/runtimes/claude-default');
    expect(links[0]?.textContent).toContain('Default profile');
    expect(links[1]?.textContent).toContain('Agent work profile');

    await click(c.querySelector('[data-page-back]'), 'Credentials');
    expect(window.location.hash).toBe(HASH);
    expect(c.querySelector('[data-credential-page]')).toBeNull();
    expect(c.querySelectorAll('[data-credential-row]')).toHaveLength(3);
    await view.unmount();
  });

  it('a login nothing uses says so, and a copied empty slot says where it came from', async () => {
    const slot = credential({ id: 'claude-slot', clonedFrom: 'laptop', ...withStatus('needs_sign_in') });
    const { view } = await open({ [LIST]: listOf([slot]) }, { hash: `${HASH}/claude-slot` });
    expect(text(view.container, '[data-credential-status]')).toContain(
      'Empty slot. It was copied from laptop without the login itself. Sign in once and every runtime that uses it can launch.',
    );
    expect(view.container.textContent).toContain('No runtime uses this login yet.');
    expect(view.container.querySelector('[data-credential-actions]')).toBeNull();
    expect(view.container.querySelector('[data-credential-status] [data-credential-usage]')).toBeNull();
    await view.unmount();
  });

  it('saves a label as one change and says so; an emptied label removes it', async () => {
    const { view, calls } = await open({}, { hash: `${HASH}/claude-work` });
    const c = view.container;
    const field = must(c.querySelector<HTMLInputElement>('#credential-label-claude-work'), 'the label field');
    expect(field.value).toBe('work');
    expect(c.querySelector('[data-credential-label] [data-change-submit]')).toBeNull();
    await type(field, '  office ');
    expect(text(c, '[data-credential-label] [data-change-submit]')).toBe('Save label');
    await click(c.querySelector('[data-credential-label] [data-change-submit]'), 'Save label');
    expect(changeBodies(calls)).toEqual([{ kind: 'credential.label', id: 'claude-work', label: 'office' }]);
    expect(text(c, '[data-credential-notice]')).toBe('Label saved.');
    expect(only(calls, LIST).length).toBeGreaterThanOrEqual(2);

    await type(field, '');
    await click(c.querySelector('[data-credential-label] [data-change-submit]'), 'Save label');
    expect(changeBodies(calls).at(-1)).toEqual({ kind: 'credential.label', id: 'claude-work', label: null });
    await view.unmount();
  });

  it('a label the machine refuses shows the refusal and no "Label saved"', async () => {
    const { view } = await open(
      { [CHANGES]: new FyHttpError('That label is already used by another login.', 409, 'fleet_change_refused') },
      { hash: `${HASH}/claude-work` },
    );
    await type(
      must(view.container.querySelector<HTMLInputElement>('#credential-label-claude-work'), 'field'),
      'personal',
    );
    await click(view.container.querySelector('[data-credential-label] [data-change-submit]'), 'Save label');
    expect(text(view.container, '[data-credential-label] [data-change-refusal]')).toBe(
      'That label is already used by another login.',
    );
    expect(view.container.querySelector('[data-credential-notice]')).toBeNull();
    await view.unmount();
  });

  it('asks the person to label logins that share an email, and cannot save a label while offline', async () => {
    const twin = credential({ id: 'claude-twin', needsLabel: true });
    const { view } = await open({ [LIST]: listOf([twin]) }, { hash: `${HASH}/claude-twin`, online: false });
    expect(text(view.container, '[data-credential-needs-label]')).toBe(
      'Another Claude Code login here has the same email. Give each a different label.',
    );
    await type(must(view.container.querySelector<HTMLInputElement>('#credential-label-claude-twin'), 'field'), 'home');
    expect(
      must(view.container.querySelector<HTMLButtonElement>('[data-credential-label] [data-change-submit]'), 'save')
        .disabled,
    ).toBe(true);
    await view.unmount();
  });
});

describe('CredentialsTab · Check now', () => {
  it('checks without a staged change, shows the answer in words, and says it is checking meanwhile', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const { view, calls } = await open(
      { 'POST /v1/fleet/credentials/claude-work/check': credential({ id: 'claude-work', label: 'work' }) },
      { hash: `${HASH}/claude-work`, wrap: client => gated(client, '/check', gate) },
    );
    const c = view.container;
    expect(text(c, '[data-credential-actions] [data-change-submit]')).toBe('Check now');
    await interact(() => {
      c.querySelector<HTMLElement>('[data-credential-actions] [data-change-submit]')?.click();
    });
    await settle();
    expect(c.querySelector('[data-credential-status]')?.getAttribute('data-credential-status')).toBe('checking');
    expect(text(c, '[data-credential-status]')).toContain('Checking with Claude Code…');
    expect(text(c, '[data-credential-actions] [data-change-submit]')).toBe('Checking…');
    await interact(async () => {
      release();
    });
    await settle();
    expect(only(calls, 'POST /v1/fleet/credentials/claude-work/check')[0]?.body).toEqual({});
    expect(only(calls, CHANGES)).toHaveLength(0);
    expect(text(c, '[data-credential-notice]')).toBe('Checked. The login works.');
    expect(c.querySelector('[data-credential-status]')?.getAttribute('data-credential-status')).toBe('refresh_due');
    await view.unmount();
  });

  it('a check that finds the login not ready says what the daemon said', async () => {
    const { view } = await open(
      {
        'POST /v1/fleet/credentials/claude-work/check': credential({
          id: 'claude-work',
          label: 'work',
          ...withStatus('needs_sign_in'),
        }),
      },
      { hash: `${HASH}/claude-work` },
    );
    await click(view.container.querySelector('[data-credential-actions] [data-change-submit]'), 'Check now');
    expect(text(view.container, '[data-credential-notice]')).toBe(
      'Checked. Needs sign-in. Runtimes that use this login can’t launch.',
    );
    await view.unmount();
  });

  it('a check that fails shows why where changes show their refusals, and a failed re-read keeps what was seen', async () => {
    let reads = 0;
    const { view } = await open(
      {
        'POST /v1/fleet/credentials/claude-work/check': new FyHttpError(
          'Anthropic did not answer in time.',
          502,
          'fleet_credential_check_failed',
        ),
        [LIST]: () => {
          reads += 1;
          return reads === 1 ? CREDENTIALS : new FyHttpError('This machine could not list its logins.', 500, 'x');
        },
      },
      { hash: `${HASH}/claude-work` },
    );
    await click(view.container.querySelector('[data-credential-actions] [data-change-submit]'), 'Check now');
    expect(text(view.container, '[data-credential-actions] [data-change-refusal]')).toBe(
      'Anthropic did not answer in time.',
    );
    expect(view.container.querySelector('[data-credential-notice]')).toBeNull();
    expect(view.container.querySelector('[data-credential-page]')).not.toBeNull();

    await click(view.container.querySelector('[data-page-back]'), 'Credentials');
    expect(text(view.container, '[data-credentials-tab] > p[role="alert"]')).toBe(
      'This machine could not list its logins.',
    );
    expect(view.container.querySelectorAll('[data-credential-row]')).toHaveLength(3);
    await view.unmount();
  });

  it('sends the operator password with a check when this browser owes it', async () => {
    const { view, calls } = await open(
      {
        'GET /v1/fleet/permissions': {
          mayInspect: true,
          mayPropose: true,
          mayApply: true,
          applyRefusal: 'granted',
          confirmation: 'operator-password',
        },
        'POST /v1/fleet/credentials/claude-work/check': credential({ id: 'claude-work', label: 'work' }),
      },
      { hash: `${HASH}/claude-work` },
    );
    const submit = must(
      view.container.querySelector<HTMLButtonElement>('[data-credential-actions] [data-change-submit]'),
      'Check now',
    );
    expect(submit.disabled).toBe(true);
    await type(
      must(
        view.container.querySelector<HTMLInputElement>('[data-credential-actions] [data-change-password]'),
        'password',
      ),
      PASSWORD,
    );
    await click(submit, 'Check now');
    expect(only(calls, 'POST /v1/fleet/credentials/claude-work/check')[0]?.body).toEqual({
      operatorPassword: PASSWORD,
    });
    expect(text(view.container, '[data-credential-notice]')).toBe('Checked. The login works.');
    await view.unmount();
  });

  it('says why a check is not offered, hides sign out when it is not offered, and disables both offline', async () => {
    const noCheck = credential({
      id: 'codex',
      harness: 'codex',
      checkNow: {
        available: false,
        reason: 'Codex checks refresh the login, which this machine does not allow from here.',
      },
      signOut: { available: false, sentence: 'Sign out of Codex?', runtimesAffected: 0, signsOutTerminal: true },
    });
    const { view } = await open({ [LIST]: listOf([noCheck]) }, { hash: `${HASH}/codex` });
    expect(text(view.container, '[data-credential-actions]')).toBe(
      'Codex checks refresh the login, which this machine does not allow from here.',
    );
    expect(view.container.querySelector('[data-credential-sign-out-ask]')).toBeNull();
    await view.unmount();

    const offline = await open({}, { hash: `${HASH}/claude-work`, online: false });
    expect(
      must(
        offline.view.container.querySelector<HTMLButtonElement>('[data-credential-actions] [data-change-submit]'),
        'check',
      ).disabled,
    ).toBe(true);
    await offline.view.unmount();
  });
});

describe('CredentialsTab · Sign out', () => {
  it('confirms with the daemon’s own sentence, and Keep signed in changes nothing', async () => {
    const { view, calls } = await open({}, { hash: `${HASH}/claude-personal` });
    const c = view.container;
    await click(c.querySelector('[data-credential-sign-out-ask]'), 'Sign out…');
    expect(text(c, '[data-credential-sign-out] p')).toBe(
      'Sign out of you@example.com (personal)? This also signs out claude in your terminal on studio-mac. 3 runtimes will need sign-in.',
    );
    expect(c.querySelector('[role="alert"]')).not.toBeNull();
    expect(text(c, '[data-credential-sign-out] [data-change-submit]')).toBe('Sign out');
    expect(c.querySelector('[data-credential-actions] [data-credential-sign-out-ask]')).toBeNull();
    await click(c.querySelector('[data-sign-out-keep]'), 'Keep signed in');
    expect(c.querySelector('[data-credential-sign-out]')).toBeNull();
    expect(c.querySelector('[data-credential-sign-out-ask]')).not.toBeNull();
    expect(only(calls, CHANGES)).toHaveLength(0);
    await view.unmount();
  });

  it('signs out as one change and says how many runtimes now need sign-in', async () => {
    const { view, calls } = await open(
      {
        [APPLY]: { outcome: 'signed-out', credential: { ...CREDENTIALS.credentials[0] } },
      },
      { hash: `${HASH}/claude-personal` },
    );
    await click(view.container.querySelector('[data-credential-sign-out-ask]'), 'Sign out…');
    await click(view.container.querySelector('[data-credential-sign-out] [data-change-submit]'), 'Sign out');
    expect(changeBodies(calls)).toEqual([{ kind: 'credential.signout', id: 'claude-personal' }]);
    expect(text(view.container, '[data-credential-notice]')).toBe('Signed out. 3 runtimes need sign-in.');
    expect(view.container.querySelector('[data-credential-sign-out]')).toBeNull();
    expect(only(calls, LIST).length).toBeGreaterThanOrEqual(2);
    await view.unmount();
  });

  it('a sign-out the tool would not do says the daemon’s reason; a refused one stays on the confirmation', async () => {
    const failed = await open(
      {
        [APPLY]: {
          outcome: 'sign-out-failed',
          reason: 'Claude would not sign out: the keychain is locked.',
          credential: { ...CREDENTIALS.credentials[0] },
        },
      },
      { hash: `${HASH}/claude-personal` },
    );
    await click(failed.view.container.querySelector('[data-credential-sign-out-ask]'), 'Sign out…');
    await click(failed.view.container.querySelector('[data-credential-sign-out] [data-change-submit]'), 'Sign out');
    expect(text(failed.view.container, '[data-credential-notice]')).toBe(
      'Claude would not sign out: the keychain is locked.',
    );
    await failed.view.unmount();

    const refused = await open(
      {
        [CHANGES]: new FyHttpError(
          'Account setup changes are switched off on this machine for now.',
          409,
          'fleet_change_disabled',
        ),
      },
      { hash: `${HASH}/claude-work` },
    );
    await click(refused.view.container.querySelector('[data-credential-sign-out-ask]'), 'Sign out…');
    await click(refused.view.container.querySelector('[data-credential-sign-out] [data-change-submit]'), 'Sign out');
    expect(text(refused.view.container, '[data-credential-sign-out] [data-change-refusal]')).toBe(
      'Account setup changes are switched off on this machine for now.',
    );
    expect(refused.view.container.querySelector('[data-credential-notice]')).toBeNull();
    expect(refused.view.container.querySelector('[data-credential-sign-out]')).not.toBeNull();
    await refused.view.unmount();
  });
});

describe('CredentialsTab · signing a login in from its page', () => {
  it('signs in in place even while account changes are switched off, then says which runtimes can launch', async () => {
    const needs = credential({
      id: 'claude-work',
      label: 'work',
      clonedFrom: 'laptop',
      usedBy: ['claude-work', 'ghost'],
      ...withStatus('needs_sign_in'),
    });
    const ready = credential({ id: 'claude-work', label: 'work', usedBy: ['claude-work', 'ghost'] });
    let signedIn = false;
    const off = machine({
      changes: { available: false, reason: 'Account setup changes are switched off on this machine for now.' },
    });
    const { view, calls } = await open(
      {
        [LIST]: () => listOf([signedIn ? ready : needs]),
        [LOGIN]: claudeFlow('awaiting-code'),
        [`POST ${FLOW}`]: () => {
          signedIn = true;
          return { outcome: 'accepted', flow: claudeFlow('complete') };
        },
      },
      { hash: `${HASH}/claude-work`, machine: off },
    );
    const c = view.container;
    expect(text(c, '[data-credential-status]')).toContain('Empty slot. It was copied from laptop');
    expect(c.querySelector('[data-credential-actions]')).toBeNull();
    expect(text(c, '[data-credential-sign-in="start"] [data-change-submit]')).toBe('Sign in to Claude Code');
    expect(c.querySelector('[data-credential-sign-in="start"] [data-change-unavailable]')).toBeNull();

    await type(must(c.querySelector<HTMLInputElement>('#credential-label-claude-work'), 'field'), 'office');
    expect(text(c, '[data-credential-label] [data-change-unavailable]')).toBe(
      'Account setup changes are switched off on this machine for now.',
    );

    await click(c.querySelector('[data-credential-sign-in="start"] [data-change-submit]'), 'Sign in to Claude Code');
    expect(only(calls, LOGIN)[0]?.body).toEqual({ credentialId: 'claude-work' });
    await type(must(c.querySelector<HTMLTextAreaElement>('textarea'), 'the code field'), 'a-code');
    await click(button(c, 'Finish sign-in for 2 runtimes'), 'Finish sign-in for 2 runtimes');

    expect(text(c, '[data-credential-signed-in] p')).toBe('Signed in. 2 runtimes can launch now.');
    const rows = Array.from(c.querySelectorAll('[data-credential-signed-in] li'));
    expect(rows.map(row => row.querySelector('.font-mono')?.textContent)).toEqual(['claude-work', 'ghost']);
    expect(rows.map(row => row.lastElementChild?.textContent)).toEqual(['Ready', 'Checking']);
    expect(rows[0]?.querySelector('[data-status-shape]')?.getAttribute('data-status-shape')).toBe('ready');
    expect(rows[1]?.querySelector('[data-status-shape]')?.getAttribute('data-status-shape')).toBe('checking');
    expect(c.querySelector('[data-credential-status]')?.getAttribute('data-credential-status')).toBe('ready');
    expect(c.querySelector('[data-credential-sign-in]')).toBeNull();
    expect(c.querySelector('[data-credential-actions]')).not.toBeNull();
    await view.unmount();
  });

  it('a login nothing uses signs in with a short sentence and lists no runtimes', async () => {
    const needs = credential({ id: 'claude-new', ...withStatus('needs_sign_in') });
    const { view } = await open(
      {
        [LIST]: listOf([needs]),
        [LOGIN]: claudeFlow('awaiting-code', 'claude-new'),
        [`POST ${FLOW}`]: { outcome: 'accepted', flow: claudeFlow('complete', 'claude-new') },
      },
      { hash: `${HASH}/claude-new` },
    );
    expect(view.container.textContent).toContain('No runtime uses this login yet.');
    expect(text(view.container, '[data-credential-sign-in="start"] p.font-semibold')).toBe('Sign in to Claude Code');
    expect(view.container.textContent).toContain('The login is kept on studio-mac. Nothing uses it yet.');
    await click(view.container.querySelector('[data-credential-sign-in="start"] [data-change-submit]'), 'start');
    await type(must(view.container.querySelector<HTMLTextAreaElement>('textarea'), 'the code field'), 'a-code');
    await click(button(view.container, 'Finish sign-in'), 'Finish sign-in');
    expect(text(view.container, '[data-credential-signed-in] p')).toBe('Signed in.');
    expect(view.container.querySelector('[data-credential-signed-in] ul')).toBeNull();
    await view.unmount();
  });

  it('offers no sign-in while the machine is offline', async () => {
    const needs = credential({ id: 'claude-work', label: 'work', ...withStatus('needs_sign_in') });
    const { view } = await open({ [LIST]: listOf([needs]) }, { hash: `${HASH}/claude-work`, online: false });
    expect(view.container.querySelector('[data-credential-page]')).not.toBeNull();
    expect(view.container.querySelector('[data-credential-sign-in]')).toBeNull();
    await view.unmount();
  });

  it('the sign-in re-reads on the tab’s own interval while it waits', async () => {
    const needs = credential({
      id: 'claude-work',
      label: 'work',
      usedBy: ['claude-work'],
      ...withStatus('needs_sign_in'),
    });
    const { view, calls } = await open(
      {
        [LIST]: listOf([needs]),
        [LOGIN]: claudeFlow('awaiting-code'),
        [`GET ${FLOW}`]: claudeFlow('complete'),
      },
      { hash: `${HASH}/claude-work`, pollMs: 5 },
    );
    await click(view.container.querySelector('[data-credential-sign-in="start"] [data-change-submit]'), 'start');
    await wait(60);
    expect(only(calls, `GET ${FLOW}`)).toHaveLength(1);
    expect(text(view.container, '[data-credential-signed-in] p')).toBe('Signed in. 1 runtime can launch now.');
    await view.unmount();
  });
});

describe('CredentialsTab · Add a login from the tab', () => {
  it('makes and signs in a login, then lands on its own page', async () => {
    const fresh = credential({ id: 'claude', email: 'new@example.com' });
    let made = false;
    const { view, calls } = await open({
      [LIST]: () => listOf(made ? [...CREDENTIALS.credentials, fresh] : CREDENTIALS.credentials),
      [CHANGES]: (call: Call) => {
        if ((call.body as { change: { kind: string } }).change.kind === 'credential.add') made = true;
        return stagedFrom(call);
      },
      [APPLY]: APPLIED,
      [LOGIN]: claudeFlow('awaiting-code', 'claude'),
      [`POST ${FLOW}`]: { outcome: 'accepted', flow: claudeFlow('complete', 'claude') },
    });
    const c = view.container;
    await click(c.querySelector('[data-add-login]'), 'Add a login');
    expect(text(c, '#machine-stepper-title')).toBe('Add a login');
    expect(text(c, '[data-stepper-position]')).toBe('Choose tool · 1 of 2');
    await click(c.querySelector('[data-add-login-tool="claude"] input'), 'the Claude radio');
    await click(c.querySelector('[data-step-next]'), 'Next');
    await click(c.querySelector('[data-change-submit]'), 'Sign in to Claude Code');
    expect(changeBodies(calls)).toEqual([{ kind: 'credential.add', id: 'claude', harness: 'claude' }]);
    await type(must(c.querySelector<HTMLTextAreaElement>('textarea'), 'the code field'), 'a-code');
    await click(button(c, 'Finish sign-in'), 'Finish sign-in');
    expect(text(c, '[role="status"]')).toBe('Signed in to Claude Code as new@example.com');
    await click(c.querySelector('[data-step-next]'), 'Next');

    expect(window.location.hash).toBe(`${HASH}/claude`);
    expect(c.querySelector('[data-machine-stepper]')).toBeNull();
    expect(c.querySelector('[data-credential-page]')?.getAttribute('data-credential-page')).toBe('claude');
    expect(text(c, '[data-credential-page] p.font-mono')).toBe('new@example.com');
    await view.unmount();
  });
});
