import { afterEach, describe, expect, test } from 'bun:test';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { RelaySessionError } from '../../../src/session/session-client.ts';
import { RELAY_CLOSE_CODES } from '../../../src/session/wire/index.ts';
import { describeStop, type StopKind, stopOf } from '../../../src/shell/machine-stop.ts';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../client/fixtures.ts';

/**
 * THE STATE MAPPING of the full-page "cannot use this machine" screen: every end state the runtime can be in for a machine
 * maps to exactly one page, and a machine that works (or only has one plugin blocked) maps to none.
 */

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

// A failed or refused read is asked again on a timer, so every pairing is removed after its test.
const openedLists: DaemonList[] = [];
afterEach(() => {
  for (const daemons of openedLists.splice(0)) daemons.remove('d1');
});

async function runtimeOf(options: {
  readonly plugins?: (request: { path: string }) => ReturnType<typeof json> | Promise<never>;
  readonly everything?: () => never;
  readonly appVersion?: string;
  readonly noTransport?: boolean;
}): Promise<ShellRuntime> {
  const transport = new FakeTransport(request => {
    if (options.everything !== undefined) return options.everything();
    return request.path === '/v1/plugins' && options.plugins !== undefined
      ? options.plugins(request)
      : request.path === '/v1/plugins'
        ? json(inventoryOf(CORE))
        : json({ protocol: 1, version: '5.0.0' });
  });
  const daemons = new DaemonList({ storage: memoryStore(), now: () => 1 });
  openedLists.push(daemons);
  daemons.add({ daemon: 'd1', machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
  const runtime = new ShellRuntime({
    appVersion: options.appVersion ?? '5.0.0',
    surfaces: CORE,
    daemons,
    connect: async () => (options.noTransport === true ? undefined : transport),
  });
  runtime.connection('d1');
  await settle();
  return runtime;
}

describe('which end state a machine is in', () => {
  test('a session closed with 4403 is "refused", and the pairing is untouched', async () => {
    const runtime = await runtimeOf({
      everything: () => {
        throw new RelaySessionError('unknown device credential', RELAY_CLOSE_CODES.authRejected);
      },
    });
    expect(stopOf(runtime, 'd1')).toEqual({ kind: 'refused', machine: 'laptop' });
    expect(runtime.daemons.get('d1')).toBeDefined();
  });

  test('a plugin list answered 403 is "turned away", with the machine’s own reason and status', async () => {
    const runtime = await runtimeOf({
      plugins: () => json({ error: 'this device is revoked.', code: 'revoked' }, 403),
    });
    expect(stopOf(runtime, 'd1')).toEqual({
      kind: 'turned-away',
      machine: 'laptop',
      status: 403,
      reason: 'this device is revoked.',
    });
  });

  test('a 401 with no reason is still "turned away", not an unreadable list', async () => {
    const runtime = await runtimeOf({ plugins: () => json({}, 401) });
    expect(stopOf(runtime, 'd1')).toEqual({ kind: 'turned-away', machine: 'laptop', status: 401 });
  });

  test('a read that failed on the way is "unreadable" and names why', async () => {
    const runtime = await runtimeOf({ plugins: () => Promise.reject(new Error('the carrier dropped')) });
    expect(stopOf(runtime, 'd1')).toEqual({ kind: 'unreadable', machine: 'laptop', detail: 'the carrier dropped' });
  });

  test('the machine’s own "update this app" (4426) is "needs-reload", not an unreadable list with a Reload button', async () => {
    const message = 'this app speaks a version the daemon does not';
    const runtime = await runtimeOf({
      plugins: () => Promise.reject(new RelaySessionError(message, RELAY_CLOSE_CODES.versionUnsupported)),
    });
    expect(stopOf(runtime, 'd1')).toEqual({ kind: 'needs-reload', machine: 'laptop', detail: message });
  });

  test('a 200 that is not a plugin list is "unreadable" too', async () => {
    const runtime = await runtimeOf({ plugins: () => json({ protocol: 1, plugins: 'nope' }) });
    expect(stopOf(runtime, 'd1')?.kind).toBe('unreadable');
  });

  test('a core piece of another build on a machine that is not older than the app is "needs-reload"', async () => {
    const runtime = await runtimeOf({ plugins: () => json(inventoryOf(CORE, { gate: { contract: 'another' } })) });
    expect(stopOf(runtime, 'd1')).toEqual({
      kind: 'needs-reload',
      machine: 'laptop',
      detail: 'gate has a different contract',
    });
  });

  test('the same piece on a machine OLDER than the app is "needs-update"', async () => {
    const runtime = await runtimeOf({
      appVersion: '5.1.0',
      plugins: () => json(inventoryOf(CORE, { gate: { contract: 'another' } })),
    });
    expect(stopOf(runtime, 'd1')?.kind).toBe('needs-update');
  });

  test('a pairing this browser cannot open any session for is "no-key"', async () => {
    const runtime = await runtimeOf({ noTransport: true });
    expect(stopOf(runtime, 'd1')).toEqual({ kind: 'no-key', machine: 'laptop' });
  });

  test('a machine this browser holds no pairing for is "not-paired", with no name to give', async () => {
    const runtime = await runtimeOf({});
    expect(stopOf(runtime, 'somebody-else')).toEqual({ kind: 'not-paired', machine: undefined });
  });

  test('a machine that works has no stop page', async () => {
    const runtime = await runtimeOf({});
    expect(stopOf(runtime, 'd1')).toBeUndefined();
  });
});

describe('the words of each page', () => {
  const kinds: readonly StopKind[] = [
    'refused',
    'turned-away',
    'no-key',
    'unreadable',
    'needs-update',
    'needs-reload',
    'not-paired',
  ];

  test.each(kinds)('%s: a plain headline with no code in it, a reason, one main button and a reference line', kind => {
    const stop = describeStop({
      kind,
      machine: kind === 'not-paired' ? undefined : 'laptop',
      status: 403,
      reason: 'x',
    });
    expect(stop.headline).not.toMatch(/\d/u);
    expect(stop.why.length).toBeGreaterThan(20);
    expect(stop.primary.label.length).toBeGreaterThan(0);
    expect(stop.reference.startsWith('Reference: ')).toBe(true);
  });

  test('the refused page says what the owner asked: not connected any more, removed or unused too long, Pair again', () => {
    const stop = describeStop({ kind: 'refused', machine: 'laptop' });
    expect(stop.headline).toBe("This browser isn't connected to laptop any more");
    expect(stop.why).toContain('removed');
    expect(stop.why).toContain('unused for too long');
    expect(stop.primary).toEqual({ action: 'pair-again', label: 'Pair again' });
  });

  test('the no-key sentence fits all three causes: key gone, key unreadable, no route to the machine', () => {
    const why = describeStop({ kind: 'no-key', machine: 'laptop' }).why;
    expect(why).toContain('gone (site data cleared) or unreadable');
    expect(why).toContain('no route to it is available');
  });

  test('a machine’s own sentence ends in exactly one full stop', () => {
    expect(describeStop({ kind: 'turned-away', machine: 'laptop', reason: 'revoked. ' }).why).toContain(
      'It said: revoked. Pairing',
    );
    expect(describeStop({ kind: 'turned-away', machine: 'laptop' }).why).toContain('It did not say why.');
  });

  test('only the update page shows a command, and it is the one the sentences own', () => {
    expect(describeStop({ kind: 'needs-update', machine: 'laptop' }).command).toBe('fy update');
    expect(describeStop({ kind: 'needs-reload', machine: 'laptop' }).command).toBeUndefined();
  });
});
