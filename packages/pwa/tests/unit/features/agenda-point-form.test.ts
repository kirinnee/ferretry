import { describe, expect, test } from 'bun:test';
import { bulletPoints } from '../../../src/features/agenda/agenda-brief.tsx';

describe('bulletPoints', () => {
  test('reads dash, star and bullet lines, ignoring blank lines and indentation', () => {
    expect(bulletPoints('- one\n\n  * two\r\n• three')).toEqual(['one', 'two', 'three']);
  });

  test('is null for prose, a mix, an empty text and a bare marker', () => {
    expect(bulletPoints('Just words.')).toBeNull();
    expect(bulletPoints('Lead\n- point')).toBeNull();
    expect(bulletPoints('  ')).toBeNull();
    expect(bulletPoints('-')).toBeNull();
    expect(bulletPoints('-dash')).toBeNull();
  });
});

describe('bulletPoints with a marker inside the point', () => {
  test('a stored "- - x" reads as one bullet "x", not a nested list', () => {
    expect(bulletPoints('- - You asked to\n- * second\n- 1. third')).toEqual(['You asked to', 'second', 'third']);
  });
});
