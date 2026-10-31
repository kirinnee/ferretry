import { describe, expect, test } from 'bun:test';
import { type AgendaItem, agendaAnswerMessage, agendaDismissedMessage, agendaReMessage } from '@ferretry/protocol';
import { HISTORY_FERRET_CHARS, type HistoryEvent, itemHistory } from '../../src/lib/agenda-history.ts';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';
import { agendaItem } from '../support/agenda-inbox.tsx';

const A47 = { id: 'A47', quote: 'Ship the relay fix?' } as never;
const entry = (id: string, kind: TranscriptEntry['kind'], text: string, at?: number): TranscriptEntry =>
  ({ id, kind, text, ...(at === undefined ? {} : { at }) }) as TranscriptEntry;

const item = (extra: Partial<AgendaItem> = {}): AgendaItem =>
  agendaItem('A47', { waitingSince: new Date(0).toISOString(), ...extra });

const said = (events: readonly HistoryEvent[]): string[] =>
  events.flatMap(event => (event.kind === 'owner' || event.kind === 'ferret' ? [`${event.kind}: ${event.text}`] : []));

describe('the history of one agenda item', () => {
  test('is empty for an item nobody touched and a chat that never mentions it', () => {
    expect(itemHistory(item(), [entry('u1', 'user', 'hello'), entry('a1', 'assistant', 'hi')])).toEqual([]);
  });

  test('says one "updated to vN" per edit, oldest first, and makes up no line for the raise', () => {
    const revisions = [
      { at: '2026-08-01T10:00:00.000Z', by: 'agent', changed: ['subject'], previous: { subject: 'Old ask' } },
      { at: '2026-08-01T11:00:00.000Z', by: 'human', changed: ['title'], previous: { title: 'Old title' } },
    ] as unknown as AgendaItem['revisions'];
    const events = itemHistory(item({ revisions }), []);
    expect(events.map(event => (event.kind === 'revision' ? event.version : event.kind))).toEqual([2, 3]);
  });

  test('reads the owner’s forms with the protocol’s reader, keeping only the parts that name this item', () => {
    const other = { id: 'A9', quote: 'Other' } as never;
    const events = itemHistory(item(), [
      entry('u1', 'user', agendaAnswerMessage(A47, 'Ship it', 'on staging first'), 5),
      entry('u2', 'user', agendaReMessage([other], 'about the other one'), 6),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'owner', form: 'answer', text: 'Ship it', note: 'on staging first' });
  });

  test('says a dismissal as "Not needed", the owner’s reason as its note', () => {
    const events = itemHistory(item(), [entry('u1', 'user', agendaDismissedMessage(A47, 'done already'), 5)]);
    expect(events[0]).toMatchObject({ kind: 'owner', form: 'dismissed', text: 'Not needed', note: 'done already' });
  });

  test('keeps a plain reply that cites the item, without the reference the composer put in front of it', () => {
    const events = itemHistory(item(), [
      entry('u1', 'user', '!A47 take the second option', 1),
      entry('u2', 'user', 'unrelated !A470 message', 2),
      entry('u3', 'user', 'no mention at all', 3),
    ]);
    expect(said(events)).toEqual(['owner: take the second option']);
  });

  test('never reads a message another ferret sent as the owner’s', () => {
    const peer = { ...entry('u1', 'user', '!A47 from a peer', 1), peer: { name: 'piper' } } as TranscriptEntry;
    expect(itemHistory(item(), [peer])).toEqual([]);
  });

  test('keeps the ferret’s FINAL text of the turn that answers the owner, even when it does not cite the item', () => {
    const events = itemHistory(item(), [
      entry('u1', 'user', '!A47 does pause kill a running turn?', 1),
      entry('a1', 'assistant', 'Let me check the runner.', 2),
      entry('t1', 'tool', 'Read(runner.ts) → 140 lines', 3),
      entry('a2', 'assistant', 'No. A running turn finishes.', 4),
      entry('u2', 'user', 'unrelated: bump the lockfile?', 5),
      entry('a3', 'assistant', 'Bumped the lockfile.', 6),
    ]);
    expect(said(events)).toEqual(['owner: does pause kill a running turn?', 'ferret: No. A running turn finishes.']);
  });

  test('keeps the ferret’s text that cites the item anywhere, and nothing else it said', () => {
    const long = `Re !A47: ${'x'.repeat(HISTORY_FERRET_CHARS + 50)}`;
    const events = itemHistory(item(), [
      entry('a0', 'assistant', 'Building the settings page.', 0),
      entry('a1', 'assistant', 'About !A47 — done.', 1),
      entry('a2', 'assistant', long, 2),
      entry('a3', 'assistant', 'About !A4 only', 3),
      entry('t1', 'tool', 'mentions !A47 but is a tool row', 4),
      entry('c1', 'command', '/model !A47', 5),
    ]);
    expect(events.map(event => event.kind)).toEqual(['ferret', 'ferret']);
    const second = events[1];
    expect(second?.kind === 'ferret' ? second.text.length : 0).toBe(HISTORY_FERRET_CHARS + 1);
    expect(second?.kind === 'ferret' ? second.text.endsWith('…') : false).toBe(true);
  });

  test('does not keep the narration of an answering turn once the ferret cites the item in it', () => {
    const events = itemHistory(item(), [
      entry('u1', 'user', '!A47 why?', 1),
      entry('a1', 'assistant', 'Checking.', 2),
      entry('a2', 'assistant', 'Updated !A47 with the reason.', 3),
    ]);
    expect(said(events)).toEqual(['owner: why?', 'ferret: Updated !A47 with the reason.']);
  });

  test('interleaves versions and chat by time, stably, and lets a row with no clock inherit the last', () => {
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
    expect(events.map(event => event.kind)).toEqual(['ferret', 'revision', 'ferret', 'ferret', 'ferret']);
    expect(events[3]?.at).toBe(base);
  });

  test('gives a revision with an unreadable time, and an unreadable waiting time, the epoch rather than NaN', () => {
    const revisions = [
      { at: 'not a time', by: 'agent', changed: ['subject'], previous: { subject: 'Old' } },
    ] as unknown as AgendaItem['revisions'];
    const events = itemHistory(item({ revisions, waitingSince: 'soon' }), []);
    expect(events.map(event => event.at)).toEqual([0]);
  });
});
