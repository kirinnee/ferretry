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

describe('the History under an open agenda card', () => {
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
    expect(rows.map(row => row.getAttribute('data-history'))).toEqual(['ferret', 'owner', 'revision', 'ferret']);
    expect(rows[0]?.querySelector('.fy-hist__who')?.textContent).toBe(
      `Lizzette${revisionStamp(new Date(AT).toISOString(), NOW)}`,
    );
    expect(rows[0]?.className).toBe('fy-hist__ag');
    expect(rows[3]?.className).toBe('fy-hist__ag');
    // Only the owner's row is a bubble.
    expect(root.querySelectorAll('.fy-hist__me')).toHaveLength(1);
    expect(rows[1]?.className).toBe('fy-hist__me');
    expect(rows[2]?.textContent).toBe('Card updated to v2');
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
});
