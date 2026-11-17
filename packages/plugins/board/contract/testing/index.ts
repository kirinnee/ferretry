/** @ferretry/plugin-board/contract/testing — the contract's fake and conformance suite (§7.8). */
import { describe, expect, test } from 'bun:test';
import { err, type Instant, ok } from '@ferretry/std';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { BoardApi } from '../port.ts';
import type { TaskId } from '../refs.ts';
import { type Task, CardSchema, type TaskView, type Progress } from '../wire.ts';
import { TASK_KIND_PREFIX } from '../workflow.ts';

const AT = '2026-11-07T09:00:00.000Z' as Instant;

/** In-memory `BoardApi`: ids count per kind, progress merges by part, a move is recorded in the history. */
export function fakeBoard(): BoardApi {
  const tasks = new Map<string, Task>();
  const counters = { bug: 0, feature: 0, infra: 0, chore: 0 };
  /** A ferret's write focuses it on the card (the real board does the same); the owner has no focus. */
  const focus = new Map<string, string>();
  const view = (task: Task): TaskView => ({
    ...task,
    lastTouchedAt: null,
    touchedBy: null,
    activity: 'active',
    rollup: {
      children: 0,
      byCategory: { backlog: 0, active: 0, review: 0, shipped: 0, verify: 0, closed: 0 },
      active: 0,
      lastTouchedAt: null,
    },
    suggestedLane: null,
    openAsks: [],
    blockedBy: [],
    blocks: [],
    shippedIn: null,
    origin: 'human',
  });
  const store = (task: Task): Task => {
    const parsed = CardSchema.parse(task);
    tasks.set(parsed.id, parsed);
    return parsed;
  };
  return {
    card: async id => {
      const task = tasks.get(id);
      return task === undefined ? undefined : view(task);
    },
    cards: async query =>
      [...tasks.values()].filter(task => query.project === undefined || task.projectId === query.project).map(view),
    // The cursor is the offset of the next card; the last page's is `null`.
    cardsPage: async query => {
      const all = [...tasks.values()]
        .filter(task => query.project === undefined || task.projectId === query.project)
        .map(view);
      const start = query.cursor === undefined ? 0 : Number(query.cursor);
      const end = start + query.limit;
      return { cards: all.slice(start, end), nextCursor: end < all.length ? String(end) : null };
    },
    // The fake has no lane sets of its own: a consumer names a lane by its id.
    laneSets: async () => [],
    // The fake's views are all `active`, so no card is ever orphaned here.
    orphanedCards: async () => ({
      cards: [...tasks.values()].map(view).filter(each => each.activity === 'orphaned'),
      laneSets: [],
    }),
    focusOf: async ferret => {
      const id = focus.get(ferret);
      const task = id === undefined ? undefined : tasks.get(id);
      return task === undefined ? undefined : { card: view(task), laneSet: null };
    },
    create: async (by, request) => {
      counters[request.kind] += 1;
      const id = `${TASK_KIND_PREFIX[request.kind]}${counters[request.kind]}`;
      const actor = by === 'owner' ? ({ kind: 'owner' } as const) : ({ kind: 'ferret', name: by, ferret: by } as const);
      const laneId = request.laneId ?? 'todo';
      if (by !== 'owner') focus.set(by, id);
      return ok(
        store({
          format: 1,
          id,
          machineId: 'local',
          projectId: request.projectId ?? 'unfiled',
          laneId,
          kind: request.kind,
          title: request.title,
          summary: request.summary,
          ask: request.ask,
          clarifications: [],
          premise: request.premise,
          context: request.context,
          terms: request.terms,
          brief: request.brief,
          howToTest: request.howToTest,
          ...(request.progress === undefined ? {} : { progress: request.progress }),
          owner: by === 'owner' ? 'owner' : by,
          assignee: request.assignee,
          parent: request.parent,
          dependsOn: [],
          blocked: null,
          dropped: null,
          workflow: request.workflow,
          links: { prs: [], branch: null, commits: [], docs: [] },
          files: request.files,
          order: null,
          createdAt: AT,
          createdBy: actor,
          history: [{ seq: 1, type: 'created', at: AT, actor, laneId }],
        }),
      );
    },
    act: async (by, id, request) => {
      const task = tasks.get(id);
      if (task === undefined) return err({ code: 'not-found', message: `no card ${id}` });
      if (request.action !== 'move') return err({ code: 'refused', message: `the fake does not do ${request.action}` });
      if (by !== 'owner') focus.set(by, id);
      const actor = by === 'owner' ? ({ kind: 'owner' } as const) : ({ kind: 'ferret', name: by, ferret: by } as const);
      return ok(
        store({
          ...task,
          laneId: request.to,
          history: [
            ...task.history,
            {
              seq: task.history.length + 1,
              type: 'moved',
              at: AT,
              actor,
              from: task.laneId,
              to: request.to,
              backward: false,
              reason: request.reason ?? null,
            },
          ],
        }),
      );
    },
    progress: async (by, id, parts) => {
      const task = tasks.get(id);
      if (task === undefined) return err({ code: 'not-found', message: `no card ${id}` });
      focus.set(by, id);
      const merged: Progress = { now: '', doneSoFar: '', next: '', ...task.progress, ...parts };
      return ok(store({ ...task, progress: merged }));
    },
    heldBy: async ferret => [...tasks.values()].filter(task => task.owner === ferret).map(view),
    switchOf: async project => ({ projectId: project as never, on: true, setBy: 'default', setAt: null }),
  };
}

export function boardConformance(name: string, make: () => BoardApi | Promise<BoardApi>): void {
  describe(`BoardApi conformance: ${name}`, () => {
    // The owner makes a card for a ferret (a card needs one to own it); a ferret's own cards need an approved board.
    const create = (api: BoardApi, assignee = 'f1') =>
      api.create('owner', {
        kind: 'feature',
        title: 'Badge colour',
        ask: { text: 'make it blue', source: 'owner' },
        summary: '',
        premise: '',
        context: '',
        terms: [],
        brief: '',
        howToTest: '',
        workflow: 'quick',
        parent: null,
        assignee,
        dependsOn: [],
        files: [],
        docs: [],
      });
    test('a created card is read back with an id that starts with its kind', async () => {
      const api = await make();
      const made = await create(api);
      expect(made.ok && made.value.id.startsWith('F')).toBe(true);
      if (made.ok) expect((await api.card(made.value.id as TaskId))?.title).toBe('Badge colour');
    });
    test('progress replaces the parts named and keeps the rest', async () => {
      const api = await make();
      const made = await create(api);
      if (!made.ok) throw new Error('setup');
      await api.progress('f1' as FerretId, made.value.id as TaskId, { now: 'building', next: 'test' });
      const after = await api.progress('f1' as FerretId, made.value.id as TaskId, { doneSoFar: '- the colour' });
      expect(after.ok && after.value.progress).toEqual({ now: 'building', doneSoFar: '- the colour', next: 'test' });
    });
    test('cardsPage reads past one page: the cursor leads to the next and is null on the last', async () => {
      const api = await make();
      for (let each = 0; each < 3; each += 1) await create(api);
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await api.cardsPage({ state: 'open', limit: 2, ...(cursor === undefined ? {} : { cursor }) });
        seen.push(...page.cards.map(task => task.id));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor !== undefined && pages < 5);
      expect(pages).toBe(2);
      expect(new Set(seen).size).toBe(3);
    });
    test('focusOf is undefined for a ferret with none, and the owner’s writes focus nobody', async () => {
      const api = await make();
      expect(await api.focusOf('nobody' as FerretId)).toBeUndefined();
      const made = await create(api);
      if (!made.ok) throw new Error('setup');
      expect(await api.focusOf('f1' as FerretId)).toBeUndefined();
    });
    test('a ferret is focused on the card it last wrote, by reporting progress or by moving it', async () => {
      const api = await make();
      const first = await create(api);
      const second = await create(api);
      if (!first.ok || !second.ok) throw new Error('setup');
      const firstId = first.value.id as TaskId;
      const secondId = second.value.id as TaskId;
      expect((await api.progress('f1' as FerretId, firstId, { now: 'building' })).ok).toBe(true);
      const focus = await api.focusOf('f1' as FerretId);
      expect(focus?.card.id).toBe(firstId);
      // The lanes of the card's board come with it (`null` for a board with none).
      expect(focus?.laneSet === null || focus?.laneSet?.projectId === focus?.card.projectId).toBe(true);
      expect((await api.progress('f1' as FerretId, secondId, { now: 'building' })).ok).toBe(true);
      expect((await api.focusOf('f1' as FerretId))?.card.id).toBe(secondId);
      expect((await api.act('f1' as FerretId, firstId, { action: 'move', to: 'doing' })).ok).toBe(true);
      expect((await api.focusOf('f1' as FerretId))?.card.id).toBe(firstId);
    });
    test('the owner’s write moves no ferret’s focus', async () => {
      const api = await make();
      const mine = await create(api);
      const other = await create(api);
      if (!mine.ok || !other.ok) throw new Error('setup');
      await api.progress('f1' as FerretId, mine.value.id as TaskId, { now: 'building' });
      expect((await api.act('owner', other.value.id as TaskId, { action: 'move', to: 'doing' })).ok).toBe(true);
      expect((await api.focusOf('f1' as FerretId))?.card.id).toBe(mine.value.id);
    });
    test('orphanedCards lists no card while every card has a live ferret, and the lanes as a list', async () => {
      const api = await make();
      await create(api);
      const read = await api.orphanedCards();
      expect(read.cards).toEqual([]);
      expect(Array.isArray(read.laneSets)).toBe(true);
    });
    test('laneSets lists lane sets (none for a board with no lanes of its own)', async () => {
      expect(Array.isArray(await (await make()).laneSets())).toBe(true);
    });
    test('a card has no way to ask or to be answered', async () => {
      const api = (await make()) as unknown as Record<string, unknown>;
      for (const name of ['ask', 'answer', 'reply']) expect(name in api).toBe(false);
    });
  });
}
