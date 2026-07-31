import { describe, expect, it } from 'bun:test';
import { cn } from '../../src/lib/class-names.ts';

describe('cn', () => {
  it('joins plain string expressions with a single space', () => {
    expect(cn('kt-btn', 'kt-btn--sm')).toBe('kt-btn kt-btn--sm');
  });

  it('drops every falsy expression a conditional class produces', () => {
    expect(cn('kt-btn', false, null, undefined, '', true)).toBe('kt-btn');
  });

  it('keeps numeric class names, including zero', () => {
    expect(cn(0, 1, 2n)).toBe('0 1 2');
  });

  it('flattens nested arrays', () => {
    expect(cn(['a', ['b', ['c', false]]], 'd')).toBe('a b c d');
  });

  it('keeps only the truthy keys of a dictionary', () => {
    expect(cn({ a: true, b: 0, c: 'yes', d: undefined })).toBe('a c');
  });

  it('returns an empty string when nothing survives', () => {
    expect(cn()).toBe('');
    expect(cn(undefined, [], {})).toBe('');
  });
});
