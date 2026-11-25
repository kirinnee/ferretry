/**
 * The browser entry for Settings › Claude connector INSIDE THE REAL SETTINGS SHELL: the real `App` over one fake machine
 * whose only plugin is Connector, with its real tab declaration and the real tab body over fixed fake data. No daemon, no
 * network, no passkey. Everything on screen is made up (fake codes, fixed fake hosts).
 *
 *   /d/ws/settings/connector                the tab (the address the daemon's waiting page links to)
 *   ?theme=<family>-<mode>
 *   ?state=off|on|tunnel|pending|apps       what the machine says (default: pending)
 *   ?request=cr_…                           the sign-in the waiting page's link named
 */
import { renderSettingsShell } from '@ferretry/app/testing/settings-shell';
import manifest from '../../../../manifest.ts';
import { ConnectorSettings } from '../../../../app/views/connector-settings.tsx';
import type { ConnectorPendingView, ConnectorStatus } from '../../../../contract/index.ts';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { type Instant, instantFromEpochMs } from '@ferretry/std';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOW = Date.parse('2026-11-25T20:00:00.000Z');
const ago = (minutes: number): Instant => instantFromEpochMs(NOW - minutes * 60_000);

const waiting = {
  id: 'cr_abcde23456',
  matchCode: 'K7Q-2MF',
  clientName: 'Claude',
  redirectHost: 'claude.example',
  scopes: ['fleet:read', 'fleet:write'],
  createdAt: ago(2),
  expiresAt: instantFromEpochMs(NOW + 8 * 60_000),
} satisfies ConnectorPendingView;

const on: ConnectorStatus = {
  enabled: true,
  switchedOn: true,
  publicUrlSource: 'configured',
  publicUrl: 'https://ferretry.example',
  mcpUrl: 'https://ferretry.example/mcp',
  pending: [],
  grants: [],
};

const STATES: Readonly<Record<string, ConnectorStatus>> = {
  off: {
    enabled: false,
    switchedOn: false,
    disabledReason: 'Switch it on here, and Claude can ask to connect.',
    pending: [],
    grants: [],
  },
  on,
  tunnel: {
    enabled: false,
    switchedOn: true,
    publicUrlSource: 'tunnel',
    disabledReason: 'On, but the built-in tunnel has no hostname yet. This page updates by itself when it does.',
    pending: [],
    grants: [],
  },
  pending: { ...on, pending: [waiting] },
  apps: {
    ...on,
    grants: [
      {
        id: 'cg_abcde23456',
        clientName: 'Claude',
        redirectHost: 'claude.example',
        scopes: ['fleet:read', 'fleet:write'],
        createdAt: ago(60 * 26),
        approvedBy: 'device:dev_fixture',
        lastUsedAt: ago(5),
      },
      {
        id: 'cg_fghij23456',
        clientName: 'Claude (read only)',
        redirectHost: 'claude.example',
        scopes: ['fleet:read'],
        createdAt: ago(60 * 24 * 9),
        approvedBy: 'admin-cli',
        revokedAt: ago(60 * 3),
      },
    ],
  },
};

const status = STATES[params.get('state') ?? 'pending'] ?? on;
const client = {
  call: async (route: string) => {
    if (route === 'GET /v1/connector') return status;
    throw new Error(`the scene answers no ${route}`);
  },
} as unknown as Pick<PluginClient, 'call'>;

function ConnectorTab() {
  return <ConnectorSettings client={client} now={NOW} />;
}

renderSettingsShell({ manifest, bodies: { connector: ConnectorTab } });
