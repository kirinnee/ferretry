import { afterEach, describe, expect, test } from 'bun:test';
import type { ResolvedAgendaItem } from '@ferretry/protocol';
import {
  AGENDA_RESOLVED_ACTION_ID,
  AgendaResolvedList,
  byNewestResolution,
  resolvedActionContribution,
  resolvedWhen,
  resolvedWords,
} from '../../../src/features/agenda/agenda-resolved.tsx';
import '../../support/dom.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

const record = (
  id: string,
  resolvedAt: string,
  overrides: Partial<Record<keyof ResolvedAgendaItem, unknown>> = {},
): ResolvedAgendaItem =>
  ({
    id,
    source: 'agent-raised',
    sourceRef: null,
    subject: `Ask ${id}`,
    why: 'Why.',
    waitingSince: '2026-07-31T09:00:00.000Z',
    howToResolve: 'Answer it.',
    ask: { kind: 'permission' },
    raisedBy: 'agent',
    raisedBySession: 'shared',
    raisedByName: 'zoe',
    resolvedAt,
    resolvedBy: 'human',
    resolvedBySession: null,
    resolvedByName: null,
    resolutionNote: null,
    disposition: 'resolved',
    response: { kind: 'permission', decision: 'approve' },
    ...overrides,
  }) as ResolvedAgendaItem;

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('the resolved records', () => {
  test('say the count in plain words and sort the newest resolution first', () => {
    expect(resolvedWords(7)).toBe('7 resolved');
    const older = record('A1', '2026-07-31T10:00:00.000Z');
    const newer = record('A2', '2026-07-31T11:00:00.000Z');
    expect([older, newer].sort(byNewestResolution).map(r => r.id)).toEqual(['A2', 'A1']);
  });

  test('the time reads short, without a year or seconds', () => {
    const stamp = resolvedWhen('2026-10-23T08:54:30.000Z', 'UTC');
    expect(stamp).toContain('Oct');
    expect(stamp).toContain('23');
    expect(stamp).not.toContain('2026');
    expect(stamp).not.toMatch(/:\d\d:\d\d/);
  });

  test('an open-question answer reads as its own words, never "undefined"', async () => {
    view = await mount(
      <AgendaResolvedList
        panelId="attn"
        records={[
          record('A1', '2026-07-31T10:00:00.000Z', { response: { kind: 'open-question', answer: 'The team login.' } }),
        ]}
      />,
    );
    const text = must(view.container, 'view').textContent ?? '';
    expect(text).toContain('Answered: The team login.');
    expect(text).not.toContain('undefined');
  });

  test('the list shows each record newest first with how it was cleared, and rings the linked one', async () => {
    view = await mount(
      <AgendaResolvedList
        highlighted="A1"
        panelId="attn"
        records={[
          record('A1', '2026-07-31T10:00:00.000Z'),
          record('A2', '2026-07-31T11:00:00.000Z', {
            disposition: 'dismissed',
            response: null,
            resolutionNote: 'Superseded by A3.',
          }),
        ]}
      />,
    );
    const c = must(view.container, 'view');
    const rows = [...c.querySelectorAll('[data-agenda-record]')];
    expect(rows.map(row => row.getAttribute('data-agenda-record'))).toEqual(['A2', 'A1']);
    expect(rows[0]?.textContent).toContain('dismissed by you');
    expect(rows[0]?.textContent).toContain('Superseded by A3.');
    expect(rows[1]?.getAttribute('data-highlighted')).toBe('true');
    expect(rows[0]?.hasAttribute('data-highlighted')).toBe(false);
    expect(document.activeElement?.id).toBe('attn-item-A1');
  });

  test('an empty list says so', async () => {
    view = await mount(<AgendaResolvedList panelId="attn" records={[]} />);
    expect(must(view.container, 'view').querySelector('[data-agenda-resolved-empty]')).not.toBeNull();
  });

  test('the menu entry is "N resolved" and is absent when there is no history', () => {
    const entry = resolvedActionContribution([record('A1', '2026-07-31T10:00:00.000Z')], 'attn', null).build(undefined);
    expect(entry).toMatchObject({ kind: 'form', id: AGENDA_RESOLVED_ACTION_ID, label: '1 resolved' });
    expect(resolvedActionContribution([], 'attn', null).build(undefined)).toBeNull();
  });

  test('the menu entry renders the list for its conversation, ringing the linked item', async () => {
    const entry = resolvedActionContribution([record('A1', '2026-07-31T10:00:00.000Z')], 'attn', 'A1').build(undefined);
    if (entry?.kind !== 'form') throw new Error('expected the resolved entry to be a form');
    view = await mount(<>{entry.render({ close: () => {} } as Parameters<typeof entry.render>[0])}</>);
    const row = must(must(view.container, 'view').querySelector('[data-agenda-record="A1"]'), 'the A1 row');
    expect(row.getAttribute('data-highlighted')).toBe('true');
  });
});

describe('the resolved menu entry as a drawer', () => {
  test('opens as a drawer headed "Resolved · N", not as a popover form', () => {
    const records = [record('A1', '2026-07-31T10:00:00.000Z'), record('A2', '2026-07-31T11:00:00.000Z')];
    const entry = resolvedActionContribution(records, 'attn', null).build(undefined);
    expect(entry).toMatchObject({ presentation: 'drawer', heading: 'Resolved · 2', title: 'Resolved in Inbox' });
  });
});

describe('a long answer in the resolved list', () => {
  const longAnswer = record('A1', '2026-07-31T10:00:00.000Z', {
    response: { kind: 'open-question', answer: 'a long answer '.repeat(60) },
  });
  /** happy-dom lays nothing out: say how tall the text is against a two-line box. */
  const overflowing = (on: boolean) => {
    const proto = HTMLElement.prototype;
    const saved = ['scrollHeight', 'clientHeight'].map(
      key => [key, Object.getOwnPropertyDescriptor(proto, key)] as const,
    );
    Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => (on ? 120 : 20) });
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 40 });
    return () => {
      for (const [key, descriptor] of saved) {
        if (descriptor === undefined) Reflect.deleteProperty(proto, key);
        else Object.defineProperty(proto, key, descriptor);
      }
    };
  };

  test('is held to two lines with a "Show more" that opens it and "Show less" that folds it back', async () => {
    const restore = overflowing(true);
    try {
      view = await mount(<AgendaResolvedList panelId="attn" records={[longAnswer]} />);
      const c = must(view.container, 'view');
      const answer = must(c.querySelector('.fy-attn-panel__record-answer'), 'answer');
      const more = must(c.querySelector<HTMLElement>('[data-agenda-record-more]'), 'show more');
      expect(answer.hasAttribute('data-clamped')).toBe(true);
      expect(more.textContent).toBe('Show more');
      expect(more.getAttribute('aria-expanded')).toBe('false');
      expect(more.getAttribute('aria-controls')).toBe(answer.id);
      await interact(() => more.click());
      expect(answer.hasAttribute('data-clamped')).toBe(false);
      expect(more.textContent).toBe('Show less');
      expect(more.getAttribute('aria-expanded')).toBe('true');
      await interact(() => more.click());
      expect(answer.hasAttribute('data-clamped')).toBe(true);
    } finally {
      restore();
    }
  });

  test('offers no "Show more" when it already fits in two lines', async () => {
    const restore = overflowing(false);
    try {
      view = await mount(<AgendaResolvedList panelId="attn" records={[longAnswer]} />);
      expect(must(view.container, 'view').querySelector('[data-agenda-record-more]')).toBeNull();
    } finally {
      restore();
    }
  });

  test('keeps the title, the outcome chip and the date on every row', async () => {
    view = await mount(<AgendaResolvedList panelId="attn" records={[longAnswer]} />);
    const row = must(must(view.container, 'view').querySelector('[data-agenda-record]'), 'row');
    expect(row.querySelector('.fy-attn-panel__record-subject')?.textContent).toBe('Ask A1');
    expect(row.querySelector('.fy-attn-panel__record-meta')?.textContent).toContain('done by you');
    expect(row.querySelector('.fy-attn-panel__record-meta')?.textContent).toMatch(/Jul|Aug/);
  });
});
