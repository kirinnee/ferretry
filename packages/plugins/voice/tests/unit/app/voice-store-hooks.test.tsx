import { describe, expect, it } from 'bun:test';
import { type ReactNode } from 'react';
import { VoiceClientProvider } from '../../../app/shell-voice.ts';
import {
  createVoiceStore,
  DaemonClientProvider,
  StoreProvider,
  useDaemonClient,
  useDaemonFetch,
  useDictationDebug,
  useDictationDebugSnapshot,
  useLiveVoiceSettingsStore,
  useOnDeviceVoices,
  useOptionalAppStore,
  useParakeetVoice,
  useSpeedupKeys,
  useSttSettingsStore,
  useTranscriptionLog,
  type VoiceStore,
} from '../../../app/lib/voice-store.tsx';
import { mount } from '../../support/app/dom.ts';

/** A store whose members are only told apart by identity: the hooks hand them back, they never call them. */
const SNAPSHOT = { enabled: true, records: [] };
const member = (name: string) => ({ name }) as never;
const fakeStore = (extra: Partial<VoiceStore> = {}): VoiceStore => ({
  stt: member('stt'),
  liveVoice: member('liveVoice'),
  voice: member('voice'),
  voices: member('voices'),
  speedupKeys: member('speedupKeys'),
  dictationDebug: {
    subscribe: () => () => undefined,
    snapshot: () => SNAPSHOT,
  } as never,
  transcriptionLog: member('transcriptionLog'),
  ...extra,
});

function readHooks() {
  const seen: Record<string, unknown> = {};
  function Probe() {
    seen.store = useOptionalAppStore();
    seen.speedupKeys = useSpeedupKeys();
    seen.dictationDebug = useDictationDebug();
    seen.snapshot = useDictationDebugSnapshot();
    seen.stt = useSttSettingsStore();
    seen.liveVoice = useLiveVoiceSettingsStore();
    seen.transcriptionLog = useTranscriptionLog();
    seen.voice = useParakeetVoice();
    seen.voices = useOnDeviceVoices();
    return null;
  }
  return { seen, Probe };
}

describe('the voice store hooks outside a store', () => {
  it('answer null, and a debug snapshot that is off and empty', async () => {
    const { seen, Probe } = readHooks();
    const view = await mount(<Probe />);
    expect(seen.store).toBeNull();
    expect(seen.speedupKeys).toBeNull();
    expect(seen.dictationDebug).toBeNull();
    expect(seen.stt).toBeNull();
    expect(seen.liveVoice).toBeNull();
    expect(seen.transcriptionLog).toBeNull();
    expect(seen.voice).toBeNull();
    expect(seen.voices).toBeNull();
    expect(seen.snapshot).toEqual({ enabled: false, records: [] });
    await view.unmount();
  });
});

describe('the voice store hooks under a StoreProvider', () => {
  it('hand back the store’s own members, and the debug ring’s snapshot', async () => {
    const store = fakeStore();
    const { seen, Probe } = readHooks();
    const view = await mount(
      <StoreProvider store={store}>
        <Probe />
      </StoreProvider>,
    );
    expect(seen.store).toBe(store);
    expect(seen.speedupKeys).toBe(store.speedupKeys);
    expect(seen.dictationDebug).toBe(store.dictationDebug);
    expect(seen.stt).toBe(store.stt);
    expect(seen.liveVoice).toBe(store.liveVoice);
    expect(seen.transcriptionLog).toBe(store.transcriptionLog);
    expect(seen.voice).toBe(store.voice);
    expect(seen.voices).toBe(store.voices);
    expect(seen.snapshot).toEqual({ enabled: true, records: [] });
    await view.unmount();
  });

  it('builds the store once from createStore when none is given', async () => {
    let built = 0;
    const store = fakeStore();
    const { seen, Probe } = readHooks();
    const view = await mount(
      <StoreProvider
        createStore={() => {
          built += 1;
          return store;
        }}
      >
        <Probe />
      </StoreProvider>,
    );
    expect(seen.store).toBe(store);
    expect(built).toBe(1);
    await view.unmount();
  });
});

describe('useDaemonFetch', () => {
  const read = async (wrap: (children: ReactNode) => ReactNode) => {
    let fetcher: ReturnType<typeof useDaemonFetch> | undefined;
    function Probe() {
      fetcher = useDaemonFetch();
      return null;
    }
    const view = await mount(<>{wrap(<Probe />)}</>);
    return { fetcher: fetcher as NonNullable<typeof fetcher>, view };
  };

  it('goes through the store’s carrier when a suite names one', async () => {
    const seen: unknown[] = [];
    const carrier = {
      fetch: async (input: unknown, init: unknown) => {
        seen.push([input, init]);
        return new Response('carried');
      },
    };
    const { fetcher, view } = await read(children => (
      <StoreProvider store={fakeStore({ carrier: carrier as never })}>{children}</StoreProvider>
    ));
    expect(await (await fetcher('/v1/x', { method: 'GET' })).text()).toBe('carried');
    expect(seen).toEqual([['/v1/x', { method: 'GET' }]]);
    await view.unmount();
  });

  it('goes through the plugin client when there is one, never the network', async () => {
    const calls: unknown[] = [];
    const client = {
      call: async (route: string, init?: unknown) => {
        calls.push([route, init]);
        return { providers: [] };
      },
    };
    const { fetcher, view } = await read(children => (
      <VoiceClientProvider client={client as never}>{children}</VoiceClientProvider>
    ));
    const response = await fetcher('/v1/speedups', {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ providers: [] });
    expect(calls).toEqual([['GET /v1/speedups', {}]]);
    await view.unmount();
  });
});

describe('useDaemonClient', () => {
  const read = async (wrap: (children: ReactNode) => ReactNode) => {
    let factory: ReturnType<typeof useDaemonClient> | undefined;
    function Probe() {
      factory = useDaemonClient();
      return null;
    }
    const view = await mount(<>{wrap(<Probe />)}</>);
    return { factory: factory as NonNullable<typeof factory>, view };
  };
  const connection = { daemonId: 'd1', baseUrl: 'http://daemon.test', deviceId: 'dev1' } as never;

  it('refuses with a sentence when there is neither a named client nor the plugin client', async () => {
    const { factory, view } = await read(children => children);
    await expect(factory(connection)).rejects.toThrow('no daemon client exists outside the voice provider');
    await view.unmount();
  });

  it('is the named client when a suite gives one', async () => {
    const named = { history: async () => [], request: async () => undefined } as never;
    const { factory, view } = await read(children => (
      <DaemonClientProvider client={async () => named}>{children}</DaemonClientProvider>
    ));
    expect(await factory(connection)).toBe(named);
    await view.unmount();
  });

  it('is a client over the plugin client when only that exists', async () => {
    const client = { call: async () => ({}) };
    const { factory, view } = await read(children => (
      <VoiceClientProvider client={client as never}>{children}</VoiceClientProvider>
    ));
    const made = await factory(connection);
    expect(await made.history('s1' as never)).toEqual([]);
    await view.unmount();
  });
});

describe('the voice store in a browser whose localStorage is not a storage', () => {
  it('opens without a settings store behind it', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {} });
    try {
      expect(() => createVoiceStore()).not.toThrow();
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
      else Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});
