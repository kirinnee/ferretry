import { describe, expect, test } from 'bun:test';
import type { AgendaConversationEntry } from '@ferretry/core-asks/contract';
import {
  conversationEvent,
  hasStoredConversation,
  storedCount,
  storedHistory,
  tailIsWhole,
} from '../../../app/lib/agenda-conversation.ts';
import type { HistoryEvent } from '../../../app/lib/agenda-history.ts';
import { agendaItem } from '../../support/app/agenda-inbox.tsx';

const entry = (overrides: Partial<AgendaConversationEntry> = {}): AgendaConversationEntry => ({
  at: '2026-11-01T10:00:00.000Z',
  by: 'owner',
  text: 'Use Postgres.',
  via: 'reply',
  ...overrides,
});

describe('how much of the thread is stored', () => {
  test('counts by the item’s own count, else by the tail it carries, else none', () => {
    expect(storedCount({ conversationCount: 9, conversation: [entry()] })).toBe(9);
    expect(storedCount({ conversation: [entry(), entry()] })).toBe(2);
    expect(storedCount({})).toBe(0);
  });

  test('has a stored thread only when it holds words, and knows when the tail is the whole thread', () => {
    expect(hasStoredConversation({})).toBe(false);
    expect(hasStoredConversation({ conversationCount: 1, conversation: [entry()] })).toBe(true);
    expect(tailIsWhole({ conversationCount: 1, conversation: [entry()] })).toBe(true);
    expect(tailIsWhole({ conversationCount: 40, conversation: [entry()] })).toBe(false);
    expect(tailIsWhole({})).toBe(true);
  });
});

describe('one stored entry as an event', () => {
  test('draws the owner’s plain words and the forms they were sent as', () => {
    expect(conversationEvent(entry(), 0)).toEqual({
      kind: 'owner',
      key: 'stored:0:2026-11-01T10:00:00.000Z',
      at: Date.parse('2026-11-01T10:00:00.000Z'),
      text: 'Use Postgres.',
      reached: { via: 'item', answered: false },
    });
    expect(conversationEvent(entry({ via: 'answer' }), 1)).toMatchObject({ kind: 'owner', form: 'answer' });
    expect(conversationEvent(entry({ via: 'needs-info' }), 2)).toMatchObject({ form: 'needs-info' });
    expect(conversationEvent(entry({ via: 'discuss' }), 3)).toMatchObject({ form: 'discuss' });
    expect(conversationEvent(entry({ via: 'chat-log' }), 4)).not.toHaveProperty('form');
  });

  test('draws the ferret’s words, and Ferretry’s own as a daemon row', () => {
    expect(conversationEvent(entry({ by: 'ferret', via: 'surface' }), 0)).toMatchObject({ kind: 'ferret' });
    expect(conversationEvent(entry({ by: 'ferret', via: 'surface' }), 0)).not.toHaveProperty('daemon');
    expect(conversationEvent(entry({ by: 'daemon', via: 'close' }), 0)).toMatchObject({ kind: 'ferret', daemon: true });
  });

  test('keeps the from-chat mark on either side, and reads a bad date as the start of time', () => {
    const fromChat = { messageId: 'm1', at: '2026-11-01T09:59:00.000Z' };
    expect(conversationEvent(entry({ fromChat }), 0)).toMatchObject({ fromChat: true });
    expect(conversationEvent(entry({ by: 'ferret', via: 'chat-log', fromChat }), 0)).toMatchObject({ fromChat: true });
    expect(conversationEvent(entry({ at: 'not a date' }), 0).at).toBe(0);
  });
});

describe('the item’s history from its stored thread', () => {
  test('puts a gap row where the unread earlier entries go, and none for an empty gap', () => {
    const stored = [entry({ text: 'one' }), entry({ text: 'two' })];
    const gapped = storedHistory(agendaItem('A5'), stored, { at: 1, count: 3, state: 'loading' });
    expect(gapped.map(event => event.kind).slice(-3)).toEqual(['owner', 'gap', 'owner']);
    const empty = storedHistory(agendaItem('A5'), stored, { at: 1, count: 0, state: 'loading' });
    expect(empty.some(event => event.kind === 'gap')).toBe(false);
  });

  test('is one event per stored entry, in stored order', () => {
    const events = storedHistory(agendaItem('A5'), [
      entry({ text: 'one' }),
      entry({ by: 'ferret', via: 'reply', text: 'two' }),
    ]);
    const said = events.filter(event => event.kind === 'owner' || event.kind === 'ferret');
    expect(said.map(event => (event as { text: string }).text)).toEqual(['one', 'two']);
  });
});

describe('how far the owner’s stored words are known to have got', () => {
  const reachOf = (event: HistoryEvent | undefined) => (event?.kind === 'owner' ? event.reached : undefined);

  test('on the item; answered once the ferret spoke after them, and Ferretry’s own note is not the ferret', () => {
    const events = storedHistory(agendaItem('A5'), [
      entry({ text: 'one' }),
      entry({ by: 'ferret', via: 'reply', text: 'two' }),
      entry({ text: 'three' }),
      entry({ by: 'daemon', via: 'close', text: 'closed' }),
    ]).filter(event => event.kind === 'owner');
    expect(events.map(reachOf)).toEqual([
      { via: 'item', answered: true },
      { via: 'item', answered: false },
    ]);
  });

  test('words the ferret logged from the chat reached it; a chat reply settled onto the item is only on the machine', () => {
    const fromChat = { messageId: 'm1', at: '2026-11-01T09:59:00.000Z' };
    expect(reachOf(conversationEvent(entry({ via: 'chat-log', fromChat }), 0))).toEqual({
      via: 'transcript',
      answered: false,
    });
    // The daemon stores a chat reply as soon as the queue accepts it, still queued: never "read" on that alone.
    expect(reachOf(conversationEvent(entry({ via: 'reply', fromChat }), 0))).toEqual({ via: 'item', answered: false });
  });
});
