import { FerretsChanged } from '@ferretry/core-ferrets/contract';
import { DaemonCallError } from '@ferretry/app';
import { interact, mount, must, RouterProvider } from '@ferretry/app/testing';
import type { AppHalf, PluginClient } from '@ferretry/kernel/manifest';
import { describe, expect, it } from 'bun:test';
import { type ReactNode, Suspense, useState } from 'react';
import { RuntimeCatalogSchema } from '@ferretry/plugin-runtimes/contract';
import { SpeedupsViewSchema } from '@ferretry/plugin-voice/contract';
import app from '../../../app/index.ts';
import { configChangeEffect } from '../../../app/hooks/use-config-change-effect.ts';
import { WardenConfigChanged } from '../../../contract/index.ts';
import { useFerretsOf } from '../../../app/hooks/use-ferrets-of.ts';
import { readGrants } from '../../../app/lib/grants.ts';
import { daemonConnection } from '../../../app/lib/machine.ts';
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
      const answer = answers[route];
      if (answer instanceof Error) throw answer;
      return answer;
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

/** The Jev and LLM layers on, so the card draws the key line and the login and model fields. */
const LAYERS_ON = {
  'GET /v1/warden/config': {
    config: wardenConfig({ layers: { jev: true, llm: true } }),
    accounts: [],
    warnings: [],
  },
};

/** Voice's Speed-ups answer with the Jev key not set, and Runtimes' catalog with one login that reads a model catalog. */
const OPTIONAL_ON = {
  'GET /v1/speedups': SpeedupsViewSchema.parse({
    vault: 'ok',
    providers: [
      {
        provider: 'jev',
        label: 'Jev',
        purpose: 'Triage.',
        costNote: 'Cheap.',
        privacyNote: 'A summary.',
        keyUrl: 'https://keys.example.test/',
        testNote: 'One decision.',
        secretName: 'JEV_API_KEY',
        set: false,
        testStale: false,
      },
    ],
  }),
  'GET /v1/runtimes': RuntimeCatalogSchema.parse({
    format: 'present',
    runtimes: [
      {
        id: 'rt-claude-default',
        name: 'Claude',
        wrapper: 'claude-default',
        harness: 'claude-code',
        credential: { id: 'login-claude', store: 'host', status: 'ready' },
        profile: 'Default',
        agent: true,
        stack: {
          harness: 'claude-code',
          available: { available: true },
          applied: [],
          skipped: [],
          conflicts: [],
          partial: [],
        },
        modelSet: { source: 'harness-default' },
        models: {
          catalog: {
            id: 'anthropic',
            label: 'Anthropic',
            origin: 'built-in',
            customIds: false,
            docs: 'docs/model-catalog.md',
          },
          choices: [{ id: 'opus', label: 'Opus', available: true, efforts: ['low', 'high'], tier: 'best' }],
          default: 'opus',
        },
        launch: { available: true },
        sameAs: [],
      },
    ],
  }),
};

/** What a route of a plugin that is off on the daemon answers. */
const PAUSED = new DaemonCallError(0, 'plugin_paused', 'voice is paused on this daemon (off).');

describe('the Warden half, bound to the shell', () => {
  it('builds its screen, its dashboard panels, its two contributions to Ferrets’ pages and its settings tab over the one client it is handed', async () => {
    const client = fakeClient({ ...WARDEN, 'GET /v1/ferrets': [] });
    const half = app.build?.({ manifest, client }) as AppHalf<typeof manifest>;
    expect(Object.keys(half.screens)).toEqual(['warden']);
    expect(Object.keys(half.panels).sort()).toEqual([
      'ask-warden-row',
      'ferret-warden',
      'warden-strip',
      'warden-verdicts',
    ]);
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

  it('draws the settings tab from the Warden’s reads and the two optional ones: Voice’s key status and Runtimes’ list', async () => {
    const client = fakeClient({ ...WARDEN, ...LAYERS_ON, ...OPTIONAL_ON });
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
    expect(client.calls).toContain('GET /v1/speedups');
    expect(client.calls).toContain('GET /v1/runtimes');
    expect(view.container.textContent).toContain('No Jev key yet.');
    expect(view.container.querySelector('select[id$="-model"]')).not.toBeNull();
    await view.unmount();
  });

  const settingsTab = async (answers: Record<string, unknown>) => {
    const client = fakeClient(answers);
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
    return view;
  };

  it('hides the Jev key line when Voice is off, and keeps the rest of the card', async () => {
    const view = await settingsTab({ ...WARDEN, ...LAYERS_ON, ...OPTIONAL_ON, 'GET /v1/speedups': PAUSED });
    const text = view.container.textContent ?? '';
    for (const line of [
      'No Jev key yet.',
      'Could not check the Jev key.',
      'needs Jev key',
      'key set',
      'key status unknown',
    ])
      expect(text).not.toContain(line);
    expect(view.container.querySelector('[data-testid="warden-config-card"]')).not.toBeNull();
    await view.unmount();
  });

  it('hides the model list when Runtimes is off: the model field is a plain text box', async () => {
    const view = await settingsTab({ ...WARDEN, ...LAYERS_ON, ...OPTIONAL_ON, 'GET /v1/runtimes': PAUSED });
    expect(view.container.querySelector('select[id$="-model"]')).toBeNull();
    expect(view.container.querySelector('input[placeholder="the login’s default"]')).not.toBeNull();
    expect(view.container.textContent).toContain('No Jev key yet.');
    await view.unmount();
  });

  it('says the key could not be checked, not that it is off, when Voice fails for any other reason', async () => {
    const view = await settingsTab({ ...WARDEN, ...LAYERS_ON, ...OPTIONAL_ON, 'GET /v1/speedups': new Error('boom') });
    expect(view.container.textContent).toContain('Could not check the Jev key.');
    await view.unmount();
  });
});

describe('what the Warden reads of other plugins', () => {
  const grantRow = (capability: string, use: boolean, useRefusal: string) => ({
    capability,
    use,
    configure: true,
    granted: { use, configure: true },
    useRefusal,
    configureRefusal: 'granted',
    mayGrant: false,
    origin: 'default',
  });

  it('reads whether warden.use is open from the grants, and nothing else of them', async () => {
    const client = fakeClient({
      'GET /v1/grants': {
        capabilities: [grantRow('warden', false, 'not-granted'), grantRow('fleet', true, 'granted')],
        governed: true,
        hostLocal: false,
        steppedUp: false,
      },
    });
    expect(await readGrants(client)).toEqual({
      capabilities: [
        { capability: 'warden', use: false, useRefusal: 'not-granted' },
        { capability: 'fleet', use: true, useRefusal: 'granted' },
      ],
    });
  });
});

describe('the ferrets of a paired daemon', () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: `ferret-${id}`,
    role: 'lead',
    harness: 'claude-code',
    runner: 'tmux',
    folder: `/work/${id}`,
    state: 'working',
    createdAt: '2026-11-07T00:00:00.000Z',
    stateAt: '2026-11-07T00:00:00.000Z',
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

const useStandIn = configChangeEffect();

describe('the settings card hears the owner come back', () => {
  function Probe({ onReread }: { readonly onReread: () => void }) {
    useStandIn('alpha', ['warden'], onReread);
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

describe('the settings card hears warden.yaml move on the daemon', () => {
  /** A Warden client whose daemon publishes events by hand: `publish` delivers to every listener of that event. */
  const liveClient = () => {
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const client = {
      subscribe: (event: { readonly name: string }, listener: (payload: unknown) => void) => {
        const set = listeners.get(event.name) ?? new Set();
        set.add(listener);
        listeners.set(event.name, set);
        return () => set.delete(listener);
      },
    } as unknown as PluginClient;
    const publish = async (name: string): Promise<void> => {
      await interact(() => {
        for (const listener of [...(listeners.get(name) ?? [])]) listener({});
      });
    };
    return { client, publish, count: (name: string) => listeners.get(name)?.size ?? 0 };
  };

  const settleReach = async (): Promise<void> => {
    await interact(async () => {
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    });
  };

  it('reads again the moment the daemon says warden.yaml moved, through that daemon’s own client', async () => {
    const live = liveClient();
    const asked: string[] = [];
    const useLive = configChangeEffect(async connection => {
      asked.push(connection.daemonId);
      return live.client;
    });
    let rereads = 0;
    function Probe() {
      useLive('alpha', ['warden', 'speedups'], () => (rereads += 1));
      return null;
    }
    const view = await mount(<Probe />);
    await settleReach();
    expect(asked).toEqual(['alpha']);
    expect(rereads).toBe(0);
    await live.publish(WardenConfigChanged.name);
    expect(rereads).toBe(1);
    await live.publish('warden.flagged');
    expect(rereads).toBe(1);
    await view.unmount();
    // Unmounted: it stops listening.
    expect(live.count(WardenConfigChanged.name)).toBe(0);
  });

  it('does not listen for warden.yaml when the card asks for no warden kind', async () => {
    const live = liveClient();
    const useLive = configChangeEffect(async () => live.client);
    function Probe() {
      useLive('alpha', ['speedups'], () => undefined);
      return null;
    }
    const view = await mount(<Probe />);
    await settleReach();
    expect(live.count(WardenConfigChanged.name)).toBe(0);
    await view.unmount();
  });

  it('declares warden.config-changed among the events the Warden publishes', () => {
    expect(manifest.data?.publishes?.map(event => event.name)).toContain('warden.config-changed');
  });
});
