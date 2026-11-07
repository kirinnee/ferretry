import { describe, expect, test } from 'bun:test';
import {
  REFERENCE_CATALOG_MAX_ENTRIES,
  ReferenceCatalogEntrySchema,
  type ReferenceCatalogInput,
  referenceCatalogLimit,
} from '@ferretry/plugin-conversation/contract';
import { type BoardCardViews, BoardReferenceCatalog } from '../../../daemon/adapters/reference-catalog.ts';
import { type Card, type CardView, cap } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';
import { card, lanes, PROJECT } from '../board/support.ts';

const view = (overrides: Partial<Card> = {}, touched: string | null = null): CardView => ({
  ...card(overrides),
  lastTouchedAt: touched,
  touchedBy: null,
  activity: 'idle',
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
});

const catalog = (views: readonly CardView[]) =>
  new BoardReferenceCatalog({
    sweepBoard: async () => ({ views, laneSets: new Map([[PROJECT, lanes()]]) }),
  } satisfies BoardCardViews);

const ask = (ferret: string, query?: string): ReferenceCatalogInput => ({
  ferret,
  ...(query === undefined ? {} : { query }),
  caller: {},
});

const ids = (entries: readonly { readonly token: string }[]): string[] => entries.map(entry => entry.token);

describe('board provides the & reference menu (reference.catalog)', () => {
  test('entries are the cards the ferret owns or is assigned: the token is the id, the label the title, the detail the assignee', async () => {
    const entries = await catalog([
      view({ id: 'F1', title: 'Badge colour', owner: 'f1', assignee: 'helper' }),
      view({ id: 'F2', title: 'Held for me', owner: 'lead', assignee: 'f1' }),
      view({ id: 'F3', title: 'Not mine', owner: 'lead', assignee: 'f2' }),
      view({ id: 'F4', title: 'Mine, unassigned', owner: 'f1', assignee: null }),
    ]).entries(ask('f1'));
    expect(ids(entries).sort()).toEqual(['F1', 'F2', 'F4']);
    const mine = entries.find(entry => entry.token === 'F1');
    expect(mine).toMatchObject({ token: 'F1', label: 'Badge colour', detail: 'helper' });
    expect(entries.find(entry => entry.token === 'F4')?.detail).toBe('unassigned');
  });

  test('the lane and the summary are the other words a card is found by', async () => {
    const [entry] = await catalog([
      view({ id: 'F1', owner: 'f1', laneId: 'implement', summary: 'green badge on the inbox' }),
    ]).entries(ask('f1'));
    expect(entry?.aliases).toEqual(['Implement', 'green badge on the inbox']);
  });

  test('an alias never passes the entry bound, and every entry parses against the contract', async () => {
    const entries = await catalog([view({ id: 'F1', owner: 'f1', summary: 'x'.repeat(500) })]).entries(ask('f1'));
    for (const entry of entries) expect(ReferenceCatalogEntrySchema.safeParse(entry).success).toBe(true);
    expect(entries[0]?.aliases?.every(alias => alias.length <= 64)).toBe(true);
  });

  test('order: open before closed; active work first, then the most recently touched, then id', async () => {
    const entries = await catalog([
      view({ id: 'F5', owner: 'f1', laneId: 'closed' }, '2026-11-07T10:00:00.000Z'),
      view({ id: 'F1', owner: 'f1', laneId: 'todo' }, '2026-11-01T10:00:00.000Z'),
      view({ id: 'F2', owner: 'f1', laneId: 'todo' }, '2026-11-05T10:00:00.000Z'),
      view({ id: 'F3', owner: 'f1', laneId: 'implement' }, '2026-10-01T10:00:00.000Z'),
      view({ id: 'F4', owner: 'f1', laneId: 'todo' }, '2026-11-05T10:00:00.000Z'),
    ]).entries(ask('f1'));
    expect(ids(entries)).toEqual(['F3', 'F2', 'F4', 'F1', 'F5']);
  });

  test('a card never touched is ordered by when it was made', async () => {
    const entries = await catalog([
      view({ id: 'F1', owner: 'f1', createdAt: '2026-11-01T00:00:00.000Z' }),
      view({ id: 'F2', owner: 'f1', createdAt: '2026-11-03T00:00:00.000Z' }),
    ]).entries(ask('f1'));
    expect(ids(entries)).toEqual(['F2', 'F1']);
  });

  test('closed: a card in a closed lane and a dropped card are known but not on offer; an open one is not marked', async () => {
    const dropped = view({ id: 'F3', owner: 'f1', laneId: 'todo' });
    const entries = await catalog([
      view({ id: 'F1', owner: 'f1', laneId: 'closed' }),
      view({ id: 'F2', owner: 'f1', laneId: 'todo' }),
      {
        ...dropped,
        dropped: { reason: 'not needed', at: '2026-11-02T00:00:00.000Z', by: { kind: 'owner' } },
      } as CardView,
    ]).entries(ask('f1'));
    const closedOf = (id: string) => entries.find(entry => entry.token === id)?.closed;
    expect(closedOf('F1')).toBe(true);
    expect(closedOf('F3')).toBe(true);
    expect(closedOf('F2')).toBeUndefined();
  });

  test('a card on a board whose lanes cannot be read stands as open under its lane id', async () => {
    const entries = await new BoardReferenceCatalog({
      sweepBoard: async () => ({ views: [view({ id: 'F1', owner: 'f1', laneId: 'mystery' })], laneSets: new Map() }),
    }).entries(ask('f1'));
    expect(entries).toEqual([{ token: 'F1', label: 'Board store', detail: 'unassigned', aliases: ['mystery'] }]);
  });

  test('the query narrows by id, title, summary, lane and assignee, ignoring case', async () => {
    const views = [
      view({ id: 'F1', title: 'Badge colour', owner: 'f1' }),
      view({ id: 'F12', title: 'Inbox', owner: 'f1', summary: 'show the Badge' }),
      view({ id: 'F20', title: 'Other', owner: 'f1', laneId: 'implement', assignee: 'Helper' }),
    ];
    const found = async (query: string) => ids(await catalog(views).entries(ask('f1', query))).sort();
    expect(await found('f12')).toEqual(['F12']);
    expect(await found('BADGE')).toEqual(['F1', 'F12']);
    expect(await found('implement')).toEqual(['F20']);
    expect(await found('helper')).toEqual(['F20']);
    expect(await found('nothing matches this')).toEqual([]);
    expect(await found('   ')).toEqual(['F1', 'F12', 'F20']);
  });

  test('the answer is bounded by the limit for &, and open cards are kept before closed ones', async () => {
    const open = Array.from({ length: REFERENCE_CATALOG_MAX_ENTRIES - 1 }, (_, index) =>
      view({ id: `F${String(index + 1)}`, owner: 'f1', laneId: 'todo' }),
    );
    const done = Array.from({ length: 30 }, (_, index) =>
      view({ id: `F${String(1000 + index)}`, owner: 'f1', laneId: 'closed' }),
    );
    const entries = await catalog([...done, ...open]).entries(ask('f1'));
    expect(referenceCatalogLimit('&')).toBe(REFERENCE_CATALOG_MAX_ENTRIES);
    expect(entries).toHaveLength(REFERENCE_CATALOG_MAX_ENTRIES);
    expect(entries.filter(entry => entry.closed === true)).toHaveLength(1);
  });

  test('a ferret with no cards, or none on this machine, is an empty menu', async () => {
    expect(await catalog([]).entries(ask('f1'))).toEqual([]);
    expect(await catalog([view({ id: 'F1', owner: 'lead', assignee: 'f2' })]).entries(ask('f1'))).toEqual([]);
  });

  test('an entry is card words and ids only: no ask text, brief, note, link or other field of the card', async () => {
    const entries = await catalog([
      view({
        id: 'F1',
        owner: 'f1',
        ask: { text: 'ASK-TEXT', source: 'owner' },
        brief: 'BRIEF-TEXT',
        context: 'CONTEXT-TEXT',
        howToTest: 'TEST-TEXT',
      }),
    ]).entries(ask('f1'));
    expect(JSON.stringify(entries)).not.toMatch(/ASK-TEXT|BRIEF-TEXT|CONTEXT-TEXT|TEST-TEXT/u);
    for (const entry of entries)
      expect(Object.keys(entry).every(key => ['token', 'label', 'detail', 'aliases', 'closed'].includes(key))).toBe(
        true,
      );
  });

  test('the demand declared is the one the direct board read declares (GET /v1/board: fleet use)', () => {
    const route = manifest.actions.routes.find(each => each.key === 'GET /v1/board');
    expect(route?.capability).toBeDefined();
    expect(catalog([]).demand).toEqual(route?.capability as never);
    expect(catalog([]).demand).toEqual(cap('fleet', 'use'));
    // …and the card list a caller reaches from a single card is asked the same, so no read here is easier than a route.
    const card = manifest.actions.routes.find(each => each.key === 'GET /v1/board/cards');
    expect(card?.capability).toEqual(route?.capability as never);
  });

  test('the manifest takes reference.catalog keyed by the & prefix, and Conversation stays an optional use', () => {
    const take = manifest.hooks.takes.find(each => each.hook.name === 'reference.catalog');
    expect((take as { readonly key?: string } | undefined)?.key).toBe('&');
    expect(Object.keys(manifest.uses ?? {})).toContain('conversation');
    expect(Object.keys(manifest.needs ?? {})).not.toContain('conversation');
  });
});
