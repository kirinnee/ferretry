import { describe, expect, test } from 'bun:test';
import { DaemonClient } from '../../../src/client/daemon-client.ts';
import { CORE, FakeTransport, inventoryOf, json } from './fixtures.ts';

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`waited 2000 ms for ${what}`);
    await wait(2);
  }
};

/** A daemon whose plugin list fails `failures` times (as `how` says) and then answers. */
function flaky(failures: number, how: 'throw' | 'status' | 'damaged') {
  let failed = 0;
  return new FakeTransport(request => {
    if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
    if (request.path !== '/v1/plugins') return json({}, 404);
    if (failed < failures) {
      failed += 1;
      if (how === 'throw') throw new Error('the carrier dropped');
      if (how === 'status') return json({ error: 'busy', code: 'busy' }, 503);
      return json({ protocol: 1, plugins: 'not a list' });
    }
    return json(inventoryOf(CORE));
  });
}

const pluginReads = (transport: FakeTransport): number =>
  transport.requests.filter(request => request.path === '/v1/plugins').length;

describe('a plugin list that failed to read is asked again, not left as the verdict', () => {
  for (const how of ['throw', 'status', 'damaged'] as const) {
    test(`${how}: unreadable first, then read by itself`, async () => {
      const transport = flaky(2, how);
      const client = new DaemonClient({ transport, surfaces: CORE, rereadAfterMs: [5] });
      await client.start();
      expect(client.inventory?.kind).toBe('unreadable');
      await until(() => client.inventory?.kind === 'read', 'the plugin list to be read again');
      expect(pluginReads(transport)).toBe(3);
      for (const entry of CORE) expect(client.standing(entry.id)).toEqual({ state: 'allowed' });
      // An answered read stops the asking.
      await wait(30);
      expect(pluginReads(transport)).toBe(3);
      client.stop();
    });
  }

  test('the wait grows through the list and the last one repeats', async () => {
    const transport = flaky(99, 'throw');
    const client = new DaemonClient({ transport, surfaces: CORE, rereadAfterMs: [5, 40] });
    await client.start();
    await until(() => pluginReads(transport) >= 3, 'three reads');
    expect(client.inventory?.kind).toBe('unreadable');
    client.stop();
  });

  test('stopping the client cancels the next read', async () => {
    const transport = flaky(99, 'throw');
    const client = new DaemonClient({ transport, surfaces: CORE, rereadAfterMs: [20] });
    await client.start();
    client.stop();
    await wait(80);
    expect(pluginReads(transport)).toBe(1);
  });

  test('an empty wait list reads once', async () => {
    const transport = flaky(99, 'throw');
    const client = new DaemonClient({ transport, surfaces: CORE, rereadAfterMs: [] });
    await client.start();
    await wait(40);
    expect(pluginReads(transport)).toBe(1);
    client.stop();
  });

  test('a protocol mismatch is an answer: it is not asked again', async () => {
    const transport = new FakeTransport(request =>
      request.path === '/v1/plugins' ? json({ protocol: 2, plugins: [] }) : json({ protocol: 2, version: '9.0.0' }),
    );
    const client = new DaemonClient({ transport, surfaces: CORE, rereadAfterMs: [5] });
    await client.start();
    await wait(40);
    expect(client.inventory?.kind).toBe('protocol-mismatch');
    expect(pluginReads(transport)).toBe(1);
    client.stop();
  });
});
