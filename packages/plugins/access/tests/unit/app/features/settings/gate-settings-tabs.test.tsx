import { describe, expect, it } from 'bun:test';
import { noteClientDaemon } from '@ferretry/app/testing';
import { CAPABILITY_NAMES } from '@ferretry/core-gate/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { ComponentType } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';
import app from '../../../../../app/index.ts';
import manifest from '../../../../../manifest.ts';
import { render, run, runUntil } from '../../../../support/app/react.ts';

const REFUSAL = 'Turning that on is only done at the machine itself. Run `fy daemon config set fleet --configure` there.';

class Refused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

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
  governed: true,
  hostLocal: false,
  steppedUp: false,
};

/** A machine answering Gate's routes; `refuse` makes the PATCH come back as Gate's refusal. */
const machine = (options: { readonly refuse?: boolean; readonly auditStatus?: number } = {}) => {
  const calls: { route: string; query?: unknown; body?: unknown }[] = [];
  const client = {
    call: async (route: string, init?: { query?: unknown; body?: unknown }) => {
      calls.push({ route, query: init?.query, body: init?.body });
      if (route === 'GET /v1/grants') return grantsView;
      if (route === 'PATCH /v1/grants') throw new Refused(REFUSAL, 403);
      if (route === 'GET /v1/audit') {
        if (options.auditStatus !== undefined) throw new Refused('The security log is read at the machine.', 403);
        return { records: [], kept: [], keptTotal: 0, unreadable: 0 };
      }
      throw new Error(`unscripted ${route}`);
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
  const view = (build({ manifest, client } as never) as unknown as { settings?: Record<string, unknown> }).settings?.[id];
  if (view === undefined) throw new Error(`the app half builds no ${id} settings tab`);
  return view as ComponentType;
};

const marked = (surface: ReactTestRenderer, marker: string) =>
  surface.root.findAll(node => typeof node.type === 'string' && node.props[marker] !== undefined);
const text = (surface: ReactTestRenderer): string => JSON.stringify(surface.toJSON());

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

  it('G111 the grants tab shows Gate’s refusal sentence whole when a remote widen is refused', async () => {
    const { client, calls } = machine({ refuse: true });
    const Grants = tab('grants', client);
    const surface = render(<Grants />);
    await runUntil(
      () => undefined,
      () => marked(surface, 'data-grant-axis').length > 0,
      'the grant switches',
    );
    const widen = marked(surface, 'data-grant-axis').find(
      node => typeof node.props.onChange === 'function' || typeof node.props.onClick === 'function',
    );
    if (widen === undefined) throw new Error('no grant switch to press');
    await runUntil(
      () => (widen.props.onChange ?? widen.props.onClick)({ target: { checked: true } }),
      () => text(surface).includes(REFUSAL),
      'Gate’s refusal sentence',
    );
    expect(calls.map(call => call.route)).toContain('PATCH /v1/grants');
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

  it('G112 the audit tab says Gate refused the log to a remote device, not that it failed', async () => {
    const { client } = machine({ auditStatus: 403 });
    const Log = tab('audit', client);
    const surface = render(<Log />);
    await runUntil(
      () => undefined,
      () => marked(surface, 'data-security-log-refused').length > 0,
      'the refused card',
    );
    expect(text(surface)).toContain('The security log is read at the machine.');
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
