import { describe, expect, it } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import { noteClientDaemon } from '@ferretry/app/testing';
import { CAPABILITY_NAMES } from '@ferretry/core-gate/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { ComponentType } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';
import { z } from 'zod';
import app from '../../../../../app/index.ts';
import { gateRouteClient } from '../../../../../app/lib/gate-client.ts';
import manifest from '../../../../../manifest.ts';
import { render, run, runUntil } from '../../../../support/app/react.ts';

const REFUSAL =
  'Turning that on is only done at the machine itself. Run `fy daemon config set fleet --configure` there.';
const AUDIT_REFUSAL = 'The security log is read at the machine.';

const grantsView = {
  capabilities: CAPABILITY_NAMES.map(capability => ({
    capability,
    use: true,
    configure: false,
    granted: { use: true, configure: false },
    useRefusal: 'granted',
    configureRefusal: 'not-granted',
    origin: 'default',
    mayGrant: false,
  })),
  // Not governed: every recorded-on switch is enabled, so a person can press one.
  governed: false,
  hostLocal: false,
  steppedUp: false,
};

interface Call {
  readonly route: string;
  readonly query?: unknown;
  readonly body?: unknown;
}

/**
 * A machine answering exactly Gate's three routes. `refuse` makes the PATCH come back as Gate's real refusal
 * (`DaemonCallError`, the class the shell's client throws); `auditStatus` does the same for the audit read. Any other
 * route key is a test error, so an adapter that sends something else fails here.
 */
const machine = (options: { readonly refuse?: boolean; readonly auditStatus?: number } = {}) => {
  const calls: Call[] = [];
  const client = {
    call: async (route: string, init?: { query?: unknown; body?: unknown }) => {
      calls.push({ route, query: init?.query, body: init?.body });
      switch (route) {
        case 'GET /v1/grants':
          return grantsView;
        case 'PATCH /v1/grants':
          if (options.refuse === true) throw new DaemonCallError(403, 'grant-refused', REFUSAL, { error: REFUSAL });
          return grantsView;
        case 'GET /v1/audit':
          if (options.auditStatus !== undefined)
            throw new DaemonCallError(options.auditStatus, 'audit-refused', AUDIT_REFUSAL, { error: AUDIT_REFUSAL });
          return { records: [], kept: [], keptTotal: 0, unreadable: 0 };
        default:
          throw new Error(`unscripted ${route}`);
      }
    },
    subscribe: () => () => undefined,
  } as unknown as PluginClient;
  noteClientDaemon(client, 'daemon-a');
  return { client, calls };
};

/** The tab exactly as the shell gets it: through the manifest-checked app half's `build`. */
const tab = (id: 'grants' | 'audit', client: PluginClient): ComponentType => {
  const build = app.build;
  if (build === undefined) throw new Error('the access app half has no build');
  const view = (build({ manifest, client } as never) as unknown as { settings?: Record<string, unknown> }).settings?.[
    id
  ];
  if (view === undefined) throw new Error(`the app half builds no ${id} settings tab`);
  return view as ComponentType;
};

const marked = (surface: ReactTestRenderer, marker: string) =>
  surface.root.findAll(node => typeof node.type === 'string' && node.props[marker] !== undefined);
const text = (surface: ReactTestRenderer): string => JSON.stringify(surface.toJSON());
const count = (calls: readonly Call[], route: string): number => calls.filter(call => call.route === route).length;

/** A stand-in for the shell: it re-renders its tab with fresh props, as a runtime change does. */
const Shell = ({ Tab }: { readonly Tab: ComponentType; readonly tick: number }) => <Tab />;

describe('Access reaches Gate’s grants and audit routes from its settings tabs (ruling #26)', () => {
  it('declares the grants and audit tabs in the manifest', () => {
    expect((manifest.ui?.settings ?? []).map(decl => decl.id)).toEqual(['devices', 'grants', 'audit']);
  });

  it('the grants tab reads Gate’s GET /v1/grants through the half’s client', async () => {
    const { client, calls } = machine();
    const Grants = tab('grants', client);
    const surface = render(<Grants />);
    await runUntil(
      () => undefined,
      () => marked(surface, 'data-grant-surface').length > 0,
      'the grants card',
    );
    expect(calls.map(call => call.route)).toContain('GET /v1/grants');
    run(() => surface.unmount());
  });

  /** Presses the `fleet.use` switch (recorded on, so it sends a narrow) and waits for Gate's sentence. */
  const pressFleetUse = async (surface: ReactTestRenderer, ready: () => boolean, what: string) => {
    await runUntil(
      () => undefined,
      () => marked(surface, 'data-grant-axis').length > 0,
      'the grant switches',
    );
    const press = marked(surface, 'data-grant-axis').find(
      node => node.props['data-grant-axis'] === 'fleet.use' && node.props.disabled === false,
    );
    if (press === undefined) throw new Error('no enabled fleet.use switch to press');
    await runUntil(() => press.props.onClick(), ready, what);
  };

  it('the grants tab shows Gate’s refusal sentence whole for a refused change, and sends the change it was asked for', async () => {
    const { client, calls } = machine({ refuse: true });
    const Grants = tab('grants', client);
    const surface = render(<Grants />);
    await pressFleetUse(surface, () => text(surface).includes(REFUSAL), 'Gate’s refusal sentence');
    expect(calls.find(call => call.route === 'PATCH /v1/grants')?.body).toEqual({ fleet: { use: false } });
    run(() => surface.unmount());
  });

  it('the grants tab keeps Gate’s refusal and reads the route once when its parent re-renders', async () => {
    const { client, calls } = machine({ refuse: true });
    const Grants = tab('grants', client);
    const surface = render(<Shell Tab={Grants} tick={1} />);
    await pressFleetUse(surface, () => text(surface).includes(REFUSAL), 'Gate’s refusal sentence');
    run(() => surface.update(<Shell Tab={Grants} tick={2} />));
    await runUntil(
      () => undefined,
      () => true,
      'a settled tab',
    );
    expect(text(surface)).toContain(REFUSAL);
    expect(count(calls, 'GET /v1/grants')).toBe(1);
    run(() => surface.unmount());
  });

  it('the audit tab reads Gate’s GET /v1/audit with its page size', async () => {
    const { client, calls } = machine();
    const Log = tab('audit', client);
    const surface = render(<Log />);
    await runUntil(
      () => undefined,
      () => calls.some(call => call.route === 'GET /v1/audit'),
      'the audit read',
    );
    expect(calls.find(call => call.route === 'GET /v1/audit')?.query).toEqual({ limit: '100' });
    run(() => surface.unmount());
  });

  it('the audit tab says Gate refused the log to a remote device, not that it failed', async () => {
    const { client } = machine({ auditStatus: 403 });
    const Log = tab('audit', client);
    const surface = render(<Log />);
    await runUntil(
      () => undefined,
      () => marked(surface, 'data-security-log-refused').length > 0,
      'the refused card',
    );
    expect(text(surface)).toContain(AUDIT_REFUSAL);
    run(() => surface.unmount());
  });

  it('the audit tab keeps its card and reads the route once when its parent re-renders', async () => {
    const { client, calls } = machine({ auditStatus: 403 });
    const Log = tab('audit', client);
    const surface = render(<Shell Tab={Log} tick={1} />);
    await runUntil(
      () => undefined,
      () => marked(surface, 'data-security-log-refused').length > 0,
      'the refused card',
    );
    run(() => surface.update(<Shell Tab={Log} tick={2} />));
    await runUntil(
      () => undefined,
      () => true,
      'a settled tab',
    );
    expect(marked(surface, 'data-security-log-refused').length).toBeGreaterThan(0);
    expect(count(calls, 'GET /v1/audit')).toBe(1);
    run(() => surface.unmount());
  });

  it('renders nothing for a client the shell did not make', () => {
    const bare = { call: async () => ({}), subscribe: () => () => undefined } as unknown as PluginClient;
    const Grants = tab('grants', bare);
    const surface = render(<Grants />);
    expect(surface.toJSON()).toBeNull();
    run(() => surface.unmount());
  });
});

describe('the Gate route adapter carries only Gate’s three routes', () => {
  const answer = z.unknown();
  const adapter = () => {
    const { client, calls } = machine();
    return { routed: gateRouteClient(client), calls };
  };

  it('sends the three allow-listed keys, query and JSON body included', async () => {
    const { routed, calls } = adapter();
    await routed.request('/v1/grants', answer);
    await routed.request('/v1/grants', answer, { method: 'PATCH', body: JSON.stringify({ fleet: { use: false } }) });
    await routed.request('/v1/audit?limit=100&keptOffset=5', answer);
    expect(calls).toEqual([
      { route: 'GET /v1/grants', query: undefined, body: undefined },
      { route: 'PATCH /v1/grants', query: undefined, body: { fleet: { use: false } } },
      { route: 'GET /v1/audit', query: { limit: '100', keptOffset: '5' }, body: undefined },
    ]);
  });

  it('throws before any request for a route that is not Gate’s grants or audit', async () => {
    const { routed, calls } = adapter();
    await expect(routed.request('/v1/security', answer)).rejects.toThrow(TypeError);
    await expect(routed.request('/v1/grants', answer, { method: 'DELETE' })).rejects.toThrow(TypeError);
    await expect(routed.request('/v1/audit', answer, { method: 'PATCH', body: '{}' })).rejects.toThrow(TypeError);
    expect(calls).toEqual([]);
  });

  it('throws on a body that is not a JSON string instead of dropping it', async () => {
    const { routed, calls } = adapter();
    const form = new FormData();
    form.set('fleet', 'off');
    await expect(routed.request('/v1/grants', answer, { method: 'PATCH', body: form })).rejects.toThrow(TypeError);
    await expect(routed.request('/v1/grants', answer, { method: 'PATCH', body: new Blob(['{}']) })).rejects.toThrow(
      TypeError,
    );
    expect(calls).toEqual([]);
  });
});
