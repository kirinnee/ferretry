import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineState } from '../../../contract/define.ts';
import { parseDocument } from '../../../testing/state.ts';

const Bare = defineState({
  name: 'bare',
  path: 'bare.json',
  store: 'json',
  format: 1,
  schema: z.strictObject({ value: z.number() }),
});
const Stamped = defineState({
  name: 'stamped',
  path: 'stamped.json',
  store: 'json',
  format: 1,
  schema: z.strictObject({ format: z.literal(1), value: z.number() }),
});

describe('test host parseDocument', () => {
  it('should read a bare schema back without its format', () => {
    const read = parseDocument(Bare, JSON.stringify({ format: 1, value: 3 }));
    expect(read.ok && read.value).toEqual({ value: 3 });
  });

  it('should read a schema that declares its own format, as the real host does', () => {
    const read = parseDocument(Stamped, JSON.stringify({ format: 1, value: 3 }));
    expect(read.ok && read.value).toEqual({ format: 1, value: 3 });
  });

  it('should still report schema damage when neither shape matches', () => {
    const read = parseDocument(Stamped, JSON.stringify({ format: 1, value: 'x' }));
    expect(read.ok).toBe(false);
  });
});
