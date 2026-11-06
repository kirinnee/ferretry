import { describe, expect, it } from 'bun:test';
import {
  AGENDA_CHANNEL_HEADER,
  AGENDA_CHANNEL_VERSION,
  AgendaListSnapshotSchema,
  AgendaReadItemSchema,
  AgendaSnapshotSchema,
  legacyAgendaSnapshot,
  MACHINE_AGENDA_ID,
} from '@ferretry/protocol';
import { AgendaSnapshotSchema as OldAgendaSnapshotSchema } from '../../../../../protocol/tests/fixtures/agenda-before-channel.ts';
import { projectionSnapshot } from '../../../../../protocol/tests/fixtures/agenda-projection.ts';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher, ApiRouter } from '../../../../src/lib/api/index.ts';
import { type AgendaLedger, AgendaService } from '../../../../src/lib/agenda/index.ts';
import { agendaRoutes } from '../../../../src/lib/runtime/mounts/agenda.ts';
import { agendaMachineRoutes } from '../../../../src/lib/runtime/mounts/agenda-machine.ts';
import { jsonBody, request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, FakeLedgerRepository, human, NO_HELD_REPLIES } from './support.ts';

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
  const routes = [
    ...agendaRoutes(service, { enrolledDevices: async () => 0, agendaDelivered: async () => 0 }, NO_HELD_REPLIES),
    ...agendaMachineRoutes(service),
  ];
  const dispatcher = new ApiDispatcher(new ApiRouter(routes), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);
  return {
    snapshot,
    mutate: (path: string, caller: Readonly<Record<string, string>>) =>
      dispatcher.dispatch(
        request({ path, method: 'POST', headers: caller, body: JSON.stringify({ action: 'dismiss', id: 'A1' }) }),
      ),
    read: (path: string, caller: Readonly<Record<string, string>> = headers) =>
      dispatcher.dispatch(request({ path, headers: caller })),
  };
};

describe('agenda list and one-item reads', () => {
  it.each(['/v1/sessions/s1/agenda', '/v1/sessions/s1/attention', '/v1/machine/agenda'])(
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

  it.each(['/v1/sessions/s1/agenda', '/v1/sessions/s1/attention', '/v1/machine/agenda'])(
    'preserves complete records for old readers of %s',
    async path => {
      const { read, snapshot } = fixture();
      const legacy = await read(path, human);
      expect(legacy.status).toBe(200);
      expect(OldAgendaSnapshotSchema.safeParse(jsonBody(legacy)).success).toBe(true);
      expect(AgendaSnapshotSchema.parse(jsonBody(legacy)).resolved).toEqual(legacyAgendaSnapshot(snapshot).resolved);
      const channel1 = await read(path, { ...human, [AGENDA_CHANNEL_HEADER]: '1' });
      expect(channel1.status).toBe(200);
      // This full-record schema is the one PWA/CLI readers used before list headers.
      expect(AgendaSnapshotSchema.parse(jsonBody(channel1)).resolved).toEqual(snapshot.resolved);
    },
  );

  it.each(['/v1/sessions/s1/agenda', '/v1/sessions/s1/attention', '/v1/machine/agenda'])(
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

  it.each(['/v1/sessions/s1/agenda', '/v1/machine/agenda'])(
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
      expect((await read(`${path}/A2`, {} as typeof headers)).status).toBe(401);
    },
  );

  it('applies the neighbouring route authority to agents, unknown sessions and wardens', async () => {
    // Arrange
    const { read } = fixture();
    // Act + Assert
    const agent = { ...headers, ...agentIn('s1') };
    expect((await read('/v1/sessions/s1/agenda/A2', agent)).status).toBe(200);
    expect((await read('/v1/machine/agenda/A2', agent)).status).toBe(403);
    expect((await read('/v1/sessions/missing/agenda/A2')).status).toBe(404);
    const warden = { ...headers, authorization: `Bearer ${CREDENTIALS.warden}` };
    expect((await read('/v1/sessions/s1/agenda/A2', warden)).status).toBe(403);
    expect((await read('/v1/machine/agenda/A2', warden)).status).toBe(403);
  });
});
