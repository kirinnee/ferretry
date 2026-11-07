import { describe, expect, it } from 'bun:test';
import { type AgendaId, MACHINE_AGENDA_ID, agendaListSnapshot } from '../../../app/wire/index.ts';
import { projectionRecord, projectionSnapshot } from '../../support/app/agenda-projection.ts';
import { fetchAgendaItem as fetchItem } from '../../../app/lib/agenda-item-client.ts';
import { type DaemonConnection, type DaemonSessionScope, daemonConnection } from '../../../app/shell.ts';
import { daemonSessionScope } from '../../../app/shell.ts';
import { callFromFetch, type TestFetch } from '../../support/app/call-from-fetch.ts';

/** One item read through the half's client, answered by a scripted fetcher. */
const fetchAgendaItem = (daemon: DaemonConnection, scope: DaemonSessionScope, item: AgendaId, fetcher: TestFetch) =>
  fetchItem(daemon, scope, item, callFromFetch(fetcher));

const connection = daemonConnection({
  daemonId: 'fixture',
});
const scope = daemonSessionScope(connection, 'session');
const id = 'A1' as AgendaId;

describe('the one-item agenda client', () => {
  it.each(['session', MACHINE_AGENDA_ID])(
    'reads one full item from %s, with no channel header (GAP agenda-channel-header)',
    async sessionId => {
      // Arrange
      const calls: { input: string; init?: RequestInit }[] = [];
      const input = projectionRecord();
      // Act
      const actual = await fetchAgendaItem(
        connection,
        daemonSessionScope(connection, sessionId),
        id,
        async (url, init) => {
          calls.push({ input: String(url), init });
          return Response.json(input);
        },
      );
      // Assert
      expect(actual).toEqual(input);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toContain(
        sessionId === MACHINE_AGENDA_ID ? '/v1/machine/agenda/A1' : '/v1/ferrets/session/agenda/A1',
      );
      expect(new Headers(calls[0]?.init?.headers).has('x-fy-agenda-channel')).toBe(false);
    },
  );

  it('refuses another daemon scope, another item, a header and a malformed document', async () => {
    // Arrange / Act / Assert
    const other = daemonSessionScope(daemonConnection({ ...connection, daemonId: 'other' }), 'session');
    await expect(
      fetchAgendaItem(connection, other, id, async () => {
        throw new Error('must not read another daemon');
      }),
    ).rejects.toThrow('scope must belong');
    await expect(
      fetchAgendaItem(connection, scope, id, async () => Response.json(projectionRecord('A2'))),
    ).rejects.toThrow('another agenda item');
    const header = agendaListSnapshot(projectionSnapshot(0, 1)).resolved[0];
    await expect(fetchAgendaItem(connection, scope, id, async () => Response.json(header))).rejects.toThrow();
    await expect(fetchAgendaItem(connection, scope, id, async () => Response.json({}))).rejects.toThrow();
  });

  it.each([
    [403, { error: 'Only the owner may read this.', code: 'owner_only' }, 'Only the owner'],
    [500, { error: 12, code: null }, 'HTTP 500'],
    [502, null, 'HTTP 502'],
  ] as const)('reports a %i refusal without losing the machine words', async (status, body, words) => {
    // Act + Assert
    await expect(
      fetchAgendaItem(connection, scope, id, async () =>
        body === null ? new Response('offline', { status }) : Response.json(body, { status }),
      ),
    ).rejects.toThrow(words);
  });
});
