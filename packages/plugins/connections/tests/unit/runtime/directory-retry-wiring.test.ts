/**
 * A DIRECTORY THAT FAILED AT BOOT IS ASKED AGAIN, AND THE DAEMON PICKS THE RELAY UP BY ITSELF.
 *
 * The defect: the hosted relay directory was read once per boot, so a network that was not up yet
 * right after a restart left the daemon direct-only until the next restart. These cases drive the
 * real plugin build with a scripted directory and the test host's driven clock — no real timers,
 * no network — and assert what a person would notice: the relay is dialled without a restart, the
 * published set and the doctor row move with it, and a definitive answer is never asked twice.
 */

import { describe, expect, test } from 'bun:test';
import type { SessionLayer } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '../../../../../core/kernel/testing/host.ts';
import { ConnectionsPort } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';
import { buildConnections, type ConnectionBindings } from '../../../daemon/index.ts';
import type { RelayAdvertisement, RelayDirectoryPort } from '../../../daemon/lib/relay/discovery.ts';
import type { RelayWebSocket } from '../../../daemon/adapters/relay/bun-relay-carrier.ts';
import { FakeSessions } from '../../support/sessions.ts';

const identity = {
  daemonId: 'fy_daemon_' + 'a'.repeat(43),
  sign: async () => ({ daemonId: 'fy_daemon_' + 'a'.repeat(43), publicKey: 'A'.repeat(59), signature: 'A'.repeat(86) }),
};
const transient: RelayAdvertisement = {
  kind: 'undetermined',
  reason: 'this daemon could not reach the relay directory',
  retry: {},
};
const available: RelayAdvertisement = { kind: 'available', relayUrl: 'https://hosted.example' };
const MINUTE = 60_000;

/** A directory that answers its script in order, remembers every read, and can hold one read open. */
function scriptedDirectory(script: Array<RelayAdvertisement | Promise<RelayAdvertisement>>) {
  const signals: AbortSignal[] = [];
  let reads = 0;
  const port: RelayDirectoryPort = {
    read: async signal => {
      reads += 1;
      if (signal !== undefined) signals.push(signal);
      const next = script.shift();
      if (next === undefined) throw new Error('the script ran out');
      return await next;
    },
  };
  return { port, reads: () => reads, signals };
}

function build(directory: RelayDirectoryPort, extra: Partial<ConnectionBindings> = {}) {
  const dialled: string[] = [];
  let half: ReturnType<typeof buildConnections> | undefined;
  const plugin = implementDaemon(manifest, {
    build: ctx =>
      (half = buildConnections(ctx, {
        identity,
        openSession: (layer, key, peer) => layer.open(key, peer),
        directUrl: 'https://box.example',
        host: '127.0.0.1',
        port: 7431,
        directory,
        socketFactory: url => {
          dialled.push(url);
          const socket: RelayWebSocket = {
            binaryType: '',
            onopen: null,
            onmessage: null,
            onclose: null,
            onerror: null,
            send: () => undefined,
            close: () => undefined,
          };
          return socket;
        },
        ...extra,
      })),
  });
  return { plugin, dialled, half: () => half! };
}

async function doctorRow(half: ReturnType<typeof buildConnections>) {
  return await half.hooks['doctor.checks']()[0]!.item.run();
}

const kinds = (host: Awaited<ReturnType<typeof testHost>>) =>
  host
    .provided(ConnectionsPort)
    .carriers()
    .map(carrier => carrier.kind);

describe('recovery from a directory that failed at boot', () => {
  test('should start the relay carrier by itself once the directory answers, with no restart', async () => {
    const directory = scriptedDirectory([transient, transient, available]);
    const rig = build(directory.port);
    const host = await testHost({ plugins: [rig.plugin] });
    await host.runJob('relay-discovery');
    await rig.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);

    // Booted direct-only, still asking.
    expect(directory.reads()).toBe(1);
    expect(kinds(host)).toEqual(['direct']);
    expect(rig.dialled).toEqual([]);

    await host.clock.advance(2_000);
    expect(directory.reads()).toBe(2);
    expect(rig.dialled).toEqual([]);
    await host.clock.advance(4_000);
    await host.clock.advance(0);

    expect(directory.reads()).toBe(3);
    expect(rig.dialled).toHaveLength(1);
    expect(rig.dialled[0]).toContain('hosted.example');
    expect(kinds(host)).toEqual(['direct', 'relay']);
    expect(rig.half().resolvers.relay()).toEqual(['hosted.example']);
    expect(host.provided(ConnectionsPort).advertisement().discoveredRelayUrl).toBe('https://hosted.example');
    await host.stop();
  });

  test('should dial exactly as a first-read success would when recovery lands before the carrier starts', async () => {
    const directory = scriptedDirectory([transient, available]);
    const rig = build(directory.port);
    const host = await testHost({ plugins: [rig.plugin] });
    await host.runJob('relay-discovery');
    await host.clock.advance(2_000);
    expect(rig.dialled).toEqual([]);
    await rig.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);
    expect(rig.dialled).toHaveLength(1);
    expect(kinds(host)).toEqual(['direct', 'relay']);
    await host.stop();
  });

  test('should flip the doctor row and the notice from retrying to discovered on recovery', async () => {
    const directory = scriptedDirectory([transient, available]);
    const rig = build(directory.port);
    const host = await testHost({ plugins: [rig.plugin] });
    await host.runJob('relay-discovery');
    await rig.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);

    const waiting = await doctorRow(rig.half());
    expect(waiting.detail).toContain('retrying in the background');
    expect(waiting.detail).toMatch(/next try at \d\d:\d\d:\d\dZ/u);
    expect(waiting.detail).not.toContain('restart to ask the hosted relay directory again');
    const trail = host.logs.map(entry => entry.message).join('\n');
    expect(trail).toContain('retrying in the background');
    expect(trail).not.toContain('restart to ask the hosted relay directory again');

    await host.clock.advance(2_000);
    await host.clock.advance(0);

    const recovered = await doctorRow(rig.half());
    expect(recovered.detail).toContain('hosted — https://hosted.example, from Ferretry’s runtime advertisement');
    expect(recovered.detail).not.toContain('retrying');
    expect(host.logs.map(entry => entry.message)).toContain('dialling the relay — https://hosted.example');
    await host.stop();
  });

  test('should keep retrying through a long outage and say so each time', async () => {
    const directory = scriptedDirectory(Array.from({ length: 6 }, () => transient));
    const rig = build(directory.port);
    const host = await testHost({ plugins: [rig.plugin] });
    await host.runJob('relay-discovery');
    // The driven clock gives a fired timer one microtask turn and a retry needs several, so time is stepped.
    for (let elapsed = 0; elapsed < 10 * MINUTE; elapsed += 5_000) {
      await host.clock.advance(5_000);
      for (let tick = 0; tick < 20; tick++) await Promise.resolve();
    }
    // 2 s, 4 s, 8 s, … → at least the six scripted failures happen inside ten minutes, and a daemon whose
    // script ran out (a read that throws) is still just "transient": it keeps waiting rather than giving up.
    expect(directory.reads()).toBeGreaterThanOrEqual(6);
    expect((await doctorRow(rig.half())).detail).toContain('retrying in the background');
    expect(rig.dialled).toEqual([]);
    await host.stop();
  });

  test('should never ask again after a definitive answer', async () => {
    const answers: RelayAdvertisement[] = [
      { kind: 'disabled' },
      { kind: 'undetermined', reason: 'the relay directory answered a document this daemon cannot read' },
      { kind: 'undetermined', reason: 'the relay directory answered 404' },
      { kind: 'undetermined', reason: 'this build carries no relay directory to ask' },
    ];
    for (const answer of answers) {
      const directory = scriptedDirectory([answer]);
      const rig = build(directory.port);
      const host = await testHost({ plugins: [rig.plugin] });
      await host.runJob('relay-discovery');
      await host.clock.advance(60 * MINUTE);
      expect(directory.reads()).toBe(1);
      expect(kinds(host)).toEqual(['direct']);
      expect((await doctorRow(rig.half())).detail).not.toContain('retrying');
      await host.stop();
    }
  });

  test('should stop asking after a definitive answer that follows transient ones', async () => {
    const directory = scriptedDirectory([transient, { kind: 'disabled' }]);
    const rig = build(directory.port);
    const host = await testHost({ plugins: [rig.plugin] });
    await host.runJob('relay-discovery');
    await host.clock.advance(60 * MINUTE);
    expect(directory.reads()).toBe(2);
    expect(rig.dialled).toEqual([]);
    expect((await doctorRow(rig.half())).detail).toContain('switched off');
    await host.stop();
  });

  test('should not read the directory at all when the operator wrote a relay, enabled or not', async () => {
    for (const relay of [{ url: 'https://mine.example' }, { url: 'https://mine.example', enabled: false }]) {
      const directory = scriptedDirectory([transient]);
      const rig = build(directory.port);
      const host = await testHost({ plugins: [rig.plugin], config: { 'connections.yaml': { relay: [relay] } } });
      await host.runJob('relay-discovery');
      await host.clock.advance(60 * MINUTE);
      expect(directory.reads()).toBe(0);
      await host.stop();
    }
  });

  test('should stop retrying, and never apply the discovered relay, once an explicit relay is written meanwhile', async () => {
    const directory = scriptedDirectory([transient, available]);
    const rig = build(directory.port);
    const host = await testHost({ plugins: [rig.plugin] });
    await host.runJob('relay-discovery');
    await rig.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);
    host.setConfig('connections.yaml', { relay: [{ url: 'https://mine.example', enabled: false }] });
    await host.clock.advance(60 * MINUTE);
    expect(directory.reads()).toBe(1);
    expect(rig.dialled).toEqual([]);
    expect(kinds(host)).toEqual(['direct']);
    await host.stop();
  });

  test('should cancel the pending retry when the daemon stops', async () => {
    const directory = scriptedDirectory([transient, available]);
    const rig = build(directory.port);
    const host = await testHost({ plugins: [rig.plugin] });
    await host.runJob('relay-discovery');
    const pending = host.clock.pending();
    await host.stop();
    expect(host.clock.pending()).toBeLessThan(pending);
    await host.clock.advance(60 * MINUTE);
    expect(directory.reads()).toBe(1);
    expect(rig.dialled).toEqual([]);
  });

  test('should abort a read in flight when the daemon stops, and apply nothing it answers', async () => {
    let answer!: (value: RelayAdvertisement) => void;
    const inFlight = new Promise<RelayAdvertisement>(resolve => (answer = resolve));
    const directory = scriptedDirectory([transient, inFlight]);
    const rig = build(directory.port);
    const host = await testHost({ plugins: [rig.plugin] });
    await host.runJob('relay-discovery');
    await rig.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);
    await host.clock.advance(2_000);
    expect(directory.reads()).toBe(2);
    expect(directory.signals[1]!.aborted).toBe(false);
    await host.stop();
    expect(directory.signals[1]!.aborted).toBe(true);
    answer(available);
    await host.clock.advance(60 * MINUTE);
    expect(rig.dialled).toEqual([]);
    expect(kinds(host)).toEqual(['direct']);
  });

  test('should not dial after the carrier’s own signal aborted', async () => {
    const directory = scriptedDirectory([transient, available]);
    const rig = build(directory.port);
    const host = await testHost({ plugins: [rig.plugin] });
    await host.runJob('relay-discovery');
    const controller = new AbortController();
    await rig.half().hooks['carriers:relay'].start(new FakeSessions(), controller.signal);
    controller.abort();
    await host.clock.advance(2_000);
    await host.clock.advance(0);
    expect(rig.dialled).toEqual([]);
    await host.stop();
  });
});

describe('boot is never held by the directory', () => {
  test('should serve and publish its direct address while the first read has not resolved', async () => {
    const never = new Promise<RelayAdvertisement>(() => {});
    const directory = scriptedDirectory([never]);
    const rig = build(directory.port);
    const host = await testHost({ plugins: [rig.plugin] });
    void host.runJob('relay-discovery');
    await Promise.resolve();
    expect(directory.reads()).toBe(1);
    expect(kinds(host)).toEqual(['direct']);
    expect(host.provided(ConnectionsPort).advertisement().appOrigin).toBeDefined();
    await host.stop();
  });

  test('should retry from the job, never from build: building schedules nothing', async () => {
    const directory = scriptedDirectory([transient, available]);
    const rig = build(directory.port);
    const host = await testHost({ plugins: [rig.plugin] });
    const before = host.clock.pending();
    await host.clock.advance(60 * MINUTE);
    expect(directory.reads()).toBe(0);
    expect(host.clock.pending()).toBe(before);
    await host.stop();
  });

  test('should ignore the layer type: a bare layer is enough to start the carrier', async () => {
    const directory = scriptedDirectory([available]);
    const rig = build(directory.port);
    const host = await testHost({ plugins: [rig.plugin] });
    await rig.half().hooks['carriers:relay'].start(new FakeSessions() as SessionLayer, new AbortController().signal);
    expect(rig.dialled).toHaveLength(1);
    await host.stop();
  });
});
