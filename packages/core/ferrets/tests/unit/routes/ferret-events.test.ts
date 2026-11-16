/**
 * R-0147 `GET /v1/ferrets/:ferretId/events` through a booted host: one page of a ferret's own journal, read from the
 * real history file the host holds, masked in one vault open, and reached by the ferret and its helpers only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { TestHost } from '@ferretry/kernel/testing';
import { FerretHistoryFiles } from '../../../contract/index.ts';
import { as, host, record } from '../daemon/ferrets/route-fixture.ts';

let open: TestHost | undefined;
afterEach(async () => {
  await open?.stop();
  open = undefined;
});

const line = (sequence: number, data: unknown, sessionId = 'wren') =>
  JSON.stringify({
    format: 1,
    schemaVersion: 1,
    sequence,
    sessionId,
    time: `2026-11-16T10:00:0${sequence}.000Z`,
    type: 'lifecycle',
    data,
  });

async function serving(journal: readonly string[], secrets: readonly string[] = []) {
  const first = await host([record('wren'), record('moth')], { secrets });
  first.state('ferrets').plant(FerretHistoryFiles, journal.map(each => `${each}\n`).join(''), 'wren');
  open = await first.restart();
  return open;
}

interface Event {
  readonly sequence: number;
  readonly sessionId: string;
  readonly source: string;
  readonly data: unknown;
}

describe('R-0147 the per-ferret events read', () => {
  test('R-0147 the owner reads a ferret’s journal in the protocol envelope, in its own sequence order', async () => {
    const h = await serving([line(1, { a: 1 }), line(2, { a: 2 }), line(3, { a: 3 })]);

    const response = await h.request('GET', '/v1/ferrets/wren/events');

    expect(response.status).toBe(200);
    const events = response.json<Event[]>();
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3]);
    expect(events.every(event => event.sessionId === 'wren' && event.source === 'daemon')).toBe(true);
  });

  test('R-0147 ?after= pages gaplessly and ?limit= bounds the page', async () => {
    const h = await serving([line(1, {}), line(2, {}), line(3, {}), line(4, {})]);

    const first = await h.request('GET', '/v1/ferrets/wren/events', { query: { limit: '2' } });
    const second = await h.request('GET', '/v1/ferrets/wren/events', { query: { after: '2', limit: '2' } });
    const past = await h.request('GET', '/v1/ferrets/wren/events', { query: { after: '4' } });

    expect(first.json<Event[]>().map(event => event.sequence)).toEqual([1, 2]);
    expect(second.json<Event[]>().map(event => event.sequence)).toEqual([3, 4]);
    expect(past.json<Event[]>()).toEqual([]);
  });

  test('R-0147 a value the vault holds is masked inside every nested string of an event’s data, and nowhere else', async () => {
    const h = await serving(
      [line(1, { note: 'token fixture-secret!', deep: { list: ['x fixture-secret', 7] } })],
      ['fixture-secret'],
    );

    const response = await h.request('GET', '/v1/ferrets/wren/events');

    expect(response.body).not.toContain('fixture-secret');
    const [event] = response.json<Event[]>();
    expect(event?.data).toEqual({ note: 'token **************!', deep: { list: ['x **************', 7] } });
  });

  test('R-0147 a query that is not a whole number is a 400, and nothing is read', async () => {
    const h = await serving([line(1, {})]);

    expect((await h.request('GET', '/v1/ferrets/wren/events', { query: { after: 'latest' } })).status).toBe(400);
    expect((await h.request('GET', '/v1/ferrets/wren/events', { query: { limit: '-1' } })).status).toBe(400);
  });

  test('R-0147 a ferret nobody holds is a 404', async () => {
    const h = await serving([]);

    expect((await h.request('GET', '/v1/ferrets/nobody/events')).status).toBe(404);
  });

  test('R-0147 a ferret may read its own journal, and a stranger’s is refused 403', async () => {
    const h = await serving([line(1, {})]);

    expect((await h.request('GET', '/v1/ferrets/wren/events', as('wren'))).status).toBe(200);
    expect((await h.request('GET', '/v1/ferrets/wren/events', as('moth'))).status).toBe(403);
  });
});
