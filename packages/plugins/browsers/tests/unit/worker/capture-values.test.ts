import { describe, expect, it } from 'bun:test';
import { CaptureValues } from '../../../daemon/worker/capture/values.ts';

describe('worker-private capture masks', () => {
  it('replaces each native field mask without keeping prefixes, and retains its last value when cleared', () => {
    const masks = new CaptureValues();
    for (const value of ['h', 'hu', 'hun', 'hunt', 'hunte', 'hunter', 'hunter2']) masks.observe('field', value);
    expect(masks.text('hello hunter hunter2')).toBe('hello hunter [redacted]');
    masks.observe('field', '');
    expect(masks.text('hunter2')).toBe('[redacted]');
    masks.observe('field', 'short');
    expect(masks.text('hunter2 short')).toBe('hunter2 short');
    masks.remember('a');
    expect(masks.text('a')).not.toBe('a');
  });
  it('masks literal metacharacters, longest values first, without matching the replacement again', () => {
    const masks = new CaptureValues();
    for (const value of ['abc', 'abcdef', '.*+$[value](x)', 'redacted']) masks.remember(value);
    expect(masks.text('abcdef abc .*+$[value](x) redacted')).toBe('█ █ █ █');
  });

  it('covers nested text while preserving already-painted image encodings', () => {
    const masks = new CaptureValues();
    masks.remember('synthetic-input');
    expect(
      masks.data({ title: 'synthetic-input', nested: ['synthetic-input'], screenshotBase64: 'synthetic-input' }),
    ).toEqual({ title: '[redacted]', nested: ['[redacted]'], screenshotBase64: 'synthetic-input' });
  });

  it('keeps masking idempotent for short input and preserves private routing facts', () => {
    const masks = new CaptureValues();
    masks.remember('a');
    const once = masks.text('a a');
    expect(masks.text(once)).toBe(once);
    expect(masks.data({ url: 'about:blank' })).toEqual({ url: 'about:blank' });
    expect(masks.data({ id: 'a', title: 'a', path: '/stage/a', scriptOrigin: 'https://a' })).toEqual({
      id: 'a',
      title: '█',
      path: '/stage/a',
      scriptOrigin: 'https://a',
    });
  });

  it('covers native line-ending normalization and ordinary serialized forms', () => {
    const masks = new CaptureValues();
    masks.remember('synthetic-<x>\r\nline');
    for (const value of [
      'synthetic-<x>\nline',
      'synthetic-<x>line',
      'synthetic-&lt;x&gt;\nline',
      JSON.stringify('synthetic-<x>\nline').slice(1, -1),
      encodeURIComponent('synthetic-<x>\nline'),
    ])
      expect(masks.text(value)).toBe('[redacted]');
  });

  it('refuses output after the bounded mask set fills instead of silently forgetting an earlier value', () => {
    const masks = new CaptureValues();
    masks.remember('first-synthetic-input');
    expect(() => masks.remember('x'.repeat(2_097_153))).toThrow(/full/u);
    expect(() => masks.text('first-synthetic-input')).toThrow(/unavailable/u);
  });
});
