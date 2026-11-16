import { describe, expect, it } from 'bun:test';
import {
  type CommandBarEntry,
  type CommandBarSource,
  commandBarCountLabel,
  commandBarResults,
  MAX_GROUP_RESULTS,
  nextActiveIndex,
} from '../../../src/ui/command-bar-model.ts';

const entry = (id: string, extra: Partial<CommandBarEntry> = {}): CommandBarEntry => ({
  id,
  group: 'Go to',
  label: id,
  resting: true,
  run: () => undefined,
  ...extra,
});
const source =
  (...entries: CommandBarEntry[]): CommandBarSource =>
  () =>
    entries;

describe('commandBarResults: one place, one row', () => {
  it('lists an id two sources offer once, where the first stood, with the later source’s entry', () => {
    const plain = source(entry('a'), entry('screen-board.board', { label: 'Board' }), entry('c'));
    const rich = source(entry('screen-board.board', { label: 'Board', description: 'Every task on every machine' }));
    const found = commandBarResults([plain, rich], '').results;
    expect(found.map(one => one.id)).toEqual(['a', 'screen-board.board', 'c']);
    expect(found[1]?.description).toBe('Every task on every machine');
  });

  it('drops the earlier entry when the later one does not match the query', () => {
    const plain = source(entry('x', { label: 'Board' }));
    const rich = source(entry('x', { label: 'Elsewhere' }));
    expect(commandBarResults([plain, rich], 'board').results).toEqual([]);
  });
});

describe('commandBarResults: order', () => {
  it('lists a group by entry order at rest, whichever source brought it, and unordered ones after', () => {
    const found = commandBarResults(
      [
        source(entry('settings', { order: 1000 })),
        source(entry('loose'), entry('board', { order: 30 }), entry('ferrets', { order: 5 })),
      ],
      '',
    ).results;
    expect(found.map(one => one.id)).toEqual(['ferrets', 'board', 'settings', 'loose']);
  });

  it('breaks a tie between equal matches by order, not by which source spoke first', () => {
    const found = commandBarResults(
      [source(entry('late', { order: 9, label: 'Match' }), entry('early', { order: 1, label: 'Match' }))],
      'match',
    );
    expect(found.results.map(one => one.id)).toEqual(['early', 'late']);
  });
});

describe('commandBarResults: how many a group shows', () => {
  const many = source(...Array.from({ length: MAX_GROUP_RESULTS + 5 }, (_, index) => entry(`place-${index}`)));

  it('shows every resting entry with no query: v4 listed all its places on an empty palette', () => {
    expect(commandBarResults([many], '').results).toHaveLength(MAX_GROUP_RESULTS + 5);
  });

  it('caps a searched group: the bar is for jumping, not browsing', () => {
    expect(commandBarResults([many], 'place').results).toHaveLength(MAX_GROUP_RESULTS);
  });
});

describe('nextActiveIndex', () => {
  it('leaves every key alone when the list is empty', () => {
    expect(nextActiveIndex(0, 0, 'ArrowDown')).toBeNull();
  });

  it('wraps the arrows around both ends', () => {
    expect(nextActiveIndex(0, 3, 'ArrowDown')).toBe(1);
    expect(nextActiveIndex(2, 3, 'ArrowDown')).toBe(0);
    expect(nextActiveIndex(1, 3, 'ArrowUp')).toBe(0);
    expect(nextActiveIndex(0, 3, 'ArrowUp')).toBe(2);
  });

  it('jumps to either end', () => {
    expect(nextActiveIndex(1, 3, 'Home')).toBe(0);
    expect(nextActiveIndex(1, 3, 'End')).toBe(2);
  });

  it('moves from where the list actually is, not from a stale index', () => {
    expect(nextActiveIndex(99, 3, 'ArrowDown')).toBe(0);
    expect(nextActiveIndex(-5, 3, 'ArrowUp')).toBe(2);
  });

  it('leaves a key the list does not answer to alone', () => {
    expect(nextActiveIndex(0, 3, 'Tab')).toBeNull();
    expect(nextActiveIndex(0, 3, 'a')).toBeNull();
  });
});

describe('commandBarCountLabel', () => {
  it('says what it found, in the reader’s number', () => {
    expect(commandBarCountLabel(0)).toBe('No results');
    expect(commandBarCountLabel(1)).toBe('1 result');
    expect(commandBarCountLabel(4)).toBe('4 results');
  });
});
