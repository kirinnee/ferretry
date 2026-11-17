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
import { ConfigChanged, headersFrom, queryFrom, type ApiRequest } from '@ferretry/kernel/contract';
import { config as kernelConfig } from '@ferretry/kernel/host';
import { device, fixedClock, standInAdmission, testArrival, testPrincipal } from '@ferretry/kernel/testing';
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

/** The Jev and LLM layers on, so the task draws the key line and the login and model fields. */
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
      'onboarding-step',
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
    // The screen is a Suspense boundary over a lazily loaded module: six zero-length turns were not enough on a loaded
    // runner (CI run 42935121742 found no page after 11 ms), so wait for the page itself, bounded under bun's 5 s.
    for (let waited = 0; view.container.querySelector('[data-warden-page]') === null && waited < 2_000; waited += 10) {
      await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
    }
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

describe('the settings card hears the files it reads move on the daemon', () => {
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
    const publish = async (name: string, payload: unknown = {}): Promise<void> => {
      await interact(() => {
        for (const listener of [...(listeners.get(name) ?? [])]) listener(payload);
      });
    };
    /** Several events delivered in one turn, as the daemon does for one edit. */
    const burst = async (events: readonly (readonly [string, unknown])[]): Promise<void> => {
      await interact(() => {
        for (const [name, payload] of events)
          for (const listener of [...(listeners.get(name) ?? [])]) listener(payload);
      });
    };
    return { client, publish, burst, count: (name: string) => listeners.get(name)?.size ?? 0 };
  };

  const settleReach = async (): Promise<void> => {
    await interact(async () => {
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    });
  };

  const frame = (path: string, state: 'absent' | 'valid' | 'invalid' | 'held' = 'valid') => ({
    plugin: 'warden',
    path,
    state,
    etag: 'e1',
  });

  it('reads again when the kernel says warden.yaml moved — whatever its state — through that daemon’s own client', async () => {
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
    // A held edit arriving or discarded, a broken file and a fixed one all wake the task, not only a version in effect.
    for (const state of ['held', 'invalid', 'valid', 'absent'] as const) {
      await live.publish(ConfigChanged.name, frame('warden.yaml', state));
    }
    expect(rereads).toBe(4);
    // Another file the task does not read, and another event, wake nothing.
    await live.publish(ConfigChanged.name, frame('learning.yaml'));
    await live.publish('warden.flagged');
    expect(rereads).toBe(4);
    await view.unmount();
    // Unmounted: it stops listening.
    expect(live.count(ConfigChanged.name)).toBe(0);
  });

  it('hears the other kinds the card reads by their own files and no others', async () => {
    const live = liveClient();
    const useLive = configChangeEffect(async () => live.client);
    const heard: string[] = [];
    let rereads = 0;
    function Counter() {
      useLive('alpha', ['speedups', 'machine', 'runtimes', 'credentials', 'unheard'], () => (rereads += 1));
      return null;
    }
    const counting = await mount(<Counter />);
    await settleReach();
    for (const path of [
      'voice.yaml',
      'accounts.yaml',
      'runtimes.yaml',
      'runtimes/claude.yaml',
      'profiles/dev.yaml',
      'model-sets/claude.yaml',
      'models/opus.yaml',
      'endpoints/proxy.yaml',
      'logins/work.yaml',
      'warden.yaml',
      'logins.yaml',
      'profiles.yaml',
      'models.yaml',
      'voice.yaml.bak',
    ]) {
      const before = rereads;
      await live.publish(ConfigChanged.name, frame(path));
      if (rereads > before) heard.push(path);
    }
    expect(heard).toEqual([
      'voice.yaml',
      'accounts.yaml',
      'runtimes.yaml',
      'runtimes/claude.yaml',
      'profiles/dev.yaml',
      'model-sets/claude.yaml',
      'models/opus.yaml',
      'endpoints/proxy.yaml',
      'logins/work.yaml',
    ]);
    await counting.unmount();
  });

  it('listens to nothing for a kind it does not know, and not at all with no way to reach the daemon', async () => {
    const live = liveClient();
    const useLive = configChangeEffect(async () => live.client);
    let rereads = 0;
    function Probe() {
      useLive('alpha', [], () => (rereads += 1));
      return null;
    }
    const view = await mount(<Probe />);
    await settleReach();
    await live.publish(ConfigChanged.name, frame('warden.yaml'));
    expect(rereads).toBe(0);
    await view.unmount();

    const none = configChangeEffect();
    function Bare() {
      none('alpha', ['warden'], () => (rereads += 1));
      return null;
    }
    const bare = await mount(<Bare />);
    await settleReach();
    expect(rereads).toBe(0);
    await bare.unmount();
  });

  it('keeps one listening through renders that spell the same kinds again, and moves it when the daemon changes', async () => {
    const live = liveClient();
    const asked: string[] = [];
    const useLive = configChangeEffect(async connection => {
      asked.push(connection.daemonId);
      return live.client;
    });
    let rereads = 0;
    function Probe({ daemon, tick }: { readonly daemon: string; readonly tick: number }) {
      useLive(daemon, ['warden', 'runtimes'], () => (rereads += tick));
      return null;
    }
    const view = await mount(<Probe daemon="alpha" tick={1} />);
    await settleReach();
    await view.render(<Probe daemon="alpha" tick={2} />);
    await settleReach();
    expect(asked).toEqual(['alpha']);
    expect(live.count(ConfigChanged.name)).toBe(1);
    // The newest reread is the one called.
    await live.publish(ConfigChanged.name, frame('warden.yaml'));
    expect(rereads).toBe(2);
    await view.render(<Probe daemon="beta" tick={2} />);
    await settleReach();
    expect(asked).toEqual(['alpha', 'beta']);
    expect(live.count(ConfigChanged.name)).toBe(1);
    await view.unmount();
  });

  it('stays quiet and keeps reading on return to the tab when the daemon cannot be reached', async () => {
    const useLive = configChangeEffect(async () => {
      throw new Error('no client');
    });
    let rereads = 0;
    function Probe() {
      useLive('alpha', ['warden'], () => (rereads += 1));
      return null;
    }
    const view = await mount(<Probe />);
    await settleReach();
    // Nothing to hear, nothing read: not on mount, and no unhandled rejection.
    expect(rereads).toBe(0);
    const visibility = (hidden: boolean) =>
      interact(() => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          value: hidden ? 'hidden' : 'visible',
        });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    await visibility(true);
    await visibility(false);
    // The tab coming back is the one thing that still reads.
    expect(rereads).toBe(1);
    await view.unmount();
  });

  it('also hears warden.config-changed for its own file, and the two sources together are one reread', async () => {
    const live = liveClient();
    const useLive = configChangeEffect(async () => live.client);
    let rereads = 0;
    function Probe({ kinds }: { readonly kinds: readonly string[] }) {
      useLive('alpha', kinds, () => (rereads += 1));
      return null;
    }
    const view = await mount(<Probe kinds={['warden']} />);
    await settleReach();
    await live.publish(WardenConfigChanged.name, {});
    expect(rereads).toBe(1);
    // One edit said twice, in the same turn: one coalesced reread.
    await live.burst([
      [ConfigChanged.name, frame('warden.yaml')],
      [WardenConfigChanged.name, {}],
    ]);
    expect(rereads).toBe(2);
    await view.unmount();
    expect(live.count(WardenConfigChanged.name)).toBe(0);
    expect(live.count(ConfigChanged.name)).toBe(0);

    // A task that does not show the Warden's own settings does not wake for them.
    const other = await mount(<Probe kinds={['credentials']} />);
    await settleReach();
    await live.publish(WardenConfigChanged.name, {});
    expect(rereads).toBe(2);
    await other.unmount();
  });

  it('refreshes an open card for a device that may use the Warden but not the fleet, through the real bus filter', async () => {
    // The device's grants: warden.use allowed, fleet.use denied (the stand-in admits by the route's own capability).
    const caller = device('phone', ['warden.use']);
    const admission = standInAdmission(() => caller);
    const request: ApiRequest = {
      method: 'GET',
      path: '/v1/bus',
      query: queryFrom([]),
      headers: headersFrom({}),
      arrival: testArrival(caller),
      principal: testPrincipal(caller, fixedClock('2026-11-06T09:00:00Z').now()),
      text: async () => '',
    };
    const declared = <Route extends { readonly key: string }>(
      route: string,
      manifestRoutes: readonly Route[] | undefined,
    ): Route => {
      const found = manifestRoutes?.find(entry => entry.key === route);
      if (found === undefined) throw new Error(`no declaration for ${route}`);
      return found;
    };
    const fileRead = kernelConfig.CONFIG_FILE_READ;
    const taskRead = declared('GET /v1/warden/config', manifest.actions?.routes);
    // The task opens (warden.use), and the kernel would not show this device a config frame (fleet.use).
    expect(admission.admit({ table: 'route', descriptor: taskRead, request, params: new Map() }).outcome).toBe(
      'admitted',
    );
    expect(kernelConfig.configFrameShown(admission, request, frame('warden.yaml'), fileRead)).toBe(false);

    // The daemon's bus as this device sees it: a config frame only where the kernel shows it, every other event as sent.
    const live = liveClient();
    const through = {
      subscribe: (event: { readonly name: string }, listener: (payload: unknown) => void) =>
        live.client.subscribe(event as never, (payload: unknown) => {
          if (
            event.name === ConfigChanged.name &&
            !kernelConfig.configFrameShown(admission, request, payload, fileRead)
          )
            return;
          listener(payload);
        }),
    } as unknown as PluginClient;
    const useLive = configChangeEffect(async () => through);
    let rereads = 0;
    function Probe() {
      useLive('alpha', ['warden'], () => (rereads += 1));
      return null;
    }
    const view = await mount(<Probe />);
    await settleReach();
    // An ordinary warden.yaml edit: the daemon publishes both, the kernel's filter drops the config frame.
    await live.burst([
      [ConfigChanged.name, frame('warden.yaml')],
      [WardenConfigChanged.name, {}],
    ]);
    expect(rereads).toBe(1);
    await view.unmount();
  });

  it('declares warden.config-changed among the events the Warden publishes', () => {
    expect(manifest.data?.publishes?.map(event => event.name)).toContain('warden.config-changed');
  });
});
