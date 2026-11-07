import { describe, it } from 'bun:test';
import { SessionContextSchema } from '../../src/lib/session.ts';
import { assertRejects, assertRoundTrips } from './schema-cases.ts';

const AT = '2026-10-30T08:00:00.000Z';

describe('the session context', () => {
  it('should round-trip a size, a window, a percent and the instant they were read', () => {
    assertRoundTrips([
      {
        name: 'context',
        schema: SessionContextSchema,
        value: { usedTokens: 118_000, windowTokens: 1_000_000, percent: 11.8, at: AT },
      },
      {
        name: 'empty',
        schema: SessionContextSchema,
        value: { usedTokens: 0, windowTokens: 200_000, percent: 0, at: AT },
      },
    ]);
  });

  it('should refuse a window of nothing, a share past the whole, and unknown fields', () => {
    const ok = { usedTokens: 1, windowTokens: 2, percent: 50, at: AT };
    assertRejects([
      { name: 'zero window', schema: SessionContextSchema, value: { ...ok, windowTokens: 0 } },
      { name: 'negative size', schema: SessionContextSchema, value: { ...ok, usedTokens: -1 } },
      { name: 'over 100%', schema: SessionContextSchema, value: { ...ok, percent: 101 } },
      { name: 'not an instant', schema: SessionContextSchema, value: { ...ok, at: 'yesterday' } },
      { name: 'unknown field', schema: SessionContextSchema, value: { ...ok, guess: true } },
    ]);
  });
});
