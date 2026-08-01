import { describe, expect, test } from 'bun:test';
import {
  ThinkingIndicator,
  formatThinkingElapsed,
  thinkingActivityLabel,
} from '../../src/components/thinking-indicator.tsx';
import { render } from '../support/react.ts';

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

  test('renders a live status with three decorative dots and optional elapsed time', () => {
    const withElapsed = render(<ThinkingIndicator activity="Writing tests (34s)" since={Date.now() - 34_000} />);
    expect(withElapsed.root.findByProps({ role: 'status' }).findAllByType('span')).toHaveLength(6);
    expect(textOf(withElapsed.toJSON())).toContain('Writing tests');
    expect(textOf(withElapsed.toJSON())).toMatch(/3[4-5]s/u);
    withElapsed.unmount();

    const withoutElapsed = render(<ThinkingIndicator />);
    expect(textOf(withoutElapsed.toJSON())).toBe('Working…');
    withoutElapsed.unmount();
  });
});
