/**
 * ONE GATE DECIDES WHETHER A DISCOVERED RELAY MAY BE PUBLISHED OR DIALLED, AND IT IS ASKED AT THE LAST MOMENT.
 *
 * Three rounds of review found the same defect in a new place each time: a path that published or dialled the
 * discovered relay across an `await` without asking again whether the operator had meanwhile switched discovery off
 * (or stopped the daemon, or broken the file). These cases pin the structure instead of the call sites:
 *
 * - every dial path asks — the boot carrier start after `initialise`, a sibling start after the previous start's
 *   `await`, a recovery that lands before the carrier starts, a recovery after the timer fires;
 * - a configuration that cannot be read vetoes (the REAL config service over a memory filesystem, because the kernel
 *   answers `undefined` or the last good version for such a file, never an exception);
 * - the carrier's stop signal aborts discovery SYNCHRONOUSLY, the first read included, and a late first answer
 *   publishes nothing — a configured sibling included.
 *
 * Fake directory and sockets, the test host's driven clock, no network.
 */

import { describe, expect, test } from 'bun:test';
import type { Clock, ConfigFileDef, ConfigPort, Log } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { createConfigFiles } from '../../../../../core/kernel/host/config/service.ts';
import { createMemoryHostFs } from '../../../../../core/kernel/host/state/memory-fs.ts';
import { testHost } from '../../../../../core/kernel/testing/host.ts';
import { buildConnections } from '../../../daemon/index.ts';
import type { RelayAdvertisement } from '../../../daemon/lib/relay/discovery.ts';
import manifest from '../../../manifest.ts';
import { FakeSessions } from '../../support/sessions.ts';

const identity = {
  daemonId: `fy_daemon_${'a'.repeat(43)}`,
  sign: async () => ({ daemonId: `fy_daemon_${'a'.repeat(43)}`, publicKey: 'A'.repeat(59), signature: 'A'.repeat(86) }),
};
const available: RelayAdvertisement = { kind: 'available', relayUrl: 'https://hosted.example' };
const transient: RelayAdvertisement = { kind: 'undetermined', reason: 'network unavailable', retry: {} };
const disabled = { relay: [{ source: 'discovery', enabled: false }] };
const mixed = { relay: [{ url: 'https://mine.example' }, { source: 'discovery' }] };
/** The config service's timers are never needed here: a clock that never fires, and a log that keeps nothing. */
const idleClock: Pick<Clock, 'nowMs' | 'after' | 'every'> = {
  nowMs: () => 1_000_000,
  after: () => () => undefined,
  every: () => () => undefined,
};
const quietLog: Log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quietLog,
};
const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
};

interface RigOptions {
  /** Called for every read of the connections configuration. */
  readonly onConfigRead?: () => void;
  /** Called as a relay socket is opened. */
  readonly onSocket?: () => void;
  /** The real configuration port to read, instead of the test host's. */
  readonly port?: ConfigPort;
}

function rig(read: (signal?: AbortSignal) => Promise<RelayAdvertisement>, options: RigOptions = {}) {
  let half: ReturnType<typeof buildConnections> | undefined;
  const sockets: string[] = [];
  const plugin = implementDaemon(manifest, {
    build: ctx => {
      const port = options.port ?? ctx.kernel.config;
      const built = buildConnections(
        {
          ...ctx,
          kernel: {
            ...ctx.kernel,
            config: {
              ...ctx.kernel.config,
              file: (def: never) => {
                const value = port.file(def);
                options.onConfigRead?.();
                return value;
              },
              fileState: (def: never) => port.fileState(def),
            },
          },
        } as never,
        {
          identity,
          openSession: (layer, key, peer) => layer.open(key, peer),
          directUrl: 'https://box.example',
          host: '127.0.0.1',
          port: 7431,
          directory: { read },
          socketFactory: url => {
            sockets.push(url);
            options.onSocket?.();
            return {
              binaryType: '',
              onopen: null,
              onmessage: null,
              onclose: null,
              onerror: null,
              send: () => {},
              close: () => {},
            };
          },
        },
      );
      half = built;
      return built;
    },
  });
  return { plugin, half: () => half!, sockets };
}

const carrierKinds = (half: ReturnType<typeof buildConnections>) =>
  half.provides.connections.carriers().map(c => c.kind);

describe('every dial path asks the gate after its last await', () => {
  test('should dial nothing when discovery is switched off after recovery but before the carrier starts', async () => {
    let reads = 0;
    const r = rig(async () => (++reads === 1 ? transient : available));
    const host = await testHost({ plugins: [r.plugin] });
    try {
      await host.runJob('relay-discovery');
      await host.clock.advance(2_000);
      await flush();
      host.setConfig('connections.yaml', disabled);
      await r.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);
      expect(r.sockets).toEqual([]);
      // Nothing it published still names the hosted relay, and nothing resolves its host for an outbound call.
      expect(carrierKinds(r.half())).toEqual(['direct']);
      expect(r.half().resolvers.relay()).toEqual([]);
    } finally {
      await host.stop();
    }
  });

  test('should dial nothing when discovery is switched off while the carrier start awaits the first read', async () => {
    let armed = false;
    let changed = false;
    let host!: Awaited<ReturnType<typeof testHost>>;
    const r = rig(async () => available, {
      onConfigRead: () => {
        if (!armed || changed) return;
        changed = true;
        queueMicrotask(() => host.setConfig('connections.yaml', disabled));
      },
    });
    host = await testHost({ plugins: [r.plugin] });
    try {
      armed = true;
      await r.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);
      expect(changed).toBe(true);
      expect(r.sockets).toEqual([]);
      expect(carrierKinds(r.half())).toEqual(['direct']);
      expect(r.half().resolvers.relay()).toEqual([]);
    } finally {
      await host.stop();
    }
  });

  test('should not dial the discovered sibling when discovery is switched off during the configured relay’s start', async () => {
    let changed = false;
    let host!: Awaited<ReturnType<typeof testHost>>;
    const r = rig(async () => available, {
      onSocket: () => {
        if (changed) return;
        changed = true;
        queueMicrotask(() =>
          host.setConfig('connections.yaml', {
            relay: [{ url: 'https://mine.example' }, { source: 'discovery', enabled: false }],
          }),
        );
      },
    });
    host = await testHost({ plugins: [r.plugin], config: { 'connections.yaml': mixed } });
    try {
      await r.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);
      // The configured relay the operator wrote keeps its behaviour; only the discovered one is vetoed.
      expect(r.sockets).toHaveLength(1);
      expect(r.sockets[0]).toContain('mine.example');
      expect(r.half().resolvers.relay()).toEqual(['mine.example']);
      expect(carrierKinds(r.half())).toEqual(['direct', 'relay']);
    } finally {
      await host.stop();
    }
  });

  test('should still dial a configured relay the operator wrote when the discovered sibling is vetoed', async () => {
    let host!: Awaited<ReturnType<typeof testHost>>;
    const r = rig(async () => available);
    host = await testHost({ plugins: [r.plugin], config: { 'connections.yaml': mixed } });
    try {
      host.setConfig('connections.yaml', {
        relay: [{ url: 'https://mine.example' }, { source: 'discovery', enabled: false }],
      });
      await r.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);
      expect(r.sockets).toHaveLength(1);
      expect(r.sockets[0]).toContain('mine.example');
    } finally {
      await host.stop();
    }
  });

  test('should dial the recovered relay when nothing changed (the gate does not over-veto)', async () => {
    let reads = 0;
    const r = rig(async () => (++reads === 1 ? transient : available));
    const host = await testHost({ plugins: [r.plugin] });
    try {
      await host.runJob('relay-discovery');
      await r.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);
      await host.clock.advance(2_000);
      await flush();
      expect(r.sockets).toHaveLength(1);
      expect(r.sockets[0]).toContain('hosted.example');
    } finally {
      await host.stop();
    }
  });
});

describe('a veto withdraws the discovered relay from everything the daemon promises', () => {
  /** Published carriers, the advertisement the pairing mint / doctor / `fyd --check` read, and the outbound permission. */
  const promisesNothing = (half: ReturnType<typeof buildConnections>): void => {
    expect(half.provides.connections.carriers()).toEqual([{ kind: 'direct', url: 'https://box.example' }]);
    expect(half.provides.connections.advertisement().discoveredRelayUrl).toBeUndefined();
    expect(half.resolvers.relay()).toEqual([]);
  };
  const promisesTheHostedRelay = (half: ReturnType<typeof buildConnections>): void => {
    expect(carrierKinds(half)).toContain('relay');
    expect(half.provides.connections.advertisement().discoveredRelayUrl).toBe('https://hosted.example');
  };

  test('should promise nothing when the veto lands after the boot answer published the relay and before the first dial', async () => {
    const r = rig(async () => available);
    const host = await testHost({ plugins: [r.plugin] });
    try {
      await host.runJob('relay-discovery');
      promisesTheHostedRelay(r.half());
      host.setConfig('connections.yaml', disabled);
      await r.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);
      expect(r.sockets).toEqual([]);
      promisesNothing(r.half());
    } finally {
      await host.stop();
    }
  });

  test('should promise nothing when the veto lands before the boot answer is applied', async () => {
    let host!: Awaited<ReturnType<typeof testHost>>;
    const r = rig(async () => {
      host.setConfig('connections.yaml', disabled);
      return available;
    });
    host = await testHost({ plugins: [r.plugin] });
    try {
      await host.runJob('relay-discovery');
      await r.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);
      expect(r.sockets).toEqual([]);
      promisesNothing(r.half());
    } finally {
      await host.stop();
    }
  });

  test('should promise nothing when the veto lands after a recovery published the relay and before it dials', async () => {
    let reads = 0;
    const r = rig(async () => (++reads === 1 ? transient : available));
    const host = await testHost({ plugins: [r.plugin] });
    try {
      await host.runJob('relay-discovery');
      await host.clock.advance(2_000);
      await flush();
      promisesTheHostedRelay(r.half());
      host.setConfig('connections.yaml', mixed);
      await r.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);
      // The operator's own relay may dial; the hosted one was never dialled and is promised nowhere.
      expect(r.sockets.every(url => !url.includes('hosted.example'))).toBe(true);
      expect(r.half().provides.connections.advertisement().discoveredRelayUrl).toBeUndefined();
      expect(r.half().resolvers.relay().includes('hosted.example')).toBe(false);
    } finally {
      await host.stop();
    }
  });

  test('should promise nothing when a recovery answer arrives after the operator disabled discovery', async () => {
    let reads = 0;
    const r = rig(async () => (++reads === 1 ? transient : available));
    const host = await testHost({ plugins: [r.plugin] });
    try {
      await host.runJob('relay-discovery');
      host.setConfig('connections.yaml', disabled);
      await host.clock.advance(2_000);
      await flush();
      await r.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);
      expect(r.sockets).toEqual([]);
      promisesNothing(r.half());
    } finally {
      await host.stop();
    }
  });

  test('should promise nothing when the file becomes invalid after boot, before the first dial (real config service)', async () => {
    const fs = createMemoryHostFs();
    const def = manifest.data.config[0] as ConfigFileDef<unknown>;
    const home = '/home/fy-relay-gate-promise';
    fs.seed(`${home}/config/connections.yaml`, 'relay:\n  - source: discovery\n');
    const files = createConfigFiles({
      home,
      fs,
      clock: idleClock,
      log: quietLog,
      binary: 'fy',
      defs: [{ plugin: 'connections', def }],
    });
    await files.reload();
    const r = rig(async () => available, { port: files.port('connections') });
    const host = await testHost({ plugins: [r.plugin] });
    try {
      await host.runJob('relay-discovery');
      promisesTheHostedRelay(r.half());
      fs.seed(`${home}/config/connections.yaml`, 'relay: [');
      await files.reload();
      await r.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);
      expect(r.sockets).toEqual([]);
      promisesNothing(r.half());
    } finally {
      await host.stop();
    }
  });
});

describe('a configuration that cannot be read vetoes (the real config service)', () => {
  const home = '/home/fy-relay-gate';
  async function realService(initial?: string) {
    const fs = createMemoryHostFs();
    const def = manifest.data.config[0] as ConfigFileDef<unknown>;
    const files = createConfigFiles({
      home,
      fs,
      clock: idleClock,
      log: quietLog,
      binary: 'fy',
      defs: [{ plugin: 'connections', def }],
    });
    if (initial !== undefined) fs.seed(`${home}/config/connections.yaml`, initial);
    await files.reload();
    return { fs, files, def, port: files.port('connections') };
  }
  const oversized = '#'.repeat(300_000);

  test('should dial nothing when the file became unreadable and the boot had no file (undefined in effect)', async () => {
    const service = await realService();
    let reads = 0;
    const r = rig(async () => (++reads === 1 ? transient : available), { port: service.port });
    const host = await testHost({ plugins: [r.plugin] });
    try {
      await host.runJob('relay-discovery');
      await r.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);
      service.fs.seed(`${home}/config/connections.yaml`, oversized);
      await service.files.reload();
      expect(service.port.fileState(service.def).state).toBe('invalid');
      expect(service.port.file(service.def)).toBeUndefined();
      await host.clock.advance(2_000);
      await flush();
      expect(r.sockets).toEqual([]);
      expect(carrierKinds(r.half())).toEqual(['direct']);
    } finally {
      await host.stop();
    }
  });

  test('should dial nothing when the file became unreadable and its last good version still says the same (equal in effect)', async () => {
    const service = await realService('relay:\n  - source: discovery\n');
    let reads = 0;
    const r = rig(async () => (++reads === 1 ? transient : available), { port: service.port });
    const host = await testHost({ plugins: [r.plugin] });
    try {
      await host.runJob('relay-discovery');
      await r.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);
      service.fs.seed(`${home}/config/connections.yaml`, oversized);
      await service.files.reload();
      // The last accepted version is still in effect and equal to the boot list; the file itself is not readable.
      expect(service.port.fileState(service.def).state).toBe('invalid');
      expect(service.port.file(service.def)).toEqual({
        relay: [{ source: 'discovery', enabled: true, reconnectSeconds: expect.anything() }],
      } as never);
      await host.clock.advance(2_000);
      await flush();
      expect(r.sockets).toEqual([]);
    } finally {
      await host.stop();
    }
  });

  test('should dial nothing when the file is already unreadable at boot', async () => {
    const service = await realService(oversized);
    const r = rig(async () => available, { port: service.port });
    const host = await testHost({ plugins: [r.plugin] });
    try {
      await host.runJob('relay-discovery');
      await r.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);
      expect(r.sockets).toEqual([]);
      expect(carrierKinds(r.half())).toEqual(['direct']);
      expect(r.half().resolvers.relay()).toEqual([]);
    } finally {
      await host.stop();
    }
  });

  const lastGood = 'relay:\n  - source: discovery\n';
  const broken = 'relay: [';

  test('should dial the accepted last good discovery relay when the boot already starts with an invalid file', async () => {
    const service = await realService(lastGood);
    service.fs.seed(`${home}/config/connections.yaml`, broken);
    await service.files.reload();
    expect(service.port.fileState(service.def)).toMatchObject({ state: 'invalid', inEffect: true });
    const r = rig(async () => available, { port: service.port });
    const host = await testHost({ plugins: [r.plugin] });
    try {
      await host.runJob('relay-discovery');
      await r.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);
      expect(r.sockets).toHaveLength(1);
      expect(r.sockets[0]).toContain('hosted.example');
    } finally {
      await host.stop();
    }
  });

  test('should recover and dial from the accepted last good list when the boot read was transient and the file is still the same broken one', async () => {
    const service = await realService(lastGood);
    service.fs.seed(`${home}/config/connections.yaml`, broken);
    await service.files.reload();
    let reads = 0;
    const r = rig(async () => (++reads === 1 ? transient : available), { port: service.port });
    const host = await testHost({ plugins: [r.plugin] });
    try {
      await host.runJob('relay-discovery');
      await r.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);
      await host.clock.advance(2_000);
      await flush();
      expect(r.sockets).toHaveLength(1);
    } finally {
      await host.stop();
    }
  });

  test('should dial nothing when the last good boot is followed by an explicit disable after boot', async () => {
    const service = await realService(lastGood);
    service.fs.seed(`${home}/config/connections.yaml`, broken);
    await service.files.reload();
    let reads = 0;
    const r = rig(async () => (++reads === 1 ? transient : available), { port: service.port });
    const host = await testHost({ plugins: [r.plugin] });
    try {
      await host.runJob('relay-discovery');
      await r.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);
      service.fs.seed(`${home}/config/connections.yaml`, 'relay:\n  - source: discovery\n    enabled: false\n');
      await service.files.reload();
      expect(service.port.fileState(service.def).state).toBe('valid');
      await host.clock.advance(2_000);
      await flush();
      expect(r.sockets).toEqual([]);
      expect(carrierKinds(r.half())).toEqual(['direct']);
    } finally {
      await host.stop();
    }
  });

  test('should dial nothing when a valid boot is followed by a broken file before the carrier starts', async () => {
    const service = await realService(lastGood);
    expect(service.port.fileState(service.def).state).toBe('valid');
    const r = rig(async () => available, { port: service.port });
    const host = await testHost({ plugins: [r.plugin] });
    try {
      await host.runJob('relay-discovery');
      // The file breaks after boot and before the discovered carrier is built: the last good version is in effect, yet
      // the corruption first appeared during this boot, so it vetoes.
      service.fs.seed(`${home}/config/connections.yaml`, broken);
      await service.files.reload();
      expect(service.port.fileState(service.def)).toMatchObject({ state: 'invalid', inEffect: true });
      await r.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);
      expect(r.sockets).toEqual([]);
      expect(carrierKinds(r.half())).toEqual(['direct']);
      expect(r.half().resolvers.relay()).toEqual([]);
    } finally {
      await host.stop();
    }
  });

  test('should stop pending discovery when a valid boot is followed by an unreadable file', async () => {
    const service = await realService(lastGood);
    let reads = 0;
    const r = rig(async () => (++reads === 1 ? transient : available), { port: service.port });
    const host = await testHost({ plugins: [r.plugin] });
    try {
      await host.runJob('relay-discovery');
      await r.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);
      service.fs.seed(`${home}/config/connections.yaml`, broken);
      await service.files.reload();
      await host.clock.advance(2_000);
      await flush();
      await host.clock.advance(120_000);
      await flush();
      expect(reads).toBe(1);
      expect(r.sockets).toEqual([]);
    } finally {
      await host.stop();
    }
  });

  test('should still dial when the boot had no file at all (absent is not unreadable)', async () => {
    const service = await realService();
    expect(service.port.fileState(service.def).state).toBe('absent');
    const r = rig(async () => available, { port: service.port });
    const host = await testHost({ plugins: [r.plugin] });
    try {
      await host.runJob('relay-discovery');
      await r.half().hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);
      expect(r.sockets).toHaveLength(1);
    } finally {
      await host.stop();
    }
  });
});

describe('the carrier stop signal aborts discovery synchronously', () => {
  test('should abort the FIRST directory read the moment the carrier signal aborts, before any slower teardown', async () => {
    let resolve!: (answer: RelayAdvertisement) => void;
    let requestSignal: AbortSignal | undefined;
    const pending = new Promise<RelayAdvertisement>(r => (resolve = r));
    const r = rig(async signal => {
      requestSignal = signal;
      return await pending;
    });
    const host = await testHost({ plugins: [r.plugin] });
    const controller = new AbortController();
    const start = r.half().hooks['carriers:relay'].start(new FakeSessions(), controller.signal);
    await flush();
    expect(requestSignal?.aborted).toBe(false);
    controller.abort();
    try {
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      resolve(available);
      await start;
      await host.stop();
    }
  });

  test('should publish nothing, a configured sibling included, when the first answer arrives after the carrier signal aborted', async () => {
    let resolve!: (answer: RelayAdvertisement) => void;
    const pending = new Promise<RelayAdvertisement>(r => (resolve = r));
    const r = rig(async () => await pending);
    const host = await testHost({ plugins: [r.plugin], config: { 'connections.yaml': mixed } });
    const controller = new AbortController();
    const start = r.half().hooks['carriers:relay'].start(new FakeSessions(), controller.signal);
    await flush();
    controller.abort();
    resolve(available);
    await start;
    try {
      expect(carrierKinds(r.half())).toEqual(['direct']);
      expect(r.half().resolvers.relay()).toEqual([]);
      expect(r.sockets).toEqual([]);
    } finally {
      await host.stop();
    }
  });

  test('should publish nothing when a transient first answer arrives after the carrier signal aborted', async () => {
    let resolve!: (answer: RelayAdvertisement) => void;
    const pending = new Promise<RelayAdvertisement>(r => (resolve = r));
    const reads: number[] = [];
    const r = rig(async () => {
      reads.push(reads.length);
      return await pending;
    });
    const host = await testHost({ plugins: [r.plugin], config: { 'connections.yaml': mixed } });
    const controller = new AbortController();
    const start = r.half().hooks['carriers:relay'].start(new FakeSessions(), controller.signal);
    await flush();
    controller.abort();
    resolve(transient);
    await start;
    try {
      await host.clock.advance(60_000);
      await flush();
      expect(reads).toEqual([0]);
      expect(carrierKinds(r.half())).toEqual(['direct']);
      expect(r.sockets).toEqual([]);
    } finally {
      await host.stop();
    }
  });

  test('should abort the first read when the daemon stops without a carrier signal ever aborting', async () => {
    let requestSignal: AbortSignal | undefined;
    let resolve!: (answer: RelayAdvertisement) => void;
    const pending = new Promise<RelayAdvertisement>(r => (resolve = r));
    const r = rig(async signal => {
      requestSignal = signal;
      return await pending;
    });
    const host = await testHost({ plugins: [r.plugin] });
    const job = host.runJob('relay-discovery');
    await flush();
    expect(requestSignal?.aborted).toBe(false);
    const stopping = host.stop();
    resolve(available);
    await Promise.allSettled([job, stopping]);
    expect(requestSignal?.aborted).toBe(true);
    expect(carrierKinds(r.half())).toEqual(['direct']);
  });

  test('should abort a retry read in flight the moment the carrier signal aborts', async () => {
    const signals: AbortSignal[] = [];
    let reads = 0;
    let resolve!: (answer: RelayAdvertisement) => void;
    const pending = new Promise<RelayAdvertisement>(r => (resolve = r));
    const r = rig(async signal => {
      if (signal !== undefined) signals.push(signal);
      return ++reads === 1 ? transient : await pending;
    });
    const host = await testHost({ plugins: [r.plugin] });
    const controller = new AbortController();
    try {
      await host.runJob('relay-discovery');
      await r.half().hooks['carriers:relay'].start(new FakeSessions(), controller.signal);
      await host.clock.advance(2_000);
      await flush();
      expect(signals).toHaveLength(2);
      expect(signals[1]?.aborted).toBe(false);
      controller.abort();
      expect(signals[1]?.aborted).toBe(true);
    } finally {
      resolve(available);
      await flush();
      await host.stop();
    }
    expect(r.sockets).toEqual([]);
  });
});
