import { describe, expect, test } from 'bun:test';
import { formatThinkingElapsed, thinkingActivityLabel } from '../../../../app/chat/thinking-indicator.tsx';

const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (value !== null && typeof value === 'object' && 'children' in value) {
    return textOf((value as { readonly children: unknown }).children);
  }
  return '';
};

describe('ThinkingIndicator', () => {
  test('keeps the meaningful daemon activity while replacing its stale elapsed suffix', () => {
    expect(thinkingActivityLabel('Writing tests (34s · 2.1k tokens)')).toBe('Writing tests');
    expect(thinkingActivityLabel('   ')).toBe('Working…');
    expect(thinkingActivityLabel('(12s)')).toBe('Working…');
  });

  test('formats elapsed time without a negative or ambiguous reading', () => {
    expect(formatThinkingElapsed(-1)).toBe('0s');
    expect(formatThinkingElapsed(34_999)).toBe('34s');
    expect(formatThinkingElapsed(95_000)).toBe('1m 35s');
  });
});
