import { describe, expect, it } from 'bun:test';
import type { WardenJevBefore } from '@ferretry/protocol';
import { jevBeforeLine, jevCost } from '../../../src/features/warden/warden-jev-line.ts';

const handed = (overrides: Partial<WardenJevBefore> = {}): WardenJevBefore => ({
  verdict: 'handed_on',
  why: 'unsure',
  at: '2026-10-30T00:28:06.349Z',
  confidence: 0.21,
  costUsd: 0.0041,
  ...overrides,
});

describe('jevBeforeLine', () => {
  it.each([
    ['unsure', handed(), 'Jev: not sure (21%) · $0.0041 → investigated'],
    ['no reason kept', handed({ why: undefined }), 'Jev: not sure (21%) · $0.0041 → investigated'],
    [
      'below the bar for an act',
      handed({ why: 'not_sure_enough', act: 'restart', confidence: 0.62 }),
      'Jev: only 62% sure it should restart it · $0.0041 → investigated',
    ],
    ['below the bar to leave it', handed({ why: 'not_sure_enough' }), 'Jev: only 21% sure · $0.0041 → investigated'],
    [
      'an act never done alone',
      handed({ why: 'never_alone', act: 'stop', confidence: 0.99 }),
      'Jev: would stop it (99%), not its to do alone · $0.0041 → investigated',
    ],
    [
      'an act not allowed alone, unnamed',
      handed({ why: 'not_allowed', confidence: 0.95 }),
      'Jev: 95% sure, not its to do alone · $0.0041 → investigated',
    ],
    [
      'a failover',
      handed({ why: 'cannot_choose_login', act: 'failover', confidence: 0.9 }),
      'Jev: would move it to another account (90%), cannot pick which · $0.0041 → investigated',
    ],
    [
      'a nudge with no message',
      handed({ why: 'no_message', confidence: 0.92 }),
      'Jev: would nudge it (92%), no message it was sure of · $0.0041 → investigated',
    ],
    [
      'an act not offered',
      handed({ why: 'not_offered' }),
      'Jev: chose an act this flag does not allow · $0.0041 → investigated',
    ],
    ['a failed call', handed({ why: 'failed', confidence: 0, costUsd: 0 }), 'Jev: call failed → investigated'],
    [
      'a failed call with no cost',
      handed({ why: 'failed', confidence: undefined, costUsd: undefined }),
      'Jev: call failed → investigated',
    ],
    [
      'an act that did not take',
      handed({ why: 'act_failed', act: 'nudge', confidence: 0.93 }),
      'Jev: tried to nudge it (93%), it did not take · $0.0041 → investigated',
    ],
    [
      'an unnamed act that did not take',
      handed({ why: 'act_failed', confidence: 0.93 }),
      'Jev: acted (93%), it did not take · $0.0041 → investigated',
    ],
    [
      'the daily cap',
      { verdict: 'skipped', why: 'jev_cap', confidence: 0, costUsd: 0 },
      'Jev: skipped — daily cap spent → investigated',
    ],
    [
      'the hourly share',
      { verdict: 'skipped', why: 'jev_paced' },
      'Jev: skipped — this hour’s share of its cap spent → investigated',
    ],
    ['the layer off', { verdict: 'off' }, 'Jev: off'],
    ['the owner asking', { verdict: 'not_asked', why: 'owner_request' }, 'Jev: not asked — you asked for this'],
    ['a forced run', { verdict: 'not_asked', why: 'forced' }, 'Jev: not asked — a forced run'],
    [
      'a kind Jev never judges',
      { verdict: 'not_asked', why: 'not_judgeable' },
      'Jev: not asked — it does not judge this kind of flag',
    ],
    ['a back-off', { verdict: 'not_asked', why: 'backoff' }, 'Jev: not asked — backing off after a rate limit'],
    [
      'an unmaskable snapshot',
      { verdict: 'not_asked', why: 'unredacted' },
      'Jev: not asked — the snapshot could not be masked',
    ],
    [
      'an earlier act',
      { verdict: 'not_asked', why: 'already_acted', act: 'nudge', confidence: 0.93 },
      'Jev: already nudged it (93%) — still flagged',
    ],
    [
      'an earlier act with no confidence',
      { verdict: 'not_asked', why: 'already_acted', act: 'failover' },
      'Jev: already moved it to another account (0%) — still flagged',
    ],
    ['an earlier act unnamed', { verdict: 'not_asked', why: 'already_acted' }, 'Jev: already acted — still flagged'],
    ['no record', { verdict: 'not_asked', why: 'no_record' }, 'Jev: no record — queued before Jev’s checks were kept'],
  ] as const)('should say %s', (_label, jev, expected) => {
    // Act / Assert
    expect(jevBeforeLine(jev as WardenJevBefore)).toBe(expected);
  });

  it('should say a result came from before Jev’s results were kept, and a fleet triage’s flags differed', () => {
    // Act / Assert
    expect(jevBeforeLine(undefined)).toBe('Jev: no record — from before Jev’s results were kept');
    expect(jevBeforeLine(undefined, 'fleet')).toBe('Jev: differs per flag');
    expect(jevBeforeLine({ verdict: 'off' }, 'fleet')).toBe('Jev: off');
  });

  it.each([
    ['resume', 'resume it', 'resumed it'],
    ['restart', 'restart it', 'restarted it'],
    ['stop', 'stop it', 'stopped it'],
  ] as const)('should name the act %s', (act, toDo, done) => {
    // Act / Assert
    expect(jevBeforeLine(handed({ why: 'never_alone', act }))).toContain(`would ${toDo} (21%)`);
    expect(jevBeforeLine({ verdict: 'not_asked', why: 'already_acted', act })).toContain(`already ${done}`);
  });

  it('should price one call to four places', () => {
    // Act / Assert
    expect(jevCost(0.00412)).toBe('$0.0041');
  });
});
