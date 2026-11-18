import { afterEach, describe, expect, test } from 'bun:test';
import {
  deviceRefusedSentence,
  UNREADABLE_INVENTORY_SENTENCE,
  wholeDaemonSentence,
} from '../../../src/client/sentences.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../client/fixtures.ts';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

// A failed read is asked again on a timer (DaemonClient's re-read), so every runtime is unpaired after its test: a
// timer left running would fire inside whichever test the same process runs next.
const openedLists: DaemonList[] = [];

afterEach(() => {
  for (const daemons of openedLists.splice(0)) daemons.remove('d1');
});

async function opened(plugins: (request: { path: string }) => ReturnType<typeof json> | Promise<never>) {
  const transport = new FakeTransport(request =>
    request.path === '/v1/plugins' ? plugins(request) : json({ protocol: 1, version: '5.0.0' }),
  );
  const daemons = new DaemonList({ storage: memoryStore(), now: () => 1 });
  openedLists.push(daemons);
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
    expect(runtime.wholeDaemonDetail('d1')).toBe('the carrier dropped');
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

describe("a refused plugin list says it was refused, with the daemon's own reason", () => {
  test('a 403 names the refusal, the reason and the code: it is NOT "could not read"', async () => {
    const runtime = await opened(() =>
      json(
        { error: 'this daemon cannot say what this device may do, so it is refusing', code: 'grant_undetermined' },
        403,
      ),
    );
    expect(runtime.wholeDaemonLine('d1')).toBe(
      'This device was refused: this daemon cannot say what this device may do, so it is refusing.',
    );
    expect(runtime.wholeDaemonLine('d1')).not.toBe(UNREADABLE_INVENTORY_SENTENCE);
    expect(runtime.wholeDaemonDetail('d1')).toBe('the daemon answered 403 grant_undetermined');
  });

  test('a 401 with no reason still says refused, and that the daemon did not say why', async () => {
    const runtime = await opened(() => json({}, 401));
    expect(runtime.wholeDaemonLine('d1')).toBe('This device was refused: the daemon did not say why.');
    expect(runtime.wholeDaemonDetail('d1')).toBe('the daemon answered 401');
  });

  test('another status is told by its number and code, not as a damaged list', async () => {
    const runtime = await opened(() => json({ error: 'busy starting', code: 'busy' }, 503));
    expect(runtime.wholeDaemonLine('d1')).toBe(UNREADABLE_INVENTORY_SENTENCE);
    expect(runtime.wholeDaemonDetail('d1')).toBe('the daemon answered 503 busy: busy starting');
  });

  test('a 200 that is not a plugin list is the ONE case that stays "could not be read"', async () => {
    const runtime = await opened(() => json({ protocol: 1, plugins: 'not a list' }));
    expect(runtime.wholeDaemonLine('d1')).toBe(UNREADABLE_INVENTORY_SENTENCE);
    // The headline is unchanged; the Why says WHERE it did not fit (a path and an issue code, never a value).
    expect(runtime.wholeDaemonDetail('d1')).toBe(
      'the plugin list this daemon sent could not be read (does not fit at plugins: wrong type)',
    );
  });

  test('the first issues name the field path and kind, never a value', async () => {
    const entry = { id: 'kernel', on: true, contract: 'x'.repeat(200) };
    const long = await opened(() => json({ protocol: 1, plugins: [{ id: 'a', on: true, contract: 'ok' }, entry] }));
    expect(long.wholeDaemonDetail('d1')).toBe(
      'the plugin list this daemon sent could not be read (does not fit at plugins[1].contract: too long)',
    );
    expect(long.wholeDaemonDetail('d1')).not.toContain('xxxx');
    const extra = await opened(() =>
      json({ protocol: 1, plugins: [{ id: 'a', on: true, contract: 'ok', member: 'h' }] }),
    );
    expect(extra.wholeDaemonDetail('d1')).toBe(
      'the plugin list this daemon sent could not be read (does not fit at plugins[0]: unexpected field (member))',
    );
    const missing = await opened(() => json({ protocol: 1, plugins: [{ id: 'a', contract: 'ok' }] }));
    expect(missing.wholeDaemonDetail('d1')).toBe(
      'the plugin list this daemon sent could not be read (does not fit at plugins[0].on: wrong type)',
    );
  });

  test('a body that is not even an object with a protocol number says what it was', async () => {
    const runtime = await opened(() => json('<html>502</html>'));
    expect(runtime.wholeDaemonDetail('d1')).toBe(
      'the plugin list this daemon sent could not be read (the answer was a string with no protocol number)',
    );
  });

  test('a read that failed with no sentence of its own names what kind of failure it was', async () => {
    const empty = await opened(() => Promise.reject(new Error('')));
    expect(empty.wholeDaemonDetail('d1')).toBe('the read failed before an answer came (Error)');
    const bare = await opened(() => Promise.reject('closed' as never));
    expect(bare.wholeDaemonDetail('d1')).toBe('the read failed before an answer came (string)');
  });

  test('the sentence ends in exactly one full stop', () => {
    expect(deviceRefusedSentence('this device is revoked.')).toBe('This device was refused: this device is revoked.');
    expect(deviceRefusedSentence(undefined)).toBe('This device was refused: the daemon did not say why.');
  });
});
