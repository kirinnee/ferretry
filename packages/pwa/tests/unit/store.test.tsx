import { describe, expect, it } from 'bun:test';
import { OLDER_DAEMON_SENTENCE } from '@ferretry/protocol';
import type { FyApiClient } from '@ferretry/protocol/client';
import { RELAY_CLOSE_CODES } from '@ferretry/relay';
import { useState } from 'react';
import { HOSTED_RELAY_PATH } from '../../src/features/onboarding/hosted-relay.ts';
import type { ConnectionHealthEnvironment } from '../../src/lib/connection-health.ts';
import type { DaemonConnectionRepository, DaemonConnectionStore } from '../../src/lib/connections.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { UNSUPPORTED_DEVICE_KEY_SENTENCE } from '../../src/lib/device-keys.ts';
import { PairingUnreachableError } from '../../src/lib/pairing-unreachable.ts';
import { DaemonOutdatedError, type RelayHeartbeatSchedule } from '../../src/lib/relay-carrier.ts';
import { PairingOutcomeUnknownError } from '../../src/lib/relay-pairing.ts';
import { RelayPairingRefusedError } from '../../src/lib/relay-session.ts';
import {
  type AppStore,
  browserConnectionRepository,
  createAppStore,
  DaemonApiPool,
  DaemonClientProvider,
  exchangePairing,
  IndexedDbConnectionRepository,
  StoreProvider,
  useAppStore,
  useConnectionSnapshot,
  useDaemonClient,
} from '../../src/lib/store.tsx';
import { MemoryDeviceKeyStore } from '../support/device-keys.ts';
import { interact, mount, must } from '../support/dom.ts';
import {
  AutoCarrierPreferences,
  autoDial,
  dialByHost,
  keyedDaemon,
  newDaemonIdentity,
  olderDaemonDial,
  relayCrypto,
  ScriptedSocket,
  settle as settleTasks,
} from '../support/relay.ts';

/*
 * A connection model that never retries. The cases that count dials must own every dial: the model's
 * own reconnect probe (300 ms at the soonest) is a second, unrelated source that a slow runner reaches
 * mid-test.
 */
const idleConnectionHealth: ConnectionHealthEnvironment = {
  now: () => Date.now(),
  schedule: () => () => undefined,
  random: () => 0.5,
  isOnline: () => true,
};

const RELAY_DIRECTORY = 'https://directory.example.test';
const HOSTED_RELAY_URL = 'https://hosted-relay.example.test';

/**
 * The relay directory is a BUILD constant, replaced by `vite.config.ts` from
 * `FY_RELAY_DIRECTORY_ORIGIN`, so a case that needs one supplies it as a global for as long as the
 * store is being opened — which is when the one read per document happens.
 */
const withRelayDirectory = async <T,>(value: string, body: () => Promise<T>): Promise<T> => {
  const host = globalThis as Record<string, unknown>;
  const had = '__FY_RELAY_DIRECTORY__' in host;
  const previous = host.__FY_RELAY_DIRECTORY__;
  host.__FY_RELAY_DIRECTORY__ = value;
  try {
    return await body();
  } finally {
    if (had) host.__FY_RELAY_DIRECTORY__ = previous;
    else delete host.__FY_RELAY_DIRECTORY__;
  }
};

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceId: 'alpha-token',
});
const beta = daemonConnection({
  daemonId: 'beta',
  baseUrl: 'https://beta.example.test',
  deviceId: 'beta-token',
});

class MemoryRepository implements DaemonConnectionRepository {
  readonly values = new Map<string, string>();

  async load(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async save(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

const client = (name: string): FyApiClient => ({ name }) as unknown as FyApiClient;

describe('DaemonApiPool', () => {
  it('shares one client only for the exact live pairing', async () => {
    const calls: string[] = [];
    const pool = new DaemonApiPool(async daemon => {
      calls.push(`${daemon.daemonId}:${daemon.baseUrl}`);
      return client(daemon.baseUrl);
    });

    const first = pool.client(alpha);
    expect(pool.client({ ...alpha })).toBe(first);
    expect(pool.client(beta)).not.toBe(first);

    const moved = daemonConnection({ ...alpha, baseUrl: 'https://alpha-moved.example.test' });
    expect(pool.client(moved)).not.toBe(first);
    await Promise.all([first, pool.client(beta), pool.client(moved)]);
    expect(calls).toEqual([
      'alpha:https://alpha.example.test',
      'beta:https://beta.example.test',
      'alpha:https://alpha-moved.example.test',
    ]);
  });

  it('retries a failed connection and forgets only the cleared daemon', async () => {
    let attempts = 0;
    const pool = new DaemonApiPool(async daemon => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
      return client(daemon.daemonId);
    });

    await expect(pool.client(alpha)).rejects.toThrow('offline');
    const recovered = pool.client(alpha);
    await recovered;
    pool.client(beta);
    pool.clearDaemon(alpha.daemonId);

    expect(pool.client(alpha)).not.toBe(recovered);
    expect(attempts).toBe(4);
  });
});

/*
 * THE DIRECT DEADLINE, FIRED BY THE EVENT IT IS ABOUT. A wall-clock deadline of a few ms also covers the
 * session handshake, so a slow runner can expire it before the `pair` record is even sent — and then
 * the daemon was never heard and the outcome is not "unknown". This schedule holds every deadline and
 * releases the first (the direct leg's) only once the scripted daemon has taken the `pair` record.
 */
const deadlineAfterPairTaken = (daemon: { readonly requests: readonly unknown[] }): RelayHeartbeatSchedule => {
  const ticks: Array<() => void> = [];
  void (async () => {
    const giveUpAt = Date.now() + 10_000;
    while (daemon.requests.length === 0 && Date.now() < giveUpAt) await new Promise(resolve => setTimeout(resolve, 1));
    ticks[0]?.();
  })();
  return tick => {
    ticks.push(tick);
    return () => {};
  };
};

describe('exchangePairing', () => {
  const DEVICE_ID = 'fy_device_id_pairedDevice0000000001';
  const STUDIO = 'https://studio.example';
  const RELAY = 'wss://relay.mine.test';
  const pairedAs = (daemonId: string, carriers: readonly unknown[] = [{ kind: 'direct', url: STUDIO }]) => ({
    deviceId: DEVICE_ID,
    daemonId,
    daemonName: 'Studio',
    capabilities: [],
    carriers,
    idleExpiryDays: 30,
  });

  /** One scripted daemon per carrier, chosen by the host the browser dialled. */
  const byHost = (routes: Readonly<Record<string, (() => ScriptedSocket) | 'refuse'>>) => {
    const dialled: string[] = [];
    const dial = (url: string): ScriptedSocket => {
      dialled.push(url);
      const route = routes[new URL(url).hostname];
      if (route === undefined || route === 'refuse') {
        const refused = new ScriptedSocket();
        queueMicrotask(() => refused.onClose?.(1006, 'the address did not answer'));
        return refused;
      }
      return route();
    };
    return { dial, dialled };
  };

  it('pairs over a direct session, registering a fresh key and saving it only once the daemon accepted it', async () => {
    const identity = await newDaemonIdentity();
    const direct = autoDial(identity, { paired: pairedAs(identity.daemonId) });
    const route = byHost({ 'studio.example': direct.dial });
    const deviceKeys = new MemoryDeviceKeyStore();

    const connection = await exchangePairing(
      { daemonUrl: STUDIO, daemonId: identity.daemonId, code: '7F3K-Q2ND' },
      { deviceKeys, relayCrypto, relayDial: route.dial },
    );

    expect(String(connection.daemonId)).toBe(identity.daemonId);
    expect(connection.baseUrl).toBe(STUDIO);
    expect(connection.deviceId).toBe(DEVICE_ID);
    expect(route.dialled).toEqual([`wss://studio.example/v1/rendezvous/${identity.daemonId}/client`]);
    const pair = direct.requests[0] as Record<string, unknown>;
    expect(pair).toMatchObject({ t: 'pair', code: '7F3K-Q2ND', deviceName: 'Ferretry PWA' });
    expect(typeof pair.deviceKey).toBe('string');
    // No bearer value exists anywhere in what was sent or what is kept.
    expect(JSON.stringify(connection)).not.toContain('7F3K-Q2ND');
    expect(deviceKeys.saved).toEqual([identity.daemonId]);
    expect(deviceKeys.keys.get(identity.daemonId)?.extractable).toBe(false);
  });

  it('saves no key when the daemon refuses the code, and carries the refusal to no second carrier', async () => {
    const identity = await newDaemonIdentity();
    const direct = autoDial(identity, { pairRefused: true });
    const relay = autoDial(identity, { paired: pairedAs(identity.daemonId) });
    const route = byHost({ 'studio.example': direct.dial, 'relay.mine.test': relay.dial });
    const deviceKeys = new MemoryDeviceKeyStore();

    const reason = await exchangePairing(
      { daemonUrl: STUDIO, daemonId: identity.daemonId, code: 'WRONG-CODE' },
      { deviceKeys, relayCrypto, relayDial: route.dial, hostedRelayUrl: RELAY },
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(reason).toBeInstanceOf(RelayPairingRefusedError);
    expect((reason as Error).message).toBe('this pairing code is wrong, expired or already spent');
    expect(relay.requests).toEqual([]);
    expect(deviceKeys.saved).toEqual([]);
  });

  it('fails closed, saving nothing, on a response naming another daemon or no carrier at all', async () => {
    const identity = await newDaemonIdentity();
    const other = await newDaemonIdentity();
    const deviceKeys = new MemoryDeviceKeyStore();
    const seed = { daemonUrl: STUDIO, daemonId: identity.daemonId, code: 'code' };

    const mismatched = autoDial(identity, { paired: pairedAs(other.daemonId) });
    await expect(
      exchangePairing(seed, { deviceKeys, relayCrypto, relayDial: byHost({ 'studio.example': mismatched.dial }).dial }),
    ).rejects.toThrow('does not match its fingerprint');

    await expect(
      exchangePairing(
        { ...seed, daemonId: 'not-a-fingerprint' },
        { deviceKeys, relayCrypto, relayDial: () => new ScriptedSocket() },
      ),
    ).rejects.toThrow('no carrier could reach this daemon');
    expect(deviceKeys.saved).toEqual([]);
  });

  it('says plainly when this browser cannot make the key it pairs with', async () => {
    const refusing = {
      generateDeviceKey: async () => {
        throw new Error('NotSupportedError');
      },
    } as unknown as typeof relayCrypto;
    await expect(
      exchangePairing(
        { daemonUrl: STUDIO, daemonId: (await newDaemonIdentity()).daemonId, code: 'code' },
        { deviceKeys: new MemoryDeviceKeyStore(), relayCrypto: refusing },
      ),
    ).rejects.toThrow(UNSUPPORTED_DEVICE_KEY_SENTENCE);
  });

  /*
   * EVERY LEG IS REPORTED, ONE PLAIN SENTENCE EACH. Reporting only the first told a phone on cellular
   * that ws://127.0.0.1:7431 "never reached the relay protocol" and said nothing about the relay leg,
   * which was the leg that was actually failing.
   */
  it('reports every leg when every carrier fails, so the relay leg is never hidden behind the direct one', async () => {
    const identity = await newDaemonIdentity();
    const route = byHost({});
    const reason = await exchangePairing(
      { daemonUrl: STUDIO, daemonId: identity.daemonId, code: 'code' },
      { deviceKeys: new MemoryDeviceKeyStore(), relayCrypto, relayDial: route.dial, hostedRelayUrl: RELAY },
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(route.dialled.map(url => new URL(url).hostname)).toEqual(['studio.example', 'relay.mine.test']);
    expect(reason).toBeInstanceOf(PairingUnreachableError);
    expect((reason as PairingUnreachableError).legs).toEqual([
      { kind: 'direct', address: STUDIO, code: 1006 },
      { kind: 'relay', address: RELAY, code: 1006 },
    ]);
    const message = (reason as Error).message;
    expect(message).toContain('could not reach the machine directly at studio.example');
    expect(message).toContain("Ferretry's relay (relay.mine.test) could not carry the connection either");
    // A transport failure, so the pairing screen keeps telling the reader the code is still good.
    expect(reason).not.toBeInstanceOf(RelayPairingRefusedError);
  });

  it('says a loopback pairing address means "this computer itself" and names a relay nobody holds', async () => {
    const identity = await newDaemonIdentity();
    const route = byHost({
      'relay.mine.test': () => {
        const absent = new ScriptedSocket();
        queueMicrotask(() => absent.onClose?.(RELAY_CLOSE_CODES.daemonAbsent, 'no daemon holds this rendezvous'));
        return absent;
      },
    });
    const reason = await exchangePairing(
      { daemonUrl: 'http://127.0.0.1:7431', daemonId: identity.daemonId, code: 'code' },
      { deviceKeys: new MemoryDeviceKeyStore(), relayCrypto, relayDial: route.dial, hostedRelayUrl: RELAY },
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    const message = (reason as Error).message;
    expect(message).toContain('127.0.0.1:7431');
    expect(message).toContain('"this computer itself"');
    expect(message).toContain('the machine is not connected to it right now');
    expect(message).not.toContain('relay protocol');
    expect(message).not.toContain(identity.daemonId);
  });

  it('says there was no relay to fall back to when this build found none', async () => {
    const identity = await newDaemonIdentity();
    const route = byHost({});
    await expect(
      exchangePairing(
        { daemonUrl: STUDIO, daemonId: identity.daemonId, code: 'code' },
        { deviceKeys: new MemoryDeviceKeyStore(), relayCrypto, relayDial: route.dial },
      ),
    ).rejects.toThrow("There was no relay to fall back to: this page could not find out where Ferretry's relay is.");
  });

  it('still reports a code the daemon may have taken unheard when the relay leg then fails at transport', async () => {
    const identity = await newDaemonIdentity();
    const direct = autoDial(identity, { pairSilently: true });
    const route = byHost({ 'studio.example': direct.dial });
    await expect(
      exchangePairing(
        { daemonUrl: STUDIO, daemonId: identity.daemonId, code: 'code' },
        {
          deviceKeys: new MemoryDeviceKeyStore(),
          relayCrypto,
          relayDial: route.dial,
          hostedRelayUrl: RELAY,
          heartbeat: deadlineAfterPairTaken(direct),
        },
      ),
    ).rejects.toBeInstanceOf(PairingOutcomeUnknownError);
  });

  /*
   * A DIRECT ADDRESS THAT NEVER ANSWERS IS DEADLINED, and the same code goes to the rendezvous. The
   * socket here opens nothing and closes nothing — a blackholed LAN address — so it is the injected
   * deadline, not a close, that ends the direct leg.
   */
  it('gives up on a silent direct address at the injected deadline and pairs over the relay', async () => {
    const identity = await newDaemonIdentity();
    const relay = autoDial(identity, { paired: pairedAs(identity.daemonId, [{ kind: 'relay', url: RELAY }]) });
    const route = byHost({ 'studio.example': () => new ScriptedSocket(), 'relay.mine.test': relay.dial });
    const deviceKeys = new MemoryDeviceKeyStore();
    const started = Date.now();

    const connection = await exchangePairing(
      { daemonUrl: STUDIO, daemonId: identity.daemonId, code: '7F3K-Q2ND' },
      { deviceKeys, relayCrypto, relayDial: route.dial, hostedRelayUrl: RELAY, directTimeoutMs: 20 },
    );

    expect(String(connection.daemonId)).toBe(identity.daemonId);
    expect((relay.requests[0] as { code: string }).code).toBe('7F3K-Q2ND');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(deviceKeys.saved).toEqual([identity.daemonId]);
  });

  /*
   * THE DEADLINE CAN BURN A CODE THE DAEMON ACTUALLY REDEEMED, AND THE READER HAS TO BE TOLD. Here the
   * direct daemon TOOK the sealed pair record and never answered, so the code may be spent under a
   * grant nobody holds; the rendezvous then truthfully refuses the same code.
   */
  it('warns that the unheard direct attempt may have paired when the relay then refuses the code', async () => {
    const identity = await newDaemonIdentity();
    const direct = autoDial(identity, { pairSilently: true });
    const relay = autoDial(identity, { pairRefused: true });
    const route = byHost({ 'studio.example': direct.dial, 'relay.mine.test': relay.dial });

    const reason = await exchangePairing(
      { daemonUrl: STUDIO, daemonId: identity.daemonId, code: '7F3K-Q2ND' },
      {
        deviceKeys: new MemoryDeviceKeyStore(),
        relayCrypto,
        relayDial: route.dial,
        hostedRelayUrl: RELAY,
        heartbeat: deadlineAfterPairTaken(direct),
      },
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect((direct.requests[0] as { t: string }).t).toBe('pair');
    expect((relay.requests[0] as { t: string }).t).toBe('pair');
    // Still a REFUSAL for every consumer that classifies one: the daemon did refuse.
    expect(reason).toBeInstanceOf(RelayPairingRefusedError);
    const message = (reason as Error).message;
    expect(message).toContain('may have paired a device this browser never heard about');
    expect(message).toContain('revoke');
    expect(message).toContain('fy pair');
  });

  /*
   * VERSION SKEW, from the pairing side. An updated app meeting an old machine must say ONE sentence
   * naming the machine as the side to update — not the first leg's connection error, which is what the
   * walk reports for an ordinary failure. Both ways an old machine can show itself are covered: its
   * liveness route after the direct leg failed, and its words on a rendezvous session.
   */
  it('pairs over a working relay even when the direct liveness read looks old, because that read proves nothing', async () => {
    const identity = await newDaemonIdentity();
    const relay = autoDial(identity, { paired: pairedAs(identity.daemonId, [{ kind: 'relay', url: RELAY }]) });
    const route = byHost({ 'relay.mine.test': relay.dial });
    const connection = await exchangePairing(
      { daemonUrl: STUDIO, daemonId: identity.daemonId, code: '7F3K-Q2ND' },
      {
        deviceKeys: new MemoryDeviceKeyStore(),
        relayCrypto,
        relayDial: route.dial,
        hostedRelayUrl: RELAY,
        network: async () => Response.json({ status: 'ok' }),
      },
    );
    expect(String(connection.daemonId)).toBe(identity.daemonId);
    expect((relay.requests[0] as { t: string }).t).toBe('pair');
  });

  it('names the machine as old when nothing reached it and its liveness route speaks an older session', async () => {
    const identity = await newDaemonIdentity();
    const relay = autoDial(identity, { paired: pairedAs(identity.daemonId) });
    const route = byHost({});
    const asked: string[] = [];
    const deviceKeys = new MemoryDeviceKeyStore();

    const reason = await exchangePairing(
      { daemonUrl: STUDIO, daemonId: identity.daemonId, code: '7F3K-Q2ND' },
      {
        deviceKeys,
        relayCrypto,
        relayDial: route.dial,
        hostedRelayUrl: RELAY,
        network: async input => {
          asked.push(String(input));
          return Response.json({ status: 'ok' });
        },
      },
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(reason).toBeInstanceOf(DaemonOutdatedError);
    expect((reason as Error).message).toBe(OLDER_DAEMON_SENTENCE);
    expect(asked).toEqual([`${STUDIO}/healthz`]);
    expect(relay.requests).toEqual([]);
    expect(deviceKeys.saved).toEqual([]);
  });

  it('names the machine as old when a rendezvous session meets the previous dialect', async () => {
    const identity = await newDaemonIdentity();
    const older = olderDaemonDial();
    const route = byHost({ 'relay.mine.test': older.dial });

    const reason = await exchangePairing(
      { daemonUrl: STUDIO, daemonId: identity.daemonId, code: '7F3K-Q2ND' },
      {
        deviceKeys: new MemoryDeviceKeyStore(),
        relayCrypto,
        relayDial: route.dial,
        hostedRelayUrl: RELAY,
        network: async () => {
          throw new TypeError('Failed to fetch');
        },
      },
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(reason).toBeInstanceOf(DaemonOutdatedError);
    expect(older.sockets).toHaveLength(1);
  });

  it('pairs silently over the relay after an unheard direct attempt, with no warning to give', async () => {
    const identity = await newDaemonIdentity();
    const direct = autoDial(identity, { pairSilently: true });
    const relay = autoDial(identity, { paired: pairedAs(identity.daemonId, [{ kind: 'relay', url: RELAY }]) });
    const route = byHost({ 'studio.example': direct.dial, 'relay.mine.test': relay.dial });

    const connection = await exchangePairing(
      { daemonUrl: STUDIO, daemonId: identity.daemonId, code: '7F3K-Q2ND' },
      {
        deviceKeys: new MemoryDeviceKeyStore(),
        relayCrypto,
        relayDial: route.dial,
        hostedRelayUrl: RELAY,
        directTimeoutMs: 40,
      },
    );

    expect(String(connection.daemonId)).toBe(identity.daemonId);
  });
});

interface FakeRequest<T> {
  result: T;
  error: DOMException | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onblocked: (() => void) | null;
  onupgradeneeded: (() => void) | null;
}

const fakeRequest = <T,>(result: T): FakeRequest<T> => ({
  result,
  error: null,
  onsuccess: null,
  onerror: null,
  onblocked: null,
  onupgradeneeded: null,
});

const fakeIndexedDb = (): IDBFactory => {
  const values = new Map<IDBValidKey, unknown>();
  const stores = new Set<string>();
  const database = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => stores.add(name),
    transaction: () => {
      const transaction = {
        error: null,
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        onerror: null as (() => void) | null,
        objectStore: () => ({
          get: (key: IDBValidKey) => {
            const request = fakeRequest(values.get(key));
            queueMicrotask(() => request.onsuccess?.());
            return request;
          },
          put: (value: unknown, key: IDBValidKey) => {
            values.set(key, value);
            queueMicrotask(() => transaction.oncomplete?.());
          },
        }),
      };
      return transaction;
    },
  };
  return {
    open: () => {
      const request = fakeRequest(database);
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  } as unknown as IDBFactory;
};

describe('IndexedDbConnectionRepository', () => {
  it('stores and reloads the versioned registry value', async () => {
    const repository = new IndexedDbConnectionRepository(fakeIndexedDb(), 'test-pairings');
    expect(await repository.load('missing')).toBeNull();

    await repository.save('connections', '{"v":1}');

    expect(await repository.load('connections')).toBe('{"v":1}');
  });

  it('degrades to document-lifetime storage when IndexedDB is unavailable', () => {
    expect(browserConnectionRepository(undefined)).toBeUndefined();
  });
});

function StoreProbe() {
  const store = useAppStore();
  const snapshot = useConnectionSnapshot();
  return (
    <button type="button" onClick={() => store.connections.add(alpha)}>
      {snapshot.selectedDaemonId ?? 'unpaired'}
    </button>
  );
}

/** Re-renders itself on demand without touching the connection store. */
function RenderCountProbe() {
  const snapshot = useConnectionSnapshot();
  const [renders, setRenders] = useState(0);
  return (
    <button type="button" onClick={() => setRenders(count => count + 1)}>
      {snapshot.selectedDaemonId ?? 'unpaired'}:{renders}
    </button>
  );
}

interface Gate<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
}

/** An open the test finishes by hand, so the opening state can be observed. */
const gate = <T,>(): Gate<T> => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

/** Flushes the promise hops between settling an open and its committed render. */
const settle = async (): Promise<void> => {
  await interact(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

interface SubscriptionLog {
  subscribes: number;
  unsubscribes: number;
}

/** Counts real subscriptions by shadowing the instance's prototype method. */
const countSubscriptions = (connections: DaemonConnectionStore): SubscriptionLog => {
  const log: SubscriptionLog = { subscribes: 0, unsubscribes: 0 };
  const subscribe = connections.subscribe.bind(connections);
  Object.defineProperty(connections, 'subscribe', {
    configurable: true,
    value: (listener: () => void) => {
      log.subscribes += 1;
      const unsubscribe = subscribe(listener);
      return () => {
        log.unsubscribes += 1;
        unsubscribe();
      };
    },
  });
  return log;
};

const memoryStore = async (): Promise<AppStore> =>
  await createAppStore({
    carrierPreferences: new AutoCarrierPreferences(undefined),
    repository: new MemoryRepository(),
    connectClient: async () => client('unused'),
    fetcher: async () => Response.json({}),
  });

describe('StoreProvider', () => {
  it('invalidates notification preferences and push devices for only the removed daemon', async () => {
    const store = await memoryStore();
    store.connections.add(alpha);
    store.connections.add(beta);
    store.notificationPreferences.set(alpha.daemonId, { enabled: true });
    store.notificationPreferences.set(beta.daemonId, { enabled: true });
    store.pushDevices.remember(alpha.daemonId, 'alpha-device');
    store.pushDevices.remember(beta.daemonId, 'beta-device');

    store.connections.remove(alpha.daemonId);

    expect(store.notificationPreferences.get(alpha.daemonId).enabled).toBe(false);
    expect(store.pushDevices.get(alpha.daemonId)).toBeNull();
    expect(store.notificationPreferences.get(beta.daemonId).enabled).toBe(true);
    expect(store.pushDevices.get(beta.daemonId)).toBe('beta-device');
  });

  it('reaches the daemon push API through the injected fetcher, never the global one', async () => {
    const requests: string[] = [];
    const globalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('the store reached the global fetch');
    }) as unknown as typeof fetch;

    try {
      const store = await createAppStore({
        carrierPreferences: new AutoCarrierPreferences(undefined),
        repository: new MemoryRepository(),
        connectClient: async () => client('unused'),
        fetcher: async input => {
          requests.push(String(input));
          return Response.json({ devices: [] });
        },
      });

      expect(await store.pushService.list(alpha)).toEqual([]);
    } finally {
      globalThis.fetch = globalFetch;
    }

    expect(requests).toEqual(['https://alpha.example.test/v1/push/subscriptions']);
  });

  /**
   * THE CASE EVERY OTHER TEST IN THIS FILE IS BLIND TO, BECAUSE THEY ALL INJECT.
   *
   * `createAppStore` is where the shipped `Illegal invocation` came from: the root handed a bare
   * builtin to the carrier router, which invoked it as a member. This test injects no fetcher and
   * makes the global itself receiver-sensitive, then drives both ways the router still reaches the
   * network: an origin no paired daemon owns, and the liveness read after a direct session failed.
   */
  it('reaches the real network without making the carrier router its receiver', async () => {
    const { daemon, deviceKeys } = await keyedDaemon('https://alpha.example.test');
    const receivers: unknown[] = [];
    const urls: string[] = [];
    const globalFetch = globalThis.fetch;
    // Deliberately not an arrow: an arrow has no receiver to be wrong about.
    globalThis.fetch = function (this: unknown, input: RequestInfo | URL): Promise<Response> {
      receivers.push(this);
      urls.push(String(input));
      return Promise.resolve(Response.json({}));
    } as unknown as typeof fetch;

    try {
      const store = await createAppStore({
        carrierPreferences: new AutoCarrierPreferences(undefined),
        repository: new MemoryRepository(),
        connectClient: async () => client('unused'),
        deviceKeys,
        relayCrypto,
        relayDial: dialByHost({}).dial,
      });
      store.connections.add(daemon);
      await store.carrier.fetch('https://unpaired.example.test/v1/anything');
      await store.carrier.fetch(`${daemon.baseUrl}/v1/projects`).catch(() => undefined);
    } finally {
      globalThis.fetch = globalFetch;
    }

    expect(urls).toEqual(['https://unpaired.example.test/v1/anything', 'https://alpha.example.test/healthz']);
    for (const receiver of receivers) expect(receiver).toBe(globalThis);
  });

  /**
   * TWO ANSWERS TO ONE QUESTION IS ONE ANSWER TOO MANY.
   *
   * The typed client used to build its own transport, which dialled the daemon's own address directly
   * and knew nothing about the carrier router. There is one path now, so the request the typed client
   * makes is a request the carrier router carried — inside a session, with no header of its own.
   */
  it('sends the typed client over the carrier rather than its own direct transport', async () => {
    const { identity, daemon, deviceKeys } = await keyedDaemon('https://alpha.example.test');
    const scripted = autoDial(identity, {
      respond: request =>
        request.path === '/v1/carriers'
          ? { body: { carriers: [{ kind: 'direct', url: 'https://alpha.example.test' }] } }
          : { body: [] },
    });
    const store = await createAppStore({
      carrierPreferences: new AutoCarrierPreferences(undefined),
      repository: new MemoryRepository(),
      deviceKeys,
      relayCrypto,
      relayDial: dialByHost({ 'alpha.example.test': scripted.dial }).dial,
      fetcher: async () => {
        throw new Error('no daemon request may reach the plain network');
      },
    });
    store.connections.add(daemon);

    await (await store.clients.client(daemon)).list();
    await settleTasks();

    const asked = scripted.requests as { path: string; headers?: Record<string, string> }[];
    expect(asked.map(request => request.path)).toEqual(['/v1/sessions', '/v1/carriers']);
    expect(asked.every(request => request.headers?.authorization === undefined)).toBe(true);
    expect(store.carrier.choice(daemon.daemonId)?.ok).toBe(true);
  });

  it('replaces the cached carrier set from the authenticated daemon view after connecting', async () => {
    const { identity, daemon, deviceKeys } = await keyedDaemon('https://daemon.example.test', [
      { kind: 'direct', daemonUrl: 'https://daemon.example.test' },
      { kind: 'relay', relayUrl: 'https://stale.example.test' },
    ]);
    const scripted = autoDial(identity, {
      respond: request =>
        request.path === '/v1/carriers'
          ? {
              body: {
                carriers: [
                  { kind: 'direct', url: 'https://daemon.example.test' },
                  { kind: 'relay', url: 'https://relay-one.example.test' },
                  { kind: 'relay', url: 'https://relay-two.example.test' },
                ],
              },
            }
          : { body: { ok: true } },
    });
    const store = await createAppStore({
      carrierPreferences: new AutoCarrierPreferences(undefined),
      repository: new MemoryRepository(),
      deviceKeys,
      relayCrypto,
      relayDial: dialByHost({ 'daemon.example.test': scripted.dial }).dial,
    });
    store.connections.add(daemon);

    await store.carrier.fetch(`${daemon.baseUrl}/v1/projects`);
    await settleTasks();

    expect((scripted.requests as { path: string }[]).map(request => request.path)).toEqual([
      '/v1/projects',
      '/v1/carriers',
    ]);
    expect(store.connections.get(daemon.daemonId)?.carriers).toEqual([
      { kind: 'direct', daemonUrl: 'https://daemon.example.test' },
      { kind: 'relay', relayUrl: 'https://relay-one.example.test', operator: 'self' },
      { kind: 'relay', relayUrl: 'https://relay-two.example.test', operator: 'self' },
    ]);
  });

  it('does not let an old pairing refresh replace a re-paired daemon cache', async () => {
    const { identity, daemon, deviceKeys } = await keyedDaemon('https://daemon.example.test', [
      { kind: 'direct', daemonUrl: 'https://daemon.example.test' },
      { kind: 'relay', relayUrl: 'https://old-relay.example.test' },
    ]);
    const repaired = daemonConnection({
      ...daemon,
      deviceId: 'fy_device_id_repairedDevice000000001',
      carriers: [
        { kind: 'direct', daemonUrl: 'https://daemon.example.test' },
        { kind: 'relay', relayUrl: 'https://new-relay.example.test' },
      ],
    });
    let refreshRequested!: () => void;
    const requested = new Promise<void>(resolve => {
      refreshRequested = resolve;
    });
    let releaseRefresh!: (answer: { body: unknown }) => void;
    const delayedRefresh = new Promise<{ body: unknown }>(resolve => {
      releaseRefresh = resolve;
    });
    const scripted = autoDial(identity, {
      respond: async request => {
        if (request.path !== '/v1/carriers') return { body: { ok: true } };
        refreshRequested();
        return await delayedRefresh;
      },
    });
    const store = await createAppStore({
      carrierPreferences: new AutoCarrierPreferences(undefined),
      repository: new MemoryRepository(),
      deviceKeys,
      relayCrypto,
      relayDial: dialByHost({ 'daemon.example.test': scripted.dial }).dial,
    });
    store.connections.add(daemon);

    await store.carrier.fetch(`${daemon.baseUrl}/v1/projects`);
    await requested;
    store.connections.remove(daemon.daemonId);
    store.connections.add(repaired);
    releaseRefresh({
      body: {
        carriers: [
          { kind: 'direct', url: 'https://daemon.example.test' },
          { kind: 'relay', url: 'https://stale-relay.example.test' },
        ],
      },
    });
    await settleTasks();

    expect(store.connections.get(daemon.daemonId)?.carriers).toEqual(repaired.carriers);
  });

  /**
   * THE PAIRING THAT PREDATES THE CARRIER SET, THROUGH THE REAL COMPOSITION ROOT.
   *
   * Such a record names one address — the direct one it was paired over — because the relay it was
   * actually reached over came from the hosted advertisement and was never stored. So the browser has
   * to be able to DIAL the current advertised address without ever adopting it: adopted, it would
   * outlive the advertisement that produced it, which is the kill switch not working.
   *
   * What this case owns is the WIRING — that the one advertisement read this document performs is the
   * address the router dials, for the right daemon, at the right rendezvous path, after direct, and
   * that nothing about it is written down. Every dial refuses on purpose: whether a session then works
   * is `relay-carrier`'s subject and is covered there.
   */
  it('dials the advertised rendezvous for a daemon that published none, and stores nothing about it', async () => {
    const { daemon, deviceKeys } = await keyedDaemon('https://old.example.test');
    const repository = new MemoryRepository();
    const route = dialByHost({});
    const fetcher = (relayUrl: string | null) => async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${RELAY_DIRECTORY}${HOSTED_RELAY_PATH}`) return Response.json({ version: 1, relayUrl });
      throw new TypeError('Failed to fetch');
    };
    const store = await withRelayDirectory(RELAY_DIRECTORY, async () =>
      createAppStore({
        carrierPreferences: new AutoCarrierPreferences(undefined),
        repository,
        deviceKeys,
        relayCrypto,
        relayDial: route.dial,
        fetcher: fetcher(HOSTED_RELAY_URL),
        connectionHealthEnvironment: idleConnectionHealth,
      }),
    );
    store.connections.add(daemon);

    await expect(store.carrier.fetch(`${daemon.baseUrl}/v1/projects`)).rejects.toThrow(
      /No configured connection worked/u,
    );
    await settleTasks();

    // Direct first, then the advertised rendezvous — both for this daemon's fingerprint.
    expect(route.dialled).toEqual([
      `wss://old.example.test/v1/rendezvous/${daemon.daemonId}/client`,
      `wss://hosted-relay.example.test/v1/rendezvous/${daemon.daemonId}/client`,
    ]);
    expect(store.connections.get(daemon.daemonId)?.carriers).toEqual([
      { kind: 'direct', daemonUrl: 'https://old.example.test' },
    ]);
    expect([...repository.values.values()].join('')).not.toContain(HOSTED_RELAY_URL);

    // THE KILL SWITCH, on the next document: `relayUrl: null` leaves only the daemon's own address.
    const withdrawn = await withRelayDirectory(RELAY_DIRECTORY, async () =>
      createAppStore({
        carrierPreferences: new AutoCarrierPreferences(undefined),
        repository,
        deviceKeys,
        relayCrypto,
        relayDial: route.dial,
        fetcher: fetcher(null),
        connectionHealthEnvironment: idleConnectionHealth,
      }),
    );
    await expect(withdrawn.carrier.fetch(`${daemon.baseUrl}/v1/projects`)).rejects.toThrow(
      /No configured connection worked/u,
    );
    await settleTasks();

    expect(route.dialled.slice(2)).toEqual([`wss://old.example.test/v1/rendezvous/${daemon.daemonId}/client`]);
  });

  /**
   * A REFRESH THE DAEMON CANNOT ANSWER CHANGES NOTHING, AND ITS FIRST REAL ANSWER CHANGES EVERYTHING.
   *
   * `404` is what an older daemon says to `GET /v1/carriers`, and it must leave the known-working
   * cache exactly as it was. Once that daemon can answer, its answer REPLACES the cache whole.
   */
  it('leaves the cache alone when a refresh is refused and replaces it whole once the daemon answers', async () => {
    const { identity, daemon, deviceKeys } = await keyedDaemon('https://box.example.test');
    const repository = new MemoryRepository();
    // Mutable on purpose: one document watches the daemon it is paired to gain the route.
    let published: unknown = null;
    const scripted = autoDial(identity, {
      respond: request => {
        if (request.path !== '/v1/carriers') return { body: { ok: true } };
        return published === null ? { status: 404, body: '' } : { body: published };
      },
    });
    const store = await withRelayDirectory(RELAY_DIRECTORY, async () =>
      createAppStore({
        carrierPreferences: new AutoCarrierPreferences(undefined),
        repository,
        deviceKeys,
        relayCrypto,
        relayDial: dialByHost({ 'box.example.test': scripted.dial }).dial,
        fetcher: async input => {
          if (String(input) === `${RELAY_DIRECTORY}${HOSTED_RELAY_PATH}`) {
            return Response.json({ version: 1, relayUrl: HOSTED_RELAY_URL });
          }
          throw new TypeError('Failed to fetch');
        },
      }),
    );
    store.connections.add(daemon);

    await store.carrier.fetch(`${daemon.baseUrl}/v1/projects`);
    await settleTasks();

    const paths = (): string[] => (scripted.requests as { path: string }[]).map(request => request.path);
    expect(paths()).toEqual(['/v1/projects', '/v1/carriers']);
    expect(store.connections.get(daemon.daemonId)?.carriers).toEqual([
      { kind: 'direct', daemonUrl: 'https://box.example.test' },
    ]);
    expect([...repository.values.values()].join('')).not.toContain(HOSTED_RELAY_URL);

    published = {
      carriers: [
        { kind: 'direct', url: 'https://box.example.test' },
        { kind: 'relay', url: HOSTED_RELAY_URL },
      ],
    };
    // Unpairing forgets the device key — that is its job — so the re-pair brings a key of its own.
    const key = must(deviceKeys.keys.get(daemon.daemonId), 'the paired device key');
    store.connections.remove(daemon.daemonId);
    expect(deviceKeys.removed).toEqual([daemon.daemonId]);
    await deviceKeys.save(daemon.daemonId, key);
    store.connections.add(daemon);
    await store.carrier.fetch(`${daemon.baseUrl}/v1/projects`);
    await settleTasks();

    expect(store.connections.get(daemon.daemonId)?.carriers).toEqual([
      { kind: 'direct', daemonUrl: 'https://box.example.test' },
      { kind: 'relay', relayUrl: HOSTED_RELAY_URL, operator: 'hosted' },
    ]);
    expect([...repository.values.values()].join('')).toContain(HOSTED_RELAY_URL);
  });

  it('publishes a daemon-scoped store and reacts to runtime pairing changes', async () => {
    const store = await memoryStore();
    const view = await mount(
      <StoreProvider store={store}>
        <StoreProbe />
      </StoreProvider>,
    );

    expect(view.container.textContent).toBe('unpaired');
    await interact(() => view.container.querySelector('button')?.click());
    expect(view.container.textContent).toBe('alpha');
    await view.unmount();
  });

  it('keeps the public landing marker content-free and in sync with pairing changes', async () => {
    const values = new Map<string, string>();
    const store = await createAppStore({
      carrierPreferences: new AutoCarrierPreferences(undefined),
      repository: new MemoryRepository(),
      connectClient: async () => client('unused'),
      fetcher: async () => Response.json({}),
      landingMarkerStorage: {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key),
      },
    });

    store.connections.add(alpha);
    expect([...values.entries()]).toEqual([['fy-has-pairings-v1', '1']]);

    store.connections.remove(alpha.daemonId);
    expect([...values.entries()]).toEqual([]);
  });

  it('shows an honest local-state failure and rejects consumers outside the provider', async () => {
    const failure = await mount(
      <StoreProvider createStore={async () => Promise.reject(new Error('database denied'))}>
        <StoreProbe />
      </StoreProvider>,
    );
    await interact(async () => await Promise.resolve());
    expect(failure.container.textContent).toContain('database denied');
    await failure.unmount();

    await expect(mount(<StoreProbe />)).rejects.toThrow('useAppStore must be rendered inside StoreProvider');
  });

  it('recovers from a rejected open when the reader retries, without replaying the failure', async () => {
    const store = await memoryStore();
    let attempts = 0;
    const createStore = async (): Promise<AppStore> => {
      attempts += 1;
      if (attempts === 1) throw new Error('database denied');
      return store;
    };

    const view = await mount(
      <StoreProvider createStore={createStore}>
        <StoreProbe />
      </StoreProvider>,
    );
    await interact(async () => await Promise.resolve());
    expect(view.container.textContent).toContain('database denied');

    await interact(() => must(view.container.querySelector('button'), 'the retry button').click());
    await interact(async () => await Promise.resolve());

    expect(attempts).toBe(2);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(must(view.container.querySelector('button'), 'the probe').textContent).toBe('unpaired');

    // The recovered store is the live one, not a snapshot taken before the retry.
    await interact(() => view.container.querySelector('button')?.click());
    expect(must(view.container.querySelector('button'), 'the probe').textContent).toBe('alpha');
    await view.unmount();
  });

  it('keeps one lifecycle surface, its sentences, and the reader focus across a failed retry', async () => {
    const store = await memoryStore();
    const attempts: Gate<AppStore>[] = [];
    const createStore = async (): Promise<AppStore> => {
      const opening = gate<AppStore>();
      attempts.push(opening);
      return await opening.promise;
    };

    const view = await mount(
      <StoreProvider createStore={createStore}>
        <StoreProbe />
      </StoreProvider>,
    );
    const status = must(view.container.querySelector('[role="status"]'), 'the status region');
    const alert = must(view.container.querySelector('[role="alert"]'), 'the alert region');

    expect(status.textContent).toBe('Opening Ferretry…');
    expect(alert.textContent).toBe('');

    must(attempts[0], 'the first open').reject(new Error('database denied'));
    await settle();

    // Same live regions: neither was remounted under the reader.
    expect(view.container.querySelector('[role="status"]')).toBe(status);
    expect(view.container.querySelector('[role="alert"]')).toBe(alert);
    expect(status.textContent).toBe('');
    expect(alert.textContent).toBe('Could not open local PWA state: database denied');

    const retry = must(view.container.querySelector('button'), 'the retry control');
    expect(retry.getAttribute('aria-disabled')).toBe('false');
    retry.focus();

    await interact(() => retry.click());

    // The control the reader pressed survived its own press, so the focus did.
    expect(attempts).toHaveLength(2);
    expect(view.container.querySelector('button')).toBe(retry);
    expect(document.activeElement).toBe(retry);
    expect(status.textContent).toBe('Retrying: opening Ferretry…');
    expect(alert.textContent).toBe('');
    expect(retry.getAttribute('aria-disabled')).toBe('true');

    // Pressing a control the reader has been told is disabled starts nothing.
    await interact(() => retry.click());
    expect(attempts).toHaveLength(2);

    must(attempts[1], 'the second open').resolve(store);
    await settle();

    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(must(view.container.querySelector('button'), 'the probe').textContent).toBe('unpaired');
    await view.unmount();
  });

  it('offers no retry control until an open has actually failed', async () => {
    const attempts: Gate<AppStore>[] = [];
    const createStore = async (): Promise<AppStore> => {
      const opening = gate<AppStore>();
      attempts.push(opening);
      return await opening.promise;
    };

    const view = await mount(
      <StoreProvider createStore={createStore}>
        <StoreProbe />
      </StoreProvider>,
    );

    // An ordinary boot: a progress sentence, a silent alert region waiting in
    // the document, and nothing a reader can tab to, press or be told is
    // unavailable. Offering "Try again" here would claim a failure that has
    // not happened.
    expect(must(view.container.querySelector('[role="status"]'), 'the status region').textContent).toBe(
      'Opening Ferretry…',
    );
    expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(view.container.querySelector('button')).toBeNull();
    expect(view.container.textContent).toBe('Opening Ferretry…');

    must(attempts[0], 'the first open').reject(new Error('database denied'));
    await settle();

    // It exists from the moment there is something to try again.
    const retry = must(view.container.querySelector('button'), 'the retry control');
    expect(retry.textContent).toBe('Try again');
    expect(retry.getAttribute('aria-disabled')).toBe('false');
    await view.unmount();
  });

  it('hands a recovered boot back to the reader instead of dropping focus to the body', async () => {
    const store = await memoryStore();
    let attempts = 0;
    const createStore = async (): Promise<AppStore> => {
      attempts += 1;
      if (attempts === 1) throw new Error('database denied');
      return store;
    };

    const view = await mount(
      <StoreProvider createStore={createStore}>
        <StoreProbe />
      </StoreProvider>,
    );
    await settle();

    const retry = must(view.container.querySelector('button'), 'the retry control');
    retry.focus();
    await interact(() => retry.click());
    await settle();

    // The surface the reader was standing on is destroyed by the open, so the
    // reader is moved to a sentence that closes out the failure rather than
    // being dropped at the top of the document with nothing said.
    const opened = must(
      view.container.querySelector<HTMLParagraphElement>('[role="status"]'),
      'the opened announcement',
    );
    expect(opened.textContent).toBe('Ferretry is open.');
    expect(opened.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(opened);
    // First in document order, ahead of everything the app itself renders.
    expect(view.container.firstElementChild).toBe(opened);
    expect(must(view.container.querySelector('button'), 'the probe').textContent).toBe('unpaired');

    // Moved once. A later render of the opened app leaves the reader wherever
    // they have since gone.
    opened.blur();
    await interact(() => must(view.container.querySelector('button'), 'the probe').click());
    expect(must(view.container.querySelector('button'), 'the probe').textContent).toBe('alpha');
    expect(document.activeElement).not.toBe(opened);
    await view.unmount();
  });

  it('neither announces nor moves the reader when the first open succeeds', async () => {
    const store = await memoryStore();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    const view = await mount(
      <StoreProvider createStore={async () => store}>
        <StoreProbe />
      </StoreProvider>,
    );
    await settle();

    // Nothing failed, so there is nothing to close out: the browser's own
    // focus placement stands and the app renders alone.
    expect(view.container.querySelector('[role="status"]')).toBeNull();
    expect(view.container.textContent).toBe('unpaired');
    expect(document.activeElement).toBe(document.body);
    await view.unmount();
  });

  it('subscribes to the connection store once per store, not once per render', async () => {
    const first = await memoryStore();
    const second = await memoryStore();
    const firstLog = countSubscriptions(first.connections);
    const secondLog = countSubscriptions(second.connections);

    const view = await mount(
      <StoreProvider store={first}>
        <RenderCountProbe />
      </StoreProvider>,
    );
    const probe = must(view.container.querySelector('button'), 'the render probe');
    await interact(() => probe.click());
    await interact(() => probe.click());

    expect(view.container.textContent).toBe('unpaired:2');
    expect(firstLog).toEqual({ subscribes: 1, unsubscribes: 0 });

    // Scoped to the store: a different one is subscribed, the old one released.
    await view.render(
      <StoreProvider store={second}>
        <RenderCountProbe />
      </StoreProvider>,
    );

    expect(firstLog).toEqual({ subscribes: 1, unsubscribes: 1 });
    expect(secondLog).toEqual({ subscribes: 1, unsubscribes: 0 });

    await view.unmount();
    expect(secondLog).toEqual({ subscribes: 1, unsubscribes: 1 });
  });
});

describe('useDaemonClient', () => {
  /** Calls the hook and hands back what it answers for one daemon. */
  function ClientProbe({ onClient }: { readonly onClient: (client: Promise<FyApiClient>) => void }) {
    const createClient = useDaemonClient();
    onClient(createClient(alpha));
    return null;
  }

  it('hands a screen the store pool’s client, so it rides the carrier rather than the plain network', async () => {
    const pooled = client('pooled');
    const store = await createAppStore({
      carrierPreferences: new AutoCarrierPreferences(undefined),
      repository: new MemoryRepository(),
      connectClient: async () => pooled,
      fetcher: async () => Response.json({}),
    });
    let answered: Promise<FyApiClient> | undefined;
    const view = await mount(
      <StoreProvider store={store}>
        <ClientProbe onClient={value => (answered = value)} />
      </StoreProvider>,
    );
    expect(await answered).toBe(pooled);
    expect(await store.clients.client(alpha)).toBe(pooled);
    await view.unmount();
  });

  it('hands a screen the client a DaemonClientProvider names, for a surface with no app store', async () => {
    const named = client('named');
    let answered: Promise<FyApiClient> | undefined;
    const view = await mount(
      <DaemonClientProvider client={async () => named}>
        <ClientProbe onClient={value => (answered = value)} />
      </DaemonClientProvider>,
    );
    expect(await answered).toBe(named);
    await view.unmount();
  });

  it('refuses outside the app store rather than building a client pointed at nothing', async () => {
    let answered: Promise<unknown> | undefined;
    // Settled into a value at once: the refusal happens during render, before anything else could
    // attach a handler, and an unwatched rejection fails the whole file.
    const view = await mount(
      <ClientProbe
        onClient={value => {
          answered = value.then(
            () => undefined,
            (reason: unknown) => reason,
          );
        }}
      />,
    );
    expect(((await answered) as Error).message).toBe('no daemon client exists outside the app store');
    await view.unmount();
  });
});
