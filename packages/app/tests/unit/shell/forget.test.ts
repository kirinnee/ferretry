import { describe, expect, test } from 'bun:test';
import type { TransportRequest } from '../../../src/client/transport.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { RelaySessionError } from '../../../src/session/session-client.ts';
import { RELAY_CLOSE_CODES } from '../../../src/session/wire/index.ts';
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

  test('S12 a daemon answering "device revoked" goes through the same unpair path: forget fires once there', async () => {
    const forgotten: string[] = [];
    const surfaces = [...CORE, withShell('conversation', { forget: (daemon: string) => void forgotten.push(daemon) })];
    const refusing = new FakeTransport(() => {
      throw new RelaySessionError('unknown device credential', RELAY_CLOSE_CODES.authRejected);
    });
    const fine = new FakeTransport((request: TransportRequest) =>
      request.path === '/v1/plugins' ? json(inventoryOf(surfaces)) : json({ protocol: 1, version: '5.0.0' }),
    );
    const daemons = new DaemonList({ storage: memoryStore(), now: () => 1 });
    const base = { machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' };
    daemons.add({ ...base, daemon: 'revoked' });
    daemons.add({ ...base, daemon: 'fine' });
    const runtime = new ShellRuntime({
      appVersion: '5.0.0',
      surfaces,
      daemons,
      connect: async paired => (paired.daemon === 'revoked' ? refusing : fine),
    });
    runtime.connection('revoked');
    runtime.connection('fine');
    await settle();
    expect(daemons.get('revoked')).toBeUndefined();
    expect(daemons.get('fine')).toBeDefined(); // another machine's pairing is never touched
    expect(forgotten).toEqual(['revoked']);
  });
});
