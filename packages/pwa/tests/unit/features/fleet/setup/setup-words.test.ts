import { describe, expect, it } from 'bun:test';
import {
  countWords,
  fileName,
  listWords,
  SETUP_HARNESS_NAMES,
  SETUP_HARNESSES,
} from '../../../../../src/features/fleet/setup/setup-words.ts';

describe('setup harness names', () => {
  it('lists the harnesses in the order every screen shows them', () => {
    expect(SETUP_HARNESSES).toEqual(['claude', 'codex']);
  });

  it('names each harness the way a person reads it', () => {
    expect(SETUP_HARNESS_NAMES.claude).toBe('Claude Code');
    expect(SETUP_HARNESS_NAMES.codex).toBe('Codex');
  });
});

describe('countWords', () => {
  it('uses the singular for exactly one', () => {
    expect(countWords(1, 'runtime')).toBe('1 runtime');
  });

  it('uses the plural for zero and for many', () => {
    expect(countWords(0, 'runtime')).toBe('0 runtimes');
    expect(countWords(3, 'runtime')).toBe('3 runtimes');
  });
});

describe('listWords', () => {
  it('reads an empty list as nothing', () => {
    expect(listWords([])).toBe('');
  });

  it('reads one item as itself', () => {
    expect(listWords(['settings.json'])).toBe('settings.json');
  });

  it('joins two items with "and"', () => {
    expect(listWords(['Claude Code', 'Codex'])).toBe('Claude Code and Codex');
  });

  it('joins three or more with commas and a final "and"', () => {
    expect(listWords(['a', 'b', 'c'])).toBe('a, b and c');
    expect(listWords(['a', 'b', 'c', 'd'])).toBe('a, b, c and d');
  });
});

describe('fileName', () => {
  it('keeps the last segment of a posix path', () => {
    expect(fileName('/home/kirin/.claude/settings.json')).toBe('settings.json');
  });

  it('keeps the last segment of a windows path', () => {
    expect(fileName('C:\\Users\\kirin\\.claude\\settings.json')).toBe('settings.json');
  });

  it('ignores a trailing separator', () => {
    expect(fileName('/home/kirin/projects/')).toBe('projects');
    expect(fileName('C:\\Users\\kirin\\')).toBe('kirin');
  });

  it('returns a bare name unchanged', () => {
    expect(fileName('CLAUDE.md')).toBe('CLAUDE.md');
  });

  it('returns the input when no name remains', () => {
    expect(fileName('/')).toBe('/');
    expect(fileName('')).toBe('');
  });
});
