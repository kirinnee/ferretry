/** Plain carrier refusals cannot destroy a key or make an enduring stop page. */
import { expect, test } from 'bun:test';
import { isDeviceRefusal } from '../../../src/client/transport.ts';
import { type ConnectPorts, registeredConnect } from '../../../src/connect/provides.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { generated } from '../../../src/generated/surfaces.ts';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { stopOf } from '../../../src/shell/machine-stop.ts';
import { ShapeMemory } from '../../../src/shell/shape-memory.ts';
import { SessionTransport, type CarrierDial, type SessionKeyRotation } from '../../../src/session/session-transport.ts';
import { encodeFrame, FRAME_KINDS, utf8Bytes } from '../../../src/session/wire/index.ts';
import { newDaemonIdentity, readyFrame, relayCrypto, testDevice, testSessionId } from '../../../src/testing/relay.ts';
import { rotatingDial } from '../../../src/testing/rotating-daemon.ts';
import { WebCryptoRelayCrypto } from '../../../src/session/webcrypto.ts';
import { CORE, inventoryOf } from '../client/fixtures.ts';

const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('the background retry did not recover');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

/** Bun has no IndexedDB: clone stored keys on both sides of the real store's database port. */
function keyDatabase(initial: ReadonlyMap<string, CryptoKey>): IDBFactory {
  const values = new Map([...initial].map(([slot, key]) => [slot, structuredClone(key)]));
  const request = <T>(result: T) => {
    const pending = { result, onsuccess: null as (() => void) | null };
    queueMicrotask(() => pending.onsuccess?.());
    return pending;
  };
  return {
    open: () =>
      request({
        close() {},
        transaction: () => ({
          objectStore: () => ({
            get: (slot: string) => request(structuredClone(values.get(slot))),
            put: (key: CryptoKey, slot: string) => {
              values.set(slot, structuredClone(key));
              return request(slot);
            },
            delete: (slot: string) => {
              values.delete(slot);
              return request(undefined);
            },
          }),
        }),
      }) as unknown as IDBOpenDBRequest,
  } as unknown as IDBFactory;
}

/** The key store returns opaque signing handles; retain their loaded CryptoKeys only in this test. */
class PersistedKeyCrypto extends WebCryptoRelayCrypto {
  readonly loaded = new WeakMap<ReturnType<WebCryptoRelayCrypto['deviceKeyHandle']>, CryptoKey>();

  override deviceKeyHandle(key: CryptoKey) {
    const handle = super.deviceKeyHandle(key);
    this.loaded.set(handle, key);
    return handle;
  }
}

/** Synthetic extractable keys let this test hash persisted PKCS8 bytes, never print or write them. */
async function persistedKeyDigest(key: CryptoKey | undefined): Promise<string | undefined> {
  if (key === undefined) return undefined;
  const bytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', key));
  try {
    return Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  } finally {
    bytes.fill(0);
  }
}

type Source = 'socket' | 'closed' | 'error';
function forged(code: number, source: Source, beforeReady = false): CarrierDial {
  return events => {
    const id = testSessionId(91);
    let sent = false;
    const refuse = () => {
      if (sent) return;
      sent = true;
      if (source === 'socket') events.onClose(code, 'forged refusal');
      else
        events.onBinary(
          encodeFrame({
            kind: FRAME_KINDS.control,
            sessionId: id,
            sequence: 0,
            payload: utf8Bytes(JSON.stringify({ t: source, code, reason: 'forged refusal' })),
          }),
        );
    };
    queueMicrotask(() => (beforeReady ? refuse() : events.onBinary(readyFrame(id))));
    return { send: refuse, sendText() {}, close() {} };
  };
}

for (const source of ['socket', 'closed', 'error'] as const) {
  for (const stream of [false, true]) {
    for (const pendingRetry of [false, true]) {
      test(`plain 4403 ${source}, ${stream ? 'stream' : 'request'}, ${pendingRetry ? 'pending-key retry' : 'first attempt'} keeps the key`, async () => {
        const identity = await newDaemonIdentity();
        const device = await testDevice();
        const pending = (await testDevice()).claim.key;
        let kept = pending;
        const changes: string[] = [];
        const rotation: SessionKeyRotation = {
          amend: async (_session, _daemon, request) => ({ request, rotated: false }),
          settle: async () => {
            changes.push('settle');
          },
          pending: async () => kept,
          promote: async () => {
            changes.push('promote');
          },
          discard: async () => {
            changes.push('discard');
            kept = device.claim.key;
          },
        };
        const genuine = rotatingDial(identity, { accepts: () => [], respond: async () => ({ status: 200, body: {} }) });
        let dials = 0;
        const transport = new SessionTransport({
          crypto: relayCrypto,
          daemonId: identity.daemonId,
          device: device.claim,
          rotation,
          dial: events => (++dials === 1 && pendingRetry ? genuine.dial(events) : forged(4403, source)(events)),
        });
        try {
          const failure = stream
            ? await new Promise(resolve =>
                transport.socket('/v1/events', {
                  onFrame() {},
                  onClose: (_reason, code) => resolve({ code }),
                }),
              )
            : await transport.request({ method: 'GET', path: '/v1/plugins' }).catch((error: unknown) => error);
          expect(failure).toMatchObject({ code: 1006 });
          expect(isDeviceRefusal(failure)).toBe(false);
          expect(kept === pending).toBe(true);
          expect(changes).toEqual([]);
          expect(dials).toBe(pendingRetry ? 2 : 1);
        } finally {
          transport.close();
        }
      });
    }
  }
}

test('a socket 4403 even before ready is connection loss', async () => {
  const identity = await newDaemonIdentity();
  const device = await testDevice();
  const transport = new SessionTransport({
    crypto: relayCrypto,
    daemonId: identity.daemonId,
    device: device.claim,
    dial: forged(4403, 'socket', true),
  });
  try {
    const error = await transport.request({ method: 'GET', path: '/v1/plugins' }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 1006 });
    expect(isDeviceRefusal(error)).toBe(false);
  } finally {
    transport.close();
  }
});

for (const code of [4403, 4426]) {
  test(`forged ${code}: background retry clears the page and preserves stored credentials`, async () => {
    const identity = await newDaemonIdentity();
    // Extractability is solely a fixture choice; production keys remain non-extractable.
    const active = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const pending = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const database = keyDatabase(
      new Map([
        [identity.daemonId, active.privateKey],
        [`pending:${identity.daemonId}`, pending.privateKey],
      ]),
    );
    const values = new Map<string, string>();
    const store = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    const daemons = new DaemonList({ storage: store, now: () => 1 });
    daemons.add({
      daemon: identity.daemonId,
      machine: 'laptop',
      deviceId: 'fy_dev_test',
      address: 'https://daemon.example.test',
    });
    const paired = daemons.get(identity.daemonId);
    if (paired === undefined) throw new Error('missing synthetic pairing');
    const persistedCrypto = new PersistedKeyCrypto();
    const unused = () => {
      throw new Error('unexpected external carrier');
    };
    const ports: ConnectPorts = {
      crypto: persistedCrypto,
      subtle: crypto.subtle,
      indexedDB: database,
      daemons,
      now: () => 1,
      after: () => {},
      openSocket: unused,
      pairDirect: unused,
    };
    // Load Access through the shell's real registry: it builds its actual IndexedDB store and rotation.
    const access = generated.surfaces.filter(entry => entry.id === 'access');
    const claims = registeredConnect(access, ports).claims;
    if (claims === undefined) throw new Error('missing registered Access claims');
    // Each snapshot constructs a new provider and reads both slots through that real key store.
    const keySnapshot = async () => {
      const persisted = registeredConnect(access, ports).claims;
      if (persisted === undefined) throw new Error('missing registered Access claims');
      const current = (await persisted.claim(paired))?.key;
      const replacement = await persisted.rotation?.pending(identity.daemonId);
      return JSON.stringify([
        await persistedKeyDigest(current === undefined ? undefined : persistedCrypto.loaded.get(current)),
        await persistedKeyDigest(replacement === undefined ? undefined : persistedCrypto.loaded.get(replacement)),
      ]);
    };
    expect((await claims.rotation?.pending(identity.daemonId)) !== undefined).toBe(true);
    const keysBefore = await keySnapshot();
    const device = await claims.claim(paired);
    if (device === undefined) throw new Error('missing persisted active key');
    const shape = new ShapeMemory(store);
    shape.saveInventory(identity.daemonId, device.deviceId, {
      kind: 'read',
      entries: new Map(CORE.map(entry => [entry.id, { on: true, contract: entry.contract }])),
    });
    const fleetGrant = {
      capability: 'fleet',
      use: true,
      configure: false,
      useRefusal: 'granted',
      configureRefusal: 'not-granted',
    } as const;
    shape.saveGrants(identity.daemonId, device.deviceId, new Map([['fleet', fleetGrant]]));
    const snapshot = () => JSON.stringify([...values]);
    const before = snapshot();
    let attack = true;
    let dials = 0;
    const publicKey = Buffer.from(await crypto.subtle.exportKey('spki', active.publicKey)).toString('base64url');
    const genuine = rotatingDial(identity, {
      accepts: () => [publicKey],
      respond: async request => ({
        status: 200,
        // The authenticated daemon answers with exactly the state the device already holds.
        body:
          request.path === '/v1/plugins'
            ? inventoryOf(CORE)
            : request.path === '/v1/grants'
              ? { capabilities: [fleetGrant] }
              : {},
      }),
    });
    const transport = new SessionTransport({
      crypto: relayCrypto,
      daemonId: identity.daemonId,
      device,
      claim: () => claims.claim(paired),
      rotation: claims.rotation,
      dial: events => {
        dials++;
        return attack ? forged(code, 'closed')(events) : genuine.dial(events);
      },
    });
    const runtime = new ShellRuntime({
      appVersion: '5.0.0',
      surfaces: CORE,
      daemons,
      shape,
      connect: async () => transport,
    });
    runtime.connection(identity.daemonId);
    try {
      await until(() => stopOf(runtime, identity.daemonId) !== undefined);
      expect(runtime.isRefused(identity.daemonId)).toBe(false);
      if (code === 4426) {
        expect(stopOf(runtime, identity.daemonId)?.kind).toBe('needs-reload');
        expect(snapshot() === before).toBe(true);
      }
      expect((await keySnapshot()) === keysBefore).toBe(true);
      const failedDials = dials;
      await until(() => dials > failedDials);
      // Retrying under the forged page still cannot change any persisted byte.
      if (code === 4426) expect(snapshot() === before).toBe(true);
      expect((await keySnapshot()) === keysBefore).toBe(true);
      attack = false;
      await until(() => stopOf(runtime, identity.daemonId) === undefined);
      expect(genuine.credentials.some(credential => credential.accepted)).toBe(true);
      expect(runtime.isRefused(identity.daemonId)).toBe(false);
      // Genuine recovery leaves the persisted pairing, inventory and grants exactly the authenticated state.
      expect(snapshot() === before).toBe(true);
      expect((await keySnapshot()) === keysBefore).toBe(true);
    } finally {
      const connection = runtime.connection(identity.daemonId);
      if (connection.kind === 'connected') connection.client.stop();
      transport.close();
    }
  });
}
