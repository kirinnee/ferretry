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
import type { PairedDaemon } from '@ferretry/app';
import { noteClientDaemon } from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { daemonCarriers } from '../../../app/carriers/router.ts';
import { buildConnectionsApp } from '../../../app/index.ts';
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

describe('the app half writes back after the daemon answers', () => {
  function fakeClient(answers: unknown[]) {
    const calls: string[] = [];
    let changed: (() => void) | undefined;
    const client = {
      call: async (route: string) => {
        calls.push(route);
        const next = answers.length > 1 ? answers.shift() : answers[0];
        if (next instanceof Error) throw next;
        return next;
      },
      subscribe: (event: { readonly name: string }, listener: () => void) => {
        if (event.name === CarriersChanged.name) changed = listener;
        return () => undefined;
      },
    } as unknown as PluginClient;
    return { client, calls, change: () => changed?.() };
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));

  test('P51 R186 R210 building the half reads GET /v1/carriers and replaces the stored set; a change event refreshes it again', async () => {
    const p = paired([DIRECT, SELF]);
    const fake = fakeClient([{ carriers: [DIRECT, HOSTED] }, { carriers: [DIRECT, SECOND] }]);
    noteClientDaemon(fake.client, DAEMON);
    buildConnectionsApp({ manifest, client: fake.client }, undefined, undefined, carrierWriteBack(p.list));
    await settle();
    expect(fake.calls).toEqual(['GET /v1/carriers']);
    expect(stored(p.list)).toEqual([DIRECT, HOSTED]);
    fake.change();
    await settle();
    expect(stored(p.list)).toEqual([DIRECT, SECOND]);
  });

  test('P51 a failed or unreadable answer leaves the stored set alone', async () => {
    const p = paired([DIRECT, SELF]);
    for (const answer of [new Error('offline'), { carriers: 'nope' }, { carriers: [], extra: 1 }]) {
      const fake = fakeClient([answer]);
      noteClientDaemon(fake.client, DAEMON);
      buildConnectionsApp({ manifest, client: fake.client }, undefined, undefined, carrierWriteBack(p.list));
      await settle();
      expect(stored(p.list)).toEqual([DIRECT, SELF]);
    }
  });
});
