import { describe, expect, spyOn, test } from 'bun:test';
import { DEVICE_NOT_ACCEPTED_SENTENCE } from '../../../src/client/sentences.ts';
import type { TransportRequest } from '../../../src/client/transport.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { type CarrierSocketEvents, SessionTransport } from '../../../src/session/session-transport.ts';
import { RELAY_CLOSE_CODES } from '../../../src/session/wire/index.ts';
import { controlFrame, newDaemonIdentity, relayCrypto, testDevice, testSessionId } from '../../../src/testing/relay.ts';
import { registeredForgets } from '../../../src/connect/provides.ts';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { CORE, FakeTransport, inventoryOf, json, surface } from '../client/fixtures.ts';

const withShell = (id: string, shell: object | undefined, skeleton = false): SurfaceEntry =>
  ({ ...surface(id), app: shell === undefined ? undefined : { skeleton, shell } }) as unknown as SurfaceEntry;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

describe('S12 forget', () => {
  test('S12 registeredForgets lists the halves that provide one, never a skeleton or a half without', () => {
    const forget = () => {};
    const found = registeredForgets([
      withShell('conversation', { forget }),
      withShell('agenda', {}),
      withShell('board', { forget }, true),
      surface('terminals'),
    ]);
    expect(found.map(entry => entry.plugin)).toEqual(['conversation']);
  });

  test('S12 every plugin forget gets the id only, once, on an unpair; a re-pair never calls it', async () => {
    const calls: unknown[][] = [];
    const surfaces = [
      ...CORE,
      withShell('conversation', { forget: (...args: unknown[]) => void calls.push(['conversation', ...args]) }),
      withShell('agenda', {
        forget: (...args: unknown[]) => {
          calls.push(['agenda', ...args]);
          throw new Error('agenda failed');
        },
      }),
      withShell('board', { forget: (...args: unknown[]) => Promise.reject(calls.push(['board', ...args])) }),
    ];
    const daemons = new DaemonList({ storage: memoryStore(), now: () => 1 });
    new ShellRuntime({ appVersion: '5.0.0', surfaces, daemons, connect: async () => undefined });
    const input = { daemon: 'd1', machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' };
    daemons.add(input);
    daemons.add(input);
    await settle();
    expect(calls).toEqual([]);
    daemons.remove('d1');
    await settle();
    // each failure costs only its own plugin; the id is the only argument
    expect(calls).toEqual([
      ['conversation', 'd1'],
      ['agenda', 'd1'],
      ['board', 'd1'],
    ]);
  });

  /**
   * C1: a `4403` is a cleartext word a relay can forge (docs/relay-protocol.md), so it NEVER unpairs. Each test drives the
   * REAL session transport and session client through one of the three ways a `4403` reaches the browser: a WebSocket
   * close, the rendezvous `closed` message and the rendezvous `error` message.
   */
  const sources: readonly (readonly [string, (events: CarrierSocketEvents) => void])[] = [
    ['a WebSocket close', events => queueMicrotask(() => events.onClose(RELAY_CLOSE_CODES.authRejected, 'forged'))],
    [
      'a rendezvous closed message',
      events =>
        queueMicrotask(() =>
          events.onBinary(
            controlFrame(testSessionId(), { t: 'closed', code: RELAY_CLOSE_CODES.authRejected, reason: 'forged' }),
          ),
        ),
    ],
    [
      'a rendezvous error message',
      events =>
        queueMicrotask(() =>
          events.onBinary(
            controlFrame(testSessionId(), { t: 'error', code: RELAY_CLOSE_CODES.authRejected, reason: 'forged' }),
          ),
        ),
    ],
  ];

  for (const [source, refuse] of sources) {
    test(`C1 a 4403 from ${source} never unpairs, deletes no key and forgets nothing; the page stops dialling and offers to pair again`, async () => {
      const forgotten: string[] = [];
      const keysDeleted: string[] = [];
      const surfaces = [
        ...CORE,
        withShell('conversation', { forget: (daemon: string) => void forgotten.push(daemon) }),
      ];
      const identity = await newDaemonIdentity();
      const device = await testDevice('dev');
      let dials = 0;
      const refusing = new SessionTransport({
        crypto: relayCrypto,
        daemonId: identity.daemonId,
        device: device.claim,
        dial: events => {
          dials += 1;
          refuse(events);
          return { send() {}, sendText() {}, close() {} };
        },
      });
      const fine = new FakeTransport((request: TransportRequest) =>
        request.path === '/v1/plugins' ? json(inventoryOf(surfaces)) : json({ protocol: 1, version: '5.0.0' }),
      );
      const daemons = new DaemonList({
        storage: memoryStore(),
        now: () => 1,
        forget: daemon => void keysDeleted.push(daemon),
      });
      const remove = spyOn(daemons, 'remove');
      const base = { machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' };
      daemons.add({ ...base, daemon: 'refused' });
      daemons.add({ ...base, daemon: 'fine' });
      const runtime = new ShellRuntime({
        appVersion: '5.0.0',
        surfaces,
        daemons,
        connect: async paired => (paired.daemon === 'refused' ? refusing : fine),
      });
      runtime.connection('refused');
      runtime.connection('fine');
      await settle();

      // Nothing the person owns is touched: the pairing, its key and every plugin's state stay.
      expect(remove).not.toHaveBeenCalled();
      expect(daemons.get('refused')).toBeDefined();
      expect(keysDeleted).toEqual([]);
      expect(forgotten).toEqual([]);
      // The page says so, and stops dialling that machine; the other machine is untouched.
      expect(runtime.isRefused('refused')).toBe(true);
      expect(runtime.wholeDaemonLine('refused')).toBe(DEVICE_NOT_ACCEPTED_SENTENCE);
      expect(runtime.blockedLine('refused', 'conversation')).toBe(DEVICE_NOT_ACCEPTED_SENTENCE);
      expect(runtime.connection('refused').kind).toBe('refused');
      expect(runtime.isRefused('fine')).toBe(false);
      expect(runtime.wholeDaemonLine('fine')).toBeUndefined();
      const dialled = dials;
      runtime.connection('refused');
      await settle();
      expect(dials).toBe(dialled);
    });
  }
});
