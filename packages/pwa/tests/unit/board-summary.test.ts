import { describe, expect, it } from 'bun:test';
import { mergeBoard, NO_BOARD_FILTERS } from '../../src/lib/board-model.ts';
import {
  agoLabel,
  DEFAULT_SUMMARY_WINDOW,
  isActionCategory,
  parseSummaryWindow,
  sectionOf,
  SUMMARY_SECTIONS,
  summarySections,
} from '../../src/lib/board-summary.ts';
import { listRows } from '../../src/lib/board-view.ts';
import { COUNTS, card, laneSetFor, laptop, originCard, PROJECT } from './board-support.ts';

const NOW = Date.parse('2026-08-01T10:00:00.000Z');
const HOUR = '2026-08-01T09:00:00.000Z';
const TWO_DAYS = '2026-07-30T10:00:00.000Z';
const OLD = '2026-07-01T10:00:00.000Z';
const release = (at: string) => ({ version: '4.110.0', tag: 'v4.110.0', at });

const rowsOf = (cards: ReturnType<typeof card>[]) =>
  listRows(
    mergeBoard(
      [
        {
          daemonId: laptop.daemonId,
          machine: 'laptop',
          version: '4.110.0',
          cards,
          laneSets: new Map([[PROJECT, laneSetFor()]]),
          counts: COUNTS,
          quarantined: [],
        },
      ],
      { ...NO_BOARD_FILTERS, agents: true },
    ),
  );

const idsOf = (cards: ReturnType<typeof card>[], window: 'today' | '7d' = '7d') =>
  summarySections({ rows: rowsOf(cards), window, now: NOW }).map(section => [
    section.id,
    section.rows.map(row => row.card.task.id),
  ]);

describe('the summary window', () => {
  it('defaults to 7 days and ignores nonsense', () => {
    expect(DEFAULT_SUMMARY_WINDOW).toBe('7d');
    expect(parseSummaryWindow('today')).toBe('today');
    expect(parseSummaryWindow('30d')).toBe('7d');
    expect(parseSummaryWindow(null)).toBe('7d');
  });
});

describe('which section a card belongs to', () => {
  it('puts verify lanes first as the action section, and leaves backlog and closed out', () => {
    expect(isActionCategory('verify')).toBe(true);
    expect(isActionCategory('shipped')).toBe(false);
    expect(SUMMARY_SECTIONS['to-test'].action).toBe(true);
    const some = rowsOf([card('F1')])[0]?.card;
    if (some === undefined) throw new Error('no card');
    expect(sectionOf(some, 'verify')).toBe('to-test');
    expect(sectionOf(some, 'active')).toBe('working');
    expect(sectionOf(some, 'review')).toBe('working');
    expect(sectionOf(some, 'backlog')).toBeNull();
    expect(sectionOf(some, 'closed')).toBeNull();
    expect(sectionOf(some, null)).toBeNull();
    expect(sectionOf(some, 'shipped')).toBe('merged');
  });
});

describe('the four sections', () => {
  const cards = [
    card('F1', { laneId: 'tested', shippedIn: release(HOUR) }),
    card('F2', { laneId: 'implement' }),
    card('F3', { laneId: 'review' }),
    card('F4', { laneId: 'merged', lastTouchedAt: HOUR }),
    card('F5', { laneId: 'released', shippedIn: release(TWO_DAYS) }),
    card('F6', { laneId: 'todo' }),
    card('F7', { laneId: 'closed' }),
  ];

  it('orders them to-test, working, merged, released and drops backlog and closed', () => {
    expect(idsOf(cards)).toEqual([
      ['to-test', ['F1']],
      ['working', ['F2', 'F3']],
      ['merged', ['F4']],
      ['released', ['F5']],
    ]);
  });

  it('narrows only merged and released by the window', () => {
    const stale = [
      ...cards,
      card('F8', { laneId: 'merged', lastTouchedAt: OLD }),
      card('F9', { laneId: 'tested', shippedIn: release(OLD) }),
      card('F10', { laneId: 'implement', lastTouchedAt: OLD }),
    ];
    expect(idsOf(stale, 'today')).toEqual([
      ['to-test', ['F1', 'F9']],
      ['working', ['F2', 'F3', 'F10']],
      ['merged', ['F4']],
    ]);
    expect(idsOf(stale).flatMap(([, ids]) => ids)).not.toContain('F8');
  });

  it('uses the latest merged PR as the merge time', () => {
    const pr = (n: number, mergedAt: string | null) => ({
      number: n,
      url: `https://github.com/ferretry/ferretry/pull/${n}`,
      repo: 'ferretry/ferretry',
      state: mergedAt === null ? 'open' : 'merged',
      draft: false,
      checks: 'passing',
      mergedAt,
      mergeSha: mergedAt === null ? null : 'a'.repeat(40),
      releasedIn: null,
      polledAt: HOUR,
    });
    const merged = card('F4', {
      laneId: 'merged',
      lastTouchedAt: OLD,
      links: { prs: [pr(1, HOUR), pr(2, null)], branch: null, commits: [], docs: [] },
    });
    const sections = summarySections({ rows: rowsOf([merged]), window: 'today', now: NOW });
    expect(sections[0]?.rows[0]?.when).toBe('merged 1h ago');
  });

  it('says when each row last mattered', () => {
    const whens = summarySections({ rows: rowsOf(cards), window: '7d', now: NOW }).flatMap(section =>
      section.rows.map(row => [row.card.task.id, row.when]),
    );
    expect(whens).toEqual([
      ['F1', 'released in 4.110.0 · 1h ago'],
      ['F2', 'working now'],
      ['F3', 'working now'],
      ['F4', 'merged 1h ago'],
      ['F5', 'released in 4.110.0 · 2d ago'],
    ]);
  });

  it('describes a quiet working card by its activity and when it was touched', () => {
    const quiet = card('F2', { laneId: 'implement', activity: 'stale', lastTouchedAt: TWO_DAYS });
    const rows = summarySections({ rows: rowsOf([quiet]), window: '7d', now: NOW })[0]?.rows;
    expect(rows?.[0]?.when).toBe('stale · touched 2d ago');
    const unknown = summarySections({
      rows: rowsOf([card('F3', { laneId: 'implement', activity: 'idle', lastTouchedAt: HOUR })]),
      window: '7d',
      now: NOW,
    })[0]?.rows[0];
    expect(unknown?.when).toBe('idle · touched 1h ago');
  });

  it('says "ready to test" for a to-test card nothing has released, and "merged" with no time', () => {
    const waiting = summarySections({ rows: rowsOf([card('F1', { laneId: 'tested' })]), window: '7d', now: NOW });
    expect(waiting[0]?.rows[0]?.when).toBe('ready to test');
    expect(agoLabel(null, NOW)).toBeNull();
    expect(agoLabel(new Date(NOW).toISOString(), NOW)).toBe('just now');
  });

  it('lists a closed card that shipped in the window, once, and never a dropped or unreleased one', () => {
    const closed = rowsOf([
      card('F20', { laneId: 'closed', shippedIn: release(HOUR) }),
      card('F21', { laneId: 'closed', shippedIn: release(OLD) }),
      card('F22', { laneId: 'closed' }),
      card('F23', {
        laneId: 'closed',
        shippedIn: release(HOUR),
        dropped: { at: HOUR, reason: 'no' },
      }),
    ]);
    const sections = summarySections({ rows: rowsOf(cards), closedRows: closed, window: '7d', now: NOW });
    expect(sections.find(section => section.id === 'released')?.rows.map(row => row.card.task.id)).toEqual([
      'F20',
      'F5',
    ]);
  });
});

describe('agent cards in the summary', () => {
  it('sits an agent card right under the human card it serves', () => {
    const cards = [
      originCard('F2', 'human', null, { laneId: 'implement', lastTouchedAt: '2026-08-01T09:30:00.000Z' }),
      originCard('F3', 'human', null, { laneId: 'implement', lastTouchedAt: '2026-08-01T09:20:00.000Z' }),
      originCard('F4', 'agent', { id: 'F2' }, { laneId: 'implement', lastTouchedAt: '2026-08-01T09:00:00.000Z' }),
    ];
    const section = summarySections({ rows: rowsOf(cards), window: '7d', now: NOW })[0];
    expect(section?.rows.map(row => [row.card.task.id, row.under === null])).toEqual([
      ['F2', true],
      ['F4', false],
      ['F3', true],
    ]);
  });
});
