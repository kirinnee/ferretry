import { describe, expect, test } from 'bun:test';
import { UNREADABLE_INVENTORY_SENTENCE, wholeDaemonSentence } from '../../../src/client/sentences.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../client/fixtures.ts';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

async function opened(plugins: (request: { path: string }) => ReturnType<typeof json> | Promise<never>) {
  const transport = new FakeTransport(request =>
    request.path === '/v1/plugins' ? plugins(request) : json({ protocol: 1, version: '5.0.0' }),
  );
  const daemons = new DaemonList({ storage: memoryStore(), now: () => 1 });
  daemons.add({ daemon: 'd1', machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
  const runtime = new ShellRuntime({ appVersion: '5.0.0', surfaces: CORE, daemons, connect: async () => transport });
  runtime.connection('d1');
  await settle();
  return runtime;
}

describe('the full-screen line tells a failed read from a different build', () => {
  test('a read that failed is not "reload": it says it could not read, and why', async () => {
    const runtime = await opened(() => Promise.reject(new Error('the carrier dropped')));
    expect(runtime.wholeDaemonLine('d1')).toBe(UNREADABLE_INVENTORY_SENTENCE);
    expect(runtime.wholeDaemonLine('d1')).not.toBe(wholeDaemonSentence('reload-app'));
    expect(runtime.wholeDaemonDetail('d1')).toBe('the plugin list this daemon sent could not be read');
  });

  test('a core piece with another contract keeps the reload sentence and names the piece', async () => {
    const runtime = await opened(() => json(inventoryOf(CORE, { gate: { contract: 'another' } })));
    expect(runtime.wholeDaemonLine('d1')).toBe(wholeDaemonSentence('reload-app'));
    expect(runtime.wholeDaemonDetail('d1')).toBe('gate has a different contract');
  });

  test('a daemon whose every core piece agrees shows neither', async () => {
    const runtime = await opened(() => json(inventoryOf(CORE)));
    expect(runtime.wholeDaemonLine('d1')).toBeUndefined();
    expect(runtime.wholeDaemonDetail('d1')).toBeUndefined();
  });
});
