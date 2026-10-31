import { describe, expect, it } from 'bun:test';
import { reviveOf, reviveRuling, SessionStatusSchema } from '../../src/lib/index.ts';

describe('reviveRuling', () => {
  it('gives every status a verdict with a reason', () => {
    for (const status of SessionStatusSchema.options) {
      const ruling = reviveRuling(status);
      expect(typeof ruling.revivable).toBe('boolean');
      expect(ruling.reason.length).toBeGreaterThan(0);
    }
  });

  it('revives what nothing is working, and not a stop that failed or a session on its way up', () => {
    const revivable = SessionStatusSchema.options.filter(status => reviveRuling(status).revivable);
    expect(revivable).toEqual(['completed', 'failed', 'stalled', 'stopped']);
  });
});

describe('reviveOf', () => {
  const state = { status: 'running' } as const;

  it('reads the daemon’s verdict when the view carries one', () => {
    const revive = { revivable: true, reason: 'Its CLI is gone.' };
    expect(reviveOf({ state, revive })).toEqual(revive);
  });

  it('falls back to the shared rule for a daemon that predates the field', () => {
    expect(reviveOf({ state: { status: 'failed' } })).toEqual(reviveRuling('failed'));
  });
});
