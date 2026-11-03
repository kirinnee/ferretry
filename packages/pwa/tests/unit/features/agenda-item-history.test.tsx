import { afterEach, describe, expect, test } from 'bun:test';
import { AgendaItemHistory } from '../../../src/features/agenda/agenda-item-history.tsx';
import type { HistoryEvent } from '../../../src/lib/agenda-history.ts';
import { revisionStamp } from '../../../src/lib/agenda-revisions.ts';
import { type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const AT = Date.parse('2026-08-01T10:02:00.000Z');

const draw = async (events: readonly HistoryEvent[]): Promise<HTMLElement> => {
  view = await mount(
    <AgendaItemHistory events={events} ferret="Lizzette" now={NOW} renderProse={text => <p>{text}</p>} />,
  );
  return view.container;
};

describe('the Conversation of an open agenda item', () => {
  test('draws nothing when nothing was said about the item', async () => {
    expect((await draw([])).querySelector('[data-agenda-history]')).toBeNull();
  });

  test('reads like the chat, oldest first: the ferret plain under its name and time, the owner as a bubble', async () => {
    const root = await draw([
      { kind: 'ferret', key: 'r', at: AT, text: 'What should happen at the hard limit?' },
      { kind: 'owner', key: 'o', at: AT + 180_000, text: 'does pause kill a running turn?' },
      { kind: 'revision', key: 'v', at: AT + 200_000, version: 2, summary: [] },
      { kind: 'ferret', key: 'f', at: AT + 240_000, text: 'No. A running turn finishes.' },
    ]);
    const rows = [...root.querySelectorAll('[data-agenda-history] li')];
    // An edit is the activity log's, never a line of the conversation.
    expect(rows.map(row => row.getAttribute('data-history'))).toEqual(['ferret', 'owner', 'ferret']);
    expect(must(root.querySelector('[data-agenda-part="conversation"] h4'), 'heading').textContent).toBe(
      'Conversation',
    );
    expect(rows[0]?.querySelector('.fy-hist__who')?.textContent).toBe(
      `Lizzette${revisionStamp(new Date(AT).toISOString(), NOW)}`,
    );
    expect(rows[0]?.className).toBe('fy-hist__ag');
    expect(rows[2]?.className).toBe('fy-hist__ag');
    // Only the owner's row is a bubble.
    expect(root.querySelectorAll('.fy-hist__me')).toHaveLength(1);
    expect(rows[1]?.className).toBe('fy-hist__me');
  });

  test('draws a reply WHOLE, however long, and every reply in order', async () => {
    const long = `${'A long report line. '.repeat(400)}The end.`;
    const root = await draw([
      { kind: 'owner', key: 'o1', at: AT, text: 'first' },
      { kind: 'ferret', key: 'f1', at: AT + 1, text: long },
      { kind: 'owner', key: 'o2', at: AT + 2, text: 'second' },
      { kind: 'ferret', key: 'f2', at: AT + 3, text: 'third' },
    ]);
    const said = [...root.querySelectorAll('[data-history]')].map(row => row.getAttribute('data-history'));
    expect(said).toEqual(['owner', 'ferret', 'owner', 'ferret']);
    expect(must(root.querySelectorAll('.fy-hist__text')[0], 'the long reply').textContent).toBe(long);
  });

  test('says how many earlier entries are still loading, above the ones it has', async () => {
    const root = await draw([
      { kind: 'gap', key: 'gap', at: 0, earlier: 12, state: 'loading' },
      { kind: 'owner', key: 'o', at: AT, text: 'latest' },
    ]);
    const rows = [...root.querySelectorAll('[data-agenda-history] li')];
    expect(rows.map(row => row.getAttribute('data-history'))).toEqual(['gap', 'owner']);
    expect(rows[0]?.getAttribute('data-history-gap')).toBe('loading');
    expect(rows[0]?.textContent).toBe('Loading 12 earlier entries…');
  });

  test('says in words when earlier entries could not be read, or are more than one read takes, never a partial thread as whole', async () => {
    const failed = await draw([{ kind: 'gap', key: 'gap', at: 0, earlier: 1, state: 'failed' }]);
    expect(failed.querySelector('[data-history-gap="failed"]')?.textContent).toContain(
      '1 earlier entry could not be read',
    );
    await view?.unmount();
    const capped = await draw([{ kind: 'gap', key: 'gap', at: 0, earlier: 30, state: 'capped' }]);
    expect(capped.querySelector('[data-history-gap="capped"]')?.textContent).toContain(
      '30 earlier entries are not shown',
    );
  });

  test('draws nothing when only edits happened: they are the activity log’s', async () => {
    expect((await draw([{ kind: 'revision', key: 'v', at: AT, version: 2, summary: [] }])).innerHTML).toBe('');
  });

  test('ticks an answer, says a note under it, and leaves a reply unticked', async () => {
    const root = await draw([
      { kind: 'owner', key: 'a', at: AT, text: 'Pause', form: 'answer', note: 'until Monday' },
      { kind: 'owner', key: 'b', at: AT, text: 'thanks' },
    ]);
    const [answer, reply] = [...root.querySelectorAll('[data-history="owner"]')];
    expect(answer?.querySelector('.fy-hist__check')).not.toBeNull();
    expect(must(answer?.querySelector('.fy-hist__note'), 'note').textContent).toBe('until Monday');
    expect(reply?.querySelector('.fy-hist__check')).toBeNull();
  });

  test('draws no clock for an event with no time', async () => {
    const root = await draw([{ kind: 'ferret', key: 'f', at: 0, text: 'hi' }]);
    expect(root.querySelector('time')).toBeNull();
  });

  test('tags words the ferret copied from chat, on either side', async () => {
    const root = await draw([
      { kind: 'owner', key: 'o', at: AT, text: 'use Postgres', fromChat: true },
      { kind: 'ferret', key: 'f', at: AT + 1, text: 'noted', fromChat: true },
      { kind: 'owner', key: 'p', at: AT + 2, text: 'typed here' },
    ]);
    const rows = [...root.querySelectorAll('[data-history]')];
    expect(rows.map(row => row.querySelector('[data-history-from-chat]')?.textContent ?? null)).toEqual([
      'from chat',
      'from chat',
      null,
    ]);
  });

  test('draws Ferretry’s own words under its name', async () => {
    const root = await draw([{ kind: 'ferret', key: 'd', at: AT, text: 'Closed as merged into !A2.', daemon: true }]);
    const row = must(root.querySelector('[data-history="daemon"]'), 'daemon row');
    expect(row.querySelector('.fy-hist__who')?.textContent).toContain('Ferretry');
    expect(row.textContent).not.toContain('Lizzette');
  });
});
