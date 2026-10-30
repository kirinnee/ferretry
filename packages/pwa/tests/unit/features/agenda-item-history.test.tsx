import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaMessagePart } from '@ferretry/protocol';
import { AgendaItemHistory } from '../../../src/features/agenda/agenda-item-history.tsx';
import type { HistoryEvent } from '../../../src/lib/agenda-history.ts';
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

const draw = async (events: readonly HistoryEvent[]): Promise<HTMLElement> => {
  view = await mount(<AgendaItemHistory events={events} ferret="Zoe" now={NOW} prose={text => <em>{text}</em>} />);
  return must(view.container, 'the view');
};

const rows = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('li[data-history]')].map(row => row.getAttribute('data-history') ?? '');

describe('the history of an item', () => {
  test('draws nothing when there is none', async () => {
    const root = await draw([]);
    expect(root.querySelector('[data-agenda-history]')).toBeNull();
  });

  test('says what a revision changed and what it was, or that it was empty', async () => {
    const at = NOW - 3_600_000;
    const root = await draw([
      {
        kind: 'revision',
        key: 'r1',
        at,
        entry: {
          at: new Date(at).toISOString(),
          by: 'agent',
          changed: [
            { field: 'subject', label: 'Question', before: '- the old ask' },
            { field: 'context', label: 'Context', before: null },
          ],
        },
      } as HistoryEvent,
    ]);
    const row = must(root.querySelector('[data-history="revision"]'), 'the revision');
    expect(row.textContent).toContain('changed Question, Context');
    expect(row.textContent).toContain('Question was');
    expect(row.textContent).toContain('the old ask');
    expect(row.textContent).toContain('Context was empty');
    expect(row.querySelector('time')).not.toBeNull();
  });

  test('draws what the ferret said through the page’s prose, and what the owner typed as plain text', async () => {
    const root = await draw([
      { kind: 'ferret', key: 'f1', at: NOW - 120_000, text: 'Done — **shipped**.' },
      { kind: 'owner-text', key: 'o1', at: NOW - 60_000, text: '!A47 thanks' },
    ]);
    expect(rows(root)).toEqual(['ferret', 'owner']);
    expect(root.querySelector('[data-history="ferret"] em')?.textContent).toBe('Done — **shipped**.');
    expect(root.querySelector('[data-history="owner"]')?.textContent).toContain('You');
    expect(root.querySelector('[data-history="owner"]')?.textContent).toContain('!A47 thanks');
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
      { kind: 'ferret', key: 'f1', at: NOW - 120_000, text: 'Looking.' },
      { kind: 'owner-text', key: 'o1', at: NOW - 90_000, text: '!A47 first' },
      { kind: 'ferret', key: 'f2', at: NOW - 60_000, text: 'Done.' },
      { kind: 'owner', key: 'p1', at: NOW - 30_000, part: part('answer', 'SQLite') },
    ]);
    expect(rows(root)).toEqual(['ferret', 'owner', 'ferret', 'owner']);
    expect(root.querySelector('[data-agenda-history]')?.textContent).toContain('History');
    expect(root.querySelector('button, details, summary, [aria-expanded]')).toBeNull();
    expect(root.querySelector('[data-agenda-history-latest]')).toBeNull();
  });

  test('draws a run with no owner message too', async () => {
    const root = await draw([{ kind: 'ferret', key: 'f1', at: NOW - 120_000, text: 'Looking.' }]);
    expect(rows(root)).toEqual(['ferret']);
  });

  test('leaves the time off an event with no known time', async () => {
    const root = await draw([{ kind: 'owner-text', key: 'o1', at: 0, text: '!A47 hi' }]);
    expect(root.querySelector('time')).toBeNull();
  });
});
