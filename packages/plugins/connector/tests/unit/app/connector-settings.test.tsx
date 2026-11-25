/** Settings › Claude connector: every state of the tab over a scripted client, and every act it can take. */
import { afterEach, describe, expect, it } from 'bun:test';
import type { Mounted } from '@ferretry/app/testing';
import { instantFromEpochMs } from '@ferretry/std';
import { ConnectorSettings } from '../../../app/views/connector-settings.tsx';
import type { ConnectorStatus } from '../../../contract/index.ts';
import {
  type Answers,
  type Call,
  grantView,
  NOW,
  OFF,
  ON,
  pendingView,
  refusal,
  scriptedClient,
  WAITING_FOR_TUNNEL,
} from './fixtures.ts';
import { click, mountSettled, text, wait } from './support.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const open = async (answers: Answers, options: { focus?: string | null; pollMs?: number } = {}) => {
  const calls: Call[] = [];
  mounted = await mountSettled(
    <ConnectorSettings
      client={scriptedClient(answers, calls)}
      now={NOW}
      focus={options.focus ?? null}
      pollMs={options.pollMs ?? 600_000}
    />,
  );
  return { root: mounted.container, calls };
};

const read = (status: ConnectorStatus) => ({ 'GET /v1/connector': status });
const switchOf = (root: ParentNode): HTMLElement => root.querySelector('[role="switch"]') as HTMLElement;

describe('Settings › Claude connector', () => {
  it('is off by default: the switch is off, the daemon’s reason is said, and no address is shown', async () => {
    const { root } = await open(read(OFF));
    expect(root.querySelector('[data-settings="connector"]')).not.toBeNull();
    expect(switchOf(root).getAttribute('aria-checked')).toBe('false');
    expect(text(root, '[data-setting-hint]')).toContain('Off. Nothing on this machine answers Claude.');
    expect(text(root, '[data-setting-hint]')).toContain('Switch it on in Settings › Claude connector.');
    expect(root.querySelector('[data-connector-url]')).toBeNull();
    expect(text(root, '[data-connector-empty="pending"]')).toContain('No sign-in is waiting');
    expect(text(root, '[data-connector-empty="grants"]')).toBe('Nothing is connected.');
  });

  it('switches on without guessing: it sends only {enabled}, then shows the status the daemon answered', async () => {
    const { root, calls } = await open({ ...read(OFF), 'PUT /v1/connector': ON });
    await click(root, '[role="switch"]');
    expect(calls.filter(call => call.route === 'PUT /v1/connector')).toEqual([
      { route: 'PUT /v1/connector', params: undefined, body: { enabled: true } },
    ]);
    expect(switchOf(root).getAttribute('aria-checked')).toBe('true');
    expect(text(root, '[data-connector-url]')).toBe('https://ferretry.example/mcp');
  });

  it('shows the address Claude is given, where it comes from, and that an address in config wins', async () => {
    const { root } = await open(read(ON));
    expect(text(root, '[data-connector-url]')).toBe('https://ferretry.example/mcp');
    expect(root.querySelector('[aria-label="Copy the connector address"]')).not.toBeNull();
    expect(text(root, '[data-connector-source]')).toContain('config/connector.yaml');
    expect(text(root, '[data-connector-source]')).toContain('always wins over the built-in tunnel');
  });

  it('says it is waiting for the tunnel while the switch is on and no hostname exists', async () => {
    const { root } = await open(read(WAITING_FOR_TUNNEL));
    expect(switchOf(root).getAttribute('aria-checked')).toBe('true');
    expect(text(root, '[data-setting-hint]')).toBe('Waiting for the tunnel to get its hostname.');
    expect(root.querySelector('[data-connector-url]')).toBeNull();
  });

  it('over the tunnel it warns that a changed hostname means reconnecting Claude', async () => {
    const { root } = await open(
      read({
        ...ON,
        publicUrlSource: 'tunnel',
        publicUrl: 'https://abc.tunnel.example',
        mcpUrl: 'https://abc.tunnel.example/mcp',
      }),
    );
    expect(text(root, '[data-connector-source="tunnel"]')).toContain('built-in tunnel');
    expect(text(root, '[data-connector-source="tunnel"]')).toContain('Claude must be reconnected');
  });

  it('shows a waiting sign-in with its match code and the warning in the same breath, and approves it by its id', async () => {
    let status: ConnectorStatus = { ...ON, pending: [pendingView()] };
    const { root, calls } = await open({
      'GET /v1/connector': () => status,
      'POST /v1/connector/requests/:id/approve': () => {
        status = { ...ON, pending: [], grants: [grantView({ lastUsedAt: undefined })] };
        return grantView();
      },
    });
    const card = root.querySelector('[data-connector-pending="cr_abcde23456"]') as HTMLElement;
    expect(text(card, '[data-connector-headline]')).toBe('Claude wants to read your fleet and control your ferrets');
    expect(text(card, '[data-connector-match-code]')).toBe('K7Q-2MF');
    expect(text(card, '[data-connector-warning]')).toBe(
      'Only approve if this code is on the page you just opened from Claude.',
    );
    expect(card.textContent).toContain('From claude.example · asked 2 minutes ago');
    await click(root, '[data-connector-approve="cr_abcde23456"]');
    expect(calls.find(call => call.route === 'POST /v1/connector/requests/:id/approve')).toEqual({
      route: 'POST /v1/connector/requests/:id/approve',
      params: { id: 'cr_abcde23456' },
      body: {},
    });
    expect(root.querySelector('[data-connector-pending]')).toBeNull();
    expect(root.querySelector('[data-connector-grant="cg_abcde23456"]')).not.toBeNull();
  });

  it('denies a waiting sign-in, which asks nothing more of the owner', async () => {
    let status: ConnectorStatus = { ...ON, pending: [pendingView()] };
    const { root, calls } = await open({
      'GET /v1/connector': () => status,
      'POST /v1/connector/requests/:id/deny': () => {
        status = ON;
        return pendingView();
      },
    });
    await click(root, '[data-connector-deny="cr_abcde23456"]');
    expect(
      calls.some(call => call.route === 'POST /v1/connector/requests/:id/deny' && call.params?.id === 'cr_abcde23456'),
    ).toBe(true);
    expect(root.querySelector('[data-connector-pending]')).toBeNull();
  });

  it('puts the sign-in the waiting page’s link named first and marks it', async () => {
    const { root } = await open(
      read({
        ...ON,
        pending: [
          pendingView({ id: 'cr_firstaaaaa', matchCode: 'AAA-111' }),
          pendingView({ id: 'cr_secondbbbb', matchCode: 'BBB-222' }),
        ],
      }),
      { focus: 'cr_secondbbbb' },
    );
    expect(
      [...root.querySelectorAll('[data-connector-pending]')].map(card => card.getAttribute('data-connector-pending')),
    ).toEqual(['cr_secondbbbb', 'cr_firstaaaaa']);
    expect(root.querySelector('[data-connector-pending="cr_secondbbbb"]')?.hasAttribute('data-focused')).toBe(true);
    expect(root.querySelector('[data-connector-pending="cr_firstaaaaa"]')?.hasAttribute('data-focused')).toBe(false);
  });

  it('says why an approval did not go through, in the daemon’s code and not its status', async () => {
    const { root } = await open({
      'GET /v1/connector': { ...ON, pending: [pendingView()] },
      'POST /v1/connector/requests/:id/approve': refusal(410, 'connector_expired', 'expired'),
    });
    await click(root, '[data-connector-approve="cr_abcde23456"]');
    expect(text(root, '[data-connector-failure]')).toBe('That sign-in ran out of time. Ask Claude to connect again.');
  });

  it('says a cancelled passkey changed nothing', async () => {
    const { root } = await open({
      'GET /v1/connector': { ...ON, pending: [pendingView()] },
      'POST /v1/connector/requests/:id/approve': refusal(403, 'grant_step_up_required', 'needs a passkey'),
    });
    await click(root, '[data-connector-approve="cr_abcde23456"]');
    expect(text(root, '[data-connector-failure]')).toContain('Nothing was changed: the passkey wasn’t confirmed.');
  });

  it('lists live apps before revoked ones, and only a live one can be revoked', async () => {
    const { root } = await open(
      read({
        ...ON,
        grants: [
          grantView({ id: 'cg_revokedaaa', clientName: 'Old Claude', revokedAt: instantFromEpochMs(NOW - 3_600_000) }),
          grantView({ id: 'cg_liveaaaaaa', clientName: 'Claude' }),
        ],
      }),
    );
    expect(
      [...root.querySelectorAll('[data-connector-grant]')].map(row => row.getAttribute('data-connector-grant')),
    ).toEqual(['cg_liveaaaaaa', 'cg_revokedaaa']);
    expect(root.querySelector('[data-connector-revoke="cg_liveaaaaaa"]')).not.toBeNull();
    expect(root.querySelector('[data-connector-revoke="cg_revokedaaa"]')).toBeNull();
    expect(text(root, '[data-connector-grant="cg_revokedaaa"] [data-connector-revoked-label]')).toBe(
      'Revoked 1 hour ago',
    );
    expect(text(root, '[data-connector-grant="cg_liveaaaaaa"]')).toContain('Approved by a paired device');
    expect(text(root, '[data-connector-grant="cg_liveaaaaaa"]')).toContain('last used 5 minutes ago');
  });

  it('revokes only after the confirm, which says what stops', async () => {
    let status: ConnectorStatus = { ...ON, grants: [grantView()] };
    const { root, calls } = await open({
      'GET /v1/connector': () => status,
      'POST /v1/connector/grants/:id/revoke': () => {
        status = { ...ON, grants: [grantView({ revokedAt: instantFromEpochMs(NOW) })] };
        return status.grants[0];
      },
    });
    await click(root, '[data-connector-revoke="cg_abcde23456"]');
    expect(calls.some(call => call.route === 'POST /v1/connector/grants/:id/revoke')).toBe(false);
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain('Revoke Claude?');
    expect(dialog.textContent).toContain('stops working on its very next call');
    await click(document.body, '[data-connector-revoke-confirm]');
    expect(calls.find(call => call.route === 'POST /v1/connector/grants/:id/revoke')?.params).toEqual({
      id: 'cg_abcde23456',
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(root.querySelector('[data-connector-revoke="cg_abcde23456"]')).toBeNull();
    expect(text(root, '[data-connector-revoked-label]')).toBe('Revoked just now');
  });

  it('keeps the grant when the owner keeps it', async () => {
    const { root, calls } = await open(read({ ...ON, grants: [grantView()] }));
    await click(root, '[data-connector-revoke="cg_abcde23456"]');
    await click(document.body, '[role="dialog"] button:not([data-connector-revoke-confirm])');
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(calls.some(call => call.route.includes('revoke'))).toBe(false);
  });

  it('says a machine without the connector needs an update, naming the command', async () => {
    const { root } = await open({ 'GET /v1/connector': refusal(404, 'unknown_route', 'no route GET /v1/connector') });
    expect(root.querySelector('[data-setup-note="connector-outdated"]')?.textContent).toContain(
      'This machine needs an update to use the Claude connector.',
    );
    expect(root.textContent).toContain('fy update');
    expect(root.querySelector('[role="switch"]')).toBeNull();
  });

  it('says so when the machine does not answer, and keeps what it showed through a failed poll', async () => {
    const failed = await open({ 'GET /v1/connector': new Error('closed') });
    expect(failed.root.querySelector('[data-setup-note="connector-failed"]')?.textContent).toContain('did not answer');
    await mounted?.unmount();

    let up = true;
    const { root } = await open({ 'GET /v1/connector': () => (up ? ON : new Error('closed')) }, { pollMs: 5 });
    expect(root.querySelector('[data-connector-url]')).not.toBeNull();
    up = false;
    await wait(40);
    expect(root.querySelector('[data-connector-url]')).not.toBeNull();
    expect(root.querySelector('[data-setup-note="connector-failed"]')).toBeNull();
  });

  it('reads again on its own while it is open, so a sign-in shows up without a reload', async () => {
    let status: ConnectorStatus = ON;
    let frozen = false;
    const { root } = await open(
      { 'GET /v1/connector': () => (frozen ? new Promise(() => undefined) : status) },
      { pollMs: 5 },
    );
    expect(root.querySelector('[data-connector-pending]')).toBeNull();
    status = { ...ON, pending: [pendingView()] };
    await wait(60);
    frozen = true;
    expect(root.querySelector('[data-connector-pending="cr_abcde23456"]')).not.toBeNull();
  });

  it('refuses an answer that carries anything the contract has no field for (no token can ride along)', async () => {
    const { root } = await open({ 'GET /v1/connector': { ...ON, accessToken: 'fyc_at_notreal' } });
    expect(root.querySelector('[data-setup-note="connector-failed"]')).not.toBeNull();
    expect(root.textContent).not.toContain('fyc_');
  });
});
