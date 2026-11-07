import { describe, expect, it } from 'bun:test';
import { commandBarCountLabel, nextActiveIndex } from '../../../src/ui/command-bar-model.ts';

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
