import { describe, it } from 'bun:test';
import { type AgendaItem, AgendaItemSchema, type AgendaSnapshot, type BoardTask } from '@ferretry/protocol';
import should from 'should';
import type { AgendaQueryResult } from '../../../src/lib/agenda/service.ts';
import type { LaneSets } from '../../../src/lib/board/index.ts';
import { TidyService, type TidyPorts } from '../../../src/lib/tidy/index.ts';
import { card, liveSession, PROJECT, rosterOf, templateLanes } from '../board/support.ts';

const NOW = '2026-10-23T10:00:00.000Z';
const ME = 'me';
const OTHER = 'other';
const MACHINE = 'machine-a';

const item = (id: string, extra: Record<string, unknown> = {}): AgendaItem =>
  AgendaItemSchema.parse({
    id,
    source: 'agent-raised',
    sourceRef: null,
    subject: `Ask ${id}`,
    why: 'Because.',
    waitingSince: NOW,
    howToResolve: 'Say so.',
    ask: { kind: 'task' },
    raisedBy: 'agent',
    raisedBySession: ME,
    raisedByName: null,
    ...extra,
  });

const snapshot = (
  sessionId: string,
  items: readonly AgendaItem[],
  extra: Partial<AgendaSnapshot> = {},
): AgendaSnapshot =>
  ({
    v: 1,
    sessionId,
    items,
    resolved: [],
    count: items.length,
    parseErrors: 0,
    updatedAt: NOW,
    ...extra,
  }) as AgendaSnapshot;

const mine = (extra: Partial<BoardTask> = {}): BoardTask =>
  card({ owner: ME, askedBy: 'agent', laneId: 'todo', ...extra });

interface World {
  cards?: readonly BoardTask[];
  on?: readonly string[];
  agendas?: Record<string, AgendaQueryResult<AgendaSnapshot>>;
  roster?: ReturnType<typeof rosterOf>;
  leads?: Record<string, string>;
}

const service = (world: World = {}) => {
  const laneSets: LaneSets = new Map([[PROJECT, templateLanes(PROJECT)]]);
  const listed: string[] = [];
  const ports: TidyPorts = {
    board: { snapshot: async () => ({ cards: world.cards ?? [], laneSets }) },
    switches: { isOn: async projectId => (world.on ?? []).includes(projectId) },
    sessions: { roster: async () => world.roster ?? rosterOf([]) },
    agenda: {
      list: async sessionId => {
        listed.push(sessionId);
        return world.agendas?.[sessionId] ?? { ok: true, value: snapshot(sessionId, []) };
      },
    },
    subFerrets: {
      leadOf: async sessionId => world.leads?.[sessionId],
      addressOf: async sessionId => sessionId,
    },
    machineId: () => MACHINE,
  };
  return { tidy: new TidyService(ports), listed };
};

const plan = async (world: World) => {
  const result = await service(world).tidy.plan(ME);
  if (!result.ok) throw new Error(result.message);
  return result.plan;
};

describe('TidyService.plan', () => {
  it('should drop the ferret’s own agent-asked card on a board that is off', async () => {
    // Arrange
    const world = { cards: [mine()] };

    // Act
    const result = await plan(world);

    // Assert
    should(result.drop.map(each => each.id)).deepEqual(['F1']);
  });

  it('should keep a card whose board the switch says is on', async () => {
    // Arrange
    const world = { cards: [mine()], on: [PROJECT] };

    // Act
    const result = await plan(world);

    // Assert
    should(result.drop).deepEqual([]);
    should(result.keep.map(each => each.code)).deepEqual(['board-on']);
  });

  it('should read who asked from the card’s own words when it does not say', async () => {
    // Arrange
    const owned = mine({ askedBy: undefined, ask: { text: 'build the board', source: 'owner' } });

    // Act
    const result = await plan({ cards: [owned] });

    // Assert
    should(result.keep.map(each => each.code)).deepEqual(['owner-asked']);
  });

  it('should leave out closed cards, dropped cards and cards of other ferrets', async () => {
    // Arrange
    const world = {
      cards: [
        mine({ id: 'F1', laneId: 'closed' }),
        mine({ id: 'F2', dropped: { reason: 'no', at: NOW, by: { kind: 'owner' } } as BoardTask['dropped'] }),
        mine({ id: 'F3', owner: OTHER }),
      ],
    };

    // Act
    const result = await plan(world);

    // Assert
    should(result.drop).deepEqual([]);
    should(result.keep).deepEqual([]);
  });

  it('should keep a card another running session is working, and drop it when that session is gone', async () => {
    // Arrange
    const handed = mine({ assignee: OTHER });

    // Act
    const running = await plan({ cards: [handed], roster: rosterOf([liveSession(OTHER)]) });
    const stopped = await plan({ cards: [handed], roster: rosterOf([liveSession(OTHER, { status: 'stopped' })]) });
    const unreadable = await plan({ cards: [handed], roster: rosterOf([], [OTHER]) });
    const unknown = await plan({ cards: [handed] });

    // Assert
    should(running.keep.map(each => each.code)).deepEqual(['assigned-to-live-session']);
    should(stopped.drop.map(each => each.id)).deepEqual(['F1']);
    should(unreadable.keep.map(each => each.code)).deepEqual(['assigned-to-live-session']);
    should(unknown.drop.map(each => each.id)).deepEqual(['F1']);
  });

  it('should keep a card that an open gate item on its ferret’s agenda waits on', async () => {
    // Arrange
    const gate = item('A1', {
      raisedBy: 'daemon',
      raisedBySession: null,
      gate: {
        cardId: 'F1',
        laneId: 'to-test',
        laneName: 'To test',
        entry: 1,
        projectId: PROJECT,
        options: [{ id: 'next', label: 'Good', outcome: 'next' }],
      },
    });
    const world = { cards: [mine()], agendas: { [ME]: { ok: true, value: snapshot(ME, [gate]) } } as const };

    // Act
    const result = await plan(world);

    // Assert
    should(result.keep.map(each => `${each.id}:${each.code}`)).deepEqual(['F1:waiting-at-gate', 'A1:gate']);
  });

  it('should find a gate item on another ferret’s agenda, and ignore an agenda it cannot read', async () => {
    // Arrange
    const gate = item('A1', {
      raisedBy: 'daemon',
      raisedBySession: null,
      gate: {
        cardId: 'F1',
        laneId: 'to-test',
        laneName: 'To test',
        entry: 1,
        projectId: PROJECT,
        options: [{ id: 'next', label: 'Good', outcome: 'next' }],
      },
    });
    const handed = [mine({ id: 'F1', assignee: OTHER }), mine({ id: 'F2', assignee: 'broken' })];
    const agendas = {
      [OTHER]: { ok: true, value: snapshot(OTHER, [gate]) },
      broken: { ok: false, error: { code: 'invalid', message: 'bad' } },
    } as const;

    // Act
    const { tidy, listed } = service({ cards: handed, agendas: agendas as never });
    const result = await tidy.plan(ME);

    // Assert
    if (!result.ok) throw new Error(result.message);
    should(result.plan.keep.map(each => `${each.id}:${each.code}`)).deepEqual(['F1:waiting-at-gate']);
    should(result.plan.drop.map(each => each.id)).deepEqual(['F2']);
    should(listed).containDeep([ME, OTHER, 'broken']);
  });

  it('should leave the cards out of a sub-ferret’s plan and still close its tracking items', async () => {
    // Arrange
    const agendas = { [ME]: { ok: true, value: snapshot(ME, [item('A1')]) } } as const;

    // Act
    const result = await plan({ cards: [mine()], agendas, leads: { [ME]: 'lead' } });

    // Assert
    should(result.subFerret).be.true();
    should(result.drop).deepEqual([]);
    should(result.close.map(each => each.id)).deepEqual(['A1']);
  });

  it('should keep items the owner is answering, read from the pending replies and the sending ones', async () => {
    // Arrange
    const agenda = snapshot(ME, [item('A1'), item('A2'), item('A3')], {
      replies: { pending: ['A1'], dueAt: NOW },
      delivery: { sending: ['A2'] },
    });

    // Act
    const result = await plan({ agendas: { [ME]: { ok: true, value: agenda } } });

    // Assert
    should(result.keep.map(each => `${each.id}:${each.code}`)).deepEqual(['A1:owner-replying', 'A2:owner-replying']);
    should(result.close.map(each => each.id)).deepEqual(['A3']);
  });

  it('should close an item linked to a card it drops, and not one linked to a card on another machine', async () => {
    // Arrange
    const items = [
      item('A1', { task: { id: 'F1', machineId: MACHINE } }),
      item('A2', { task: { id: 'F1', machineId: 'machine-b' } }),
    ];

    // Act
    const result = await plan({ cards: [mine()], agendas: { [ME]: { ok: true, value: snapshot(ME, items) } } });

    // Assert
    should(result.close.map(each => `${each.id}:${each.code}`)).deepEqual(['A1:card-dropped', 'A2:status-only']);
  });

  it('should say so when the ferret’s own agenda cannot be read', async () => {
    // Arrange
    const agendas = { [ME]: { ok: false, error: { code: 'invalid', message: 'bad session' } } } as never;

    // Act
    const result = await service({ agendas }).tidy.plan(ME);

    // Assert
    should(result).deepEqual({ ok: false, message: 'bad session' });
  });
});
