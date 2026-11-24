import '../../../support/dom.ts';
import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import {
  type ConnectorClient,
  type ConnectorGrant,
  type ConnectorPending,
  type ConnectorView,
} from '../../../../src/features/connector/connector-api.ts';
import {
  type ConnectorClientFactory,
  ConnectorSurface,
  connectorSettingsTab,
} from '../../../../src/features/connector/connector-settings.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../../support/dom.ts';
import { runAsync } from '../../../support/react.ts';
import { settleUntil } from '../../../support/settle.ts';

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceId: 'fy_device_id_alpha00000000000000000',
});

const pendingRow: ConnectorPending = {
  id: 'cr_abcdefghij',
  matchCode: 'K7Q-2MF',
  clientName: 'Claude',
  redirectHost: 'claude.ai',
  scopes: ['fleet:read', 'fleet:write'],
  createdAt: new Date(NOW - 60_000).toISOString(),
  expiresAt: new Date(NOW + 540_000).toISOString(),
};
const grantRow: ConnectorGrant = {
  id: 'cg_abcdefghij',
  clientName: 'Claude',
  redirectHost: 'claude.ai',
  scopes: ['fleet:read'],
  createdAt: new Date(NOW - 3 * 3_600_000).toISOString(),
  approvedBy: 'device:fy_device_id_alpha00000000000000000',
  lastUsedAt: new Date(NOW - 120_000).toISOString(),
};

const on = (overrides: Partial<ConnectorView> = {}): ConnectorView => ({
  enabled: true,
  publicUrl: 'https://mcp.example.test',
  mcpUrl: 'https://mcp.example.test/mcp',
  pending: [],
  grants: [],
  ...overrides,
});

interface Call {
  readonly path: string;
  readonly method: string;
}

/** A client whose reads answer from `view()` and whose writes are recorded (and may refuse). */
const fake =
  (view: () => ConnectorView, calls: Call[] = [], refuse?: (call: Call) => Error | undefined): ConnectorClientFactory =>
  async () =>
    ({
      request: (async (path: string, _schema: unknown, init?: RequestInit) => {
        const call = { path, method: init?.method ?? 'GET' };
        if (call.method !== 'GET') {
          calls.push(call);
          const refusal = refuse?.(call);
          if (refusal !== undefined) throw refusal;
          return {};
        }
        return view();
      }) as ConnectorClient['request'],
    }) satisfies ConnectorClient;

const settled = async (container: HTMLElement, selector: string): Promise<void> => {
  await settleUntil(() => container.querySelector(selector) !== null, selector, runAsync);
};
const gone = async (container: HTMLElement, selector: string): Promise<void> => {
  await settleUntil(() => container.querySelector(selector) === null, `no ${selector}`, runAsync);
};

const surface = (createClient: ConnectorClientFactory) => (
  <ConnectorSurface connection={alpha} createClient={createClient} now={() => NOW} pollMs={600_000} />
);

describe('Settings › Claude connector', () => {
  it('shows the address and copies it when the connector is on', async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
    const shown = await mount(surface(fake(() => on())));
    await settled(shown.container, '[data-connector-card]');
    expect(must(shown.container.querySelector('[data-connector-url]'), 'url').textContent).toBe(
      'https://mcp.example.test/mcp',
    );
    expect(shown.container.querySelector('[data-connector-no-pending]')).not.toBeNull();
    expect(shown.container.querySelector('[data-connector-no-grants]')).not.toBeNull();
    await interact(() => (must(shown.container.querySelector('[data-connector-copy]'), 'copy') as HTMLElement).click());
    await settleUntil(
      () => shown.container.querySelector('[data-connector-copied="copied"]') !== null,
      'copied',
      runAsync,
    );
    expect(copied).toEqual(['https://mcp.example.test/mcp']);
    await shown.unmount();
  });

  it('says why it is off and offers no switch', async () => {
    const shown = await mount(
      surface(
        fake(() => ({ enabled: false, disabledReason: 'No connector.publicUrl is set.', pending: [], grants: [] })),
      ),
    );
    await settled(shown.container, '[data-connector-off]');
    const text = must(shown.container.querySelector('[data-connector-off]'), 'off').textContent ?? '';
    expect(text).toContain('No connector.publicUrl is set.');
    expect(text).toContain('only be turned on at the machine');
    expect(shown.container.querySelector('[data-connector-url]')).toBeNull();
    expect(shown.container.querySelector('input[type="checkbox"], [role="switch"]')).toBeNull();
    await shown.unmount();
  });

  it('draws a pending sign-in with its match code, the warning, and what it wants', async () => {
    const shown = await mount(surface(fake(() => on({ pending: [pendingRow] }))));
    await settled(shown.container, '[data-connector-pending]');
    const row = must(shown.container.querySelector('[data-connector-pending]'), 'row');
    expect(must(row.querySelector('[data-connector-headline]'), 'headline').textContent).toBe(
      'Claude wants to read your fleet and control your ferrets',
    );
    expect(must(row.querySelector('[data-connector-match-code]'), 'code').textContent).toBe('K7Q-2MF');
    expect(must(row.querySelector('[data-connector-warning]'), 'warning').textContent).toBe(
      'Only approve if this code is on the page you just opened from Claude.',
    );
    expect(row.textContent).toContain('claude.ai');
    await shown.unmount();
  });

  it('approves with the passkey route, then re-reads', async () => {
    const calls: Call[] = [];
    let pending = [pendingRow];
    const shown = await mount(
      surface(
        fake(
          () => on({ pending }),
          calls,
          call => {
            if (call.path.endsWith('/approve')) pending = [];
            return undefined;
          },
        ),
      ),
    );
    await settled(shown.container, '[data-connector-approve]');
    await interact(() =>
      (must(shown.container.querySelector('[data-connector-approve]'), 'approve') as HTMLElement).click(),
    );
    await gone(shown.container, '[data-connector-pending]');
    expect(calls).toEqual([{ path: '/v1/connector/requests/cr_abcdefghij/approve', method: 'POST' }]);
    await shown.unmount();
  });

  it('says in one sentence when the passkey was not confirmed, and keeps the sign-in waiting', async () => {
    const shown = await mount(
      surface(
        fake(
          () => on({ pending: [pendingRow] }),
          [],
          () => new FyHttpError('step up', 403, 'grant_step_up_required'),
        ),
      ),
    );
    await settled(shown.container, '[data-connector-approve]');
    await interact(() =>
      (must(shown.container.querySelector('[data-connector-approve]'), 'approve') as HTMLElement).click(),
    );
    await settled(shown.container, '[data-connector-failure]');
    expect(must(shown.container.querySelector('[data-connector-failure]'), 'failure').textContent).toContain(
      'the passkey wasn’t confirmed',
    );
    expect(shown.container.querySelector('[data-connector-pending]')).not.toBeNull();
    await shown.unmount();
  });

  it('denies a sign-in', async () => {
    const calls: Call[] = [];
    const shown = await mount(surface(fake(() => on({ pending: [pendingRow] }), calls)));
    await settled(shown.container, '[data-connector-deny]');
    await interact(() => (must(shown.container.querySelector('[data-connector-deny]'), 'deny') as HTMLElement).click());
    await settleUntil(() => calls.length === 1, 'deny posted', runAsync);
    expect(calls[0]).toEqual({ path: '/v1/connector/requests/cr_abcdefghij/deny', method: 'POST' });
    await shown.unmount();
  });

  it('lists connected apps with scopes, approver, age and last use; revoked ones have no button', async () => {
    const revoked = {
      ...grantRow,
      id: 'cg_zzzzzzzzzz',
      clientName: 'Old app',
      revokedAt: new Date(NOW - 60_000).toISOString(),
    };
    const shown = await mount(surface(fake(() => on({ grants: [revoked, grantRow] }))));
    await settled(shown.container, '[data-connector-grant]');
    const rows = [...shown.container.querySelectorAll('[data-connector-grant]')];
    // Live first, revoked after.
    expect(rows.map(row => row.getAttribute('data-connector-grant'))).toEqual(['cg_abcdefghij', 'cg_zzzzzzzzzz']);
    const live = rows[0]?.textContent ?? '';
    expect(live).toContain('Can read your fleet.');
    expect(live).toContain('Approved by a paired device');
    expect(live).toContain('3 hours ago');
    expect(live).toContain('last used 2 minutes ago');
    expect(rows[0]?.querySelector('[data-connector-revoke]')).not.toBeNull();
    expect(rows[1]?.querySelector('[data-connector-revoke]')).toBeNull();
    expect(rows[1]?.textContent).toContain('Revoked 1 minute ago');
    await shown.unmount();
  });

  it('asks before revoking, and revokes only on confirm', async () => {
    const calls: Call[] = [];
    let grants = [grantRow];
    const shown = await mount(
      surface(
        fake(
          () => on({ grants }),
          calls,
          () => {
            grants = [{ ...grantRow, revokedAt: new Date(NOW).toISOString() }];
            return undefined;
          },
        ),
      ),
    );
    await settled(shown.container, '[data-connector-revoke]');
    await interact(() =>
      (must(shown.container.querySelector('[data-connector-revoke]'), 'revoke') as HTMLElement).click(),
    );
    const dialog = must(shown.container.querySelector('[data-connector-revoke-dialog]'), 'dialog');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.textContent).toContain('stops working on its very next call');
    expect(calls).toEqual([]);

    await interact(() =>
      (must(shown.container.querySelector('[data-connector-revoke-confirm]'), 'confirm') as HTMLElement).click(),
    );
    await gone(shown.container, '[data-connector-revoke-dialog]');
    expect(calls).toEqual([{ path: '/v1/connector/grants/cg_abcdefghij/revoke', method: 'POST' }]);
    await shown.unmount();
  });

  it('cancelling the revoke dialog sends nothing', async () => {
    const calls: Call[] = [];
    const shown = await mount(surface(fake(() => on({ grants: [grantRow] }), calls)));
    await settled(shown.container, '[data-connector-revoke]');
    await interact(() =>
      (must(shown.container.querySelector('[data-connector-revoke]'), 'revoke') as HTMLElement).click(),
    );
    const keep = [...shown.container.querySelectorAll('[data-connector-revoke-dialog] button')].find(
      button => button.textContent === 'Keep it',
    );
    await interact(() => (must(keep, 'keep') as HTMLElement).click());
    expect(shown.container.querySelector('[data-connector-revoke-dialog]')).toBeNull();
    expect(calls).toEqual([]);
    await shown.unmount();
  });

  it('says so, plainly, when the machine cannot be read', async () => {
    const shown = await mount(
      surface(async () => ({
        request: (async () => {
          throw new Error('down');
        }) as ConnectorClient['request'],
      })),
    );
    await settled(shown.container, '[data-connector-state="failed"]');
    await shown.unmount();
  });

  it('is a Settings panel named connector', () => {
    const tab = connectorSettingsTab(fake(() => on()));
    expect(tab.id).toBe('connector');
    expect(tab.label).toBe('Claude connector');
  });
});

describe('Settings › Claude connector — the rest of the behaviour', () => {
  const clipboardRefusing = (): void => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
    });
  };

  it('says copying was not allowed, and shows the address to copy by hand', async () => {
    clipboardRefusing();
    const shown = await mount(surface(fake(() => on())));
    await settled(shown.container, '[data-connector-copy]');
    await interact(() => (must(shown.container.querySelector('[data-connector-copy]'), 'copy') as HTMLElement).click());
    await settled(shown.container, '[data-connector-copied="failed"]');
    expect(must(shown.container.querySelector('[data-connector-copied]'), 'status').textContent).toContain(
      'Copying was not allowed here',
    );
    expect(must(shown.container.querySelector('[data-connector-url]'), 'url').textContent).toBe(
      'https://mcp.example.test/mcp',
    );
    await shown.unmount();
  });

  it('says a connected app was never used when it has not been', async () => {
    const { lastUsedAt: _unused, ...never } = grantRow;
    const shown = await mount(surface(fake(() => on({ grants: [never] }))));
    await settled(shown.container, '[data-connector-grant]');
    expect(must(shown.container.querySelector('[data-connector-grant]'), 'grant').textContent).toContain('never used');
    await shown.unmount();
  });

  it('reads again as soon as the page becomes visible after being hidden', async () => {
    let reads = 0;
    let visible = false;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (visible ? 'visible' : 'hidden'),
    });
    const shown = await mount(
      surface(
        fake(() => {
          reads += 1;
          return on();
        }),
      ),
    );
    try {
      // Hidden: the panel waits and reads nothing.
      await runAsync(async () => undefined);
      expect(reads).toBe(0);
      visible = true;
      await interact(() => void document.dispatchEvent(new Event('visibilitychange')));
      await settled(shown.container, '[data-connector-card]');
      expect(reads).toBeGreaterThanOrEqual(1);
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
      await shown.unmount();
    }
  });

  it('keeps the failure sentence when the re-read after an act also fails', async () => {
    let healthy = true;
    const client: ConnectorClient = {
      request: (async (_path: string, _schema: unknown, init?: RequestInit) => {
        if (init?.method === 'POST') {
          healthy = false;
          throw new FyHttpError('gone', 404, 'not_found');
        }
        if (!healthy) throw new Error('down');
        return on({ pending: [pendingRow] });
      }) as ConnectorClient['request'],
    };
    const shown = await mount(surface(async () => client));
    await settled(shown.container, '[data-connector-approve]');
    await interact(() =>
      (must(shown.container.querySelector('[data-connector-approve]'), 'approve') as HTMLElement).click(),
    );
    await settled(shown.container, '[data-connector-failure]');
    expect(must(shown.container.querySelector('[data-connector-failure]'), 'failure').textContent).toContain(
      'not waiting any more',
    );
    // What was on screen stays on screen.
    expect(shown.container.querySelector('[data-connector-pending]')).not.toBeNull();
    await shown.unmount();
  });

  it('renders the panel its Settings tab names, for the machine it is opened on', async () => {
    const tab = connectorSettingsTab(fake(() => on()));
    const shown = await mount(<tab.Surface connection={alpha} />);
    await settled(shown.container, '[data-connector-card]');
    expect(must(shown.container.querySelector('[data-connector-url]'), 'url').textContent).toBe(
      'https://mcp.example.test/mcp',
    );
    await shown.unmount();
  });
});
