import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/core-asks/contract';
import { readFold, writeFold } from '../../../app/lib/agenda-fold.ts';
import {
  activityLog,
  activityStamp,
  ITEM_VIEW_PARTS,
  itemCardAsks,
  itemStage,
  PART_TITLES,
  referenceRows,
  stateChip,
} from '../../../app/lib/agenda-item-sections.ts';
import { agendaItem } from '../../support/app/agenda-inbox.tsx';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const item = (overrides: Partial<AgendaItem> = {}): AgendaItem => agendaItem('A5', overrides);

describe('the eight parts', () => {
  test('are in the spec’s order, with the detailed context, the terms and references, the conversation and the activity log folded', () => {
    expect(ITEM_VIEW_PARTS).toEqual([
      'head',
      'premise',
      'detail',
      'references',
      'needs',
      'tabs',
      'conversation',
      'activity',
    ]);
  });

  test('call the tabs the item’s live document (&F923)', () => {
    expect(PART_TITLES.tabs).toBe('The live document');
    expect(PART_TITLES.needs).toBe('What I need from you');
  });
});

describe('the state chip', () => {
  test('says each state in the owner’s words', () => {
    expect(stateChip(item(), 'Zoe', NOW)).toEqual({ state: 'needs-you', label: 'Needs you' });
    const replied = item({ parked: { reason: 'replied', at: '2026-08-01T11:30:00.000Z' } } as Partial<AgendaItem>);
    expect(stateChip(replied, 'Zoe', NOW).label).toBe('Resting · waiting on Zoe');
    const working = item({
      parked: { reason: 'replied', at: '2026-08-01T11:30:00.000Z' },
      resting: { sub: 'working', at: '2026-08-01T11:30:00.000Z', why: 'Writing the report' },
    } as Partial<AgendaItem>);
    expect(stateChip(working, 'Zoe', NOW).label).toBe('Resting · working');
    const snoozed = item({
      parked: { reason: 'snoozed', at: '2026-08-01T11:00:00.000Z', until: '2026-08-01T15:00:00.000Z' },
    } as Partial<AgendaItem>);
    expect(stateChip(snoozed, 'Zoe', NOW).label).toMatch(/^Snoozed until \d\d:\d\d$/u);
    expect(
      stateChip({ ...item(), resolvedAt: '2026-08-01T11:59:00.000Z' } as unknown as AgendaItem, 'Zoe', NOW),
    ).toEqual({
      state: 'done',
      label: 'Done',
    });
  });
});

describe('the stage', () => {
  test('is the stage the item carries, else its kind’s, and Done once closed', () => {
    expect(itemStage(item({ stage: 'tracker' }))).toBe('tracker');
    expect(itemStage(item({ kind: 'info' }))).toBe('explainer');
    expect(
      itemStage({ ...item({ stage: 'test' }), resolvedAt: '2026-08-01T11:00:00.000Z' } as unknown as AgendaItem),
    ).toBe('done');
  });

  test('reads a standalone card gate from before stages as a plan to approve or a test', () => {
    const gate = {
      cardId: 'F2',
      laneId: 'plan',
      laneName: 'Plan',
      entry: 1,
      projectId: 'p',
      options: [{ id: 'o', label: 'OK', outcome: 'advance' }],
    };
    expect(itemStage(item({ gate, subject: 'OK to build? Pairing QR' } as Partial<AgendaItem>))).toBe('plan');
    expect(itemStage(item({ gate, subject: 'Badge colour is ready to test' } as Partial<AgendaItem>))).toBe('test');
  });
});

describe('terms and references', () => {
  test('are one list: every term with its meaning, then every link meaning its label', () => {
    const rows = referenceRows({
      terms: [{ term: 'WAL', meaning: 'write-ahead log' }],
      links: [
        { label: 'The PR', target: 'https://github.com/kirinnee/ferretry/pull/1428' },
        { target: '&F12' },
        { target: '!A3' },
        { target: 'docs/agenda.md' },
      ],
    });
    expect(rows.map(row => (row.kind === 'term' ? row.term : row.link.target))).toEqual([
      'WAL',
      'https://github.com/kirinnee/ferretry/pull/1428',
      '&F12',
      '!A3',
      'docs/agenda.md',
    ]);
    // A link means what its label says, and nothing is made up for one that has none.
    expect(rows.map(row => row.meaning)).toEqual(['write-ahead log', 'The PR', '', '', '']);
    expect(referenceRows({})).toEqual([]);
  });

  test('a link means its own meaning when it has one, then its label; a blank one reads as nothing', () => {
    const rows = referenceRows({
      links: [
        { target: '!A3', label: 'The parent', meaning: 'Where this came from' },
        { target: '&F12', label: 'The card', meaning: '  ' },
        { target: '@docs/agenda.md', meaning: 'The contract' },
      ],
    });
    expect(rows.map(row => row.meaning)).toEqual(['Where this came from', '', 'The contract']);
  });
});

describe('card asks', () => {
  const gate = {
    cardId: 'F12',
    laneId: 'tested',
    laneName: 'Try it',
    entry: 3,
    projectId: 'p1',
    options: [
      { id: 'o0', label: 'Done', outcome: 'close' },
      { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' },
    ],
  };

  test('carry the card’s How to test from the board, and none when the board has none', () => {
    const attached = item({ cardAsks: [{ gate: gate, at: '2026-08-01T10:00:00.000Z' }] } as Partial<AgendaItem>);
    const asked: string[] = [];
    const steps = itemCardAsks(attached, cardId => {
      asked.push(cardId);
      return '  1. Open the badge.\n2. See it is blue.  ';
    });
    expect(asked).toEqual(['F12']);
    expect(steps[0]?.howToTest).toBe('1. Open the badge.\n2. See it is blue.');
    expect(itemCardAsks(attached, () => null)[0]?.howToTest).toBeNull();
    expect(itemCardAsks(attached, () => '   ')[0]?.howToTest).toBeNull();
    expect(itemCardAsks(attached, () => undefined)[0]?.howToTest).toBeNull();
    expect(itemCardAsks(attached)[0]?.howToTest).toBeNull();
    expect(itemCardAsks(item(), () => 'steps')).toEqual([]);
  });

  test('are a list: today the one gate the thread carries, keyed by its reference', () => {
    const asks = itemCardAsks(
      item({ cardAsks: [{ gate: gate, at: '2026-08-01T10:00:00.000Z' }] } as Partial<AgendaItem>),
    );
    expect(asks).toHaveLength(1);
    expect(asks[0]?.key).toBe('gate:F12:tested:3');
    expect(asks[0]?.view.ask).toEqual({
      kind: 'multiple-choice',
      options: expect.arrayContaining([expect.objectContaining({ label: 'Done' })]),
    });
    expect(itemCardAsks(item())).toEqual([]);
  });
});

describe('the activity log', () => {
  test('keeps every stage the item entered, every edit whole, and its own history lines, oldest first', () => {
    const log = activityLog(
      item({
        stages: [
          { stage: 'explainer', at: '2026-08-01T09:00:00.000Z' },
          { stage: 'question', at: '2026-08-01T10:00:00.000Z' },
          { stage: 'plan', at: '2026-08-01T10:30:00.000Z' },
          { stage: 'tracker', at: '2026-08-01T11:00:00.000Z' },
          { stage: 'test', at: '2026-08-01T11:20:00.000Z' },
        ],
        history: [
          { at: '2026-08-01T09:30:00.000Z', kind: 'needs-info' },
          { at: '2026-08-01T09:45:00.000Z', kind: 'updated' },
          { at: '2026-08-01T10:45:00.000Z', kind: 'replied', note: 'their words are the conversation’s' },
        ],
      } as Partial<AgendaItem>),
      'Zoe',
      [{ key: 'v2', at: Date.parse('2026-08-01T10:15:00.000Z'), version: 2, summary: ['x'.repeat(2_000)] }],
      NOW,
    );
    expect(log.map(line => line.text)).toEqual([
      'Started as Explainer',
      'You asked for more information',
      'Zoe updated it',
      'Moved to Question',
      'Updated to v2',
      'Moved to Plan to approve',
      'You replied',
      'Moved to Tracker',
      'Moved to Test',
    ]);
    expect(log.find(line => line.key === 'v2')?.details).toEqual(['x'.repeat(2_000)]);
    expect(log.map(line => line.text).join(' ')).not.toContain('their words');
  });

  test('says where it rests or sleeps now, and that it was marked done', () => {
    const working = activityLog(
      item({
        parked: { reason: 'replied', at: '2026-08-01T11:30:00.000Z' },
        resting: { sub: 'working', at: '2026-08-01T11:30:00.000Z', why: 'Writing the report' },
      } as Partial<AgendaItem>),
      'Zoe',
      [],
      NOW,
    );
    expect(working.map(line => line.text)).toEqual(['Zoe took it on: Writing the report']);
    const snoozed = activityLog(
      item({
        parked: { reason: 'snoozed', at: '2026-08-01T11:00:00.000Z', until: '2026-08-01T15:00:00.000Z' },
      } as Partial<AgendaItem>),
      'Zoe',
      [],
      NOW,
    );
    expect(snoozed[0]?.text).toMatch(/^Snoozed until /u);
    const done = activityLog(
      item({
        stages: [
          { stage: 'test', at: '2026-08-01T09:00:00.000Z' },
          { stage: 'done', at: '2026-08-01T11:00:00.000Z' },
        ],
      }),
      'Zoe',
      [],
      NOW,
    );
    expect(done.map(line => line.text)).toEqual(['Started as Test', 'Marked done']);
  });

  test('says every kind of history line, and that a replied item waits on its ferret', () => {
    const log = activityLog(
      item({
        parked: { reason: 'replied', at: '2026-08-01T11:50:00.000Z' },
        resting: { sub: 'waiting-on-ferret', at: '2026-08-01T11:50:00.000Z' },
        history: [
          { at: '2026-08-01T09:00:00.000Z', kind: 'discuss' },
          { at: '2026-08-01T09:10:00.000Z', kind: 'surfaced' },
          { at: '2026-08-01T09:20:00.000Z', kind: 'surfaced', note: 'ready for you' },
          { at: '2026-08-01T09:30:00.000Z', kind: 'gate-answered' },
          { at: '2026-08-01T09:40:00.000Z', kind: 'gate-answered', note: 'gate:F12:tested:3' },
        ],
      } as Partial<AgendaItem>),
      'Zoe',
      [],
      NOW,
    );
    expect(log.map(line => line.text)).toEqual([
      'You asked to talk it through',
      'Brought to you',
      'Brought to you: ready for you',
      'You answered a card ask',
      'You answered the card ask gate:F12:tested:3',
      'Waiting on Zoe',
    ]);
  });

  test('is empty for an item nothing happened to', () => {
    expect(activityLog(item(), 'Zoe', [], NOW)).toEqual([]);
  });

  test('stamps a line with its time, and says none for an instant it cannot read', () => {
    expect(activityStamp(0, NOW)).toBe('');
    expect(activityStamp(Date.parse('2026-08-01T11:00:00.000Z'), NOW)).not.toBe('');
  });
});

describe('the folds, remembered per item on this device', () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, 'window');
  afterEach(() => {
    if (real === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', real);
  });
  const withWindow = (value: unknown): void => {
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value });
  };

  const memory = (): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { readonly kept: Map<string, string> } => {
    const kept = new Map<string, string>();
    return {
      kept,
      getItem: key => kept.get(key) ?? null,
      setItem: (key, value) => void kept.set(key, value),
      removeItem: key => void kept.delete(key),
    };
  };

  test('start closed, and keep each item’s and each part’s own state', () => {
    const store = memory();
    expect(readFold('laptop/s1/A5', 'detail', store)).toBe(false);
    writeFold('laptop/s1/A5', 'detail', true, store);
    expect(readFold('laptop/s1/A5', 'detail', store)).toBe(true);
    expect(readFold('laptop/s1/A5', 'activity', store)).toBe(false);
    expect(readFold('laptop/s2/A5', 'detail', store)).toBe(false);
    writeFold('laptop/s1/A5', 'detail', false, store);
    expect(store.kept.size).toBe(0);
  });

  test('use this device’s localStorage when none is handed in, and read as closed where it cannot be read', () => {
    const kept = new Map<string, string>();
    withWindow({
      localStorage: {
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => void kept.set(key, value),
        removeItem: (key: string) => void kept.delete(key),
      },
    });
    writeFold('k', 'activity', true);
    expect(readFold('k', 'activity')).toBe(true);
    writeFold('k', 'activity', false);
    expect(readFold('k', 'activity')).toBe(false);
    // Blocked site data: touching localStorage throws, and nothing is kept.
    withWindow({
      get localStorage(): never {
        throw new Error('blocked');
      },
    });
    expect(readFold('k', 'activity')).toBe(false);
    expect(() => writeFold('k', 'activity', true)).not.toThrow();
    // No window at all (a worker, a test): the same.
    Reflect.deleteProperty(globalThis, 'window');
    expect(readFold('k', 'activity')).toBe(false);
  });

  test('read as closed, and drop the write, when the storage throws or is missing', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readFold('k', 'detail', throwing)).toBe(false);
    expect(() => writeFold('k', 'detail', true, throwing)).not.toThrow();
    expect(readFold('k', 'detail', null)).toBe(false);
    expect(() => writeFold('k', 'detail', true, null)).not.toThrow();
  });
});
