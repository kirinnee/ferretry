import { expect, test } from 'bun:test';
import { DaemonClient } from '../../../src/client/daemon-client.ts';
import type { TransportAnswer } from '../../../src/client/transport.ts';
import { CORE, FakeTransport, inventoryOf, json, surface } from './fixtures.ts';
const board = surface('board', { routes: ['GET /v1/one', 'GET /v1/two', 'POST /v1/write'] });
const surfaces = [...CORE, board];
const locked = json({ error: 'Unlock this machine.', code: 'unlock_required' }, 401);
const daemon = {
  daemon: 'synthetic',
  machine: 'Synthetic',
  address: 'https://synthetic.example',
  deviceId: 'synthetic-device',
  carriers: [],
  pairedAt: 1,
  lastSelectedAt: 1,
};
test('E-35 another passive route waits on the known machine lock without sending; a press still sends', async () => {
  const transport = new FakeTransport(request =>
    request.path === '/v1/plugins'
      ? json(inventoryOf(surfaces))
      : request.path === '/v1/health'
        ? json({ protocol: 1, version: '5.0.0' })
        : locked,
  );
  const waits: ((yes: boolean) => void)[] = [];
  const client = new DaemonClient({
    transport,
    surfaces,
    personActing: () => false,
    passkey: {
      daemon,
      handler: {
        ask: async () => false,
        focus: () => {},
        locked: () => [],
        subscribe: () => () => {},
        need: a => (a.status === 401 ? { kind: 'unlock' } : undefined),
        confirm: () => new Promise(resolve => waits.push(resolve)),
      },
    },
  });
  await client.start();
  const one = client
    .forPackage('board')
    .call('GET /v1/one')
    .catch(() => undefined);
  await Bun.sleep(5);
  const two = client
    .forPackage('board')
    .call('GET /v1/two')
    .catch(() => undefined);
  await Bun.sleep(5);
  expect(transport.requests.filter(r => r.path === '/v1/two')).toHaveLength(0);
  const write = client
    .forPackage('board')
    .call('POST /v1/write')
    .catch(() => undefined);
  await Bun.sleep(5);
  expect(transport.requests.filter(r => r.path === '/v1/write')).toHaveLength(1);
  for (const resolve of waits) resolve(false);
  await Promise.all([one, two, write]);
  client.stop();
});
test('E-40 each bootstrap deadline aborts its actual request before another read starts', async () => {
  const seen: { path: string; signal?: AbortSignal }[] = [];
  const transport = new FakeTransport(request => {
    seen.push(request);
    return new Promise<TransportAnswer>(() => {});
  });
  const client = new DaemonClient({ transport, surfaces, bootstrapDeadlineMs: 5, rereadAfterMs: [] });
  await client.start();
  expect(seen.map(r => r.path)).toEqual(['/v1/plugins', '/v1/health']);
  expect(seen.every(r => r.signal?.aborted === true)).toBe(true);
  client.stop();
});

test('E-35 old-generation grants refusals cannot restore a lock after confirmation', async () => {
  let finish: ((answer: TransportAnswer) => void) | undefined;
  const transport = new FakeTransport(request =>
    request.path === '/v1/plugins'
      ? json(inventoryOf(surfaces))
      : request.path === '/v1/health'
        ? json({ protocol: 1, version: '5.0.0' })
        : request.path === '/v1/grants'
          ? new Promise(resolve => {
              finish = resolve;
            })
          : json({ ok: true }),
  );
  const client = new DaemonClient({
    transport,
    surfaces,
    personActing: () => false,
    passkey: {
      daemon,
      handler: {
        need: a => (a.status === 401 ? { kind: 'unlock' } : undefined),
        confirm: async () => false,
        ask: async () => false,
        focus: () => {},
        locked: () => [],
        subscribe: () => () => {},
      },
    },
  });
  await client.start();
  const old = client.readGrants({ noPause: true });
  await Bun.sleep(1);
  client.noteConfirmed();
  finish?.(locked);
  await old;
  expect(await client.forPackage('board').call('GET /v1/two')).toEqual({ ok: true });
  expect(transport.requests.filter(r => r.path === '/v1/two')).toHaveLength(1);
  client.stop();
});

test('E-35 a fresh successful grants read retires a lock opened in another tab', async () => {
  let unlocked = false;
  const transport = new FakeTransport(request =>
    request.path === '/v1/plugins'
      ? json(inventoryOf(surfaces))
      : request.path === '/v1/health'
        ? json({ protocol: 1, version: '5.0.0' })
        : unlocked
          ? json({ ok: true })
          : locked,
  );
  const client = new DaemonClient({
    transport,
    surfaces,
    personActing: () => false,
    passkey: {
      daemon,
      handler: {
        need: a => (a.status === 401 ? { kind: 'unlock' } : undefined),
        confirm: async () => false,
        ask: async () => false,
        focus: () => {},
        locked: () => [],
        subscribe: () => () => {},
      },
    },
  });
  await client.start();
  await client.readGrants({ noPause: true });
  unlocked = true;
  await client.readGrants({ noPause: true });
  expect(await client.forPackage('board').call('GET /v1/two')).toEqual({ ok: true });
  client.stop();
});

test('E-35 proof routes stay readable while the machine is known locked', async () => {
  const access = surface('access', { routes: ['GET /v1/passkeys'] });
  Object.assign(access.manifest.actions?.routes?.[0] ?? {}, { unlockExempt: true });
  const entries = [...surfaces, access];
  const transport = new FakeTransport(request =>
    request.path === '/v1/plugins'
      ? json(inventoryOf(entries))
      : request.path === '/v1/grants'
        ? locked
        : json({ ok: true }),
  );
  const client = new DaemonClient({
    transport,
    surfaces: entries,
    personActing: () => false,
    passkey: {
      daemon,
      handler: {
        need: a => (a.status === 401 ? { kind: 'unlock' } : undefined),
        confirm: async () => false,
        ask: async () => false,
        focus: () => {},
        locked: () => [],
        subscribe: () => () => {},
      },
    },
  });
  await client.start();
  await client.readGrants({ noPause: true });
  expect(await client.forPackage('access').call('GET /v1/passkeys')).toEqual({ ok: true });
  expect(transport.requests.filter(r => r.path === '/v1/passkeys')).toHaveLength(1);
  client.stop();
});
