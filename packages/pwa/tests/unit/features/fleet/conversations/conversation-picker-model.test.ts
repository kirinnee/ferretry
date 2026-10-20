import { describe, expect, it } from 'bun:test';
import { CONVERSATION_IMPORT_PATH } from '@ferretry/protocol';
import {
  adoptRequest,
  conversationHeadline,
  EMPTY_FILTER,
  EMPTY_SELECTION,
  ferretState,
  foundLine,
  keepButtonLabel,
  listingPath,
  listingQuery,
  matchesDate,
  matchesSearch,
  RECENT_LIMIT,
  runtimeChoice,
  START_LIMIT_HINT,
  selectLastDays,
  sinceInstant,
  toggleKeep,
  toggleStart,
  visibleConversations,
} from '../../../../../src/features/fleet/conversations/conversation-picker-model.ts';
import { runtime } from '../account-support.ts';
import { conversation, NOW } from './conversation-support.ts';

describe('the headline of a row', () => {
  it('is the name, with the first message under it', () => {
    expect(conversationHeadline(conversation('a', { name: 'Cart bugfix', preview: 'Fix the cart' }))).toEqual({
      headline: 'Cart bugfix',
      secondary: 'Fix the cart',
      named: true,
    });
  });

  it('is the first message only when there is no name, and a placeholder when there is none', () => {
    expect(conversationHeadline(conversation('a', { preview: 'Fix the cart' }))).toEqual({
      headline: 'Fix the cart',
      named: false,
    });
    expect(conversationHeadline(conversation('a', { preview: '  ' })).headline).toBe('No message preview');
  });

  it('never lets a ferret stand in for what the conversation is about', () => {
    expect(conversationHeadline(conversation('a', { name: 'Cart bugfix', preview: ' ' }))).toEqual({
      headline: 'Cart bugfix',
      named: true,
    });
  });
});

describe('a ferret’s state dot', () => {
  it('is live while it runs, stopped once it ends, failed when it failed, and absent when unread', () => {
    expect(ferretState('running')).toBe('live');
    expect(ferretState('thinking')).toBe('live');
    expect(ferretState('stopped')).toBe('stopped');
    expect(ferretState('completed')).toBe('stopped');
    expect(ferretState('failed')).toBe('failed');
    expect(ferretState(undefined)).toBeUndefined();
  });
});

describe('search and date filters', () => {
  it('matches every word, in any case, across the first message, the latest one and the folder', () => {
    const row = conversation('a', { preview: 'Fix the Checkout', latest: 'now the tests', project: '/work/shop' });
    expect(matchesSearch(row, '')).toBe(true);
    expect(matchesSearch(row, '  checkout  SHOP ')).toBe(true);
    expect(matchesSearch(row, 'tests')).toBe(true);
    expect(matchesSearch(row, 'checkout notes')).toBe(false);
    expect(matchesSearch(conversation('b'), 'tests')).toBe(false);
  });

  it('matches a word in the conversation name too', () => {
    const row = conversation('a', { name: 'Cart total bugfix' });
    expect(matchesSearch(row, 'BUGFIX cart')).toBe(true);
    expect(matchesSearch(row, 'refund')).toBe(false);
  });

  it('keeps rows active within the window, and every row for any time', () => {
    expect(sinceInstant('any', NOW)).toBeUndefined();
    expect(sinceInstant('7d', NOW)).toBe('2026-10-06T08:00:00.000Z');
    expect(sinceInstant('30d', NOW)).toBe('2026-09-13T08:00:00.000Z');
    expect(matchesDate(conversation('a', { daysAgo: 40 }), 'any', NOW)).toBe(true);
    expect(matchesDate(conversation('a', { daysAgo: 7 }), '7d', NOW)).toBe(true);
    expect(matchesDate(conversation('a', { daysAgo: 8 }), '7d', NOW)).toBe(false);
    expect(matchesDate(conversation('a', { daysAgo: 8 }), '30d', NOW)).toBe(true);
  });
});

describe('visible rows and groups', () => {
  const many = Array.from({ length: 25 }, (_, index) => conversation(`c${index}`, { daysAgo: 25 - index }));

  it('shows the 20 most recent, newest first, until Show all', () => {
    const recent = visibleConversations(many, EMPTY_FILTER, NOW);
    expect(recent.rows).toHaveLength(RECENT_LIMIT);
    expect(recent.rows[0]?.id).toBe('c24');
    expect(recent.hidden).toBe(5);
    const all = visibleConversations(many, { ...EMPTY_FILTER, showAll: true }, NOW);
    expect(all.rows).toHaveLength(25);
    expect(all.hidden).toBe(0);
  });

  it('applies the search and the date together', () => {
    const shown = visibleConversations(many, { text: 'c2', date: '7d', showAll: false }, NOW);
    expect(shown.rows.map(row => row.id)).toEqual(['c24', 'c23', 'c22', 'c21', 'c20']);
  });

  it('says how many it found and how many are already kept', () => {
    expect(foundLine([conversation('a')])).toBe('Found 1 conversation');
    expect(foundLine([conversation('a'), conversation('b', { adoptedBy: 's-1' })])).toBe(
      'Found 2 conversations · 1 already kept',
    );
  });
});

describe('selection', () => {
  const free = conversation('a');
  const kept = conversation('b', { adoptedBy: 's-1' });

  it('keeps and unkeeps a row; unkeeping also stops Start now', () => {
    const on = toggleKeep(EMPTY_SELECTION, free, true);
    expect(on.keep).toEqual(['a']);
    expect(toggleKeep(on, free, true)).toBe(on);
    const starting = { keep: ['a'], start: ['a'] };
    expect(toggleKeep(starting, free, false)).toEqual(EMPTY_SELECTION);
  });

  it('never picks a row a ferret already keeps', () => {
    expect(toggleKeep(EMPTY_SELECTION, kept, true)).toBe(EMPTY_SELECTION);
  });

  it('starts only kept rows, and refuses an eleventh', () => {
    expect(toggleStart(EMPTY_SELECTION, 'a', true)).toEqual({
      kind: 'refused',
      sentence: 'Keep this conversation first.',
    });
    const keptOne = { keep: ['a'], start: [] };
    const started = toggleStart(keptOne, 'a', true);
    expect(started).toEqual({ kind: 'ok', selection: { keep: ['a'], start: ['a'] } });
    expect(toggleStart({ keep: ['a'], start: ['a'] }, 'a', true)).toEqual({
      kind: 'ok',
      selection: { keep: ['a'], start: ['a'] },
    });
    expect(toggleStart({ keep: ['a'], start: ['a'] }, 'a', false)).toEqual({
      kind: 'ok',
      selection: { keep: ['a'], start: [] },
    });
    const ten = Array.from({ length: 10 }, (_, index) => `c${index}`);
    expect(toggleStart({ keep: [...ten, 'x'], start: ten }, 'x', true)).toEqual({
      kind: 'refused',
      sentence: START_LIMIT_HINT,
    });
  });

  it('Select last 7 days adds the fresh unkept rows and skips adopted ones', () => {
    const rows = [
      conversation('fresh', { daysAgo: 2 }),
      conversation('already', { daysAgo: 1 }),
      conversation('stale', { daysAgo: 9 }),
      conversation('adopted', { daysAgo: 1, adoptedBy: 's-1' }),
    ];
    expect(selectLastDays(rows, { keep: ['already'], start: [] }, NOW, 7)).toEqual({
      keep: ['already', 'fresh'],
      start: [],
    });
  });

  it('builds the adoption with start off unless switched on', () => {
    expect(adoptRequest('codex', 'codex-default', { keep: ['a', 'b'], start: ['b'] })).toEqual({
      harness: 'codex',
      runtime: 'codex-default',
      conversations: [
        { id: 'a', start: false },
        { id: 'b', start: true },
      ],
    });
    expect(keepButtonLabel(0)).toBe('Keep 0 as ferrets');
    expect(keepButtonLabel(1)).toBe('Keep 1 as a ferret');
    expect(keepButtonLabel(3)).toBe('Keep 3 as ferrets');
  });
});

describe('runtime choice and the listing query', () => {
  const claude = runtime({ name: 'claude-default' });
  const second = runtime({ name: 'claude-work' });
  const codex = runtime({ name: 'codex-default', harness: 'codex' });

  it('picks the only runtime, offers several, and says when there is none', () => {
    expect(runtimeChoice([claude, codex], 'claude')).toEqual({ kind: 'one', runtime: claude });
    expect(runtimeChoice([claude, second, codex], 'claude')).toEqual({ kind: 'several', runtimes: [claude, second] });
    expect(runtimeChoice([claude], 'codex')).toEqual({
      kind: 'none',
      sentence: 'No Codex runtime on this machine yet. Add one in Settings › Runtimes, then try again.',
    });
  });

  it('builds the daemon query from only what narrows', () => {
    expect(listingQuery({ text: '  ', harness: 'all', date: 'any' }, NOW)).toEqual({});
    expect(listingQuery({ text: ' shop ', harness: 'codex', date: '7d' }, NOW, 50)).toEqual({
      harness: 'codex',
      q: 'shop',
      since: '2026-10-06T08:00:00.000Z',
      limit: 50,
    });
  });

  it('writes the listing address with a query string only when one is needed', () => {
    expect(listingPath({})).toBe(CONVERSATION_IMPORT_PATH);
    expect(
      listingPath({ source: 'ferretry', harness: 'claude', q: 'a b', since: '2026-10-06T08:00:00.000Z', limit: 5 }),
    ).toBe(
      `${CONVERSATION_IMPORT_PATH}?source=ferretry&harness=claude&q=a+b&since=2026-10-06T08%3A00%3A00.000Z&limit=5`,
    );
  });
});
