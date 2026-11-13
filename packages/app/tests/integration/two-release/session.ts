import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeCrypto, nativeFetch, NativeResponse, nativeSetTimeout, NativeWebSocket } from './native-socket.ts';
import type { StartedDaemon } from '../../../../../scripts/test/two-release/daemon.ts';
import type { Release } from '../../../../../scripts/test/two-release/releases.ts';
import type { DaemonTransport } from '../../../src/client/transport.ts';
import { connector, type DirectDial, pairOverDirect } from '../../../src/connect/connector.ts';
import {
  type ConnectPorts,
  type DeviceClaims,
  registeredBackgroundViews,
  registeredConnect,
  registeredDevicePanels,
} from '../../../src/connect/provides.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { directDial, type SocketLike } from '../../../src/session/direct-dial.ts';
import { WebCryptoRelayCrypto } from '../../../src/session/webcrypto.ts';
import { toBase64Url } from '../../../src/session/wire/index.ts';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { type KeyValueStore, memoryStore } from '../../../src/storage/records.ts';
import { RecordingTransport } from './recording-transport.ts';

/**
 * A real paired device and the real app shell over it (redesign §10.5, §9.6).
 *
 * 1. The owner mints a pairing code over loopback HTTP with the host's admin token (the code is never logged, never
 *    asserted on as text).
 * 2. The app's own `pairOverDirect` redeems it over the REAL direct carrier: a WebSocket to the daemon's own listener,
 *    a sealed session, the daemon proved against its fingerprint, the device key registered.
 * 3. The app's own `connector` builds the sealed-session transport that device proves each session with; a recording
 *    decorator sits between it and the generated per-daemon client; `ShellRuntime` runs over that.
 *
 * Nothing here is faked on the app side or the daemon side. A failure in this file is a real bug in the app session
 * against a real listener (the first end-to-end proof of it on 5.0), not a fixture bug.
 */

export interface AppSession {
  readonly runtime: ShellRuntime;
  readonly daemons: DaemonList;
  readonly storage: KeyValueStore;
  /** The daemon's id: the key the runtime holds it under. */
  readonly daemonId: string;
  /** The transport the runtime's client talks through; throws before the runtime has connected. */
  recording(): RecordingTransport;
  /** Reads the connection to the daemon once its first inventory answer is in. */
  ready(): Promise<void>;
  /** Drops the pairing (stopping the client) and closes the sealed session, so nothing outlives the test. */
  close(): void;
  /** With {@link ProductionCarrier}: every socket URL the registered Connections router dialled, in order. */
  readonly dialled: readonly string[];
  /** With {@link ProductionCarrier}: whether the relay stand-in answers. Takes effect on the next session. */
  setRelayUp(up: boolean): void;
  /** With {@link ProductionCarrier}: opens one more session through the registered carrier and asks the daemon a read. */
  probe(): Promise<void>;
  /** With {@link ProductionCarrier}: the line the registered Connections background view draws for this daemon. */
  relayFallbackLine(): string | undefined;
  /** With {@link ProductionCarrier}: the device-settings panels the registered halves draw (no machine needed). */
  deviceSettingsPanels(): readonly string[];
}

/**
 * THE REGISTERED PRODUCTION CARRIER (not `carriers: []`): the shell's own `registeredConnect` over the REAL generated
 * registry builds Connections' router exactly as `main.tsx` does, with its real default preference. Only the network is
 * the fixture's: the hosted relay directory's answer, and what a relay socket reaches.
 */
/**
 * The browser-storage key Connections keeps its per-machine preference under. Another package is reached only through its
 * contract, so the key is spelled here; if it drifts, the chosen-Relay case stops being strict and its test fails.
 */
const CARRIER_PREFERENCE_KEY = 'fy-carrier-preference-v1';

export interface ProductionCarrier {
  /**
   * The relay the hosted directory advertises: none (`undefined`), or one at a loopback address that answers only while
   * {@link AppSession.setRelayUp} says so. When it answers it is the daemon's own listener, which speaks the same session
   * route a rendezvous does; when not, nothing listens there.
   */
  readonly relay?: { readonly up: boolean };
  /** The person chose "Relay only" for this machine (saved in the browser's storage, as Connections saves it). */
  readonly chosenRelayOnly?: boolean;
  /** The pairing crossed a relay, so the link's address is not one this device paired over. */
  readonly pairedViaRelay?: boolean;
}

const poll = async <T>(read: () => T | undefined, what: string, ms = 30_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`waited ${ms} ms for ${what}`);
    await new Promise<void>(resolve => nativeSetTimeout(resolve, 10));
  }
};

/**
 * The owner at the machine turns the confirmation on opening off, with Gate's own `PATCH /v1/security` and the admin
 * token over loopback: exactly what `fy daemon security set unlockOnOpen false` does. A change at the machine is applied
 * at once (the kernel's config service loads the file before it answers), never held.
 *
 * WHY THE LEGS THAT READ EVENTS NEED IT: the kernel's event bus socket (`GET /v1/bus`) is not `unlockExempt`, and a
 * device off the host that has not unlocked with a passkey is served nothing but the unlock routes (401
 * `unlock_required`). A CI run has no hands for a passkey, so a leg that is not about the unlock has the owner turn it
 * off first. The fixture routes are `unlockExempt` instead (`workspace.ts`); the kernel's own bus is not a fixture.
 * A leg that proves `unlock_required` must NOT call this.
 */
export async function turnUnlockOffAtTheMachine(daemon: StartedDaemon): Promise<void> {
  const token = await daemon.adminToken();
  const response = await nativeFetch(`${daemon.url}/v1/security`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ unlockOnOpen: false }),
  });
  // The answer is the settings view (no credential); a refusal's body is its sentence and code.
  if (!response.ok)
    throw new Error(
      `turning unlockOnOpen off answered HTTP ${response.status}: ${(await response.text()).slice(0, 400)}\n${daemon.diagnose()}`,
    );
}

/** Pairs a device with `grants` on `daemon`, and opens a shell runtime over the registry of `app`. */
export async function openApp(
  daemon: StartedDaemon,
  app: Pick<Release, 'surfaces' | 'appVersion'>,
  options: { readonly grants: 'full' | 'limited'; readonly production?: ProductionCarrier },
): Promise<AppSession> {
  const crypto = new WebCryptoRelayCrypto(nativeCrypto.subtle);
  const direct: DirectDial = target =>
    directDial({
      address: target.address,
      daemonId: target.daemon,
      openSocket: url => new NativeWebSocket(url) as unknown as SocketLike,
      after: (delayMs, run) => {
        nativeSetTimeout(run, delayMs);
      },
    });

  const token = await daemon.adminToken();
  const mint = await nativeFetch(`${daemon.url}/v1/pair/code`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ grants: options.grants }),
  });
  // A refusal's body is its sentence and code (no credential); an answer's is the live code, never shown.
  if (!mint.ok)
    throw new Error(
      `minting a pairing code answered HTTP ${mint.status}: ${(await mint.text()).slice(0, 400)}\n${daemon.diagnose()}`,
    );
  const text = await mint.text();
  let code: unknown;
  let mintedDaemonId: unknown;
  try {
    const minted = JSON.parse(text) as { code?: unknown; daemonId?: unknown };
    code = minted.code;
    mintedDaemonId = minted.daemonId;
  } catch {
    code = undefined;
  }
  // The body is shown only when it holds no code (so it is no credential): its type and first bytes name what answered.
  if (typeof code !== 'string')
    throw new Error(
      `minting a pairing code answered HTTP ${mint.status} (${mint.headers.get('content-type')}) with no code: ${text.slice(0, 300)}\n${daemon.diagnose()}`,
    );

  const daemonId = daemon.host.identity.daemonId;
  // The QR carries the minted id; a session dialled with the kernel's id must be the same daemon (never print the code).
  if (mintedDaemonId !== daemonId)
    throw new Error(`the pairing code names daemon ${String(mintedDaemonId)} but the kernel answers as ${daemonId}`);
  const device = await crypto.generateDeviceKey();
  const handle = crypto.deviceKeyHandle(device.privateKey);
  const outcome = await pairOverDirect(
    crypto,
    direct,
  )({
    address: daemon.url,
    daemonId,
    code,
    key: {
      deviceName: 'two-release fixture',
      publicKey: toBase64Url(device.publicKeySpki),
      key: handle,
      save: async () => {},
    },
  });
  const deviceId = (outcome.response as { deviceId?: unknown }).deviceId;
  if (typeof deviceId !== 'string') throw new Error('the pairing answer named no device');

  const claims: DeviceClaims = {
    claim: async () => ({ deviceId, key: handle, appSession: toBase64Url(crypto.randomBytes(16)) }),
    pairingKey: async () => {
      throw new Error('the fixture device is already paired');
    },
    forget: async () => {},
  };
  const storage = memoryStore();
  const daemons = new DaemonList({ storage, now: () => 1 });
  daemons.add({
    daemon: daemonId,
    machine: 'fixture',
    deviceId,
    address: daemon.url,
    ...(options.production?.pairedViaRelay === true ? { pairedViaRelay: true as const } : {}),
  });

  const dialled: string[] = [];
  const relayState = { up: options.production?.relay?.up ?? false };
  const restore: Array<() => void> = [];
  let registered: ReturnType<typeof registeredConnect> | undefined;
  let connect = connector({ crypto, claims, carriers: [], direct });
  if (options.production !== undefined) {
    const production = options.production;
    const RELAY_URL = 'ws://127.0.0.1:9';
    const daemonOrigin = new URL(daemon.url);
    // A relay socket reaches the daemon's own listener while the stand-in is up, and nothing otherwise.
    const openSocket = (url: string): SocketLike => {
      dialled.push(url);
      const asked = new URL(url);
      const isRelay = asked.host === new URL(RELAY_URL).host;
      const target = isRelay && relayState.up ? `ws://${daemonOrigin.host}${asked.pathname}` : url;
      return new NativeWebSocket(target) as unknown as SocketLike;
    };
    const host = globalThis as { localStorage?: unknown; __FY_RELAY_DIRECTORY__?: string };
    const priorStorage = host.localStorage;
    const priorDirectory = host.__FY_RELAY_DIRECTORY__;
    restore.push(() => {
      host.localStorage = priorStorage;
      host.__FY_RELAY_DIRECTORY__ = priorDirectory;
    });
    // Connections reads its saved preference from the browser's storage when it is built, as it does in a page.
    const saved = new Map<string, string>(
      production.chosenRelayOnly === true ? [[CARRIER_PREFERENCE_KEY, JSON.stringify({ [daemonId]: 'relay' })]] : [],
    );
    host.localStorage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
    };
    host.__FY_RELAY_DIRECTORY__ = production.relay === undefined ? undefined : 'https://directory.example';
    const ports: ConnectPorts = {
      crypto,
      subtle: nativeCrypto.subtle,
      indexedDB: null,
      openSocket,
      after: (delayMs, run) => void nativeSetTimeout(run, delayMs),
      now: () => Date.now(),
      daemons,
      pairDirect: pairOverDirect(crypto, direct),
      ...(production.relay === undefined
        ? {}
        : {
            directory: async () =>
              new NativeResponse(JSON.stringify({ version: 1, relayUrl: RELAY_URL }), {
                headers: { 'content-type': 'application/json' },
              }),
          }),
    };
    registered = registeredConnect(app.surfaces as readonly SurfaceEntry[], ports);
    if (registered.carriers.length === 0)
      throw new Error(`the registered Connections carrier did not build: ${JSON.stringify(registered.failures)}`);
    connect = connector({ crypto, claims, carriers: registered.carriers, direct });
  }

  let latest: RecordingTransport | undefined;
  let opened: (DaemonTransport & { close?: () => void }) | undefined;
  const runtime = new ShellRuntime({
    appVersion: app.appVersion,
    surfaces: app.surfaces,
    daemons,
    connect: async paired => {
      const transport: DaemonTransport | undefined = await connect(paired);
      if (transport === undefined) return undefined;
      opened = transport;
      latest = new RecordingTransport(transport);
      return latest;
    },
  });

  return {
    runtime,
    daemons,
    storage,
    daemonId,
    close: () => {
      daemons.remove(daemonId);
      opened?.close?.();
      for (const undo of restore) undo();
    },
    dialled,
    setRelayUp: up => {
      relayState.up = up;
    },
    probe: async () => {
      const paired = daemons.get(daemonId);
      if (paired === undefined) throw new Error('the pairing is gone');
      const transport = await connect(paired);
      if (transport === undefined) throw new Error('no transport');
      try {
        await transport.request({ method: 'GET', path: '/v1/health' });
      } finally {
        (transport as { close?: () => void }).close?.();
      }
    },
    relayFallbackLine: () => {
      const view = registeredBackgroundViews(app.surfaces as readonly SurfaceEntry[]).find(
        entry => entry.plugin === 'connections' && entry.id === 'relay-fallback',
      );
      if (view === undefined) throw new Error('Connections registered no relay-fallback background view');
      const html = renderToStaticMarkup(createElement(view.view, { daemon: daemonId, client: {} as never }));
      const line = /data-relay-fallback="">([^<]*)</u.exec(html)?.[1];
      return line === undefined ? undefined : line.replaceAll('&#x27;', "'").replaceAll('&amp;', '&');
    },
    deviceSettingsPanels: () => [
      ...registeredDevicePanels(app.surfaces as readonly SurfaceEntry[], 'device.settings').keys(),
    ],
    recording: () => {
      if (latest === undefined) throw new Error('the runtime has not connected yet');
      return latest;
    },
    ready: async () => {
      // `connection` opens the session on the first ask; the client's bootstrap read then fills the inventory.
      await poll(() => {
        const connection = runtime.connection(daemonId);
        if (connection.kind === 'unreachable') throw new Error('the app could not open a session to the daemon');
        return connection.kind === 'connected' && connection.client.inventory !== undefined ? true : undefined;
      }, 'the app to read the daemon’s plugin inventory');
    },
  };
}
