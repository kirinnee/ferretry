import { describe, expect, test } from 'bun:test';
import { DaemonClient } from '../../../src/client/daemon-client.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import { CORE, FakeTransport, inventoryOf, json } from './fixtures.ts';

/** A daemon that answers the plugin list with the name it is called right now. */
const calledBy = (name: () => string | undefined) =>
  new FakeTransport(request => {
    if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
    if (request.path !== '/v1/plugins') return json({}, 404);
    const named = name();
    return json({ ...(inventoryOf(CORE) as object), ...(named === undefined ? {} : { daemonName: named }) });
  });

const paired = { daemon: 'd1', machine: 'old-hostname', deviceId: 'dev-d1', address: 'http://127.0.0.1:40245' };

describe('a machine the owner renamed is called its new name on every device', () => {
  test('the plugin list carries the name, and the paired record follows it on the next read', async () => {
    let name: string | undefined = 'pebox';
    const list = new DaemonList({ storage: memoryStore(), now: () => 1 });
    list.add(paired);
    const client = new DaemonClient({
      transport: calledBy(() => name),
      surfaces: CORE,
      learnName: learned => list.learnMachine('d1', learned),
    });
    await client.start();
    expect(list.get('d1')?.machine).toBe('pebox');
    name = 'studio';
    await client.refresh();
    expect(list.get('d1')?.machine).toBe('studio');
    client.stop();
  });

  test('a daemon older than the field names nothing, and the record keeps the name it has', async () => {
    const learned: string[] = [];
    const client = new DaemonClient({
      transport: calledBy(() => undefined),
      surfaces: CORE,
      learnName: name => learned.push(name),
    });
    await client.start();
    expect(client.inventory?.kind).toBe('read');
    expect(learned).toEqual([]);
    client.stop();
  });

  test('an unreadable plugin list teaches nothing', async () => {
    const learned: string[] = [];
    const client = new DaemonClient({
      transport: new FakeTransport(request =>
        request.path === '/v1/health'
          ? json({ protocol: 1, version: '5.0.0' })
          : json({ protocol: 1, daemonName: 'pebox', plugins: 'not a list' }),
      ),
      surfaces: CORE,
      rereadAfterMs: [],
      learnName: name => learned.push(name),
    });
    await client.start();
    expect(learned).toEqual([]);
    client.stop();
  });
});
