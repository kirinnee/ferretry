import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaMessagePart } from '@ferretry/protocol';
import { AgendaItemHistory } from '../../../src/features/agenda/agenda-item-history.tsx';
import type { HistoryEvent } from '../../../src/lib/agenda-history.ts';
import type { TranscriptEntry } from '../../../src/lib/session-screens.ts';
import { type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const part = (kind: AgendaMessagePart['kind'], text: string, note?: string): AgendaMessagePart =>
  ({
    kind,
    text,
    raw: `${kind}:${text}`,
    items: [],
    ...(note === undefined ? {} : { note }),
  }) as unknown as AgendaMessagePart;

const ferretSaid = (key: string, at: number, text: string): HistoryEvent => ({
  kind: 'ferret',
  key,
  at,
  text,
  entry: { id: key, kind: 'assistant', text, ...(at === 0 ? {} : { at }) } as TranscriptEntry,
});
const ownerSaid = (key: string, at: number, text: string): HistoryEvent => ({
  kind: 'owner-text',
  key,
  at,
  text,
  entry: { id: key, kind: 'user', text, ...(at === 0 ? {} : { at }) } as TranscriptEntry,
});

const draw = async (events: readonly HistoryEvent[]): Promise<HTMLElement> => {
  view = await mount(<AgendaItemHistory events={events} ferret="Zoe" now={NOW} />);
  return must(view.container, 'the view');
};

const rows = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('li[data-history]')].map(row => row.getAttribute('data-history') ?? '');

describe('the history of an item', () => {
  test('draws nothing when there is none', async () => {
    const root = await draw([]);
    expect(root.querySelector('[data-agenda-history]')).toBeNull();
  });

  test('says who edited what as a small divider, with the time, and who raised the item', async () => {
    const at = NOW - 3_600_000;
    const root = await draw([
      { kind: 'raised', key: 'raised', at: NOW - 7_200_000, by: 'agent' },
      { kind: 'raised', key: 'raised-you', at: 0, by: 'human' },
      {
        kind: 'revision',
        key: 'r1',
        at,
        entry: {
          at: new Date(at).toISOString(),
          by: 'agent',
          changed: [
            { field: 'subject', label: 'Question', before: '- the old ask' },
            { field: 'context', label: 'Why now', before: null },
          ],
        },
      } as HistoryEvent,
      {
        kind: 'revision',
        key: 'r2',
        at,
        entry: {
          at: new Date(at).toISOString(),
          by: 'human',
          changed: [{ field: 'subject', label: 'Question', before: null }],
        },
      } as HistoryEvent,
    ]);
    const [raised, raisedYou, edited, ownerEdited] = [...root.querySelectorAll('li.fy-item-history__divider')];
    expect(raised?.getAttribute('data-history')).toBe('raised');
    expect(raised?.textContent).toContain('Raised by Zoe');
    expect(raised?.querySelector('time')).not.toBeNull();
    expect(raisedYou?.textContent).toBe('Raised by you');
    expect(edited?.getAttribute('data-history')).toBe('revision');
    expect(edited?.textContent).toContain('Zoe edited question, why now');
    expect(edited?.querySelector('time')).not.toBeNull();
    expect(ownerEdited?.textContent).toContain('You edited question');
    expect(root.textContent).not.toContain('the old ask');
  });

  test('draws what the ferret said and what the owner typed as the chat’s own message rows', async () => {
    const root = await draw([
      ferretSaid('f1', NOW - 120_000, 'Done — **shipped**.'),
      ownerSaid('o1', NOW - 60_000, '!A47 thanks'),
    ]);
    expect(rows(root)).toEqual(['ferret', 'owner']);
    const ferretRow = root.querySelector('[data-history="ferret"] article.fy-message-assistant');
    expect(ferretRow?.textContent).toContain('shipped');
    expect(root.querySelector('[data-history="owner"] article.fy-message-user')?.textContent).toContain('thanks');
  });

  test('draws the owner’s answers with a check and the others plainly, each with its note', async () => {
    const root = await draw([
      { kind: 'owner', key: 'p1', at: NOW - 50_000, part: part('answer', 'SQLite', 'on staging first') },
      { kind: 'owner', key: 'p2', at: NOW - 40_000, part: part('done', 'Shipped') },
      { kind: 'owner', key: 'p3', at: NOW - 30_000, part: part('re', 'one more thing') },
      { kind: 'owner', key: 'p4', at: NOW - 20_000, part: part('dismissed', '') },
    ]);
    const kinds = [...root.querySelectorAll('li[data-history-kind]')].map(row => row.getAttribute('data-history-kind'));
    expect(kinds).toEqual(['answer', 'done', 're', 'dismissed']);
    const [answer, done, reply, dismissed] = [...root.querySelectorAll('li[data-history-kind]')];
    expect(answer?.querySelector('.fy-item-history__choice')?.textContent).toBe('SQLite');
    expect(answer?.textContent).toContain('You · Answered');
    expect(answer?.textContent).toContain('Note: on staging first');
    expect(done?.querySelector('.fy-item-history__choice')?.textContent).toBe('Shipped');
    expect(reply?.querySelector('.fy-item-history__choice')).toBeNull();
    expect(reply?.textContent).toContain('one more thing');
    expect(dismissed?.querySelector('.fy-item-history__bubble')).toBeNull();
  });

  test('is never folded: every event is drawn, in order, with no toggle, count or disclosure', async () => {
    const root = await draw([
      ferretSaid('f1', NOW - 120_000, 'Looking.'),
      ownerSaid('o1', NOW - 90_000, '!A47 first'),
      ferretSaid('f2', NOW - 60_000, 'Done.'),
      { kind: 'owner', key: 'p1', at: NOW - 30_000, part: part('answer', 'SQLite') },
    ]);
    expect(rows(root)).toEqual(['ferret', 'owner', 'ferret', 'owner']);
    expect(root.querySelector('[data-agenda-history]')?.textContent).toContain('History');
    expect(
      root.querySelector('button:not(.fy-receipt), details, summary, [aria-expanded]:not(.fy-receipt)'),
    ).toBeNull();
    expect(root.querySelector('[data-agenda-history-latest]')).toBeNull();
  });

  test('draws a run with no owner message too', async () => {
    const root = await draw([ferretSaid('f1', NOW - 120_000, 'Looking.')]);
    expect(rows(root)).toEqual(['ferret']);
  });

  test('leaves the time off an event with no known time', async () => {
    const root = await draw([ownerSaid('o1', 0, '!A47 hi')]);
    expect(root.querySelector('time')).toBeNull();
  });
});
