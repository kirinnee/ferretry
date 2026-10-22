import { type ConfigChangeKind, DaemonCarriersViewSchema, type PairingResponse } from '@ferretry/protocol';
import type { FyApiClient } from '@ferretry/protocol/client';
import { publishedConnectionMethods } from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  bundledRelayDirectory,
  type HostedRelayFallback,
  readHostedRelayFallback,
} from '../features/onboarding/hosted-relay.ts';
import {
  checkAccountPickerHealth,
  readAccountPickerCatalog,
  readAccountPickerHealth,
} from './account-picker-catalog.ts';
import { DaemonAccountPickerStore } from './account-picker-store.ts';
import { DaemonHttpTransport, daemonApiClient } from './api-client.ts';
import { DaemonAttentionClient } from './attention-client.ts';
import { browserLoginPort, DaemonBrowserLoginStore } from './browser-login.ts';
import { browserCarrierDropEnvironment, CarrierDropLog } from './carrier-drops.ts';
import { CarrierPreferenceStore } from './carrier-preference.ts';
import { DaemonConfigChangeStore } from './config-changes.ts';
import {
  browserConnectionHealthEnvironment,
  type ConnectionHealth,
  type ConnectionHealthEnvironment,
  DaemonConnectionHealth,
} from './connection-health.ts';
import {
  browserConnectionSignals,
  type ConnectionSignalEnvironment,
  watchConnectionSignals,
} from './connection-signals.ts';
import {
  type DaemonConnectionRepository,
  DaemonConnectionStore,
  type DaemonConnectionsSnapshot,
} from './connections.ts';
import { browserControlsStorage, DaemonControlsStore } from './controls.ts';
import { type DaemonConnection, type DaemonId, sameDaemonConnection } from './daemon-connection.ts';
import { boundDaemonId, daemonRequest } from './daemon-transport.ts';
import { type DeviceKeyStore, IndexedDbDeviceKeyStore, mintDeviceKey } from './device-keys.ts';
import { documentDraftStore } from './drafts.ts';
import { DaemonEventTransport, type DaemonStreamOpener } from './event-transport.ts';
import { type DaemonFleetPort, DaemonFleetStore } from './fleet-store.ts';
import { KeyRotation } from './key-rotation.ts';
import { DeviceNotificationFilterStore } from './notification-filter.ts';
import { browserNotificationFilterMirror } from './notification-filter-mirror.ts';
import { DaemonNotificationPreferences } from './notification-preferences.ts';
import { type PairingSeed, pairedDaemonConnection } from './pairing.ts';
import { type PairingLegFailure, PairingUnreachableError } from './pairing-unreachable.ts';
import type { CredentialsPort } from './passkeys.ts';
import { browserLongTaskObserver, type LongTaskObserverPort, observeLongTasks } from './performance/main-thread.ts';
import { PerformanceRecorder } from './performance/recorder.ts';
import { recordingFetch, recordingStreams } from './performance/recording-fetch.ts';
import { DaemonPinClient } from './pin-client.ts';
import { browserPresenceEnvironment, PresenceTracker } from './presence.ts';
import { DaemonProjectsStore, daemonProjectsPort } from './projects-store.ts';
import { DaemonPushDevices, type DaemonPushService, daemonPushService } from './push-enrolment.ts';
import {
  type CarrierDialers,
  DaemonCarrierRouter,
  type OutdatedSide,
  outdatedError,
  outdatedRefusal,
  outdatedSide,
  type RelayDial,
} from './relay-carrier.ts';
import { PairingOutcomeUnknownError, pairingCandidates, redeemPairingInSession } from './relay-pairing.ts';
import { RelayPairingRefusedError, RelaySessionError } from './relay-session.ts';
import { browserFetch, type DaemonFetch } from './runtime-models.ts';
import { browserScrollMemoryStorage, ScrollMemory, type ScrollMemoryStorage } from './scroll-memory.ts';
import { fetchSecuritySettings, UNLOCK_STAYS_FALLBACK, unlockStaysSentence } from './security-settings-client.ts';
import { SessionCache, type SessionCacheBackend, seedFleetFromCache } from './session-cache.ts';
import { browserSessionCacheBackend } from './session-cache-storage.ts';
import { sharingIdenticalReads } from './shared-reads.ts';
import {
  browserCredentials,
  describeStepUpFailure,
  firstPasskeyOffer,
  stepUpCeremony,
  unlockCeremony,
} from './step-up-ceremony.ts';
import { StepUpGate } from './step-up-gate.ts';
import { DictationDebugLog, type DictationDebugSnapshot } from './stt/dictation-debug.ts';
import {
  browserParakeetVoice,
  type ParakeetAssets,
  type ParakeetGlobalLike,
  type ParakeetVoice,
} from './stt/parakeet-voice.ts';
import { DeviceSpeedupKeys, IndexedDbSpeedupKeyRecords } from './stt/speedup-keys.ts';
import { SttSettingsStore } from './stt/stt-settings.ts';
import { TranscriptionLog, type TranscriptionLogSnapshot } from './stt/transcription-log.ts';
import { IndexedDbTranscriptionLogRecords } from './stt/transcription-log-records.ts';
import { readTunnelService, type TunnelServiceState } from './tunnel-service.ts';
import { keptTunnel, TunnelSwitchStore } from './tunnel-switch.ts';
import { DaemonUsageStore, daemonUsagePort } from './usage-store.ts';
import { browserWebRtcDialer, type WebRtcDialer } from './webrtc-carrier.ts';
import { WorkspaceLayoutStore } from './workspace-layout-store.ts';

const CONNECTION_DATABASE = 'ferretry-pwa';
const CONNECTION_OBJECT_STORE = 'connections';

/**
 * The landing page reads just this synchronous, content-free hint to decide
 * whether opening the app is more useful than repeating the product pitch. It
 * is never a pairing record: no daemon address, identity, or credential enters
 * localStorage.
 */
export const LANDING_MARKER_KEY = 'fy-has-pairings-v1';
const PAIRED_MARKER = '1';

export interface LandingMarkerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Safely finds browser storage without making a storage refusal fatal to the app. */
const browserLandingMarkerStorage = (): LandingMarkerStorage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

/** Mirrors only the empty/non-empty shape of the runtime pairing registry. */
export const syncLandingMarker = (storage: LandingMarkerStorage | undefined, pairingCount: number): void => {
  if (storage === undefined) return;
  try {
    if (pairingCount > 0) storage.setItem(LANDING_MARKER_KEY, PAIRED_MARKER);
    else storage.removeItem(LANDING_MARKER_KEY);
  } catch {
    // Private browsing and storage policies must fail open to the landing page.
  }
};

const requestResult = <T,>(request: IDBRequest<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });

const transactionComplete = (transaction: IDBTransaction): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });

/** Browser persistence for the runtime pairing registry. */
export class IndexedDbConnectionRepository implements DaemonConnectionRepository {
  readonly #database: Promise<IDBDatabase>;

  constructor(factory: IDBFactory, databaseName = CONNECTION_DATABASE) {
    this.#database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(CONNECTION_OBJECT_STORE)) {
          request.result.createObjectStore(CONNECTION_OBJECT_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('could not open the pairing database'));
      request.onblocked = () => reject(new Error('the pairing database upgrade is blocked'));
    });
  }

  async load(key: string): Promise<string | null> {
    const database = await this.#database;
    const transaction = database.transaction(CONNECTION_OBJECT_STORE, 'readonly');
    const value = await requestResult(transaction.objectStore(CONNECTION_OBJECT_STORE).get(key));
    return typeof value === 'string' ? value : null;
  }

  async save(key: string, value: string): Promise<void> {
    const database = await this.#database;
    const transaction = database.transaction(CONNECTION_OBJECT_STORE, 'readwrite');
    transaction.objectStore(CONNECTION_OBJECT_STORE).put(value, key);
    await transactionComplete(transaction);
  }
}

/** Returns no repository when storage is unavailable; pairing still works for this tab. */
export const browserConnectionRepository = (
  factory: IDBFactory | undefined = globalThis.indexedDB,
): DaemonConnectionRepository | undefined =>
  factory === undefined ? undefined : new IndexedDbConnectionRepository(factory);

type ConnectDaemonClient = (daemon: DaemonConnection) => Promise<FyApiClient>;

interface ClientEntry {
  readonly connection: DaemonConnection;
  readonly client: Promise<FyApiClient>;
}

/** One typed client promise per live pairing, fenced across re-pairing. */
export class DaemonApiPool {
  readonly #entries = new Map<DaemonId, ClientEntry>();

  constructor(private readonly connect: ConnectDaemonClient) {}

  client(daemon: DaemonConnection): Promise<FyApiClient> {
    const current = this.#entries.get(daemon.daemonId);
    if (current !== undefined && sameDaemonConnection(current.connection, daemon)) return current.client;

    const client = this.connect(daemon);
    const entry = { connection: daemon, client };
    this.#entries.set(daemon.daemonId, entry);
    void client.catch(() => {
      if (this.#entries.get(daemon.daemonId) === entry) this.#entries.delete(daemon.daemonId);
    });
    return client;
  }

  clearDaemon(daemonId: DaemonId): void {
    this.#entries.delete(daemonId);
  }
}

/**
 * How this browser names itself when the caller named nothing. The confirm screen always names it
 * (`device-name.ts`), so only a caller with no person in front of it lands here.
 */
const PAIRING_DEVICE_NAME = 'Ferretry PWA';

/**
 * How long the DIRECT leg of a redemption may spend before the walk moves on.
 *
 * Short on purpose. It is not a budget for a slow daemon — a reachable daemon keys a session in
 * milliseconds on a LAN — it is the point at which "this address is not answering" becomes the more
 * useful conclusion. The code it is spending has a two-minute life, and the rendezvous attempt behind
 * this one needs a socket, a handshake and a sealed exchange of its own.
 */
const DIRECT_PAIRING_TIMEOUT_MS = 4_000;

export interface ExchangePairingOptions {
  /** What this device is called at the machine — `fy device ls`, revoke, the device list. */
  readonly deviceName?: string;
  /** Where this browser keeps device keys. The new key is saved here only once the daemon accepted it. */
  readonly deviceKeys: DeviceKeyStore;
  readonly hostedRelayUrl?: string;
  /** WebCrypto by default: the session's primitives, and the one that mints the device key. */
  readonly relayCrypto?: WebCryptoRelayCrypto;
  /** The browser WebSocket by default. Injected so no suite opens one. */
  readonly relayDial?: RelayDial;
  /** `DIRECT_PAIRING_TIMEOUT_MS` by default. A parameter so a suite can prove the deadline in ms. */
  readonly directTimeoutMs?: number;
  /**
   * The plain network, for ONE read: the daemon's public liveness route after the direct leg failed,
   * which is how an old daemon is told from an absent one. Absent means nobody can ask.
   */
  readonly network?: DaemonFetch;
}

/**
 * A sealed refusal that arrived after an earlier leg's code may already have been spent.
 *
 * A subclass rather than a new class, deliberately: the daemon genuinely refused, so every consumer
 * that asks "was this a refusal or a transport failure" — `pairing-screen.tsx` is the one that
 * matters — must keep getting `refusal` and must keep telling the reader to mint a fresh code. What
 * this adds is the half that screen cannot know: minting again is necessary and may not be
 * sufficient, because a device may already be paired under a grant nobody holds.
 */
class AmbiguousPairingError extends RelayPairingRefusedError {
  constructor(refusal: unknown) {
    super();
    this.name = 'AmbiguousPairingError';
    this.cause = refusal;
    this.message =
      'this pairing code is spent, and an earlier attempt from this browser may be what spent it: the ' +
      'code reached the daemon, but the connection ended before its answer arrived, so the daemon may ' +
      'have paired a device this browser never heard about. Check the daemon for a device you do not ' +
      'recognise and revoke it, then run `fy pair` for a fresh code.';
  }
}

/**
 * Exchanges one reader-supplied, single-use fragment code — over whichever carrier reaches its daemon.
 *
 * THE WALK IS §1'S: the daemon's own address first, then the one rendezvous this build discovered for
 * itself. Both are SESSIONS — the daemon is proved against the QR's fingerprint before the code leaves
 * this browser, on the LAN as much as across the internet — and both register the same freshly minted,
 * non-extractable device key. Only a TRANSPORT failure advances the walk; a sealed `pair-refused` is
 * the daemon's final answer for that attempt, and carrying the same code to a second carrier would
 * spend another guess to be told the same thing.
 *
 * THE KEY IS SAVED ONLY AFTER THE DAEMON ACCEPTED IT, and only for the daemon that did. A refused or
 * unreachable pairing leaves nothing behind in this browser.
 *
 * WHAT IS REPORTED WHEN EVERYTHING FAILS is EVERY leg, one plain sentence each
 * (`PairingUnreachableError`). Reporting only the first told a phone on cellular that
 * the loopback address "never reached the relay protocol" and said nothing about the relay leg,
 * which was the one that mattered. A refusal still ends the walk on its own sentence, an old machine
 * still decides the sentence when one is detected, and a code that may have been spent unheard is
 * still reported as exactly that.
 */
export async function exchangePairing(seed: PairingSeed, options: ExchangePairingOptions): Promise<DaemonConnection> {
  const crypto = options.relayCrypto ?? new WebCryptoRelayCrypto();
  const minted = await mintDeviceKey(crypto);
  const key = crypto.deviceKeyHandle(minted.privateKey);
  const legs: PairingLegFailure[] = [];
  let spentUnheard: PairingOutcomeUnknownError | undefined;
  let outdated: OutdatedSide | undefined;
  for (const method of pairingCandidates(seed, options.hostedRelayUrl)) {
    let response: PairingResponse;
    try {
      response = await redeemPairingInSession({
        crypto,
        seed,
        deviceName: options.deviceName ?? PAIRING_DEVICE_NAME,
        method,
        publicKey: minted.publicKey,
        key,
        ...(options.relayDial === undefined ? {} : { dial: options.relayDial }),
        ...(method.kind === 'direct' ? { deadlineMs: options.directTimeoutMs ?? DIRECT_PAIRING_TIMEOUT_MS } : {}),
      });
    } catch (reason) {
      // A sealed refusal is the DAEMON's answer and ends the walk; anything else is this carrier not
      // working, which is the next one's turn.
      if (reason instanceof RelayPairingRefusedError) {
        throw spentUnheard === undefined ? reason : new AmbiguousPairingError(reason);
      }
      // AN OLD MACHINE IS A SIGNAL, NOT A VERDICT. Both signs of one are unauthenticated — a plaintext
      // liveness read, a refusal sent before any key was checked — so they never stop the walk short of
      // a carrier that works. They only decide the sentence when every carrier has failed.
      outdated ??=
        outdatedRefusal(reason) ??
        (method.kind === 'direct' && options.network !== undefined
          ? await outdatedSide(options.network, method.daemonUrl)
          : undefined);
      if (reason instanceof PairingOutcomeUnknownError) spentUnheard ??= reason;
      legs.push({
        kind: method.kind,
        address: method.kind === 'direct' ? method.daemonUrl : method.relayUrl,
        ...(reason instanceof RelaySessionError ? { code: reason.code } : {}),
      });
      continue;
    }
    // Deliberately outside the catch above: a response that paired but named no rendezvous this
    // browser crossed is a decided outcome, not a carrier that failed. The grant exists and this
    // device is discarding it, and dialling the next carrier would mint a second one to discard.
    const connection = pairedDaemonConnection(
      seed,
      response,
      options.hostedRelayUrl,
      method.kind === 'relay' ? method : undefined,
    );
    await options.deviceKeys.save(connection.daemonId, minted.privateKey);
    return connection;
  }
  if (outdated !== undefined) throw outdatedError(outdated);
  if (spentUnheard !== undefined) throw spentUnheard;
  if (legs.length === 0) throw new Error('no carrier could reach this daemon to pair with it');
  throw new PairingUnreachableError(legs);
}

export interface AppStore {
  readonly connections: DaemonConnectionStore;
  readonly clients: DaemonApiPool;
  readonly fleet: DaemonFleetStore;
  readonly controls: DaemonControlsStore;
  readonly projects: DaemonProjectsStore;
  readonly accountPicker: DaemonAccountPickerStore;
  /** Which kinds of each machine's configuration have moved, so a screen reads them again. */
  readonly configChanges: DaemonConfigChangeStore;
  /** The one daemon/session-scoped Attention cache and mutation client. */
  readonly attention: DaemonAttentionClient;
  readonly usage: DaemonUsageStore;
  readonly pins: DaemonPinClient;
  readonly browserLogin: DaemonBrowserLoginStore;
  readonly stt: SttSettingsStore;
  /**
   * Parakeet on this device: whether it can run, its install, and on-device dictation sessions. One
   * per document, like the dictation settings, because the model belongs to the device.
   */
  readonly voice: ParakeetVoice;
  /** Groq/Cerebras keys THIS device holds for direct dictation clean-up; never synced, never sent to a daemon. */
  readonly speedupKeys: DeviceSpeedupKeys;
  /** The opt-in dictation debug switch and its in-memory ring of recent cleanup calls; this tab only. */
  readonly dictationDebug: DictationDebugLog;
  /** Every dictation this device made, kept in its own IndexedDB; never synced, never sent to a daemon. */
  readonly transcriptionLog: TranscriptionLog;
  /** Every agent's remembered split workspace, forgotten with the machine it belongs to. */
  readonly workspaceLayouts: WorkspaceLayoutStore;
  readonly notificationPreferences: DaemonNotificationPreferences;
  /** This browser's one device-wide notification filter — see `notification-filter.ts`. */
  readonly notificationFilter: DeviceNotificationFilterStore;
  readonly pushDevices: DaemonPushDevices;
  /**
   * The daemon push API bound to the SAME fetcher as every other daemon call.
   * Built here rather than by the root because a root that injects a fetcher —
   * a suite, or a future offline shell — would otherwise get the real network
   * for enrolment alone, which is the one call that hands a daemon an endpoint.
   */
  readonly pushService: DaemonPushService;
  /**
   * WHICH CARRIER EACH DAEMON'S TRAFFIC IS ON, and the thing that puts it there.
   *
   * Direct first, the relay as the automatic fallback, and a sentence naming which
   * won and why the other did not — `docs/relay-protocol.md` §1. Read `choice()` for
   * the disclosure; call nothing else on it from a surface.
   */
  readonly carrier: DaemonCarrierRouter;
  /**
   * WHICH CARRIERS THIS BROWSER WALKS FOR EACH MACHINE (§15 "The choice"), kept on this device.
   *
   * A change is the router's cue to forget that machine's winner and walk again; the store wires that,
   * so a surface only ever calls `set`.
   */
  readonly carrierPreferences: CarrierPreferenceStore;
  /** Whether this build can dial WebRTC at all, so a selector can say so beside the option. */
  readonly webrtcAvailable: boolean;
  /** The measured round trip of this machine's peer-to-peer path, or `undefined` when it has none. */
  readonly webrtcRttMs: (daemonId: DaemonId) => Promise<number | undefined>;
  /**
   * Whether the hosted tunnel service is set up, read once per document on first ask, never throwing.
   * Only ever a sentence: a tunnel the daemon published is dialled whatever this says.
   */
  readonly tunnelService: () => Promise<TunnelServiceState>;
  /**
   * EACH MACHINE'S TUNNEL SWITCH (§15): whether its tunnel is on, and the write that turns it on or off —
   * carried as carrier control, so it reaches a machine whose only allowed carrier is the tunnel itself.
   */
  readonly tunnelSwitch: TunnelSwitchStore;
  /**
   * HOW WELL EACH DAEMON IS REACHED, as one fact per daemon — and the loop that recovers it.
   *
   * Fed by the carrier router; read by every surface through `useConnectionHealth`. A lost carrier is
   * said ONCE, here, instead of by every panel that happened to be polling when it went.
   */
  readonly connectionHealth: ConnectionHealth;
  /** Every held session this browser lost, kept for Settings › Machine › Performance (`carrier-drops.ts`). */
  readonly carrierDrops: CarrierDropLog;
  /**
   * WHAT THIS BROWSER SPENT ITS TIME ON — every daemon request by route, the live streams it opened,
   * long tasks and render timings — for the Performance report beside the daemon's own. Optional only
   * so a suite's partial store need not build one; the store this module opens always has one.
   */
  readonly performance?: PerformanceRecorder;
  /**
   * The passkey prompt every daemon request shares: a refusal for want of a step-up raises it once,
   * and the request is sent again when the person has confirmed. Rendered by `StepUpDialog`.
   */
  readonly stepUp: StepUpGate;
  /**
   * The prompt a machine that wants a passkey on opening raises (`401 unlock_required`): the same
   * gate, its own two routes. Rendered by a second `StepUpDialog` with the presence copy.
   */
  readonly unlockGate: StepUpGate;
  readonly pair: (seed: PairingSeed, deviceName?: string) => Promise<DaemonConnection>;
  /**
   * Whether Ferretry's default relay is advertising itself right now.
   *
   * Bound to the SAME injected fetcher as pairing and push, for the same reason:
   * a suite or an offline shell that injects a fetcher must not get the real
   * network back for one read. Never throws — "could not find out" is a state.
   */
  readonly readDefaultRelay: () => Promise<HostedRelayFallback>;
  /** What this device last saw of each machine's sessions, drawn before the network answers. */
  readonly sessionCache: SessionCache;
  /** Where each page and chat was scrolled, for Back, Forward and a reload of this tab. */
  readonly scrollMemory: ScrollMemory;
}

export interface CreateAppStoreOptions {
  /** IndexedDB by default; `null` keeps the session cache in memory only. Injected by suites. */
  readonly sessionCacheBackend?: SessionCacheBackend | null;
  /** This tab's `sessionStorage` by default; `null` remembers no scroll position. Injected by suites. */
  readonly scrollMemoryStorage?: ScrollMemoryStorage | null;
  /**
   * Where the build put the speech worker and its runtime (bound in `src/main.tsx`), handed in
   * by `main.tsx` because only the bundler knows. Without it Parakeet reports itself unavailable.
   */
  readonly speechAssets?: ParakeetAssets | null;
  /** A ready-made on-device voice service. Injected by suites; built from `speechAssets` otherwise. */
  readonly voice?: ParakeetVoice;
  /** Provider keys this device holds. Injected by suites; this browser's IndexedDB otherwise. */
  readonly speedupKeys?: DeviceSpeedupKeys;
  /** The dictation debug ring. Injected by suites; a fresh one reading this browser's switch otherwise. */
  readonly dictationDebug?: DictationDebugLog;
  /** The transcription log. Injected by suites; this browser's IndexedDB otherwise. */
  readonly transcriptionLog?: TranscriptionLog;
  readonly repository?: DaemonConnectionRepository;
  readonly fetcher?: DaemonFetch;
  readonly connectClient?: ConnectDaemonClient;
  /** A deliberately content-free hint used only by the static landing page. */
  readonly landingMarkerStorage?: LandingMarkerStorage;
  /** WebCrypto by default: the session primitives, and the adapter that mints and wraps device keys. */
  readonly relayCrypto?: WebCryptoRelayCrypto;
  /** IndexedDB by default. Where this browser keeps the device key each pairing proved itself with. */
  readonly deviceKeys?: DeviceKeyStore;
  /** The browser WebSocket by default. Injected so no suite opens one. */
  readonly relayDial?: RelayDial;
  /** Carriers that need more than a URL to dial; none by default, so WebRTC is passed over, said. */
  readonly carrierDialers?: CarrierDialers;
  /**
   * The WebRTC dialer (`docs/relay-protocol.md` §16): this browser's own, built from `RTCPeerConnection`,
   * by default; `null` for none. Ignored when `carrierDialers` is given, which names its own.
   */
  readonly webrtc?: WebRtcDialer | null;
  /** This browser's `localStorage` by default. Injected so a suite decides each machine's preference. */
  readonly carrierPreferences?: CarrierPreferenceStore;
  /** `navigator.credentials` by default: where a passkey step-up is asked of the person. */
  readonly passkeyCredentials?: CredentialsPort;
  /** `location.origin` by default: this copy of the app, which a passkey belongs to. */
  readonly appOrigin?: string;
  /** The page's own attention signals by default. Injected so a suite decides who is present. */
  readonly presence?: Pick<PresenceTracker, 'present'>;
  /** The real clock, timers, `Math.random` and `navigator.onLine` by default. Injected by suites. */
  readonly connectionHealthEnvironment?: ConnectionHealthEnvironment;
  /** `online`, foreground and network-change events by default. Injected so a suite fires them. */
  readonly connectionSignals?: ConnectionSignalEnvironment;
  /** Where this document records what its daemon requests cost; a fresh recorder on the page clock by default. */
  readonly performance?: PerformanceRecorder;
  /** The browser's long-task reports by default; a suite hands in its own, or an unsupported one. */
  readonly longTasks?: LongTaskObserverPort;
}

/** How long one reconnect probe may wait for its answer before the attempt counts as failed. */
const CONNECTION_PROBE_TIMEOUT_MS = 15_000;

/** Builds the document-lifetime stores and registers every daemon cache together. */
export async function createAppStore(options: CreateAppStoreOptions = {}): Promise<AppStore> {
  const fetcher = options.fetcher ?? browserFetch;
  // Every DAEMON-BOUND call goes through the carrier router, and every one of them rides a session
  // the device key opened. The raw fetcher is left for the relay advertisement alone, which is not
  // bound to any daemon.
  //
  // PAIRING DOES NOT TRAVEL THE ROUTER EITHER, for the opposite reason: the router's sessions are
  // opened with a device key this exchange is what registers. `exchangePairing` dials its own sealed
  // pairing sessions — direct, then the discovered rendezvous — and a RE-pair through an existing
  // session would exchange a fresh code under the grant it is replacing.
  const readDefaultRelay = async (): Promise<HostedRelayFallback> =>
    // The directory origin is the build constant and nothing else: no literal, no
    // relative path, no guess. Unset ships no directory and answers without
    // dialling, which is what a local build or a fork honestly is.
    await readHostedRelayFallback({ directoryUrl: bundledRelayDirectory(), fetcher });

  /**
   * Discovery labels a published relay, and is the last resort for a daemon that publishes none.
   *
   * The address set is daemon-authored on pairing and `/v1/carriers`, and this read is never written
   * into it. It has two uses, both of them read-only: saying whether a published URL is Ferretry's
   * hosted service, and standing in as a dial-time fallback for a daemon too old to publish a set at
   * all — which would otherwise lose the hosted path it has always been reached over, with no
   * connection left that could teach it back. Read ONCE per document, so `relayUrl: null` withdraws
   * it on the next load rather than being remembered.
   */
  const hostedRelayUrl = readDefaultRelay().then(fallback =>
    fallback.kind === 'available' ? fallback.relayUrl : undefined,
  );

  /**
   * The hosted tunnel service's advertisement, from the SAME directory origin as the relay's (§15), read
   * once — and only when something asks: "Tunnel only" with no tunnel to dial, or a selector saying why.
   * An ordinary page load never pays for it.
   */
  let tunnelServiceRead: Promise<TunnelServiceState> | undefined;
  const tunnelService = async (): Promise<TunnelServiceState> => {
    tunnelServiceRead ??= readTunnelService({ directoryUrl: bundledRelayDirectory(), fetcher });
    return await tunnelServiceRead;
  };
  const carrierPreferences = options.carrierPreferences ?? new CarrierPreferenceStore();
  const webrtc = options.webrtc === undefined ? browserWebRtcDialer() : (options.webrtc ?? undefined);
  const carrierDialers = options.carrierDialers ?? (webrtc === undefined ? {} : { webrtc: webrtc.dial });

  // One adapter for the document, shared by the carrier router and by a redemption that has to fall
  // back to a rendezvous. A second instance would be harmless and is still worth not having: it is
  // the same WebCrypto either way, and one value is one thing a suite has to replace.
  const relayCrypto = options.relayCrypto ?? new WebCryptoRelayCrypto();
  const deviceKeys = options.deviceKeys ?? new IndexedDbDeviceKeyStore();
  // One tracker per document: whether a person is at this device, so only their requests keep it
  // from idling out on the daemon.
  const presence = options.presence ?? new PresenceTracker(browserPresenceEnvironment());
  const appOrigin = options.appOrigin ?? globalThis.location?.origin ?? '';
  const stepUp = new StepUpGate({
    // The pool is built below and read only when a person presses the prompt's button.
    ceremony: stepUpCeremony({
      client: async daemon => await clients.client(daemon),
      credentials: options.passkeyCredentials ?? browserCredentials(),
      origin: appOrigin,
    }),
    describe: describeStepUpFailure(appOrigin),
  });
  const unlockGate = new StepUpGate({
    ceremony: unlockCeremony({
      client: async daemon => await clients.client(daemon),
      credentials: options.passkeyCredentials ?? browserCredentials(),
      origin: appOrigin,
    }),
    describe: describeStepUpFailure(appOrigin),
    // A device with no passkey, inside its window, is offered to set one up rather than sent elsewhere.
    firstPasskey: firstPasskeyOffer(async daemon => await clients.client(daemon)),
    // The machine's own number, read once as the prompt opens (an exempt route, so it answers before an unlock).
    scope: async daemon => {
      try {
        const view = await fetchSecuritySettings(await clients.client(daemon));
        return unlockStaysSentence(view.settings.unlockValidityHours);
      } catch {
        return UNLOCK_STAYS_FALLBACK;
      }
    },
  });
  /**
   * Each reconnect attempt is a REAL read through the router — the same `/v1/carriers` read a fresh
   * connection makes — so "recovered" always means a request was answered. Its outcome reaches the
   * health model the way every request's does; nothing here reads it.
   */
  const connectionHealth = new DaemonConnectionHealth(
    options.connectionHealthEnvironment ?? browserConnectionHealthEnvironment(),
    async daemonId => {
      const daemon = connections.list().find(record => record.daemonId === daemonId);
      if (daemon === undefined) return;
      // A DEADLINE, because the next attempt is scheduled only once this one settles: a probe that never
      // came back used to leave the machine "reconnecting" for good, with every read deferred behind it.
      const request = daemonRequest(daemon, '/v1/carriers', {
        cache: 'no-store',
        signal: AbortSignal.timeout(CONNECTION_PROBE_TIMEOUT_MS),
      });
      await carrier.probe(daemon, request.url, request.init);
    },
  );
  const carrierDrops = new CarrierDropLog(browserCarrierDropEnvironment());
  /**
   * The daemon's word on its own tunnel decides what this device keeps (§15): up at a hostname is kept,
   * off or unable to run is forgotten — the one answer that can tell a withdrawn tunnel from one that is
   * merely reconnecting. Its requests are carrier control, so they reach the router only when sent.
   */
  const tunnelSwitch = new TunnelSwitchStore({
    control: async (daemon, url, init) => await carrier.control(daemon, url, init),
    observed: (daemon, view) => {
      const tunnel = keptTunnel(view);
      if (tunnel !== undefined) connections.replaceTunnel(daemon, tunnel ?? undefined);
    },
  });
  const carrier = new DaemonCarrierRouter({
    network: fetcher,
    health: connectionHealth,
    drops: carrierDrops,
    presence: () => presence.present(),
    stepUp: async (daemon, act, origin) => await stepUp.require(daemon, act, origin),
    unlockRequired: async (daemon, origin) => await unlockGate.require(daemon, undefined, origin),
    crypto: relayCrypto,
    rotation: new KeyRotation({ store: deviceKeys, crypto: relayCrypto }),
    // Read per session, never cached: a key the person removed by clearing site data must stop
    // opening sessions the moment it is gone.
    deviceKey: async daemonId => {
      const key = await deviceKeys.load(daemonId);
      return key === undefined ? undefined : relayCrypto.deviceKeyHandle(key);
    },
    ...(options.relayDial === undefined ? {} : { dial: options.relayDial }),
    preference: daemonId => carrierPreferences.preference(daemonId),
    dialers: carrierDialers,
    tunnelService,
    // What a "Tunnel only" walk learned by asking the daemon over an introducer is kept exactly as an
    // ordinary refresh's answer is, so the next reload dials the tunnel it found without asking again.
    learned: (daemon, carriers) => {
      connections.replaceCarriers(daemon, carriers);
    },
    tunnelSwitchedOff: daemonId => {
      const state = tunnelSwitch.state(daemonId);
      return state.kind === 'known' && !state.view.enabled;
    },
    // The same one-per-load promise both other readers await; the router waits on it only after a
    // daemon's own carriers have all failed, so nothing on the ordinary path pays for the read.
    hostedRelay: async () => await hostedRelayUrl,
  });
  const performanceRecorder =
    options.performance ?? new PerformanceRecorder({ now: () => globalThis.performance.now() });
  /** Every daemon-bound request, recorded as it leaves (`performance/recording-fetch.ts`). */
  const carried = recordingFetch(carrier.fetch, performanceRecorder);
  // Document-lifetime, like the recorder: a browser that reports no long tasks is recorded as such.
  observeLongTasks(performanceRecorder, options.longTasks ?? browserLongTaskObserver());
  /**
   * The same carrier for the stores that read without the typed client, with an identical read still
   * in flight to the same daemon joined rather than sent twice (`shared-reads.ts`): several surfaces
   * read the usage feed, the projects and a session's board in the same instant. Scoped by the
   * daemon the request is bound to, because two paired machines may announce one address.
   */
  const sharedReads = sharingIdenticalReads(carried, init => boundDaemonId(init) ?? '');
  /**
   * THE TYPED CLIENT TRAVELS THE CARRIER TOO, and it did not used to.
   *
   * `daemonApiClient`'s default transport dials the daemon's own address directly,
   * so everything built on the typed client — the fleet list, a session read, and the
   * Settings REACHABILITY PROBE — took a path the carrier router knew nothing about.
   * The result was a screen showing a green "Reachable" pill beside a Carrier panel
   * saying no connection worked, and both were reporting honestly: they were asking
   * different questions over different code.
   *
   * Two answers to "can this browser reach that daemon" is one answer too many. There
   * is now one path, so a probe cannot pass on a carrier the product cannot use, and
   * a daemon that is only reachable through the relay is reported reachable rather
   * than reported down by a probe that never tried the relay.
   */
  /**
   * THE LIVE EVENT STREAM IS WIRED, AND IT WAS NOT BEFORE.
   *
   * `DaemonEventTransport` has been in this package, unit-tested, and constructed by nothing:
   * `daemonApiClient` never passed an `eventTransport`, so the typed client fell back to the
   * protocol package's own `WebSocketEventTransport`, which dials the daemon's address directly and
   * knows nothing about a carrier. On a relayed connection that is a socket opened at precisely the
   * address the relay exists because the browser cannot reach — a subscribed viewer receiving
   * nothing, forever, which is the failure this protocol spends §7 and §9 avoiding.
   *
   * It is handed the router's `openStream`, so every stream — direct or relayed — is a §14 stream
   * session the device key opened, on whichever carrier reaches the daemon at the moment it connects.
   */
  const clients = new DaemonApiPool(
    options.connectClient ??
      (async daemon =>
        await daemonApiClient(daemon, {
          transport: new DaemonHttpTransport(daemon, carried),
          eventTransport: new DaemonEventTransport(
            daemon,
            recordingStreams(async (paired, request) => await carrier.openStream(paired, request), performanceRecorder),
          ),
        })),
  );
  const sessionCache = new SessionCache(
    options.sessionCacheBackend === undefined ? browserSessionCacheBackend() : options.sessionCacheBackend,
  );
  const scrollMemory = new ScrollMemory(
    options.scrollMemoryStorage === undefined ? browserScrollMemoryStorage() : options.scrollMemoryStorage,
  );
  const fleetPort: DaemonFleetPort = {
    // Every good list read is kept for the next open, under the generation it was issued in: an answer
    // that lands after the machine was unpaired is not written back.
    list: async daemon => {
      const generation = sessionCache.generation(daemon.daemonId);
      const sessions = await (await clients.client(daemon)).list();
      sessionCache.saveSessions(daemon.daemonId, sessions, generation);
      return sessions;
    },
    get: async (daemon, sessionId) => await (await clients.client(daemon)).get(sessionId),
  };
  const fleet = new DaemonFleetStore(fleetPort);
  const controls = new DaemonControlsStore();
  const configChanges = new DaemonConfigChangeStore();
  const projects = new DaemonProjectsStore(daemonProjectsPort(sharedReads));
  const accountPicker = new DaemonAccountPickerStore({
    catalog: async daemon => await readAccountPickerCatalog(await clients.client(daemon)),
    health: async daemon => await readAccountPickerHealth(await clients.client(daemon)),
    checkHealth: async daemon => await checkAccountPickerHealth(await clients.client(daemon)),
  });
  // Attention is not part of the generated FyApiClient yet, but it still takes
  // the SAME carrier as every generated call. A direct-only second client would
  // make the action modal fail on precisely the remote phone it is for.
  const attention = new DaemonAttentionClient(undefined, sharedReads);
  const usage = new DaemonUsageStore(daemonUsagePort(sharedReads));
  const pins = new DaemonPinClient(undefined, carried);
  const browserLogin = new DaemonBrowserLoginStore(daemon => ({
    status: async () => await browserLoginPort(await clients.client(daemon)).status(),
    act: async action => await browserLoginPort(await clients.client(daemon)).act(action),
  }));
  const browserStorage = browserControlsStorage() ?? null;
  const stt = new SttSettingsStore(browserStorage);
  const speedupKeys =
    options.speedupKeys ??
    new DeviceSpeedupKeys(new IndexedDbSpeedupKeyRecords(globalThis.indexedDB), globalThis.crypto.subtle, fetcher);
  const dictationDebug = options.dictationDebug ?? new DictationDebugLog();
  const transcriptionLog =
    options.transcriptionLog ?? new TranscriptionLog(new IndexedDbTranscriptionLogRecords(globalThis.indexedDB));
  void transcriptionLog.hydrate();
  const voice =
    options.voice ?? browserParakeetVoice(globalThis as unknown as ParakeetGlobalLike, options.speechAssets ?? null);
  // Reads what is already installed; it never downloads.
  void voice.refresh();
  const workspaceLayouts = new WorkspaceLayoutStore();
  const notificationPreferences = new DaemonNotificationPreferences(browserStorage);
  const notificationFilter = new DeviceNotificationFilterStore(browserStorage, browserNotificationFilterMirror());
  const pushDevices = new DaemonPushDevices(browserStorage);
  const pushService = daemonPushService(carried);
  const connections = await DaemonConnectionStore.open({
    repository: options.repository ?? browserConnectionRepository(),
    // `documentDraftStore` is not built here — the composer needs it as a module default before any
    // context exists — but it is browser-persisted daemon state like every other entry, so it is
    // invalidated like every other entry. A store the registry cannot reach keeps serving an
    // unpaired daemon's records; `scripts/validate/daemon-scope.sh` now fails the commit that
    // leaves one out. The carrier router is in the list for the same reason: a live relay session
    // holds the credential that opened it, so it must not outlive the pairing.
    caches: [
      clients,
      fleet,
      controls,
      projects,
      accountPicker,
      attention,
      usage,
      pins,
      browserLogin,
      notificationPreferences,
      pushDevices,
      documentDraftStore,
      workspaceLayouts,
      carrier,
      connectionHealth,
      carrierDrops,
      sessionCache,
    ],
    // The key goes with the pairing it proved, and only when the pairing goes for good — a re-pair in
    // place has already saved the new key under the same daemon id.
    forget: daemonId => void deviceKeys.remove(daemonId).catch(() => undefined),
  });
  // The router must never hold its own copy of who is paired: a second copy is how a
  // request keeps going to a daemon somebody has unpaired. It routes by the daemon a request was
  // built for, never by address: two machines paired over the relay share one loopback origin.
  carrier.resolvePaired(() => connections.list());
  // Every paired machine's last list, drawn while its first live read is still on the way.
  for (const daemon of connections.list()) void seedFleetFromCache(fleet, sessionCache, daemon);
  const landingMarkerStorage = options.landingMarkerStorage ?? browserLandingMarkerStorage();
  const syncLandingPage = (): void =>
    syncLandingMarker(landingMarkerStorage, connections.getSnapshot().connections.length);
  syncLandingPage();
  // The document-lifetime store owns this document-lifetime convenience. Every
  // add, eviction, and explicit unpair now keeps the marker honest.
  connections.subscribe(syncLandingPage);

  /** The daemon is authoritative; after a carrier first answers, replace the cache. */
  // Back online, back in the foreground, a new network: retry every outage now, and prove every held
  // session is still alive rather than waiting for its next ping. Document-lifetime, like the store.
  watchConnectionSignals(options.connectionSignals ?? browserConnectionSignals(), {
    reconnecting: () => connectionHealth.reconnecting(),
    retryNow: daemonId => connectionHealth.retryNow(daemonId),
    checkLiveness: () => carrier.checkLiveness(),
    // A path found on the network this device just left is not worth trusting: every peer-to-peer
    // connection is dropped, its sessions redial, and the next WebRTC attempt negotiates on this one.
    networkChanged: () => webrtc?.networkChanged(),
  });

  /**
   * A NEW PREFERENCE IS A NEW WALK, AT ONCE. The router forgets the machine's winner and closes what it
   * held, and the same `/v1/carriers` read a reconnect makes walks the new preference straight away, so
   * Connection status names the new carrier — or says why there is none — without waiting for the next
   * request. Its outcome reaches the health model like every probe's.
   */
  carrierPreferences.subscribe(daemonId => {
    carrier.rewalk(daemonId);
    const daemon = connections.list().find(record => record.daemonId === daemonId);
    if (daemon === undefined) return;
    const request = daemonRequest(daemon, '/v1/carriers', {
      cache: 'no-store',
      signal: AbortSignal.timeout(CONNECTION_PROBE_TIMEOUT_MS),
    });
    void carrier.probe(daemon, request.url, request.init).catch(() => undefined);
  });

  carrier.onConnected(daemon => {
    void (async () => {
      const request = daemonRequest(daemon, '/v1/carriers', { cache: 'no-store' });
      const response = await carried(request.url, request.init);
      if (!response.ok) return;
      const view = DaemonCarriersViewSchema.safeParse(await response.json().catch(() => undefined));
      if (!view.success) return;
      const published = publishedConnectionMethods(view.data.carriers, await hostedRelayUrl);
      const record = connections.replaceCarriers(daemon, published);
      // A tunnel kept through a set that no longer names one is checked with the daemon, which knows
      // whether it was switched off or is only reconnecting.
      if (
        !published.some(method => method.kind === 'tunnel') &&
        record?.carriers.some(method => method.kind === 'tunnel') === true
      )
        await tunnelSwitch.refresh(daemon);
    })().catch(() => undefined);
  });

  return {
    performance: performanceRecorder,
    carrier,
    carrierPreferences,
    webrtcAvailable: carrierDialers.webrtc !== undefined,
    webrtcRttMs: async daemonId => await webrtc?.rttMs(daemonId),
    tunnelService,
    tunnelSwitch,
    connectionHealth,
    carrierDrops,
    stepUp,
    unlockGate,
    connections,
    clients,
    fleet,
    controls,
    projects,
    accountPicker,
    configChanges,
    attention,
    usage,
    pins,
    browserLogin,
    stt,
    voice,
    speedupKeys,
    dictationDebug,
    transcriptionLog,
    workspaceLayouts,
    notificationPreferences,
    notificationFilter,
    pushDevices,
    pushService,
    readDefaultRelay,
    sessionCache,
    scrollMemory,
    pair: async (seed, deviceName) => {
      const connection = await exchangePairing(seed, {
        ...(deviceName === undefined ? {} : { deviceName }),
        deviceKeys,
        relayCrypto,
        ...(options.relayDial === undefined ? {} : { relayDial: options.relayDial }),
        ...((await hostedRelayUrl) === undefined ? {} : { hostedRelayUrl: await hostedRelayUrl }),
        network: fetcher,
      });
      connections.add(connection);
      return connection;
    },
  };
}

const StoreContext = createContext<AppStore | null>(null);

export interface StoreProviderProps {
  readonly children: ReactNode;
  readonly store?: AppStore;
  readonly createStore?: () => Promise<AppStore>;
}

interface StoreAttempt {
  readonly attempt: number;
  readonly opening: Promise<AppStore>;
}

const openingSentence = (attempt: number): string =>
  attempt === 0 ? 'Opening Ferretry…' : 'Retrying: opening Ferretry…';

/**
 * Opens browser persistence once, including under React StrictMode's effect
 * replay, and keeps a rejected open recoverable.
 *
 * The in-flight promise is cached per ATTEMPT: StrictMode's second effect run
 * reuses the open already running, while the reader's retry is a genuinely new
 * one. A rejected attempt is dropped as it rejects, so no later run can be
 * answered by a failure that has already been reported.
 *
 * Until the store opens, one lifecycle surface stays mounted across every
 * attempt rather than being swapped for a different tree per state. Swapping
 * trees moves a screen reader's live regions in and out of the document — a
 * region added in the same commit as its text is unreliably announced — and
 * destroys the retry control the reader just pressed, so the retry drops focus
 * to the body. Here the status region and the alert region are the same two
 * nodes from the first paint until the store is open, and the retry control is
 * the same node from the first failure onward.
 *
 * THE RETRY CONTROL DOES NOT EXIST BEFORE THE FIRST FAILURE. Keeping it
 * mounted is worth a permanent node only because it preserves the control a
 * reader just pressed, and while nothing has failed there is nothing to
 * preserve. Offering "Try again" during an ordinary open would claim a failure
 * that has not happened, and would cost a reader a tab stop announced as
 * unavailable on every boot.
 *
 * The status region owns the progress sentence and falls silent on failure;
 * the alert region owns the failure sentence. They never both speak, because
 * two live regions carrying the same sentence announce it twice.
 *
 * A RECOVERED BOOT HANDS THE READER OVER. Opening the store replaces this
 * whole surface, including the retry control the reader is standing on, so
 * focus would otherwise fall to the body with nothing said — the same silent
 * drop the persistent control exists to prevent. A reader who has seen a
 * failure therefore gets one focused status line on the successful open. It is
 * FOCUS that makes the sentence reliably read: the region is inserted in the
 * same commit as its text, which is exactly the case a live region announces
 * unreliably. An open that never failed says nothing and moves nothing — the
 * browser has already placed focus and there is no failure to close out.
 *
 * A failed open is reported, never smoothed over: no empty store is published
 * in its place, so no consumer can mistake damaged local state for an
 * unpaired one.
 */
export function StoreProvider({ children, store, createStore = createAppStore }: StoreProviderProps) {
  const pending = useRef<StoreAttempt | null>(null);
  const [resolved, setResolved] = useState<AppStore | null>(store ?? null);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const openedAnnouncer = useRef<HTMLParagraphElement>(null);
  const handedOver = useRef(false);

  useEffect(() => {
    if (store !== undefined) {
      setResolved(store);
      setFailure(null);
      return;
    }
    let entry = pending.current;
    if (entry === null || entry.attempt !== attempt) {
      entry = { attempt, opening: createStore() };
      pending.current = entry;
    }
    const started = entry;
    let current = true;
    void started.opening.then(
      value => {
        if (current) setResolved(value);
      },
      reason => {
        if (pending.current === started) pending.current = null;
        if (current) setFailure(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [attempt, createStore, store]);

  // The handover is latched rather than keyed on a render, because a mount
  // effect runs twice under StrictMode and a reader may only be moved once.
  useEffect(() => {
    if (resolved === null || attempt === 0 || handedOver.current) return;
    handedOver.current = true;
    openedAnnouncer.current?.focus();
  }, [attempt, resolved]);

  if (resolved !== null)
    return (
      <StoreContext.Provider value={resolved}>
        {attempt === 0 ? null : (
          // `tabIndex={-1}` takes the focus this surface is about to destroy
          // without adding a tab stop of its own, and `sr-only` keeps a
          // sentence that is only about the boot out of the visual design.
          <p
            ref={openedAnnouncer}
            tabIndex={-1}
            className="sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            Ferretry is open.
          </p>
        )}
        {children}
      </StoreContext.Provider>
    );

  const opening = failure === null;
  // A press is what the control has to survive, so it appears with the first
  // failure and stays for every attempt after it.
  const failedBefore = attempt > 0 || failure !== null;
  return (
    <div>
      <p role="status" aria-live="polite" aria-atomic="true">
        {opening ? openingSentence(attempt) : ''}
      </p>
      <p role="alert" aria-atomic="true">
        {opening ? '' : `Could not open local PWA state: ${failure}`}
      </p>
      {/*
        `aria-disabled` rather than `disabled`: a disabled control leaves the
        focus order, so the browser blurs it the moment the retry starts —
        exactly the focus loss a persistent control exists to prevent. The
        handler enforces the same refusal the attribute announces.
      */}
      {failedBefore ? (
        <button
          type="button"
          aria-disabled={opening}
          onClick={() => {
            if (opening) return;
            setFailure(null);
            setAttempt(count => count + 1);
          }}
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function useAppStore(): AppStore {
  const store = useContext(StoreContext);
  if (store === null) throw new Error('useAppStore must be rendered inside StoreProvider');
  return store;
}

/**
 * The typed client a screen reaches a daemon through: the store's own pool, so it rides the carrier
 * router and a session the device key opened.
 *
 * THE ONLY DEFAULT A SURFACE MAY USE. A client built on the plain network reaches no daemon at all — a
 * paired browser is answered only inside its own session — which is why `daemonApiClient` has no
 * default transport any more. Outside a provider there is no pool, and the answer is a refusal that
 * says so rather than a client pointed at nothing — unless a {@link DaemonClientProvider} names one.
 */
export function useDaemonClient(): (daemon: DaemonConnection) => Promise<FyApiClient> {
  const named = useContext(DaemonClientContext);
  const store = useContext(StoreContext);
  return useMemo(
    () =>
      named ??
      (store === null
        ? async () => {
            throw new Error('no daemon client exists outside the app store');
          }
        : async (daemon: DaemonConnection) => await store.clients.client(daemon)),
    [named, store],
  );
}

type DaemonClientFactory = (daemon: DaemonConnection) => Promise<FyApiClient>;

const DaemonClientContext = createContext<DaemonClientFactory | null>(null);

/**
 * Names the typed client for every screen below it, in place of the app store's pool.
 *
 * For a surface rendered WITHOUT an app store — the design harness, which answers a daemon inside the
 * page. The app never mounts one: inside it, the store's pool is the only client there is.
 */
export function DaemonClientProvider({
  client,
  children,
}: {
  readonly client: DaemonClientFactory;
  readonly children: ReactNode;
}) {
  return <DaemonClientContext.Provider value={client}>{children}</DaemonClientContext.Provider>;
}

/**
 * The app's ONE passkey prompt, as a function a screen can call BEFORE a press (`store.stepUp.require`).
 *
 * Outside a provider there is no prompt and the answer is `undefined`, so a screen rendered on its own
 * offers no step-up control rather than one that can never be answered. It is the same gate the carrier
 * asks on a refused request, so there is still exactly one prompt component.
 */
export function useStepUpRequest(): ((daemon: DaemonConnection, act?: string) => Promise<boolean>) | undefined {
  const store = useContext(StoreContext);
  return useMemo(
    () =>
      store === null
        ? undefined
        : async (daemon: DaemonConnection, act?: string) => await store.stepUp.require(daemon, act),
    [store],
  );
}

/** No machine's configuration ever moves outside a store, so a screen reads once, as it always did. */
const NO_CONFIG_CHANGES = new DaemonConfigChangeStore();

/**
 * How many times any of these kinds of configuration has moved on this machine — the number a screen
 * that shows configuration puts in its read's dependencies, so it reads again the moment the machine's
 * configuration moves, from anywhere (docs/config-files.md "Live changes"). Outside a provider (a
 * component rendered on its own by a suite) it never moves.
 */
export function useConfigChangeCounter(daemonId: DaemonId, kinds: readonly ConfigChangeKind[]): number {
  const store = useContext(StoreContext)?.configChanges ?? NO_CONFIG_CHANGES;
  const key = kinds.join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the kinds' spelling is the deliberate key
  const read = useCallback(() => store.counter(daemonId, kinds), [store, daemonId, key]);
  return useSyncExternalStore(
    useCallback(listener => store.subscribe(listener), [store]),
    read,
    read,
  );
}

/**
 * Run `reread` whenever any of these kinds of this machine's configuration moves after the screen
 * mounted — never on mount itself, which is the screen's own first read. The latest `reread` is
 * called, so a caller need not memoise it.
 */
export function useConfigChangeEffect(
  daemonId: DaemonId,
  kinds: readonly ConfigChangeKind[],
  reread: () => void,
): void {
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

/**
 * The machines whose background reads are waiting on an unlock: each one waits for its machine to come on
 * screen rather than prompting over another's page, and the machine list shows it as locked.
 */
export function useLockedMachines(gate: StepUpGate): readonly DaemonId[] {
  return useSyncExternalStore(
    listener => gate.subscribe(listener),
    () => gate.waitingDaemons(),
    () => gate.waitingDaemons(),
  );
}

/**
 * The fetch a screen reads a daemon through: the carrier router, so a daemon only the relay can reach
 * is reached through the relay.
 *
 * Screens that built their own request and called the network directly worked on the LAN and failed
 * on precisely the phone that needed the relay. This is the one way a component gets a daemon fetch.
 * Outside a provider — a component rendered on its own by a test — there is no router to route
 * through, and the answer is the plain network.
 */
/** This device's provider keys, or `null` outside a store (a component rendered on its own). */
export function useSpeedupKeys(): DeviceSpeedupKeys | null {
  return useContext(StoreContext)?.speedupKeys ?? null;
}

/** The dictation debug switch and ring, or `null` outside a store. */
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

/** This device's transcription log, or `null` outside a store. */
export function useTranscriptionLog(): TranscriptionLog | null {
  return useContext(StoreContext)?.transcriptionLog ?? null;
}

const NO_LOG: TranscriptionLogSnapshot = Object.freeze({ enabled: false, entries: [], saved: false });
const noLogSnapshot = (): TranscriptionLogSnapshot => NO_LOG;

/** What the transcription log holds right now; off and empty outside a store. */
export function useTranscriptionLogSnapshot(): TranscriptionLogSnapshot {
  const log = useTranscriptionLog();
  return useSyncExternalStore(log?.subscribe ?? noSubscription, log?.snapshot ?? noLogSnapshot);
}

/**
 * This device's Parakeet service, or `null` outside a store (a static render, a component suite).
 * Dictation and Settings read it from here so the composer never has to carry it.
 */
export function useParakeetVoice(): ParakeetVoice | null {
  return useContext(StoreContext)?.voice ?? null;
}

export function useDaemonFetch(): DaemonFetch {
  const store = useContext(StoreContext);
  // ONE identity per store, read through at call time. Effects list this fetch as a dependency, so a
  // carrier whose `fetch` member is re-read as a fresh function (a wrapped router hands out a new
  // bound one per read) would otherwise restart every read on every render, forever.
  return useMemo<DaemonFetch>(() => {
    if (store === null) return browserFetch;
    const send: DaemonFetch = async (input, init) => await store.carrier.fetch(input, init);
    return store.performance === undefined ? send : recordingFetch(send, store.performance);
  }, [store]);
}

/**
 * Opens one §14 stream session through the carrier router — direct first, then each rendezvous.
 *
 * One identity per store, for the reason `useDaemonFetch` gives. Outside a store there is no router
 * and no device key to open a stream with, so the opener refuses rather than reaching for the network.
 */
export function useDaemonStreamOpener(): DaemonStreamOpener {
  const store = useContext(StoreContext);
  return useMemo<DaemonStreamOpener>(
    () =>
      store === null
        ? async () => {
            throw new Error('no paired carrier is available to open this stream');
          }
        : recordingStreams(
            async (daemon, request) => await store.carrier.openStream(daemon, request),
            store.performance,
          ),
    [store],
  );
}

/**
 * Reads the pairing registry, resubscribing only when the store itself changes.
 *
 * The callbacks are memoised against the current connection store: a fresh
 * `subscribe` identity makes `useSyncExternalStore` tear the subscription down
 * and build it again on every render of every consumer, which is pure churn
 * while the store is the same object — and still correct re-subscription when
 * the provider publishes a different one.
 */
export function useConnectionSnapshot(): DaemonConnectionsSnapshot {
  const { connections } = useAppStore();
  const subscribe = useCallback((listener: () => void) => connections.subscribe(listener), [connections]);
  const getSnapshot = useCallback(() => connections.getSnapshot(), [connections]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
