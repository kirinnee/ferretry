import { describe, expect, test } from 'bun:test';
import { defineEvent } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { DaemonClient, fillPath } from '../../../src/client/daemon-client.ts';
import { DaemonCallError, type TransportRequest } from '../../../src/client/transport.ts';
import { CORE, FakeTransport, inventoryOf, json, surface } from './fixtures.ts';

const board = surface('board', { routes: ['GET /v1/board', 'GET /v1/board/:id'], sockets: ['GET /v1/board/stream'] });
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
    expect(await client.forPackage('agenda').call('GET /v1/agenda').catch(e => e.code)).toBe('not_found');
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
