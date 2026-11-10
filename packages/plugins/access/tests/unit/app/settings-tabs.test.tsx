import '../../support/app/dom.ts';
import { describe, expect, it } from 'bun:test';
import { CAPABILITY_NAMES } from '@ferretry/core-gate/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import app from '../../../app/index.ts';
import { connectionRecord } from '../../../app/daemon-scope.tsx';
import { grantsTab, securityLogTab, securityTab } from '../../../app/surfaces.tsx';
import manifest from '../../../manifest.ts';
import { interact, mount } from '../../support/app/dom.ts';
import { settleUntil } from '../../support/app/settle.ts';
import { runAsync } from '../../support/app/react.ts';

/**
 * v4's Settings › ‹machine› tabs that Access owns beside Devices: What devices may do, Security and Security log. Each
 * only MOUNTS today's surface, reading through this machine's own client by route key (Gate's `GET /v1/grants`,
 * `GET /v1/audit`, Access's `GET /v1/passkeys`).
 */

const machine = connectionRecord({
  daemon: 'daemon-alpha',
  machine: 'laptop',
  address: 'https://alpha.example.test',
  deviceId: 'device-alpha',
  label: 'Work laptop',
  pairedAt: 1,
  lastSelectedAt: 1,
} as never);
const useAlpha = () => machine;
const useNone = () => undefined;

interface Call {
  readonly route: string;
  readonly init: unknown;
}

const clientOf = (answers: Readonly<Record<string, unknown>>) => {
  const calls: Call[] = [];
  const client = {
    call: async (route: string, init?: unknown) => {
      calls.push({ route, init });
      if (!(route in answers)) throw new Error(`no route ${route}`);
      return answers[route];
    },
  } as unknown as PluginClient;
  return { client, calls };
};

const GRANTS = {
  capabilities: CAPABILITY_NAMES.map(capability => ({
    capability,
    use: true,
    configure: true,
    granted: { use: true, configure: true },
    useRefusal: 'granted',
    configureRefusal: 'granted',
    origin: 'default',
    mayGrant: false,
  })),
  governed: true,
  hostLocal: false,
  steppedUp: false,
};
const AUDIT = { records: [], kept: [], keptTotal: 0, unreadable: 0 };
const PASSKEYS = { passkeys: [], registration: 'first-window' };

describe('Access’s settings tabs beside Devices', () => {
  it('declares What devices may do, Security and Audit log after Devices, in v4’s order', () => {
    const tabs = (manifest.ui?.settings ?? []).map(tab => `${tab.id}:${tab.label}:${tab.order}`);
    expect(tabs).toEqual([
      'devices:Devices:20',
      'grants:What devices may do:21',
      'security:Security:22',
      'audit:Audit log:23',
    ]);
  });

  it('builds all four tabs into the app half', () => {
    const built = (
      app as { build: (context: { manifest: unknown; client: unknown }) => Record<string, Record<string, unknown>> }
    ).build({ manifest, client: { call: async () => ({}) } });
    expect(Object.keys(built.settings ?? {})).toEqual(['devices', 'grants', 'security', 'audit']);
  });

  it('What devices may do shows the machine’s limits, read through Gate’s grants route on this machine’s client', async () => {
    const { client, calls } = clientOf({ 'GET /v1/grants': GRANTS });
    const Tab = grantsTab(client, useAlpha);
    const shown = await mount(<Tab />);
    await settleUntil(() => shown.container.querySelector('[data-grant-axis]') !== null, 'the grants', runAsync);
    expect(calls.map(call => call.route)).toContain('GET /v1/grants');
    await shown.unmount();
  });

  it('Security lists this machine’s passkeys, read through Access’s own route', async () => {
    const { client, calls } = clientOf({ 'GET /v1/passkeys': PASSKEYS, 'GET /v1/security': {} });
    const Tab = securityTab(client, useAlpha);
    const shown = await mount(<Tab />);
    await settleUntil(
      () => calls.some(call => call.route === 'GET /v1/passkeys') && shown.container.textContent !== '',
      'the passkeys',
      runAsync,
    );
    expect(shown.container.textContent).toContain('This device has no passkey for this machine yet.');
    await shown.unmount();
  });

  it('Audit log shows the machine’s recent activity, the limit riding as the call’s query and not in the route', async () => {
    const { client, calls } = clientOf({ 'GET /v1/audit': AUDIT });
    const Tab = securityLogTab(client, useAlpha);
    const shown = await mount(<Tab />);
    await settleUntil(
      () => shown.container.querySelector('[data-security-log-panel]') !== null,
      'the security log',
      runAsync,
    );
    expect(calls[0]).toEqual({ route: 'GET /v1/audit', init: { query: { limit: '100' } } });
    await shown.unmount();
  });

  it('each tab draws nothing outside a machine’s view', async () => {
    const { client } = clientOf({});
    for (const factory of [grantsTab, securityTab, securityLogTab]) {
      const Tab = factory(client, useNone);
      const shown = await mount(<Tab />);
      await interact(async () => {});
      expect(shown.container.innerHTML).toBe('');
      await shown.unmount();
    }
  });

  it('with no shell around, the default machine hook finds no machine and the tab draws nothing', async () => {
    const { client } = clientOf({});
    const Tab = grantsTab(client);
    const shown = await mount(<Tab />);
    expect(shown.container.innerHTML).toBe('');
    await shown.unmount();
  });
});
