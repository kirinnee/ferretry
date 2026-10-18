/**
 * The composition root's half of silent reconnect: the health model is fed by the router every daemon
 * request goes through, its retries are real reads over that router, and the browser saying the
 * network changed both retries now and checks every held session.
 */

import { describe, expect, it } from 'bun:test';
import type { FyApiClient } from '@ferretry/protocol/client';
import type { ConnectionHealthEnvironment, DaemonConnectionHealth } from '../../src/lib/connection-health.ts';
import type { ConnectionSignal } from '../../src/lib/connection-signals.ts';
import type { DaemonConnectionRepository } from '../../src/lib/connections.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import { createAppStore } from '../../src/lib/store.tsx';
import { autoDial, keyedDaemon, relayCrypto, ScriptedSocket, settle } from '../support/relay.ts';

class MemoryRepository implements DaemonConnectionRepository {
  readonly values = new Map<string, string>();
  async load(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async save(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

/** Timers the test fires by hand. */
const manualHealthEnvironment = () => {
  const armed: { run: () => void; delayMs: number; cancelled: boolean }[] = [];
  const environment: ConnectionHealthEnvironment = {
    now: () => 1_000,
    schedule: (run, delayMs) => {
      const entry = { run, delayMs, cancelled: false };
      armed.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    random: () => 0,
    isOnline: () => true,
  };
  return { armed, environment };
};

describe('the store’s connection health', () => {
  it('reconnects through a real carriers read when the browser says it is back online', async () => {
    const { identity, daemon, deviceKeys } = await keyedDaemon('https://alpha.example.test');
    const scripted = autoDial(identity, {
      respond: request =>
        request.path === '/v1/carriers'
          ? { body: { carriers: [{ kind: 'direct', url: 'https://alpha.example.test' }] } }
          : { body: [] },
    });
    let reachable = false;
    const dial = (): ScriptedSocket => {
      if (reachable) return scripted.dial();
      const refused = new ScriptedSocket();
      queueMicrotask(() => refused.onClose?.(1006, 'the address did not answer'));
      return refused;
    };
    const timers = manualHealthEnvironment();
    let signal: ((kind: ConnectionSignal) => void) | undefined;
    const store = await createAppStore({
      repository: new MemoryRepository(),
      connectClient: async () => ({}) as unknown as FyApiClient,
      fetcher: async () => Response.json({}),
      deviceKeys,
      relayCrypto,
      relayDial: dial,
      connectionHealthEnvironment: timers.environment,
      connectionSignals: {
        listen: listener => {
          signal = listener;
          return () => undefined;
        },
      },
    });
    store.connections.add(daemon);

    // Arrange — a request no carrier carried puts the daemon into an outage.
    await store.carrier.fetch(`${daemon.baseUrl}/v1/projects`).catch(() => undefined);
    expect(store.connectionHealth.state(daemon.daemonId).kind).toBe('reconnecting');

    // Act — the network comes back and the browser says so.
    reachable = true;
    signal?.('online');
    await settle();

    // Assert — the retry ran at once (no backoff fired) as a real read, and it ended the outage.
    expect(store.connectionHealth.state(daemon.daemonId).kind).toBe('connected');
    expect(scripted.requests.map(request => (request as { path: string }).path)).toContain('/v1/carriers');
    expect(scripted.sockets[0]?.texts).toEqual([]);
    // The same signal now proves the live session is alive: a ping, without waiting for the interval.
    signal?.('visible');
    await settle(2);
    expect(scripted.sockets[0]?.texts).toEqual(['fy-ping']);

    // An unpair stops anything further for that daemon.
    store.connections.remove(daemon.daemonId);
    expect(store.connectionHealth.state(daemon.daemonId).kind).toBe('unknown');
  });

  it('attempts nothing for a daemon that is no longer paired', async () => {
    const timers = manualHealthEnvironment();
    const store = await createAppStore({
      repository: new MemoryRepository(),
      connectClient: async () => ({}) as unknown as FyApiClient,
      fetcher: async () => Response.json({}),
      connectionHealthEnvironment: timers.environment,
      connectionSignals: { listen: () => () => undefined },
    });
    const health = store.connectionHealth as DaemonConnectionHealth;
    const nobody = 'fy_nobody' as DaemonId;
    health.outage(nobody, { failures: [], daemonAbsent: false, relaysNeverOpened: false });
    health.retryNow(nobody);
    await settle(2);
    // The attempt settled without a request, so the loop simply scheduled its next try.
    expect(health.state(nobody)).toMatchObject({ kind: 'reconnecting', attempt: 1 });
    expect(timers.armed.filter(entry => !entry.cancelled).map(entry => entry.delayMs)).toEqual([30_000, 500]);
  });
});
