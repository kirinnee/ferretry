import { FerretsChanged } from '@ferretry/core-ferrets/contract';
import { interact, mount, must, RouterProvider } from '@ferretry/app/testing';
import type { AppHalf, PluginClient } from '@ferretry/kernel/manifest';
import { describe, expect, it } from 'bun:test';
import { type ReactNode, Suspense, useState } from 'react';
import app from '../../../app/index.ts';
import { useConfigChangeEffect } from '../../../app/hooks/use-config-change-effect.ts';
import { useFerretsOf } from '../../../app/hooks/use-ferrets-of.ts';
import { parseAccountPickerCatalog, readAccountPickerCatalog } from '../../../app/lib/account-picker.ts';
import { readGrants } from '../../../app/lib/grants.ts';
import { daemonConnection } from '../../../app/lib/machine.ts';
import { parseSpeedups, readSpeedups } from '../../../app/lib/speedups.ts';
import { DaemonReachContext } from '../../../app/lib/warden-client-context.tsx';
import manifest from '../../../manifest.ts';
import { wardenConfig, wardenStatus } from '../../support/app/warden.ts';

interface Fake extends PluginClient {
  readonly calls: string[];
  readonly emit: (event: string, payload: unknown) => void;
}

/** A plugin client answering by route key, and letting a test push an event to whoever subscribed. */
const fakeClient = (answers: Readonly<Record<string, unknown>>): Fake => {
  const calls: string[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const client = {
    calls,
    emit: (event: string, payload: unknown) => {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    call: async (route: string) => {
      calls.push(route);
      if (!(route in answers)) throw new Error(`no answer for ${route}`);
      return answers[route];
    },
    subscribe: (event: { readonly name: string }, listener: (payload: unknown) => void) => {
      const set = listeners.get(event.name) ?? new Set();
      set.add(listener);
      listeners.set(event.name, set);
      return () => set.delete(listener);
    },
  };
  return client as unknown as Fake;
};

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 6; turn += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

const WARDEN = {
  'GET /v1/warden/status': wardenStatus(),
  'GET /v1/warden/verdicts': [],
  'GET /v1/warden/config': { config: wardenConfig(), accounts: [], warnings: [] },
};

describe('the Warden half, bound to the shell', () => {
  it('builds its screen, its dashboard panels and its settings tab over the one client it is handed', async () => {
    const client = fakeClient({ ...WARDEN, 'GET /v1/ferrets': [] });
    const half = app.build?.({ manifest, client }) as AppHalf<typeof manifest>;
    expect(Object.keys(half.screens)).toEqual(['warden']);
    expect(Object.keys(half.panels).sort()).toEqual(['warden-strip', 'warden-verdicts']);
    expect(Object.keys(half.settings)).toEqual(['warden']);

    const Screen = half.screens.warden as () => ReactNode;
    const view = await mount(
      <RouterProvider>
        <Suspense fallback={<p>loading</p>}>
          <Screen />
        </Suspense>
      </RouterProvider>,
    );
    await settle();
    expect(must(view.container.querySelector('[data-warden-page]'), 'the Warden page')).toBeDefined();
    expect(client.calls).toContain('GET /v1/warden/status');
    expect(client.calls).toContain('GET /v1/ferrets');
    await view.unmount();
  });

  it('draws the pack-health strip and the verdicts for the daemon it was built for', async () => {
    const client = fakeClient({ ...WARDEN });
    const half = app.build?.({ manifest, client }) as AppHalf<typeof manifest>;
    const Strip = half.panels['warden-strip'] as () => ReactNode;
    const Verdicts = half.panels['warden-verdicts'] as () => ReactNode;
    const view = await mount(
      <Suspense fallback={null}>
        <Strip />
        <Verdicts />
      </Suspense>,
    );
    await settle();
    expect(client.calls).toContain('GET /v1/warden/status');
    expect(client.calls).toContain('GET /v1/warden/verdicts');
    await view.unmount();
  });

  it('draws the settings tab from the Warden’s own reads, and calls no route of a plugin it does not use', async () => {
    const client = fakeClient({ ...WARDEN });
    const half = app.build?.({ manifest, client }) as AppHalf<typeof manifest>;
    const Settings = half.settings.warden as () => ReactNode;
    const view = await mount(
      <RouterProvider>
        <Suspense fallback={null}>
          <Settings />
        </Suspense>
      </RouterProvider>,
    );
    await settle();
    expect(must(view.container.querySelector('[data-testid="warden-config-card"]'), 'the settings card')).toBeDefined();
    expect(client.calls).toContain('GET /v1/warden/config');
    expect(client.calls.filter(route => !route.startsWith('GET /v1/warden/'))).toEqual([]);
    await view.unmount();
  });
});

describe('what the Warden reads of other plugins', () => {
  it('reads whether warden.use is open from the grants, and nothing else of them', async () => {
    const client = fakeClient({
      'GET /v1/grants': {
        capabilities: [
          { capability: 'warden', use: false, useRefusal: 'not-granted', configure: true, configureRefusal: 'granted' },
          { capability: 'fleet', use: true },
        ],
        governed: true,
      },
    });
    expect(await readGrants(client)).toEqual({
      capabilities: [
        { capability: 'warden', use: false, useRefusal: 'not-granted' },
        { capability: 'fleet', use: true },
      ],
    });
  });

  it('reads the Speed-ups answer as names and booleans', async () => {
    const body = {
      providers: [
        { provider: 'jev', keyUrl: 'https://keys.example.test/', set: true, label: 'Jev', secretName: 'JEV' },
      ],
      vault: 'ok',
    };
    expect(parseSpeedups(body)).toEqual({
      providers: [{ provider: 'jev', keyUrl: 'https://keys.example.test/', set: true }],
      vault: 'ok',
    });
  });

  it('projects each runtime to a login the Warden can investigate on, with its models', async () => {
    const credential = { id: 'login-a', store: 'host' };
    const body = {
      runtimes: [
        {
          id: 'rt-a',
          name: 'Claude',
          wrapper: 'claude-default',
          harness: 'claude-code',
          credential,
          agent: true,
          modelSet: { source: 'harness-default' },
          models: {
            default: 'opus',
            catalog: { id: 'anthropic', label: 'Anthropic', customIds: false },
            choices: [{ id: 'opus', available: true, label: 'Opus', tier: 'best', efforts: ['low', 'high'] }],
          },
          launch: { available: true },
        },
        {
          id: 'rt-b',
          name: 'Bare',
          wrapper: 'bare',
          harness: 'codex',
          credential,
          agent: true,
          modelSet: { source: 'model-set', models: [{ id: 'm1', available: true }], default: 'm1' },
          launch: { available: false, reason: 'Sign in to launch' },
        },
      ],
    };
    const { accounts } = parseAccountPickerCatalog(body);
    expect(accounts[0]).toMatchObject({
      wrapper: 'claude-default',
      defaultModel: 'opus',
      available: true,
      unavailableReason: null,
      modelCatalog: { customIds: false },
      models: [{ id: 'opus', tier: 'best', efforts: ['low', 'high'] }],
    });
    expect(accounts[1]).toMatchObject({
      wrapper: 'bare',
      defaultModel: 'm1',
      available: false,
      unavailableReason: 'Sign in to launch',
      models: [{ id: 'm1', available: true }],
    });
    expect(accounts[1]?.modelCatalog).toBeUndefined();
  });

  it('refuses a roster it cannot read instead of passing it on as an empty one', () => {
    expect(() => parseAccountPickerCatalog({ runtimes: 'none' })).toThrow();
  });

  it('does not call a plugin the Warden does not use: those two reads refuse until its manifest declares them', async () => {
    await expect(readSpeedups()).rejects.toThrow('does not read Speed-ups yet');
    await expect(readAccountPickerCatalog()).rejects.toThrow('does not read the runtime list yet');
  });
});

describe('the ferrets of a paired daemon', () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: `ferret-${id}`,
    folder: `/work/${id}`,
    ...extra,
  });

  function Names({ daemon }: { readonly daemon: string }) {
    const ferrets = useFerretsOf(daemonConnection({ daemonId: daemon }));
    return <output>{ferrets === null ? 'unread' : ferrets.map(ferret => ferret.config.name).join(',')}</output>;
  }

  it('names them from Ferrets’ list, reads again when Ferrets says the set moved, and drops a late answer', async () => {
    const alpha = fakeClient({ 'GET /v1/ferrets': [row('a', { title: 'Fix the build' })] });
    const beta = fakeClient({ 'GET /v1/ferrets': [row('b')] });
    const reach = async (connection: { readonly daemonId: string }) => (connection.daemonId === 'alpha' ? alpha : beta);
    function Host() {
      const [daemon, setDaemon] = useState('alpha');
      return (
        <DaemonReachContext.Provider value={reach}>
          <Names daemon={daemon} />
          <button type="button" onClick={() => setDaemon('beta')}>
            switch
          </button>
        </DaemonReachContext.Provider>
      );
    }
    const view = await mount(<Host />);
    await settle();
    const output = () => must(view.container.querySelector('output'), 'the names').textContent;
    expect(output()).toBe('ferret-a');

    alpha.calls.length = 0;
    await interact(() => alpha.emit(FerretsChanged.name, { ferret: 'a', generation: 2 }));
    await settle();
    expect(alpha.calls).toEqual(['GET /v1/ferrets']);

    await interact(() => must(view.container.querySelector('button'), 'the switch').click());
    await settle();
    expect(output()).toBe('ferret-b');
    await view.unmount();
  });

  it('names a ferret by the id the Warden carries when the list cannot be read', async () => {
    const broken = fakeClient({});
    const view = await mount(
      <DaemonReachContext.Provider value={async () => broken}>
        <Names daemon="alpha" />
      </DaemonReachContext.Provider>,
    );
    await settle();
    expect(must(view.container.querySelector('output'), 'the names').textContent).toBe('unread');
    await view.unmount();
  });
});

describe('the settings card hears the owner come back', () => {
  function Probe({ onReread }: { readonly onReread: () => void }) {
    useConfigChangeEffect('alpha', ['warden'], onReread);
    return null;
  }

  const hide = (hidden: boolean) =>
    interact(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: hidden ? 'hidden' : 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });

  it('reads again when the tab becomes visible after being hidden, and never on mount or on hiding', async () => {
    let rereads = 0;
    const view = await mount(<Probe onReread={() => (rereads += 1)} />);
    expect(rereads).toBe(0);
    await hide(true);
    expect(rereads).toBe(0);
    await hide(false);
    expect(rereads).toBe(1);
    await view.unmount();
  });
});
