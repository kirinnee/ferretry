import { describe, expect, it } from 'bun:test';
import type { Instant } from '@ferretry/std';
import {
  conversationHeadline,
  ferretState,
  listingQuery,
  listingQueryParams,
  matchesDate,
  matchesSearch,
  sinceInstant,
} from '../../../../app/links/conversation-picker-model.ts';
import { conversation, NOW } from '../../../support/app/links.ts';

describe('the headline of a row', () => {
  it('is the title alone: the first message is not printed under it', () => {
    expect(conversationHeadline(conversation('a', { name: 'Cart bugfix', preview: 'Fix the cart' }))).toEqual({
      headline: 'Cart bugfix',
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

describe('the listing query', () => {
  it('builds the daemon query from only what narrows', () => {
    expect(listingQuery({ text: '  ', harness: 'all', date: 'any' }, NOW)).toEqual({});
    expect(listingQuery({ text: ' shop ', harness: 'codex', date: '7d' }, NOW, 50)).toEqual({
      harness: 'codex',
      q: 'shop',
      since: '2026-10-06T08:00:00.000Z' as Instant,
      limit: 50,
    });
  });

  it('writes the listing query with only what narrows it', () => {
    expect(listingQueryParams({})).toEqual({});
    expect(
      listingQueryParams({
        source: 'ferretry',
        harness: 'claude-code',
        q: 'a b',
        since: '2026-10-06T08:00:00.000Z' as Instant,
        limit: 5,
      }),
    ).toEqual({ source: 'ferretry', harness: 'claude-code', q: 'a b', since: '2026-10-06T08:00:00.000Z', limit: '5' });
  });
});
