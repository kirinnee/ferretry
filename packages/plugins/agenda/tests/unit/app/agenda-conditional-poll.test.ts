/**
 * THE AGENDA POLL COSTS A 304 WHEN NOTHING MOVED. The app re-reads a ferret's board on a beat, and a lead's board is over
 * a megabyte, so the read sends the etag it holds: a 304 keeps the snapshot already held, a 200 replaces it.
 */
import { describe, expect, it } from 'bun:test';
import type { PluginConditionalAnswer, PluginConditionalInit } from '@ferretry/kernel/manifest';
import { fetchAgendaSnapshot } from '../../../app/lib/agenda-client.ts';
import type { AgendaCall } from '../../../app/lib/agenda-call.ts';
import { DaemonResponseError, daemonConnection, daemonSessionScope } from '../../../app/shell.ts';

const daemon = daemonConnection({ daemonId: 'daemon-a' });
const scope = daemonSessionScope(daemon, 'lead-1');

/** An empty board; `revision` is what tells one read from another (the instant it was last updated). */
const board = (revision: number) => ({
  v: 1,
  sessionId: 'lead-1',
  items: [],
  resolved: [],
  count: 0,
  parseErrors: 0,
  updatedAt: `2026-11-16T00:00:0${String(revision)}.000Z`,
});

/** A daemon holding one board, naming it by its count, answering a conditional read the way the route does. */
function pollingDaemon() {
  const state = { count: 0 };
  const asked: Array<{
    route: string;
    params: Readonly<Record<string, string>>;
    init: PluginConditionalInit | undefined;
  }> = [];
  const client: AgendaCall = {
    call: (async () => {
      throw new Error('the board is polled through the conditional read');
    }) as AgendaCall['call'],
    async conditional(route, params, init): Promise<PluginConditionalAnswer> {
      asked.push({ route, params, init });
      const etag = `"board-${String(state.count)}"`;
      return init?.ifNoneMatch === etag ? { status: 304, etag } : { status: 200, etag, body: board(state.count) };
    },
  };
  return { client, state, asked };
}

describe('fetchAgendaSnapshot polls a ferret’s board conditionally', () => {
  it('a 304 keeps the held snapshot, the very one, with the channel header sent and the held etag named', async () => {
    const { client, asked } = pollingDaemon();
    const first = await fetchAgendaSnapshot(daemon, scope, client);

    const again = await fetchAgendaSnapshot(daemon, scope, client);

    expect(again).toBe(first);
    expect(asked.map(each => each.init?.ifNoneMatch)).toEqual([undefined, '"board-0"']);
    expect(asked[1]).toMatchObject({
      route: 'GET /v1/ferrets/:ferretId/agenda',
      params: { ferretId: 'lead-1' },
      init: { headers: { 'x-fy-agenda-channel': '2' } },
    });
  });

  it('a 200 replaces the held snapshot, and the next poll names the new etag', async () => {
    const { client, state, asked } = pollingDaemon();
    const first = await fetchAgendaSnapshot(daemon, scope, client);
    state.count = 2;

    const changed = await fetchAgendaSnapshot(daemon, scope, client);

    expect(changed).not.toBe(first);
    expect(changed.updatedAt).toBe('2026-11-16T00:00:02.000Z');
    expect(await fetchAgendaSnapshot(daemon, scope, client)).toBe(changed);
    expect(asked.map(each => each.init?.ifNoneMatch)).toEqual([undefined, '"board-0"', '"board-2"']);
  });

  it('still refuses a board that is another session’s, and a daemon that is not the scope’s', async () => {
    const { client, state } = pollingDaemon();
    state.count = 1;
    const other = daemonSessionScope(daemon, 'someone-else');
    await expect(fetchAgendaSnapshot(daemon, other, client)).rejects.toThrow('another session');
    await expect(fetchAgendaSnapshot(daemonConnection({ daemonId: 'daemon-b' }), scope, client)).rejects.toThrow(
      'attention scope must belong to the requested daemon',
    );
  });

  it('tells a refusal as the half’s own refusal, and a failure that is no answer as it came', async () => {
    const refusing: AgendaCall = {
      call: (async () => ({})) as AgendaCall['call'],
      conditional: async () =>
        Promise.reject(Object.assign(new Error('No such ferret.'), { status: 404, code: 'not-found' })),
    };
    const refusal = await fetchAgendaSnapshot(daemon, scope, refusing).catch(error => error);
    expect(refusal).toBeInstanceOf(DaemonResponseError);
    expect(refusal).toMatchObject({ status: 404, code: 'not-found' });

    const dropped: AgendaCall = {
      call: (async () => ({})) as AgendaCall['call'],
      conditional: async () => Promise.reject(new Error('carrier outage')),
    };
    const failure = await fetchAgendaSnapshot(daemon, scope, dropped).catch(error => error);
    expect(failure).not.toBeInstanceOf(DaemonResponseError);
    expect(failure.message).toBe('carrier outage');
    await expect(
      fetchAgendaSnapshot(daemon, scope, {
        call: (async () => ({})) as AgendaCall['call'],
        conditional: async () => Promise.reject('plain'),
      }),
    ).rejects.toBe('plain');
  });

  it('reads the machine board whole: it is small, and its store has no cheap version', async () => {
    const calls: string[] = [];
    const client: AgendaCall = {
      call: (async (route: string) => {
        calls.push(route);
        return { ...board(0), sessionId: 'machine-agenda' };
      }) as AgendaCall['call'],
      conditional: async () => {
        throw new Error('the machine board is not read conditionally');
      },
    };
    const machine = daemonSessionScope(daemon, 'machine-agenda');
    expect((await fetchAgendaSnapshot(daemon, machine, client)).sessionId).toBe('machine-agenda');
    expect(calls).toEqual(['GET /v1/machine/agenda']);
  });

  it('reads whole, as before, through a client the shell has not given a conditional read', async () => {
    const calls: string[] = [];
    const client: AgendaCall = {
      call: (async (route: string) => {
        calls.push(route);
        return board(3);
      }) as AgendaCall['call'],
    };
    expect((await fetchAgendaSnapshot(daemon, scope, client)).updatedAt).toBe('2026-11-16T00:00:03.000Z');
    expect((await fetchAgendaSnapshot(daemon, scope, client)).updatedAt).toBe('2026-11-16T00:00:03.000Z');
    expect(calls).toEqual(['GET /v1/ferrets/:ferretId/agenda', 'GET /v1/ferrets/:ferretId/agenda']);
  });

  it('parses a held board again when the body came whole but is not an object the memory can key', async () => {
    const client: AgendaCall = { call: (async () => 'not a board') as AgendaCall['call'] };
    await expect(fetchAgendaSnapshot(daemon, scope, client)).rejects.toThrow();
  });
});
