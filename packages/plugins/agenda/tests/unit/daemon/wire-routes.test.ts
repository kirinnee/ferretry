import { expect, test } from 'bun:test';
import {
  AskBoardSnapshotSchema,
  AskItemSchema,
  type AskOwnerAction,
  AskOwnerActionError,
  AskOwnerActionSchema,
  type AsksApi,
  MACHINE_AGENDA_ID,
} from '@ferretry/core-asks/contract';
import { FakeAsks, entryId, sourceKey } from '@ferretry/core-asks/contract/testing';
import { ownerStanding, ferretStanding, wardenStanding } from '@ferretry/core-gate/contract/testing';
import { ApiError, type CallStanding, type FerretId, type RouteHandler } from '@ferretry/kernel/contract';
import { owner, testArrival } from '@ferretry/kernel/testing';
import { AgendaOpenPageSchema, DaemonAgendaSchema, DAEMON_AGENDA_ID } from '../../../contract/index.ts';
import { AgendaRollup } from '../../../daemon/lib/rollup.ts';
import { MachineAgendaView } from '../../../daemon/lib/machine-agenda.ts';
import { agendaRoutes, type AgendaRouteParts } from '../../../daemon/routes.ts';
import { raiseAsk } from './support.ts';

test('Agenda’s app half is bound: no half of it is pending, and what is still open is named by GAP', async () => {
  const pending = await Bun.file(new URL('../../../../../../ports-pending.json', import.meta.url)).json();
  expect(pending.pendingHalves.agenda).toBeUndefined();
  expect(pending.pendingAppPorts.some((port: { plugin: string }) => port.plugin === 'agenda')).toBe(false);
  const open = await Bun.file(new URL('../../../app/NEEDS-APP-SHELL.txt', import.meta.url)).text();
  expect(open).not.toContain('GAP(agenda-channel-header)');
  expect(open).toContain('GAP(agenda-composer)');
});

const AT = '2026-11-07T12:00:00.000Z';
const board = DAEMON_AGENDA_ID as FerretId;
const item = AskItemSchema.parse({
  id: 'A1',
  subject: 'Choose a colour',
  why: 'Ready',
  howToResolve: 'Pick one',
  source: 'question',
  sourceRef: null,
  raisedBy: 'daemon',
  raisedBySession: null,
  raisedByName: null,
  waitingSince: AT,
  answers: [{ direction: 'right', label: 'Done', does: 'done' }],
  parked: { reason: 'snoozed', at: AT, until: '2026-11-08T12:00:00.000Z' },
  cardAsks: [
    {
      at: AT,
      howToTest: '1. Try the card.',
      gate: {
        cardId: 'F12',
        laneId: 'verify',
        laneName: 'Try it',
        entry: 1,
        projectId: 'p1',
        options: [{ id: 'done', label: 'Done', outcome: 'close' }],
      },
    },
  ],
  conversation: [{ by: 'owner', via: 'chat-log', at: AT, text: 'Keep my words.' }],
  conversationCount: 1,
});
const snapshot = (sessionId: string, items = [item]) =>
  AskBoardSnapshotSchema.parse({
    v: 1,
    sessionId,
    items,
    resolved: [],
    count: items.length,
    parseErrors: 0,
    updatedAt: AT,
  });
function routes(asks: Pick<AsksApi, 'snapshots' | 'ownerAction'>) {
  return agendaRoutes({
    rollup: new AgendaRollup(asks),
    machine: new MachineAgendaView(asks, board),
  } as AgendaRouteParts);
}
async function call(
  handler: RouteHandler,
  body?: unknown,
  standing: CallStanding = ownerStanding(),
  params: [string, string][] = [],
) {
  try {
    const response = await handler({
      ...standing,
      params: new Map(params),
      request: {
        method: body === undefined ? 'GET' : 'POST',
        path: '/v1/machine/agenda',
        query: new Map(),
        headers: new Map(),
        arrival: testArrival(owner()),
        text: async () => (body === undefined ? '' : JSON.stringify(body)),
      },
    });
    return { status: response.status, json: () => JSON.parse(response.body) };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, json: () => ({ error: error.message, code: error.code }) };
  }
}

test('R-0044 roll-up round-trips full items in sessions and never splits a board across pages', async () => {
  const asks = {
    snapshots: async () => [snapshot('z'), snapshot('empty', []), snapshot('a', [item, { ...item, id: 'A2' }])],
  };
  const rollup = new AgendaRollup(asks);
  const first = AgendaOpenPageSchema.parse(JSON.parse(JSON.stringify(await rollup.page({ limit: 1 }))));
  expect(first.sessions.map(group => group.sessionId)).toEqual(['a']);
  expect(first.sessions[0]?.items).toEqual([item, { ...item, id: 'A2' }]);
  expect(first.next).toBe('a');
  expect(await rollup.page({ after: first.next, limit: 1 })).toEqual({ sessions: [{ sessionId: 'z', items: [item] }] });
  const response = await call(routes({ ...asks, ownerAction: async () => snapshot(board) })['GET /v1/agenda/open']);
  expect(response.status).toBe(200);
  expect(AgendaOpenPageSchema.parse(response.json()).sessions).toHaveLength(2);
  expect(AgendaOpenPageSchema.parse({ sessions: [] })).toEqual({ sessions: [] });
});

test('R-0044 a machine-only board leaves the conversation roll-up empty', async () => {
  const asks = new FakeAsks();
  await raiseAsk(asks, MACHINE_AGENDA_ID, 'machine-only');
  expect(DAEMON_AGENDA_ID).toBe(MACHINE_AGENDA_ID);
  expect(await new AgendaRollup(asks).page({ limit: 1 })).toEqual({ sessions: [] });
  expect((await new MachineAgendaView(asks, board).list()).items).toHaveLength(1);
});

test('R-0044 machine items never consume the conversation page limit or cursor', async () => {
  const asks = new FakeAsks();
  // The reserved id sorts before both ferret ids, so including it would take the whole first page.
  await raiseAsk(asks, MACHINE_AGENDA_ID, 'machine-first');
  await raiseAsk(asks, MACHINE_AGENDA_ID, 'machine-second');
  await raiseAsk(asks, 'n-ferret', 'first-conversation');
  await raiseAsk(asks, 'z-ferret', 'last-conversation');
  const rollup = new AgendaRollup(asks);
  const first = await rollup.page({ limit: 1 });
  expect(first.sessions.map(session => session.sessionId)).toEqual(['n-ferret']);
  expect(first.next).toBe('n-ferret');
  const last = await rollup.page({ after: first.next, limit: 1 });
  expect(last.sessions.map(session => session.sessionId)).toEqual(['z-ferret']);
  expect(last.next).toBeUndefined();
  expect(
    (await rollup.page({ after: MACHINE_AGENDA_ID, limit: 2 })).sessions.map(session => session.sessionId),
  ).toEqual(['n-ferret', 'z-ferret']);
});

test('R-0110 R-0111 machine reads round-trip a complete list snapshot and an item', async () => {
  const handlers = routes({ snapshots: async () => [snapshot(board)], ownerAction: async () => snapshot(board) });
  const response = await call(handlers['GET /v1/machine/agenda']);
  expect(response.status).toBe(200);
  expect(DaemonAgendaSchema.parse(response.json())).toEqual(snapshot(board));
  expect(
    (await call(handlers['GET /v1/machine/agenda/:id'], undefined, ownerStanding(), [['id', 'A1']])).json(),
  ).toEqual(item);
  expect((await call(handlers['GET /v1/machine/agenda/:id'], undefined, ownerStanding(), [['id', 'A99']])).status).toBe(
    404,
  );
});

test('R-0305 machine POST forwards all four verbs with id, note and snooze time', async () => {
  const applied: AskOwnerAction[] = [];
  const handlers = routes({
    snapshots: async () => [snapshot(board)],
    ownerAction: async action => {
      applied.push(action);
      return snapshot(board);
    },
  });
  for (const action of [
    { action: 'dismiss', id: 'A1', note: 'Clear this.' },
    { action: 'snooze', id: 'A1', until: '2026-11-08T12:00:00.000Z' },
    { action: 'unsnooze', id: 'A1' },
    { action: 'resolve', id: 'A1', note: 'Checked.' },
  ]) {
    const result = await call(handlers['POST /v1/machine/agenda'], action);
    expect(result.status).toBe(200);
    expect(DaemonAgendaSchema.parse(result.json())).toEqual(snapshot(board));
    const { id, ...verb } = action;
    expect(applied.at(-1)).toEqual(AskOwnerActionSchema.parse({ ...verb, ref: { ferret: board, id } }));
  }
  for (const body of [
    { action: 'dismiss', ask: 'A1' },
    { action: 'resolve', id: 'A1', response: {} },
    { action: 'snooze', id: 'A1' },
  ]) {
    expect((await call(handlers['POST /v1/machine/agenda'], body)).status).toBe(400);
  }
  expect(applied).toHaveLength(4);
});

test('G40 machine owner routes refuse ferret and warden standing before reading or mutating', async () => {
  const handlers = routes({
    snapshots: async () => {
      throw new Error('must not read');
    },
    ownerAction: async () => {
      throw new Error('must not mutate');
    },
  });
  for (const standing of [ferretStanding('f1' as FerretId), wardenStanding('f1' as FerretId)]) {
    expect((await call(handlers['GET /v1/machine/agenda'], undefined, standing)).status).toBe(403);
    expect((await call(handlers['POST /v1/machine/agenda'], { action: 'dismiss', id: 'A1' }, standing)).status).toBe(
      403,
    );
  }
});

test('R-0305 engine refusals retain HTTP status and words', async () => {
  const handlers = routes({
    snapshots: async () => [snapshot(board)],
    ownerAction: async () => {
      throw new AskOwnerActionError('not-found', 'agenda item not found');
    },
  });
  expect(await call(handlers['POST /v1/machine/agenda'], { action: 'dismiss', id: 'A1' })).toMatchObject({
    status: 404,
  });
});

test('R-0305 contract fake keeps a snoozed item until unsnoozed and records the owner close', async () => {
  const asks = new FakeAsks();
  const ref = await asks.raise({
    kind: 'yesno',
    source: sourceKey('daemon'),
    entry: entryId('notice1'),
    ref: {},
    subject: 'Ready',
    why: 'Checked',
    raisedBy: { kind: 'daemon' },
    ferret: board,
  });
  const machine = new MachineAgendaView(asks, board);
  expect(
    (await machine.act({ action: 'snooze', id: ref.id, until: '2026-11-08T12:00:00.000Z' as never })).items[0]?.parked
      ?.reason,
  ).toBe('snoozed');
  expect((await machine.act({ action: 'unsnooze', id: ref.id })).items[0]?.parked).toBeUndefined();
  expect((await machine.act({ action: 'dismiss', id: ref.id, note: 'Read.' })).resolved[0]).toMatchObject({
    resolvedBy: 'human',
    resolutionNote: 'Read.',
  });
});
