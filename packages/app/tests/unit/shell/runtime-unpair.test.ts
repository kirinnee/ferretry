import { describe, expect, test } from 'bun:test';
import type { TransportRequest } from '../../../src/client/transport.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../client/fixtures.ts';

/** A transport that records being closed, as a session transport does (it owns the request lanes' sessions). */
class ClosableTransport extends FakeTransport {
  closed = 0;
  close(): void {
    this.closed += 1;
  }
}

const surfaces: SurfaceEntry[] = [...CORE];

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

describe('unpairing a daemon', () => {
  test('R568 the shell closes the transport it opened, so no request lane outlives the pairing', async () => {
    const transport = new ClosableTransport((request: TransportRequest) =>
      request.path === '/v1/plugins'
        ? json(inventoryOf(surfaces, {}))
        : json({ error: 'none', code: 'not_found' }, 404),
    );
    const daemons = new DaemonList({ storage: memoryStore(), now: () => 1 });
    daemons.add({ daemon: 'd1', machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
    const runtime = new ShellRuntime({ appVersion: '5.0.0', surfaces, daemons, connect: async () => transport });
    runtime.connection('d1');
    await settle();
    expect(runtime.connection('d1').kind).toBe('connected');
    expect(transport.closed).toBe(0);
    daemons.remove('d1');
    expect(transport.closed).toBe(1);
  });
});
