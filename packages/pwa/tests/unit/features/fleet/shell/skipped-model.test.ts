import { describe, expect, it } from 'bun:test';
import type { FleetAccountChangeOutcome } from '@ferretry/protocol';
import {
  groupSkipped,
  SKIPPED_REASON,
  skippedCountLine,
  skippedFromOutcome,
} from '../../../../../src/features/fleet/shell/skipped-model.ts';
import { runtime } from '../account-support.ts';

const ONE = '00000000-0000-4000-8000-000000000001';
const TWO = '00000000-0000-4000-8000-000000000002';
const HOME = '/home/kirin/.ferretry/fleet/homes/claude-one';

const committed = (skipped: readonly { path: string; reason: string; runtime?: string; within?: string }[]) =>
  ({
    outcome: 'applied',
    apply: {
      outcome: 'committed',
      result: {
        accountCount: 2,
        operationCount: 3,
        manifestPath: '/home/kirin/.ferretry/fleet/manifest.json',
        prunedWrappers: [],
        sharedHistory: [],
        skipped,
      },
    },
  }) as FleetAccountChangeOutcome;

describe('skippedFromOutcome', () => {
  it('should read what a committed apply left as it was', () => {
    const entry = { path: `${HOME}/skills/review`, reason: 'raw', runtime: ONE, within: 'skills/review' };

    expect(skippedFromOutcome(committed([entry]))).toEqual([entry]);
  });

  it('should say an apply that skipped nothing skipped nothing, so an earlier list is replaced', () => {
    expect(skippedFromOutcome(committed([]))).toEqual([]);
  });

  it('should read the skipped entries of a fleet that landed with only its history failing', () => {
    const entry = { path: `${HOME}/commands`, reason: 'raw', runtime: ONE, within: 'commands' };
    const outcome = {
      outcome: 'applied',
      apply: {
        outcome: 'committed-with-history-failure',
        failedHarness: 'claude',
        reason: 'no space',
        committed: {
          accountCount: 1,
          operationCount: 1,
          manifestPath: '/m.json',
          manifest: { version: 1, generatedAt: '2027-01-15T08:00:00.000Z', accounts: [] },
          prunedWrappers: [],
          sharedHistory: [],
          skipped: [entry],
        },
      },
    } as unknown as FleetAccountChangeOutcome;

    expect(skippedFromOutcome(outcome)).toEqual([entry]);
  });

  it('should have no answer from an outcome that is not an apply that landed', () => {
    expect(
      skippedFromOutcome({ outcome: 'executed', executor: 'setup', summary: 'Done.' } as FleetAccountChangeOutcome),
    ).toBeNull();
    expect(
      skippedFromOutcome({
        outcome: 'applied',
        apply: { outcome: 'rolled-back', failedOperation: 'copy', reason: 'no' },
      } as unknown as FleetAccountChangeOutcome),
    ).toBeNull();
  });
});

describe('groupSkipped', () => {
  const runtimes = [runtime({ name: 'claude-one', id: ONE }), runtime({ name: 'claude-two', id: TWO })];

  it('should group entries by runtime name', () => {
    const grouped = groupSkipped(
      [
        { path: `${HOME}/skills/a`, reason: 'raw', runtime: TWO, within: 'skills/a' },
        { path: `${HOME}/skills/b`, reason: 'raw', runtime: ONE, within: 'skills/b' },
        { path: `${HOME}/skills/c`, reason: 'raw', runtime: TWO, within: 'skills/c' },
      ],
      runtimes,
    );

    expect(grouped.byRuntime.get('claude-one')?.map(item => item.within)).toEqual(['skills/b']);
    expect(grouped.byRuntime.get('claude-two')?.map(item => item.within)).toEqual(['skills/a', 'skills/c']);
    expect(grouped.elsewhere).toEqual([]);
  });

  it('should show the path inside the runtime and a plain reason, never the folder on disk or the raw message', () => {
    const grouped = groupSkipped(
      [
        {
          path: `${HOME}/skills/a`,
          reason: `not moving or removing ${HOME}/skills/a on this platform`,
          runtime: ONE,
          within: 'skills/a',
        },
      ],
      runtimes,
    );

    expect(grouped.byRuntime.get('claude-one')).toEqual([{ within: 'skills/a', reason: SKIPPED_REASON }]);
    expect(JSON.stringify(grouped)).not.toContain('/home/kirin');
    expect(SKIPPED_REASON).not.toContain('/');
  });

  it('should keep an entry of no listed runtime, naming only what is safe to show', () => {
    const grouped = groupSkipped(
      [
        {
          path: `${HOME}/skills/a`,
          reason: 'raw',
          runtime: '00000000-0000-4000-8000-0000000000ff',
          within: 'skills/a',
        },
        { path: '/home/kirin/.ferretry/vault/keys/passkeys.json', reason: 'raw' },
      ],
      runtimes,
    );

    expect(grouped.byRuntime.size).toBe(0);
    expect(grouped.elsewhere.map(item => item.within)).toEqual(['skills/a', 'passkeys.json']);
    expect(JSON.stringify(grouped)).not.toContain('/home/kirin');
  });
});

describe('skippedCountLine', () => {
  it('should count one and many', () => {
    expect(skippedCountLine(1)).toBe('1 item skipped');
    expect(skippedCountLine(3)).toBe('3 items skipped');
  });
});
