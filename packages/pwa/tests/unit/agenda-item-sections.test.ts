import { describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import { readFold, writeFold } from '../../src/lib/agenda-fold.ts';
import {
  activityLog,
  FOLDED_PARTS,
  ITEM_VIEW_PARTS,
  itemCardAsks,
  itemStage,
  plainTargetMeaning,
  referenceRows,
  stateChip,
} from '../../src/lib/agenda-item-sections.ts';
import { agendaItem } from '../support/agenda-inbox.tsx';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const item = (overrides: Partial<AgendaItem> = {}): AgendaItem => agendaItem('A5', overrides);

describe('the nine parts', () => {
  test('are in the spec’s order, with the detailed context and the activity log folded', () => {
    expect(ITEM_VIEW_PARTS).toEqual([
      'head',
      'premise',
      'detail',
      'references',
      'where',
      'conversation',
      'needs',
      'body',
      'activity',
    ]);
    expect([...FOLDED_PARTS].sort()).toEqual(['activity', 'detail']);
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
  test('are one list: every term, then every link, each with a plain meaning', () => {
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
    expect(rows.map(row => row.meaning)).toEqual([
      'write-ahead log',
      'A pull request.',
      'A card on the board.',
      'Another agenda item.',
      'A file.',
    ]);
    expect(referenceRows({})).toEqual([]);
  });

  test('name what each kind of target is', () => {
    expect(plainTargetMeaning('https://example.test')).toBe('A web page.');
    expect(plainTargetMeaning('#12')).toBe('A pull request.');
    expect(plainTargetMeaning('%terminal:dev')).toBe('A terminal.');
    expect(plainTargetMeaning('%browser:app')).toBe('A browser page.');
    expect(plainTargetMeaning('/babysit-pr')).toBe('A skill.');
    expect(plainTargetMeaning('/home/x/file.ts')).toBe('A file.');
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

  test('are a list: today the one gate the thread carries, keyed by its reference', () => {
    const asks = itemCardAsks(item({ gateAttached: gate } as Partial<AgendaItem>));
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
      'Card updated to v2',
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
});

describe('the folds, remembered per item on this device', () => {
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
