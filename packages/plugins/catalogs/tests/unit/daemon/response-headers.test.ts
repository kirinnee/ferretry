import { describe, expect, it } from 'bun:test';
import { namesTag } from '../../../daemon/lib/response-headers.ts';

describe('namesTag', () => {
  it('matches the tag exactly, weak or not', () => {
    expect(namesTag('"abc"', '"abc"')).toBe(true);
    expect(namesTag('W/"abc"', '"abc"')).toBe(true);
  });

  it('matches one tag in a comma list, ignoring spaces', () => {
    expect(namesTag('"x" ,  "abc"', '"abc"')).toBe(true);
  });

  it('matches everything on a wildcard', () => {
    expect(namesTag('*', '"abc"')).toBe(true);
  });

  it('does not match a different tag', () => {
    expect(namesTag('"x", "y"', '"abc"')).toBe(false);
    expect(namesTag('', '"abc"')).toBe(false);
  });
});
