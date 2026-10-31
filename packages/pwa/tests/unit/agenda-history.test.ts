import { describe, expect, test } from 'bun:test';
import { type AgendaItem, agendaAnswerMessage, agendaReMessage } from '@ferretry/protocol';
import { HISTORY_FERRET_CHARS, itemHistory, recentEntries } from '../../src/lib/agenda-history.ts';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';
import { agendaItem } from '../support/agenda-inbox.tsx';

const A47 = { id: 'A47', quote: 'Ship the relay fix?' } as never;
const entry = (id: string, kind: TranscriptEntry['kind'], text: string, at?: number): TranscriptEntry =>
  ({ id, kind, text, ...(at === undefined ? {} : { at }) }) as TranscriptEntry;

const item = (extra: Partial<AgendaItem> = {}): AgendaItem =>
  agendaItem('A47', { waitingSince: new Date(0).toISOString(), ...extra });

describe('the history of one agenda item', () => {
  test('is empty for an item nobody touched and a chat that never mentions it', () => {
    expect(itemHistory(item(), [entry('u1', 'user', 'hello'), entry('a1', 'assistant', 'hi')])).toEqual([]);
  });

  test('lists the revisions oldest first, each with the fields it changed', () => {
    const revisions = [
      { at: '2026-08-01T10:00:00.000Z', by: 'agent', changed: ['subject'], previous: { subject: 'Old ask' } },
      { at: '2026-08-01T11:00:00.000Z', by: 'owner', changed: ['title'], previous: { title: 'Old title' } },
    ] as unknown as AgendaItem['revisions'];
    const events = itemHistory(item({ revisions }), []);
    expect(events.map(event => event.kind)).toEqual(['raised', 'revision', 'revision']);
    expect(events.map(event => event.at)).toEqual([
      0,
      Date.parse('2026-08-01T10:00:00.000Z'),
      Date.parse('2026-08-01T11:00:00.000Z'),
    ]);
    const first = events[1];
    expect(first?.kind === 'revision' ? first.entry.changed[0]?.label : '').toBe('Question');
  });

  test('reads the owner’s forms with the protocol’s reader, keeping only the parts that name this item', () => {
    const other = { id: 'A9', quote: 'Other' } as never;
    const answer = agendaAnswerMessage(A47, 'Ship it', 'on staging first');
    const events = itemHistory(item(), [
      entry('u1', 'user', answer, 5),
      entry('u2', 'user', agendaReMessage([other], 'about the other one'), 6),
    ]);
    expect(events).toHaveLength(2);
    const only = events[1];
    expect(only?.kind).toBe('owner');
    expect(only?.kind === 'owner' ? only.part.text : '').toBe('Ship it');
    expect(only?.kind === 'owner' ? only.part.note : '').toBe('on staging first');
  });

  test('reads a plain message that names the item as the owner talking about it, and ignores one that does not', () => {
    const events = itemHistory(item(), [
      entry('u1', 'user', '!A47 take the second option', 1),
      entry('u2', 'user', 'unrelated !A470 message', 2),
      entry('u3', 'user', 'no mention at all', 3),
    ]);
    expect(events.map(event => event.kind)).toEqual(['raised', 'owner-text']);
  });

  test('reads the ferret’s messages that name the item, cutting a long one', () => {
    const long = `Re !A47: ${'x'.repeat(HISTORY_FERRET_CHARS + 50)}`;
    const events = itemHistory(item(), [
      entry('a1', 'assistant', 'About !A47 — done.', 1),
      entry('a2', 'assistant', long, 2),
      entry('a3', 'assistant', 'About !A4 only', 3),
      entry('t1', 'tool', 'mentions !A47 but is a tool row', 4),
    ]);
    expect(events.map(event => event.kind)).toEqual(['raised', 'ferret', 'ferret']);
    const second = events[2];
    expect(second?.kind === 'ferret' ? second.text.length : 0).toBe(HISTORY_FERRET_CHARS + 1);
    expect(second?.kind === 'ferret' ? second.text.endsWith('…') : false).toBe(true);
  });

  test('interleaves revisions and chat by time, stably, and lets a row with no clock inherit the last', () => {
    const revisions = [
      { at: '2026-08-01T10:00:00.000Z', by: 'agent', changed: ['subject'], previous: { subject: 'Old' } },
    ] as unknown as AgendaItem['revisions'];
    const base = Date.parse('2026-08-01T10:00:00.000Z');
    const events = itemHistory(item({ revisions }), [
      entry('a0', 'assistant', 'before: !A47', base - 1_000),
      entry('a1', 'assistant', 'same moment: !A47', base),
      entry('a2', 'assistant', 'no clock: !A47'),
      entry('a3', 'assistant', 'later: !A47', base + 5_000),
    ]);
    expect(events.map(event => event.kind)).toEqual(['raised', 'ferret', 'revision', 'ferret', 'ferret', 'ferret']);
    expect(events[4]?.at).toBe(base);
  });

  test('gives a revision with an unreadable time the epoch rather than NaN', () => {
    const revisions = [
      { at: 'not a time', by: 'agent', changed: ['subject'], previous: { subject: 'Old' } },
    ] as unknown as AgendaItem['revisions'];
    expect(itemHistory(item({ revisions }), [])[1]?.at).toBe(0);
  });

  test('opens with who raised the item, at the time it started waiting, and sorts into the lead-up before it', () => {
    const raisedAt = Date.parse('2026-08-01T10:00:00.000Z');
    const events = itemHistory(item({ waitingSince: '2026-08-01T10:00:00.000Z', raisedBy: 'human' }), [
      entry('a0', 'assistant', 'lead-up: !A47', raisedAt - 1_000),
      entry('a1', 'assistant', 'after: !A47', raisedAt + 1_000),
    ]);
    expect(events.map(event => event.kind)).toEqual(['ferret', 'raised', 'ferret']);
    const raised = events[1];
    expect(raised?.kind === 'raised' ? raised.by : '').toBe('human');
    expect(raised?.at).toBe(raisedAt);
  });

  test('gives an unreadable waiting time the epoch', () => {
    const events = itemHistory(item({ waitingSince: 'soon' }), [entry('a1', 'assistant', 'x: !A47', 3)]);
    expect(events[0]).toMatchObject({ kind: 'raised', at: 0 });
  });
});

describe('what the ferret said lately', () => {
  test('becomes the chat’s assistant rows, with a clock only when the message has a readable one', () => {
    const rows = recentEntries([
      { text: 'one', timestamp: '2026-08-01T10:00:00.000Z' },
      { text: 'two' },
      { text: 'three', timestamp: 'nope' },
    ]);
    expect(rows).toEqual([
      { id: 'recent:0', kind: 'assistant', text: 'one', at: Date.parse('2026-08-01T10:00:00.000Z') },
      { id: 'recent:1', kind: 'assistant', text: 'two' },
      { id: 'recent:2', kind: 'assistant', text: 'three' },
    ]);
  });

  test('is the lead-up of an item that nothing names, with a long message cut', () => {
    const long = 'y'.repeat(HISTORY_FERRET_CHARS + 20);
    const events = itemHistory(item(), [], recentEntries([{ text: 'Cut the branch.' }, { text: long }]));
    expect(events.map(event => event.kind)).toEqual(['raised', 'ferret', 'ferret']);
    const last = events[2];
    expect(last?.kind === 'ferret' ? last.text.length : 0).toBe(HISTORY_FERRET_CHARS + 1);
  });

  test('is not drawn twice when the item’s own reading already holds the message, however it was cut or spaced', () => {
    const said = 'About !A47 — done.\n  and   more';
    const events = itemHistory(
      item(),
      [entry('a1', 'assistant', said, 2)],
      recentEntries([{ text: 'About !A47 — done. and more…' }, { text: 'Something else.' }]),
    );
    const texts = events.flatMap(event => (event.kind === 'ferret' ? [event.text] : []));
    expect(texts).toHaveLength(2);
    expect(texts.filter(text => text.startsWith('About'))).toHaveLength(1);
    expect(texts).toContain('Something else.');
  });
});
