import { describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import {
  candidateLine,
  isPlainThread,
  lineageLines,
  mergeCandidates,
  mergeChoice,
  mergeOffered,
  mergeWords,
} from '../../src/lib/agenda-merge.ts';
import { agendaItem } from '../support/agenda-inbox.tsx';

const item = (id: string, overrides: Partial<AgendaItem> = {}): AgendaItem => agendaItem(id, overrides);

describe('which items merge', () => {
  test('a plain conversation does, and every card the daemon acts on does not', () => {
    expect(isPlainThread(item('A1'))).toBe(true);
    expect(isPlainThread(item('A1', { notice: true }))).toBe(false);
    expect(isPlainThread(item('A1', { kind: 'input' }))).toBe(false);
    expect(isPlainThread(item('A1', { gate: { card: 'F1', lane: 'review', options: [] } as never }))).toBe(false);
    expect(isPlainThread(item('A1', { gateAttached: { card: 'F1', lane: 'review', options: [] } as never }))).toBe(
      false,
    );
    expect(isPlainThread(item('A1', { confirms: 'x' as never }))).toBe(false);
    expect(isPlainThread(item('A1', { input: {} as never }))).toBe(false);
    expect(isPlainThread(item('A1', { taskPlan: {} as never }))).toBe(false);
    expect(isPlainThread(item('A1', { copyPlan: {} as never }))).toBe(false);
    expect(isPlainThread(item('A1', { signInRuleSuggestion: {} as never }))).toBe(false);
    expect(isPlainThread(item('A1', { twoFactorSeed: {} as never }))).toBe(false);
    expect(isPlainThread(item('A1', { phoneApproval: {} as never }))).toBe(false);
  });

  test('is offered only where the machine merges, the host can send it, and the item is open and plain', () => {
    const open = item('A5');
    expect(mergeOffered({ machineMerges: true, hostMerges: true, item: open })).toBe(true);
    expect(mergeOffered({ machineMerges: undefined, hostMerges: true, item: open })).toBe(false);
    expect(mergeOffered({ machineMerges: false, hostMerges: true, item: open })).toBe(false);
    expect(mergeOffered({ machineMerges: true, hostMerges: false, item: open })).toBe(false);
    expect(
      mergeOffered({
        machineMerges: true,
        hostMerges: true,
        item: { ...open, resolvedAt: '2026-11-01T00:00:00.000Z' } as unknown as AgendaItem,
      }),
    ).toBe(false);
    expect(mergeOffered({ machineMerges: true, hostMerges: true, item: item('A5', { notice: true }) })).toBe(false);
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

  test('keeps the viewed item unless the other is picked, and says what happens in words', () => {
    expect(mergeChoice('A5', 'A2', false)).toEqual({ survivor: 'A5', absorbed: 'A2' });
    expect(mergeChoice('A5', 'A2', true)).toEqual({ survivor: 'A2', absorbed: 'A5' });
    const words = mergeWords({ survivor: 'A2', absorbed: 'A5' });
    expect(words.question).toBe('Merge !A5 into !A2?');
    expect(words.outcome).toContain('!A5 closes as merged into !A2');
    expect(words.kept).toContain('Both conversations and all cards are kept');
    expect(words.button).toBe('Merge into !A2');
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
});
