import { describe, expect, it } from 'bun:test';
import {
  AGENDA_CHANNEL_HEADER,
  AGENDA_CHANNEL_VERSION,
  AgendaListSnapshotSchema,
  AgendaReadItemSchema,
  AgendaSnapshotSchema,
  MACHINE_AGENDA_ID,
} from '../../../../daemon/lib/protocol/agenda.ts';
import { type AgendaLedger, AgendaService } from '../../../../daemon/lib/agenda/index.ts';
import { agendaRoutes } from '../../../../daemon/lib/routes/agenda.ts';
import { projectionSnapshot } from '../fixtures/agenda-projection.ts';
import {
  agentIn,
  FakeLedgerRepository,
  human,
  jsonBody,
  NO_CALLER,
  NO_HELD_REPLIES,
  type RequestOverrides,
  routeDispatcher,
  warden,
} from './support.ts';

const headers = { ...human, [AGENDA_CHANNEL_HEADER]: AGENDA_CHANNEL_VERSION };
const fixture = () => {
  const snapshot = projectionSnapshot(1, 2);
  const ledger: AgendaLedger = {
    sessionId: 's1',
    nextId: 4,
    updatedAt: snapshot.updatedAt,
    entries: [
      ...snapshot.items.map(item => ({ lifecycle: 'active' as const, origin: { kind: 'human' as const }, item })),
      ...snapshot.resolved.map(item => ({ lifecycle: 'addressed' as const, origin: { kind: 'human' as const }, item })),
    ],
  };
  const service = new AgendaService(
    new FakeLedgerRepository(ledger),
    { now: () => snapshot.updatedAt },
    { has: async id => id === 's1' || id === MACHINE_AGENDA_ID },
    { raised: async () => {} },
  );
  const dispatch = routeDispatcher(agendaRoutes(service, NO_HELD_REPLIES, { enrolledDevices: async () => 0 }));
  return {
    snapshot,
    mutate: (path: string, caller: RequestOverrides['headers']) =>
      dispatch({ path, method: 'POST', headers: caller, body: JSON.stringify({ action: 'dismiss', id: 'A1' }) }),
    read: (path: string, caller: RequestOverrides['headers'] = headers) => dispatch({ path, headers: caller }),
  };
};

describe('agenda list and one-item reads', () => {
  it.each(['/v1/ferrets/s1/agenda'])(
    'projects every closed record on %s and keeps active items complete',
    async path => {
      // Arrange
      const { read, snapshot } = fixture();
      // Act
      const response = await read(path);
      const actual = AgendaListSnapshotSchema.parse(jsonBody(response));
      // Assert
      expect(response.status).toBe(200);
      expect(actual.items[0]).toEqual(snapshot.items[0]);
      expect(actual.resolved).toHaveLength(2);
      for (const record of actual.resolved) {
        expect(record).toHaveProperty('projection', 'header');
        expect(record).not.toHaveProperty('revisions');
        expect(record).not.toHaveProperty('tabs');
        expect(record).not.toHaveProperty('conversation');
      }
    },
  );

  it.each(['/v1/ferrets/s1/agenda'])(
    'preserves complete records for readers below channel 2 of %s',
    async path => {
      const { read, snapshot } = fixture();
      for (const caller of [human, { ...human, [AGENDA_CHANNEL_HEADER]: '1' }]) {
        const response = await read(path, caller);
        expect(response.status).toBe(200);
        // This full-record schema is the one PWA/CLI readers used before list headers.
        expect(AgendaSnapshotSchema.parse(jsonBody(response)).resolved).toEqual(snapshot.resolved);
      }
    },
  );

  it.each(['/v1/ferrets/s1/agenda'])(
    'keeps mutation snapshots complete on %s for every reader',
    async path => {
      for (const version of [undefined, '1', '2']) {
        const { mutate } = fixture();
        const caller = version === undefined ? human : { ...human, [AGENDA_CHANNEL_HEADER]: version };
        const response = await mutate(path, caller);
        expect(response.status).toBe(200);
        const snapshot = AgendaSnapshotSchema.parse(jsonBody(response));
        expect(snapshot.resolved).toHaveLength(3);
        expect(snapshot.resolved.every(item => !('projection' in item))).toBe(true);
      }
    },
  );

  it.each(['/v1/ferrets/s1/agenda'])(
    'reads one whole active or addressed item from %s, with no sibling documents',
    async path => {
      // Arrange
      const { read, snapshot } = fixture();
      // Act + Assert
      for (const item of [...snapshot.items, ...snapshot.resolved]) {
        const response = await read(`${path}/${item.id}`);
        expect(response.status).toBe(200);
        expect(AgendaReadItemSchema.parse(jsonBody(response))).toEqual(item);
      }
      expect((await read(`${path}/A99`)).status).toBe(404);
      expect((await read(`${path}/invalid`)).status).toBe(400);
      expect((await read(`${path}/A2`, NO_CALLER)).status).toBe(401);
    },
  );

  it('refuses the reserved machine agenda id on a ferret path before reaching any port', async () => {
    const { read } = fixture();
    const response = await read(`/v1/ferrets/${MACHINE_AGENDA_ID}/agenda/A1`, agentIn('s1'));
    expect(response.status).toBe(404);
    expect(jsonBody(response)).toMatchObject({ code: 'not-found' });
  });

  it('applies the neighbouring route authority to agents, unknown sessions and wardens', async () => {
    // Arrange
    const { read } = fixture();
    // Act + Assert
    const agent = { ...headers, ...agentIn('s1') };
    expect((await read('/v1/ferrets/s1/agenda/A2', agent)).status).toBe(200);
    expect((await read('/v1/ferrets/missing/agenda/A2')).status).toBe(404);
    expect((await read('/v1/ferrets/s1/agenda/A2', { ...headers, ...warden })).status).toBe(403);
  });
});
