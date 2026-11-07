import { nativeCrypto, nativeFetch, nativeSetTimeout, NativeWebSocket } from './native-socket.ts';
import type { StartedDaemon } from '../../../../../scripts/test/two-release/daemon.ts';
import type { Release } from '../../../../../scripts/test/two-release/releases.ts';
import type { DaemonTransport } from '../../../src/client/transport.ts';
import { connector, type DirectDial, pairOverDirect } from '../../../src/connect/connector.ts';
import type { DeviceClaims } from '../../../src/connect/provides.ts';
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

/** Pairs a device with `grants` on `daemon`, and opens a shell runtime over the registry of `app`. */
export async function openApp(
  daemon: StartedDaemon,
  app: Pick<Release, 'surfaces' | 'appVersion'>,
  options: { readonly grants: 'full' | 'limited' },
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
  // Status only: the body is a live credential.
  if (!mint.ok) throw new Error(`minting a pairing code answered HTTP ${mint.status}`);
  const code = ((await mint.json()) as { code: string }).code;

  const daemonId = daemon.host.identity.daemonId;
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
  const connect = connector({ crypto, claims, carriers: [], direct });

  const storage = memoryStore();
  const daemons = new DaemonList({ storage, now: () => 1 });
  daemons.add({ daemon: daemonId, machine: 'fixture', deviceId, address: daemon.url });

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
    },
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
