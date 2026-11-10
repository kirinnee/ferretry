/**
 * The carrier-set write-back: the daemon is authoritative and a device's stored carriers are a cache of its answer.
 * Ported from v4's `pwa/tests/unit/connections.test.ts` ("replaces carriers only for the pairing that authenticated the
 * refresh") and `relay-connection.test.ts` ("keep a known-working cache when an authenticated refresh publishes nothing",
 * "write a carrier back out so the next load can read it"), over Connections' own refresh.
 *
 * The stored list is a two-method stand-in for the shell's `DaemonList` (`get`, `setCarriers`): a plugin's tests reach
 * the app package only through its contract, and the shell's own list tests own its storage. What the router does with
 * the stored set is proved against the real `daemonCarriers`.
 */
import { describe, expect, test } from 'bun:test';
import type { ConnectPorts, PairedDaemon } from '@ferretry/app';
import { noteClientDaemon, render, run, runAsync } from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { createElement } from 'react';
import { daemonCarriers } from '../../../app/carriers/router.ts';
import connections, { buildConnectionsApp, carrierWriteBackView } from '../../../app/index.ts';
import { carrierWriteBack, type StoredCarrierSets } from '../../../app/lib/carrier-write-back.ts';
import { CarriersChanged, type PublishedCarriers } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';

const DAEMON = `fy_daemon_${'A'.repeat(43)}`;
const ADDRESS = 'https://studio.example';
const DIRECT = { kind: 'direct', url: ADDRESS } as const;
const SELF = { kind: 'relay', url: 'https://relay.mine' } as const;
const HOSTED = { kind: 'relay', url: 'https://relay.ferretry' } as const;
const SECOND = { kind: 'relay', url: 'https://relay.second' } as const;

/** The stored list as `DaemonList` keeps it for the write-back: a record per daemon, `setCarriers` replacing the set. */
function paired(carriers: PublishedCarriers = [DIRECT], deviceId = 'fy_device_x') {
  const records = new Map<string, PairedDaemon>();
  let writes = 0;
  const pair = (next: Partial<PairedDaemon> & { readonly carriers?: readonly unknown[] }): void =>
    void records.set(DAEMON, {
      daemon: DAEMON,
      machine: 'studio',
      deviceId,
      address: ADDRESS,
      carriers: [],
      pairedAt: 1,
      lastSelectedAt: 1,
      ...next,
    } as PairedDaemon);
  pair({ carriers: [...carriers] });
  const list: StoredCarrierSets = {
    get: daemon => records.get(daemon),
    setCarriers: (daemon, set) => {
      const record = records.get(daemon);
      if (record === undefined) return;
      writes += 1;
      records.set(daemon, { ...record, carriers: [...set].slice(0, 16) });
    },
  };
  return { list, pair, unpair: () => records.delete(DAEMON), writes: () => writes };
}
const stored = (list: StoredCarrierSets): readonly unknown[] => list.get(DAEMON)?.carriers ?? [];

describe('the stored carrier set is replaced by the daemon’s answer', () => {
  test('P51 R186 a client replaces its stored set with the daemon’s answer and never merges', () => {
    const p = paired([DIRECT, SELF]);
    const writeBack = carrierWriteBack(p.list);
    // A withdrawn relay disappears and a new pair takes its place: replacement, not merge.
    expect(writeBack.begin(DAEMON)([DIRECT])).toBe(true);
    expect(stored(p.list)).toEqual([DIRECT]);
    expect(writeBack.begin(DAEMON)([DIRECT, HOSTED, SECOND])).toBe(true);
    expect(stored(p.list)).toEqual([DIRECT, HOSTED, SECOND]);
    // Idempotent: the same answer is not a new snapshot.
    const before = p.writes();
    expect(writeBack.begin(DAEMON)([DIRECT, HOSTED, SECOND])).toBe(false);
    expect(p.writes()).toBe(before);
  });

  test('R170 the daemon is authoritative: where a client’s cache and the daemon disagree, the daemon is right', () => {
    const p = paired([DIRECT, SELF, HOSTED]);
    carrierWriteBack(p.list).begin(DAEMON)([DIRECT, SECOND]);
    expect(stored(p.list)).toEqual([DIRECT, SECOND]);
    // The cache holds nothing the daemon did not publish: no entry survives from the old set.
    expect(stored(p.list)).not.toContainEqual(SELF);
    expect(stored(p.list)).not.toContainEqual(HOSTED);
  });

  test('P51 R186 only the pairing that authenticated the refresh is written to', () => {
    // A refresh began as one pairing; the device was re-paired (a new device key) while it was in flight.
    const p = paired([DIRECT, SELF]);
    const writeBack = carrierWriteBack(p.list);
    const adopt = writeBack.begin(DAEMON);
    p.pair({ deviceId: 'fy_device_rotated', carriers: [DIRECT] });
    expect(adopt([DIRECT, HOSTED])).toBe(false);
    expect(stored(p.list)).toEqual([DIRECT]);
    // A moved address is another pairing too, and an unpaired daemon has nothing to write.
    const moved = writeBack.begin(DAEMON);
    p.pair({ deviceId: 'fy_device_rotated', address: 'https://moved.example', carriers: [DIRECT] });
    expect(moved([DIRECT, HOSTED])).toBe(false);
    const gone = writeBack.begin(DAEMON);
    p.unpair();
    expect(gone([DIRECT])).toBe(false);
    expect(p.list.get(DAEMON)).toBeUndefined();
    expect(writeBack.begin(DAEMON)([DIRECT])).toBe(false);
  });

  test('P51 an authenticated refresh that publishes nothing keeps the known-working cache', () => {
    const p = paired([DIRECT, SELF]);
    expect(carrierWriteBack(p.list).begin(DAEMON)([])).toBe(false);
    expect(stored(p.list)).toEqual([DIRECT, SELF]);
    expect(p.writes()).toBe(0);
  });

  test('R198 a stale relay is pruned on the next refresh: the router’s set no longer names it', () => {
    const p = paired([DIRECT, SELF, HOSTED]);
    const record = (): PairedDaemon => p.list.get(DAEMON)!;
    expect(daemonCarriers(record()).some(method => method.kind === 'relay' && method.relayUrl === SELF.url)).toBe(true);
    carrierWriteBack(p.list).begin(DAEMON)([DIRECT, HOSTED]);
    const methods = daemonCarriers(record());
    expect(methods.some(method => method.kind === 'relay' && method.relayUrl === SELF.url)).toBe(false);
    expect(methods.some(method => method.kind === 'relay' && method.relayUrl === HOSTED.url)).toBe(true);
  });

  test('R210 the stored set is seeded by redemption and replaced wholesale by the first answer', () => {
    // Redemption seeds the set the pairing answered with; the answer then replaces it, never extends it.
    const p = paired([DIRECT, HOSTED]);
    expect(stored(p.list)).toEqual([DIRECT, HOSTED]);
    carrierWriteBack(p.list).begin(DAEMON)([DIRECT, SELF]);
    expect(stored(p.list)).toEqual([DIRECT, SELF]);
  });

  test('P51 what is stored is exactly what the contract admits: a set it refuses is not written', () => {
    const p = paired([DIRECT]);
    const nine = Array.from({ length: 9 }, (_, n) => ({
      kind: 'relay' as const,
      url: `https://r${String(n)}.example`,
    }));
    expect(carrierWriteBack(p.list).begin(DAEMON)(nine)).toBe(false);
    expect(stored(p.list)).toEqual([DIRECT]);
  });
});

describe('R635 a refresh that omits the tunnel does not erase it; only the daemon’s own word forgets it', () => {
  const TUNNEL = { kind: 'tunnel', url: 'https://k3x9.tunnels.example.com' } as const;
  const MOVED = { kind: 'tunnel', url: 'https://n3w.tunnels.example.com' } as const;

  test('R635 a set read while the connector reconnects (no tunnel in it) keeps the last tunnel the daemon published', () => {
    const p = paired([DIRECT, SELF, TUNNEL]);
    const writeBack = carrierWriteBack(p.list);

    expect(writeBack.begin(DAEMON)([DIRECT, HOSTED])).toBe(true);

    // The relay it withdrew is gone, as ever (R198); the tunnel is the one entry omission does not withdraw.
    expect(stored(p.list)).toEqual([DIRECT, HOSTED, TUNNEL]);
    expect(writeBack.holdsTunnel(DAEMON)).toBe(true);
    // The same omission again is no new snapshot.
    expect(writeBack.begin(DAEMON)([DIRECT, HOSTED])).toBe(false);
  });

  test('R635 a different tunnel the daemon publishes replaces the kept one, and the kept one is never doubled', () => {
    const p = paired([DIRECT, TUNNEL]);
    const writeBack = carrierWriteBack(p.list);

    writeBack.begin(DAEMON)([DIRECT, MOVED]);
    expect(stored(p.list)).toEqual([DIRECT, MOVED]);

    writeBack.begin(DAEMON)([DIRECT, MOVED, SELF]);
    expect(stored(p.list)).toEqual([DIRECT, MOVED, SELF]);
  });

  test('R635 off or unable to run forgets the tunnel; a daemon that says it is on keeps it; neither is a write for a pairing that moved', () => {
    const p = paired([DIRECT, TUNNEL]);
    const writeBack = carrierWriteBack(p.list);

    // The daemon says its tunnel is up somewhere else: that one is kept in place of the old.
    expect(writeBack.replaceTunnel(DAEMON, { kind: 'tunnel', tunnelUrl: MOVED.url })).toBe(true);
    expect(stored(p.list)).toEqual([DIRECT, MOVED]);
    // Off or unable to run: forgotten, and the refresh that follows no longer brings it back.
    expect(writeBack.replaceTunnel(DAEMON, undefined)).toBe(true);
    expect(stored(p.list)).toEqual([DIRECT]);
    expect(writeBack.holdsTunnel(DAEMON)).toBe(false);
    writeBack.begin(DAEMON)([DIRECT, HOSTED]);
    expect(stored(p.list)).toEqual([DIRECT, HOSTED]);
    // Nothing to forget is no write; an unpaired daemon has nothing to write to.
    const before = p.writes();
    expect(writeBack.replaceTunnel(DAEMON, undefined)).toBe(false);
    expect(p.writes()).toBe(before);
    p.unpair();
    expect(writeBack.replaceTunnel(DAEMON, { kind: 'tunnel', tunnelUrl: TUNNEL.url })).toBe(false);
    expect(writeBack.holdsTunnel(DAEMON)).toBe(false);
  });

  test('R635 a stored set the contract no longer admits is left alone rather than rewritten around', () => {
    const p = paired([DIRECT, TUNNEL]);
    p.pair({ carriers: [DIRECT, { kind: 'carrier-from-the-future' }, TUNNEL] });
    const writeBack = carrierWriteBack(p.list);

    expect(writeBack.replaceTunnel(DAEMON, undefined)).toBe(false);
    expect(stored(p.list)).toEqual([DIRECT, { kind: 'carrier-from-the-future' }, TUNNEL]);
  });
});

describe('the background view writes back after the daemon answers, with no Connections screen drawn', () => {
  /** A client whose `CarriersChanged` and feed-live listeners are counted, so a leak is a number. */
  function fakeClient(answers: unknown[]) {
    const calls: string[] = [];
    const changed = new Set<() => void>();
    const live = new Set<(live: boolean) => void>();
    const client = {
      call: async (route: string) => {
        calls.push(route);
        const next = answers.length > 1 ? answers.shift() : answers[0];
        if (next instanceof Error) throw next;
        return next;
      },
      subscribe: (event: { readonly name: string }, listener: () => void) => {
        if (event.name !== CarriersChanged.name) return () => undefined;
        changed.add(listener);
        return () => void changed.delete(listener);
      },
      feed: {
        isLive: () => true,
        subscribeLive: (listener: (live: boolean) => void) => {
          live.add(listener);
          return () => void live.delete(listener);
        },
      },
    } as unknown as PluginClient;
    return {
      client,
      calls,
      change: () => void [...changed].forEach(listener => void listener()),
      feed: (isLive: boolean) => void [...live].forEach(listener => void listener(isLive)),
      listeners: () => changed.size + live.size,
    };
  }
  const settle = () => runAsync(async () => void (await new Promise(resolve => setTimeout(resolve, 5))));
  /** The background view as the shell mounts it for one paired daemon: nothing else of Connections is drawn. */
  const mountWatcher = (fake: ReturnType<typeof fakeClient>, list: StoredCarrierSets) => {
    const View = carrierWriteBackView(() => carrierWriteBack(list));
    return render(createElement(View, { daemon: DAEMON, client: fake.client }));
  };

  test('P51 R186 R198 R210 the stored set is replaced on mount, on a change event and when the feed goes live again, with no view drawn', async () => {
    const p = paired([DIRECT, SELF]);
    const fake = fakeClient([{ carriers: [DIRECT, HOSTED] }, { carriers: [DIRECT, SECOND] }, { carriers: [DIRECT] }]);
    mountWatcher(fake, p.list);
    await settle();
    // On mount: the daemon's answer replaces the set, and the relay it withdrew (SELF) is pruned (R198).
    expect(fake.calls).toEqual(['GET /v1/carriers']);
    expect(stored(p.list)).toEqual([DIRECT, HOSTED]);
    expect(daemonCarriers(p.list.get(DAEMON)!).some(m => m.kind === 'relay' && m.relayUrl === SELF.url)).toBe(false);
    // The daemon says its carriers changed.
    fake.change();
    await settle();
    expect(stored(p.list)).toEqual([DIRECT, SECOND]);
    // The feed drops (nothing to read) and comes back live (v4's `carrier.onConnected`): the answer is read again.
    fake.feed(false);
    await settle();
    expect(fake.calls).toHaveLength(2);
    fake.feed(true);
    await settle();
    expect(fake.calls).toHaveLength(3);
    expect(stored(p.list)).toEqual([DIRECT]);
  });

  test('P51 R186 R198 R210 the half Connections hands the shell mounts the write-back as a background view, wired to the shell’s stored list', async () => {
    const p = paired([DIRECT, SELF]);
    const ports = {
      openSocket: () => {
        throw new Error('nothing dials here');
      },
      after: () => {},
      now: () => 0,
      daemons: { registerCache: () => () => {}, get: p.list.get, setCarriers: p.list.setCarriers },
    } as unknown as ConnectPorts;
    const shell = (connections as unknown as { shell: import('@ferretry/app').ShellProvides }).shell;
    // The shell builds the half's connect parts once per document, and mounts what it provides as a background view.
    (shell as Required<import('@ferretry/app').ShellProvides>).carriers(ports);
    const view = shell.background?.['carrier-set'];
    if (view === undefined)
      throw new Error('Connections provides no background view: the stored set refreshes only when a screen is drawn');
    const fake = fakeClient([{ carriers: [DIRECT, HOSTED] }]);
    render(createElement(view, { daemon: DAEMON, client: fake.client }));
    await settle();
    expect(fake.calls).toEqual(['GET /v1/carriers']);
    expect(stored(p.list)).toEqual([DIRECT, HOSTED]);
  });

  test('P51 R186 the background view unsubscribes everything on unmount, and an answer still in flight writes nothing', async () => {
    const p = paired([DIRECT, SELF]);
    const fake = fakeClient([{ carriers: [DIRECT, HOSTED] }]);
    const mounted = mountWatcher(fake, p.list);
    expect(fake.listeners()).toBe(2);
    // Unmounted before the answer lands: the listeners are gone and the late answer is dropped.
    run(() => mounted.unmount());
    expect(fake.listeners()).toBe(0);
    await settle();
    expect(stored(p.list)).toEqual([DIRECT, SELF]);
    // Mounting again after an unmount leaves exactly one set of listeners, not an accumulation.
    for (let n = 0; n < 3; n += 1) {
      const again = mountWatcher(fake, p.list);
      expect(fake.listeners()).toBe(2);
      run(() => again.unmount());
    }
    expect(fake.listeners()).toBe(0);
  });

  test('P51 a failed or unreadable answer leaves the stored set alone', async () => {
    const p = paired([DIRECT, SELF]);
    for (const answer of [new Error('offline'), { carriers: 'nope' }, { carriers: [], extra: 1 }]) {
      const fake = fakeClient([answer]);
      mountWatcher(fake, p.list);
      await settle();
      expect(stored(p.list)).toEqual([DIRECT, SELF]);
    }
  });

  test('P51 a half rebuilt on every reconnect leaves no CarriersChanged listener, and its panel watches only while drawn', async () => {
    const fake = fakeClient([{ carriers: [DIRECT, HOSTED] }]);
    noteClientDaemon(fake.client, DAEMON);
    const halves = Array.from({ length: 3 }, () => buildConnectionsApp({ manifest, client: fake.client }));
    // Building a half reads nothing and listens to nothing: no screen is drawn.
    await settle();
    expect(fake.calls).toEqual([]);
    expect(fake.listeners()).toBe(0);
    // A drawn panel watches (one set of listeners); closing it releases them.
    const Panel = halves[0]!.panels.carrier;
    const mounted = render(createElement(Panel));
    await settle();
    expect(fake.calls).toEqual(['GET /v1/carriers']);
    expect(fake.listeners()).toBe(2);
    run(() => mounted.unmount());
    expect(fake.listeners()).toBe(0);
  });
});
