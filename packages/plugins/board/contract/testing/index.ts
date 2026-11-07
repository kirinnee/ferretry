/** @ferretry/plugin-board/contract/testing — the contract's fake and conformance suite (§7.8). */
import { describe, expect, test } from 'bun:test';
import { err, type Instant, ok } from '@ferretry/std';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { BoardApi } from '../port.ts';
import type { CardId } from '../refs.ts';
import { type Card, CardSchema, type CardView, type Progress } from '../wire.ts';
import { CARD_KIND_PREFIX } from '../workflow.ts';

const AT = '2026-11-07T09:00:00.000Z' as Instant;

/** In-memory `BoardApi`: ids count per kind, progress merges by part, a move is recorded in the history. */
export function fakeBoard(): BoardApi {
  const cards = new Map<string, Card>();
  const counters = { bug: 0, feature: 0, infra: 0, chore: 0 };
  const view = (card: Card): CardView => ({
    ...card,
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
  const store = (card: Card): Card => {
    const parsed = CardSchema.parse(card);
    cards.set(parsed.id, parsed);
    return parsed;
  };
  return {
    card: async id => {
      const card = cards.get(id);
      return card === undefined ? undefined : view(card);
    },
    cards: async query =>
      [...cards.values()].filter(card => query.project === undefined || card.projectId === query.project).map(view),
    create: async (by, request) => {
      counters[request.kind] += 1;
      const id = `${CARD_KIND_PREFIX[request.kind]}${counters[request.kind]}`;
      const actor = by === 'owner' ? ({ kind: 'owner' } as const) : ({ kind: 'ferret', ferret: by } as const);
      const laneId = request.laneId ?? 'todo';
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
      const card = cards.get(id);
      if (card === undefined) return err({ code: 'not-found', message: `no card ${id}` });
      if (request.action !== 'move') return err({ code: 'refused', message: `the fake does not do ${request.action}` });
      const actor = by === 'owner' ? ({ kind: 'owner' } as const) : ({ kind: 'ferret', ferret: by } as const);
      return ok(
        store({
          ...card,
          laneId: request.to,
          history: [
            ...card.history,
            {
              seq: card.history.length + 1,
              type: 'moved',
              at: AT,
              actor,
              from: card.laneId,
              to: request.to,
              backward: false,
              reason: request.reason ?? null,
            },
          ],
        }),
      );
    },
    progress: async (_by, id, parts) => {
      const card = cards.get(id);
      if (card === undefined) return err({ code: 'not-found', message: `no card ${id}` });
      const merged: Progress = { now: '', doneSoFar: '', next: '', ...card.progress, ...parts };
      return ok(store({ ...card, progress: merged }));
    },
    heldBy: async ferret => [...cards.values()].filter(card => card.owner === ferret).map(view),
    switchOf: async project => ({ projectId: project as never, on: true, setBy: 'default', setAt: null }),
  };
}

export function boardConformance(name: string, make: () => BoardApi): void {
  describe(`BoardApi conformance: ${name}`, () => {
    const create = (api: BoardApi) =>
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
        assignee: null,
        dependsOn: [],
        files: [],
        docs: [],
      });
    test('a created card is read back with an id that starts with its kind', async () => {
      const api = make();
      const made = await create(api);
      expect(made.ok && made.value.id.startsWith('F')).toBe(true);
      if (made.ok) expect((await api.card(made.value.id as CardId))?.title).toBe('Badge colour');
    });
    test('progress replaces the parts named and keeps the rest', async () => {
      const api = make();
      const made = await create(api);
      if (!made.ok) throw new Error('setup');
      await api.progress('f1' as FerretId, made.value.id as CardId, { now: 'building', next: 'test' });
      const after = await api.progress('f1' as FerretId, made.value.id as CardId, { doneSoFar: '- the colour' });
      expect(after.ok && after.value.progress).toEqual({ now: 'building', doneSoFar: '- the colour', next: 'test' });
    });
    test('a card has no way to ask or to be answered', () => {
      const api = make() as unknown as Record<string, unknown>;
      for (const name of ['ask', 'answer', 'reply']) expect(name in api).toBe(false);
    });
  });
}
