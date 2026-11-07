/**
 * THE VOICE HALF'S OWN STORE (today's slice of `lib/store.tsx`).
 *
 * Today the PWA built ONE app store holding everything; the voice parts of it were the dictation settings, the live-voice
 * settings, Parakeet and the other on-device voices, the device's speed-up keys, the dictation debug ring and the
 * transcription log. Those are the voice plugin's, so the plugin builds them itself — {@link createVoiceStore} is the
 * body of the old `createAppStore` with everything else removed — and the hooks keep today's names so no screen changed.
 *
 * Nothing here reaches a daemon: the stores keep their data in this browser (localStorage, IndexedDB), and a daemon is
 * called through the plugin client `app/index.ts` puts in a context (`shell-voice.ts`).
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import {
  apiClientOver,
  browserFetch,
  type DaemonConnection,
  type DaemonFetch,
  type DaemonId,
  type IFyApiClient,
  pluginFetch,
  useOptionalVoiceClient,
} from '../shell-voice.ts';
import { LiveVoiceSettingsStore } from './voice-chat/live-settings.ts';
import { DictationDebugLog, type DictationDebugSnapshot } from './stt/dictation-debug.ts';
import {
  browserOnDeviceVoices,
  OnDeviceVoices,
  type SpeechAssets,
  type SpeechGlobalLike,
} from './stt/on-device-voices.ts';
import { browserParakeetVoice, type ParakeetVoice } from './stt/parakeet-voice.ts';
import { speedPlannerFor } from './stt/speed-planner.ts';
import type { SpeedGlobalLike } from './stt/speed-signals.ts';
import { DeviceSpeedupKeys, IndexedDbSpeedupKeyRecords } from './stt/speedup-keys.ts';
import { SttSettingsStore } from './stt/stt-settings.ts';
import { TranscriptionLog } from './stt/transcription-log.ts';
import { IndexedDbTranscriptionLogRecords } from './stt/transcription-log-records.ts';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Resolves the browser store, treating denial as an ordinary condition: reading `localStorage` throws in some privacy modes. */
const browserStorage = (): StorageLike | null => {
  try {
    const candidate = (globalThis as { localStorage?: StorageLike }).localStorage;
    return candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function'
      ? candidate
      : null;
  } catch {
    return null;
  }
};

/** What the voice half keeps on this device. */
export interface VoiceStore {
  readonly stt: SttSettingsStore;
  /** This device's voice-chat settings (Auto-read replies, voice, rate), kept in this browser only. */
  readonly liveVoice: LiveVoiceSettingsStore;
  /** Parakeet on this device: whether it can run, its install, and on-device dictation sessions. */
  readonly voice: ParakeetVoice;
  /** Every on-device speech model this device can install and run, Parakeet's voice among them. */
  readonly voices: OnDeviceVoices;
  /** Groq/Cerebras keys THIS device holds for direct dictation clean-up; never synced, never sent to a daemon. */
  readonly speedupKeys: DeviceSpeedupKeys;
  /** The opt-in dictation debug switch and its in-memory ring of recent cleanup calls; this tab only. */
  readonly dictationDebug: DictationDebugLog;
  /** Every dictation this device made, kept in its own IndexedDB; never synced, never sent to a daemon. */
  readonly transcriptionLog: TranscriptionLog;
  /** A `fetch` for daemon requests, when something other than the plugin client carries them (a suite, the design harness). */
  readonly carrier?: { readonly fetch: DaemonFetch };
}

/** Today's name for it, kept so the suites and screens read as they did. */
export type AppStore = VoiceStore;

export interface VoiceStoreOptions {
  readonly voice?: ParakeetVoice;
  readonly voices?: OnDeviceVoices;
  readonly speechAssets?: SpeechAssets | null;
  readonly speedupKeys?: DeviceSpeedupKeys;
  readonly dictationDebug?: DictationDebugLog;
  readonly transcriptionLog?: TranscriptionLog;
  readonly fetcher?: DaemonFetch;
}

/** Builds this device's voice stores (the body of today's `createAppStore`, voice parts only). */
export function createVoiceStore(options: VoiceStoreOptions = {}): VoiceStore {
  const storage = browserStorage();
  const stt = new SttSettingsStore(storage);
  const liveVoice = new LiveVoiceSettingsStore(storage);
  const speedupKeys =
    options.speedupKeys ??
    new DeviceSpeedupKeys(
      new IndexedDbSpeedupKeyRecords(globalThis.indexedDB),
      globalThis.crypto.subtle,
      options.fetcher ?? browserFetch,
    );
  const dictationDebug = options.dictationDebug ?? new DictationDebugLog();
  const transcriptionLog =
    options.transcriptionLog ?? new TranscriptionLog(new IndexedDbTranscriptionLogRecords(globalThis.indexedDB));
  void transcriptionLog.hydrate();
  const speechGlobal = globalThis as unknown as SpeechGlobalLike;
  const speedPlanner = speedPlannerFor(globalThis as unknown as SpeedGlobalLike);
  const voice = options.voice ?? browserParakeetVoice(speechGlobal, options.speechAssets ?? null, speedPlanner);
  const voices =
    options.voices ??
    (options.voice === undefined
      ? browserOnDeviceVoices(speechGlobal, options.speechAssets ?? null, voice, speedPlanner)
      : new OnDeviceVoices([voice]));
  // Reads what is already installed; it never downloads.
  void voices.refresh();
  if (voices.get(voice.model.id) !== voice) void voice.refresh();
  return { stt, liveVoice, voice, voices, speedupKeys, dictationDebug, transcriptionLog };
}

const StoreContext = createContext<VoiceStore | null>(null);

export interface StoreProviderProps {
  readonly children?: ReactNode;
  readonly store?: VoiceStore;
  readonly createStore?: () => VoiceStore;
}

/** Puts a voice store under every screen below it; builds one (once) when none is given. */
export function StoreProvider({ children, store, createStore = createVoiceStore }: StoreProviderProps) {
  const resolved = useMemo(() => store ?? createStore(), [store, createStore]);
  return <StoreContext.Provider value={resolved}>{children}</StoreContext.Provider>;
}

export function useOptionalAppStore(): VoiceStore | null {
  return useContext(StoreContext);
}

/** Groq/Cerebras keys this device holds, or `null` outside a store. */
export function useSpeedupKeys(): DeviceSpeedupKeys | null {
  return useContext(StoreContext)?.speedupKeys ?? null;
}

/** The dictation debug log, or `null` outside a store. */
export function useDictationDebug(): DictationDebugLog | null {
  return useContext(StoreContext)?.dictationDebug ?? null;
}

const NO_DEBUG: DictationDebugSnapshot = Object.freeze({ enabled: false, records: [] });
const noDebugSnapshot = (): DictationDebugSnapshot => NO_DEBUG;
const noSubscription = (): (() => void) => () => undefined;

/** What the debug ring holds right now; always off and empty outside a store. */
export function useDictationDebugSnapshot(): DictationDebugSnapshot {
  const log = useDictationDebug();
  return useSyncExternalStore(log?.subscribe ?? noSubscription, log?.snapshot ?? noDebugSnapshot);
}

/** This device's dictation settings store, or `null` outside a store. */
export function useSttSettingsStore(): SttSettingsStore | null {
  return useContext(StoreContext)?.stt ?? null;
}

/** This device's live-voice settings, or `null` outside a store. */
export function useLiveVoiceSettingsStore(): LiveVoiceSettingsStore | null {
  return useContext(StoreContext)?.liveVoice ?? null;
}

/** This device's transcription log, or `null` outside a store. */
export function useTranscriptionLog(): TranscriptionLog | null {
  return useContext(StoreContext)?.transcriptionLog ?? null;
}

/** Parakeet on this device, or `null` outside a store. */
export function useParakeetVoice(): ParakeetVoice | null {
  return useContext(StoreContext)?.voice ?? null;
}

/** Every on-device voice this device can install, or `null` outside a store. */
export function useOnDeviceVoices(): OnDeviceVoices | null {
  return useContext(StoreContext)?.voices ?? null;
}

/**
 * The `fetch` a screen reads the daemon through: the store's carrier when a suite or harness names one, else the plugin
 * client's, else the plain network. ONE identity per source, because effects list it as a dependency.
 */
export function useDaemonFetch(): DaemonFetch {
  const store = useContext(StoreContext);
  const client = useOptionalVoiceClient();
  return useMemo<DaemonFetch>(() => {
    if (store?.carrier !== undefined) {
      const carrier = store.carrier;
      return async (input, init) => await carrier.fetch(input, init);
    }
    if (client !== null) {
      const routed = pluginFetch(client);
      return async (input, init) => await routed(String(input), init ?? {});
    }
    return browserFetch;
  }, [store, client]);
}

// ─── the daemon client ────────────────────────────────────────────────────────────────────────────────────────────

type DaemonClientFactory = (daemon: DaemonConnection) => Promise<IFyApiClient>;

const DaemonClientContext = createContext<DaemonClientFactory | null>(null);

/** Names the typed client for every screen below it: for a surface rendered without the plugin client (a suite, the harness). */
export function DaemonClientProvider({
  client,
  children,
}: {
  readonly client: DaemonClientFactory;
  readonly children?: ReactNode;
}) {
  return <DaemonClientContext.Provider value={client}>{children}</DaemonClientContext.Provider>;
}

/**
 * A factory from a connection to a client: the named one, else one over the plugin client, else a refusal that says
 * there is none (a client built on the plain network reaches no daemon at all).
 */
export function useDaemonClient(): DaemonClientFactory {
  const named = useContext(DaemonClientContext);
  const client = useOptionalVoiceClient();
  return useMemo(
    () =>
      named ??
      (client === null
        ? async () => {
            throw new Error('no daemon client exists outside the voice provider');
          }
        : async () => apiClientOver(client)),
    [named, client],
  );
}

// ─── live configuration changes ───────────────────────────────────────────────────────────────────────────────────

/** What the shell's configuration stream offers: how many times any of these kinds moved on a machine. */
export interface ConfigChanges {
  subscribe(listener: () => void): () => void;
  counter(daemonId: DaemonId, kinds: readonly string[]): number;
}

const NO_CONFIG_CHANGES: ConfigChanges = {
  subscribe: () => () => undefined,
  counter: () => 0,
};

/** The store of the configuration stream, when the shell offers one. */
export function ConfigChangesProvider({
  changes,
  children,
}: {
  readonly changes: ConfigChanges;
  readonly children?: ReactNode;
}) {
  return <ConfigChangesContext.Provider value={changes}>{children}</ConfigChangesContext.Provider>;
}
const ConfigChangesContext = createContext<ConfigChanges>(NO_CONFIG_CHANGES);

/** How many times any of these kinds of configuration has moved on this machine; outside a provider it never moves. */
export function useConfigChangeCounter(daemonId: DaemonId, kinds: readonly string[]): number {
  const changes = useContext(ConfigChangesContext);
  const key = kinds.join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the kinds' spelling is the deliberate key
  const read = useCallback(() => changes.counter(daemonId, kinds), [changes, daemonId, key]);
  return useSyncExternalStore(
    useCallback(listener => changes.subscribe(listener), [changes]),
    read,
    read,
  );
}

/** Run `reread` whenever any of these kinds moves after the screen mounted — never on mount itself. */
export function useConfigChangeEffect(daemonId: DaemonId, kinds: readonly string[], reread: () => void): void {
  const counter = useConfigChangeCounter(daemonId, kinds);
  const latest = useRef(reread);
  latest.current = reread;
  const seen = useRef(counter);
  useEffect(() => {
    if (counter === seen.current) return;
    seen.current = counter;
    latest.current();
  }, [counter]);
}
