import { describe, expect, test } from 'bun:test';
import { sameText } from '../../../../daemon/lib/secrets/same-text.ts';

describe('sameText', () => {
  test('equal texts are the same, and texts of any length that differ are not', () => {
    expect(sameText('sk-ant-0123', 'sk-ant-0123')).toBe(true);
    expect(sameText('sk-ant-0123', 'sk-ant-0124')).toBe(false);
    expect(sameText('short', 'a much longer text than the first one')).toBe(false);
    expect(sameText('', '')).toBe(true);
  });
});
