import { describe, expect, test } from 'bun:test';
import type { AgendaItem } from '../../../app/wire/index.ts';
import {
  candidateLine,
  flipLabel,
  isPlainThread,
  lineageLines,
  lineageTitles,
  mergeCandidates,
  mergeChoice,
  mergeOffered,
  mergeWords,
  PICKER_LEAD,
} from '../../../app/lib/agenda-merge.ts';
import { agendaItem } from '../../support/app/agenda-inbox.tsx';

const item = (id: string, overrides: Partial<AgendaItem> = {}): AgendaItem => agendaItem(id, overrides);

describe('which items merge', () => {
  test('a plain conversation does, and every card the daemon acts on does not', () => {
    expect(isPlainThread(item('A1'))).toBe(true);
    expect(isPlainThread(item('A1', { notice: true }))).toBe(false);
    expect(isPlainThread(item('A1', { kind: 'input' }))).toBe(false);
    expect(isPlainThread({ ...item('A1'), gate: { card: 'F1', lane: 'review', options: [] } } as never)).toBe(false);
    expect(
      isPlainThread(item('A1', { cardAsks: [{ gate: { card: 'F1', lane: 'review', options: [] } }] as never })),
    ).toBe(false);
    expect(isPlainThread(item('A1', { confirms: 'x' as never }))).toBe(false);
    expect(isPlainThread(item('A1', { input: {} as never }))).toBe(false);
    expect(isPlainThread(item('A1', { taskPlan: {} as never }))).toBe(false);
    expect(isPlainThread(item('A1', { copyPlan: {} as never }))).toBe(false);
    expect(isPlainThread(item('A1', { signInRuleSuggestion: {} as never }))).toBe(false);
    expect(isPlainThread(item('A1', { twoFactorSeed: {} as never }))).toBe(false);
    expect(isPlainThread(item('A1', { phoneApproval: {} as never }))).toBe(false);
  });

  test('is offered only where the host can send it, and the item is open and plain', () => {
    const open = item('A5');
    expect(mergeOffered({ hostMerges: true, item: open })).toBe(true);
    expect(mergeOffered({ hostMerges: false, item: open })).toBe(false);
    expect(
      mergeOffered({
        hostMerges: true,
        item: { ...open, resolvedAt: '2026-11-01T00:00:00.000Z' } as unknown as AgendaItem,
      }),
    ).toBe(false);
    expect(mergeOffered({ hostMerges: true, item: item('A5', { notice: true }) })).toBe(false);
  });
});

describe('what a merge can join', () => {
  test('lists the other open plain conversations, oldest first', () => {
    const board = [
      item('A10'),
      item('A2'),
      item('A5'),
      item('A3', { notice: true }),
      { ...item('A4'), resolvedAt: '2026-11-01T00:00:00.000Z' } as unknown as AgendaItem,
    ];
    expect(mergeCandidates(item('A5'), board).map(other => other.id)).toEqual(['A2', 'A10']);
  });

  test('keeps the viewed item unless the other is picked', () => {
    const viewed = item('A5', { subject: 'Does push repeat?' });
    const other = item('A2', { subject: 'Where do snoozed items go?' });
    expect(mergeChoice(viewed, other, false)).toEqual({ survivor: viewed, absorbed: other });
    expect(mergeChoice(viewed, other, true)).toEqual({ survivor: other, absorbed: viewed });
  });

  test('says what happens by reference alone, with the open agenda as "this item" and no title', () => {
    const viewed = item('A5', { subject: 'Does push repeat?' });
    const other = item('A2', { subject: 'Where do snoozed items go?' });
    expect(mergeWords(mergeChoice(viewed, other, false), 'A5')).toEqual({
      question: 'Merge !A2 into this item?',
      outcome: '!A2 closes; this item keeps its ask. Both conversations and all cards are kept.',
      button: 'Merge',
    });
    expect(mergeWords(mergeChoice(viewed, other, true), 'A5')).toEqual({
      question: 'Merge this item into !A2?',
      outcome: 'This item closes; !A2 keeps its ask. Both conversations and all cards are kept.',
      button: 'Merge',
    });
  });

  test('asks the picker question without naming the open agenda, and the flip label without a title', () => {
    expect(PICKER_LEAD).toBe('Merge this item with which open agenda?');
    expect(flipLabel(item('A2', { subject: 'Where do snoozed items go?' }))).toBe('Keep !A2 instead');
  });

  test('names a candidate by its reference and its title', () => {
    expect(candidateLine(item('A7', { subject: 'Pick the queue' }))).toBe('!A7 Pick the queue');
  });
});

describe('where an item came from', () => {
  test('says where a merged item went and what the survivor took in', () => {
    expect(lineageLines({ mergedInto: 'A2' })).toEqual([{ key: 'merged-into', text: 'Merged into !A2' }]);
    expect(lineageLines({ mergedFrom: ['A5', 'A6'] })).toEqual([
      { key: 'merged-from', text: 'Merged in from !A5, !A6' },
    ]);
  });

  test('says where a split came from and where it went', () => {
    expect(lineageLines({ splitFrom: 'A3' })).toEqual([{ key: 'split-from', text: 'Split from !A3' }]);
    expect(lineageLines({ splitInto: ['A7', 'A8'] })).toEqual([{ key: 'split-into', text: 'Split into !A7, !A8' }]);
  });

  test('says nothing for an item with no lineage', () => {
    expect(lineageLines({})).toEqual([]);
  });

  test('names each target by its title where the board holds it, and by its id alone where it does not', () => {
    const titles = { A7: 'the snooze copy', A2: 'Where do snoozed items go?' };
    expect(lineageLines({ splitInto: ['A7', 'A8'] }, titles)).toEqual([
      { key: 'split-into', text: 'Split into !A7 (the snooze copy), !A8' },
    ]);
    expect(lineageLines({ mergedInto: 'A2' }, titles)).toEqual([
      { key: 'merged-into', text: 'Merged into !A2 (Where do snoozed items go?)' },
    ]);
  });

  test('cuts a long title at a word with an ellipsis, or at the limit when it has no word to cut at', () => {
    const spoken = 'Should a reply to a snoozed agenda wake it up again straight away or wait for the owner';
    expect(lineageLines({ mergedInto: 'A2' }, { A2: spoken })).toEqual([
      { key: 'merged-into', text: 'Merged into !A2 (Should a reply to a snoozed agenda wake it up again…)' },
    ]);
    expect(lineageLines({ mergedInto: 'A2' }, { A2: 'x'.repeat(80) })).toEqual([
      { key: 'merged-into', text: `Merged into !A2 (${'x'.repeat(60)}…)` },
    ]);
  });

  test('collects the titles of the agendas an item names from the board, leaving out what the board lacks', () => {
    const board = [item('A7', { subject: 'Badge count' }), item('A9', { subject: 'Unrelated' })];
    expect(lineageTitles({ splitInto: ['A7', 'A8'], splitFrom: 'A3' }, board)).toEqual({ A7: 'Badge count' });
    expect(lineageTitles({}, board)).toEqual({});
  });
});
