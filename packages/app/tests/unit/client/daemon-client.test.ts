import { describe, expect, test } from 'bun:test';
import { defineEvent } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { DaemonClient, fillPath } from '../../../src/client/daemon-client.ts';
import { DaemonCallError, type TransportRequest } from '../../../src/client/transport.ts';
import { CORE, FakeTransport, inventoryOf, json, surface } from './fixtures.ts';

const board = surface('board', {
  routes: ['GET /v1/board', 'GET /v1/board/:id'],
  sockets: ['GET /v1/board/stream', 'GET /v1/board/:id/stream'],
});
const agenda = surface('agenda', { routes: ['GET /v1/agenda'] });
const compiled = [...CORE, board, agenda];
const BoardChanged = defineEvent('board.changed', z.strictObject({ id: z.string() }));
const AgendaChanged = defineEvent('agenda.changed', z.strictObject({ n: z.number() }));

function daemon(inventory: unknown = inventoryOf(compiled)) {
  const transport = new FakeTransport((request: TransportRequest) => {
    if (request.path === '/v1/plugins') return json(inventory);
    if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
    if (request.path === '/v1/board/F%201') return json({ id: 'F 1' });
    if (request.path === '/v1/board') return json({ cards: [] });
    return json({ error: 'No such thing.', code: 'not_found' }, 404);
  });
  const client = new DaemonClient({ transport, surfaces: compiled });
  return { transport, client };
}

const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));

describe('fillPath', () => {
  test('substitutes and encodes parameters', () => {
    expect(fillPath('/v1/board/:id', { id: 'F 1' })).toBe('/v1/board/F%201');
    expect(() => fillPath('/v1/board/:id')).toThrow('needs the parameter "id"');
  });

  test('refuses a parameter that is a dot segment or holds a slash, so it cannot reach another route', () => {
    for (const id of ['.', '..', 'a/b', '../stream'])
      expect(() => fillPath('/v1/board/:id/stream', { id })).toThrow(/cannot be "\." or "\.\." or hold a "\/"/u);
    expect(fillPath('/v1/board/:id/stream', { id: '..a' })).toBe('/v1/board/..a/stream');
  });
});

describe('the bootstrap read', () => {
  test('the first call is the inventory; a call made before it waits unsent', async () => {
    const { transport, client } = daemon();
    const early = client.forPackage('board').call('GET /v1/board');
    await flush();
    expect(transport.requests).toHaveLength(0);
    await client.start();
    expect(await early).toEqual({ cards: [] });
    expect(transport.paths()).toEqual(['GET /v1/plugins', 'GET /v1/health', 'GET /v1/board']);
    expect(client.daemonVersion).toBe('5.0.0');
  });

  test('no event stream opens before the bootstrap read', async () => {
    const { transport, client } = daemon();
    client.forPackage('board').subscribe(BoardChanged, () => {});
    expect(transport.eventStreams).toBe(0);
    await client.start();
    expect(transport.eventStreams).toBe(1);
  });
});

describe('the guard', () => {
  test('a blocked package fails plugin_paused without sending', async () => {
    const { transport, client } = daemon(inventoryOf(compiled, { board: { contract: 'other' } }));
    await client.start();
    const sent = transport.requests.length;
    const failure = await client
      .forPackage('board')
      .call('GET /v1/board')
      .catch(e => e);
    expect(failure).toBeInstanceOf(DaemonCallError);
    expect((failure as DaemonCallError).code).toBe('plugin_paused');
    expect(transport.requests.length).toBe(sent);
  });

  test("a call to another package's route is guarded by that owner too", async () => {
    const { client } = daemon(inventoryOf(compiled, { board: { on: false } }));
    await client.start();
    const failure = await client
      .forPackage('agenda')
      .call('GET /v1/board')
      .catch(e => e);
    expect((failure as DaemonCallError).code).toBe('plugin_paused');
    expect(
      await client
        .forPackage('agenda')
        .call('GET /v1/agenda')
        .catch(e => e.code),
    ).toBe('not_found');
  });

  test('an undeclared route is a programming error', async () => {
    const { client } = daemon();
    await client.start();
    await expect(client.forPackage('board').call('GET /v1/nowhere')).rejects.toThrow('no compiled manifest');
  });

  test('a daemon refusal carries its code and sentence', async () => {
    const { client } = daemon();
    await client.start();
    const failure = (await client
      .forPackage('agenda')
      .call('GET /v1/agenda')
      .catch(e => e)) as DaemonCallError;
    expect([failure.status, failure.code, failure.message]).toEqual([404, 'not_found', 'No such thing.']);
    expect(failure.body).toEqual({ error: 'No such thing.', code: 'not_found' });
  });

  test('a socket of a blocked package is refused, and an open one closes when it becomes blocked', async () => {
    let inventory = inventoryOf(compiled);
    const { transport, client } = daemon();
    transport.answer = request =>
      request.path === '/v1/plugins' ? json(inventory) : json({ protocol: 1, version: '5.0.0' });
    await client.start();
    const closed: string[] = [];
    client.forPackage('board').socket('GET /v1/board/stream', {}, { onFrame: () => {}, onClose: r => closed.push(r) });
    expect(transport.sockets).toHaveLength(1);
    inventory = inventoryOf(compiled, { board: { contract: 'new' } });
    transport.emit({ name: 'kernel.plugins-changed', payload: { generation: 2 } });
    await client.refresh();
    expect(transport.sockets[0]?.closed).toBe(true);
    expect(closed).toEqual(['plugin_paused']);
    expect(() =>
      client.forPackage('board').socket('GET /v1/board/stream', {}, { onFrame: () => {}, onClose: () => {} }),
    ).toThrow('paused');
  });

  test('a socket carries its query onto the opened path, encoded, and params still fill only the placeholders', async () => {
    const { transport, client } = daemon();
    await client.start();

    client
      .forPackage('board')
      .socket(
        'GET /v1/board/stream',
        {},
        { onFrame: () => {}, onClose: () => {} },
        { after: '3', sessionId: 'a b&c=d' },
      );
    client.forPackage('board').socket('GET /v1/board/stream', {}, { onFrame: () => {}, onClose: () => {} });

    expect(transport.sockets.map(open => open.path)).toEqual([
      '/v1/board/stream?after=3&sessionId=a+b%26c%3Dd',
      '/v1/board/stream',
    ]);
  });

  test('a socket route fills its :param, and a query with ?, #, &, = and non-ASCII in keys and values cannot leave the query', async () => {
    const { transport, client } = daemon();
    await client.start();

    client
      .forPackage('board')
      .socket(
        'GET /v1/board/:id/stream',
        { id: 'F 1' },
        { onFrame: () => {}, onClose: () => {} },
        { 'k&x=y?z#w': 'a?b#c/d&e=f', kéy: 'välue ✓' },
      );

    const opened = transport.sockets.map(open => open.path);
    expect(opened).toHaveLength(1);
    const url = new URL(opened[0] ?? '', 'http://daemon.test');
    expect(url.pathname).toBe('/v1/board/F%201/stream');
    expect(url.hash).toBe('');
    expect([...url.searchParams.entries()]).toEqual([
      ['k&x=y?z#w', 'a?b#c/d&e=f'],
      ['kéy', 'välue ✓'],
    ]);
    for (const encoded of ['%3F', '%23', '%26', '%3D', '%2F', '%C3%A9', '%E2%9C%93'])
      expect(opened[0]).toContain(encoded);
    expect((opened[0] ?? '').match(/\?/gu)).toHaveLength(1);
  });

  test('a socket parameter that is a dot segment is refused at once, nothing is opened', async () => {
    const { transport, client } = daemon();
    await client.start();
    const listeners = { onFrame: () => {}, onClose: () => {} };

    expect(() => client.forPackage('board').socket('GET /v1/board/:id/stream', { id: '..' }, listeners)).toThrow(
      /cannot be/u,
    );
    expect(() => client.forPackage('board').socket('GET /v1/board/:id/stream', { id: '.' }, listeners)).toThrow(
      /cannot be/u,
    );
    expect(transport.sockets).toHaveLength(0);
  });

  test('a socket hears when the daemon accepts the stream, and the close code the stream ended with', async () => {
    const { transport, client } = daemon(inventoryOf(compiled));
    await client.start();
    const heard: string[] = [];
    client.forPackage('board').socket(
      'GET /v1/board/stream',
      {},
      {
        onOpen: () => heard.push('open'),
        onFrame: () => {},
        onClose: (reason, code) => heard.push(`close ${reason} ${String(code)}`),
      },
    );
    transport.sockets[0]?.listeners.onOpen?.();
    transport.sockets[0]?.listeners.onClose('invalid input', 1008);
    expect(heard).toEqual(['open', 'close invalid input 1008']);
  });
});

describe('events', () => {
  test('heard only for subscribed, allowed packages; a bad payload is dropped', async () => {
    const { transport, client } = daemon(inventoryOf(compiled, { agenda: { contract: 'x' } }));
    await client.start();
    const heard: unknown[] = [];
    client.forPackage('board').subscribe(BoardChanged, p => heard.push(p));
    client.forPackage('agenda').subscribe(AgendaChanged, p => heard.push(p));
    transport.emit({ name: 'board.changed', payload: { id: 'F1' } });
    transport.emit({ name: 'board.changed', payload: { id: 7 } });
    transport.emit({ name: 'agenda.changed', payload: { n: 1 } });
    transport.emit({ name: 'terminals.changed', payload: {} });
    expect(heard).toEqual([{ id: 'F1' }]);
  });

  test('plugins.changed re-reads the inventory and resumes a package now allowed', async () => {
    let inventory = inventoryOf(compiled, { board: { contract: 'old' } });
    const { transport, client } = daemon();
    transport.answer = request =>
      request.path === '/v1/plugins' ? json(inventory) : json({ protocol: 1, version: '5.0.0' });
    await client.start();
    const heard: unknown[] = [];
    client.forPackage('board').subscribe(BoardChanged, p => heard.push(p));
    transport.emit({ name: 'board.changed', payload: { id: 'A' } });
    inventory = inventoryOf(compiled);
    let changes = 0;
    client.onChange(() => {
      changes += 1;
    });
    transport.emit({ name: 'kernel.plugins-changed', payload: { generation: 1 } });
    await client.refresh();
    expect(changes).toBe(1);
    transport.emit({ name: 'board.changed', payload: { id: 'B' } });
    expect(heard).toEqual([{ id: 'B' }]);
  });

  test('a reconnect re-reads the inventory before anything resumes', async () => {
    const { transport, client } = daemon();
    await client.start();
    transport.reconnect();
    expect(client.standing('board')).toEqual({ state: 'blocked', reason: 'unread' });
    await client.refresh();
    expect(client.standing('board')).toEqual({ state: 'allowed' });
    expect(transport.paths().filter(p => p === 'GET /v1/plugins')).toHaveLength(2);
  });

  test('an unreadable inventory blocks everything', async () => {
    const { client } = daemon({ nonsense: true });
    await client.start();
    expect(client.standing('board')).toEqual({ state: 'blocked', reason: 'unreadable' });
  });
});
