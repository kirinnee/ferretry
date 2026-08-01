import { describe, it } from 'bun:test';
import should from 'should';
import { isDaemonOwnedScratchEntry, scratchEligibility } from '../../../src/lib/scratch/index.ts';

const NOW = Date.parse('2026-08-01T00:00:00.000Z');
const HOUR = 3_600_000;
const eligible = {
  status: 'completed',
  finishedAt: new Date(NOW - 25 * HOUR).toISOString(),
  newestMtimeMs: NOW - 25 * HOUR,
  nowMs: NOW,
  ttlMs: 24 * HOUR,
  hasMonitor: false,
  hasLivePane: false,
  launching: false,
  wardenTarget: false,
} as const;

describe('scratch reclamation policy', () => {
  it('should preserve every daemon-owned entry including an in-flight atomic write', () => {
    should(isDaemonOwnedScratchEntry('events.jsonl')).be.true();
    should(isDaemonOwnedScratchEntry('state.json.tmp.1234')).be.true();
    should(isDaemonOwnedScratchEntry('checkout')).be.false();
    should(isDaemonOwnedScratchEntry('unrelated.tmp.1234')).be.false();
  });

  it('should only reclaim a settled terminal session past its TTL', () => {
    should(scratchEligibility(eligible)).deepEqual({ eligible: true });
    should(scratchEligibility({ ...eligible, status: 'running' })).deepEqual({
      eligible: false,
      reason: 'not terminal',
    });
    should(scratchEligibility({ ...eligible, hasLivePane: true })).deepEqual({
      eligible: false,
      reason: 'the tmux pane is still alive',
    });
    should(scratchEligibility({ ...eligible, hasMonitor: true })).deepEqual({
      eligible: false,
      reason: 'a monitor is still attached',
    });
  });

  it('should refuse a terminal session whose files were touched inside the TTL', () => {
    should(scratchEligibility({ ...eligible, newestMtimeMs: NOW - HOUR })).deepEqual({
      eligible: false,
      reason: 'a file under the session directory changed inside the TTL',
    });
    should(scratchEligibility({ ...eligible, finishedAt: undefined, newestMtimeMs: undefined })).deepEqual({
      eligible: false,
      reason: 'no finishedAt and no file mtime to age from',
    });
  });
});
