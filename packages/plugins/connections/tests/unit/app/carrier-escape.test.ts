/**
 * Which choice is to blame when a machine cannot be reached (`app/features/carrier/carrier-escape.tsx`): only a
 * preference that narrowed the walk, and not while the device's own network is down.
 */
import { describe, expect, test } from 'bun:test';
import { stuckPreference } from '../../../app/features/carrier/carrier-escape.tsx';
import type { ConnectionHealthState } from '../../../app/lib/connection-health.ts';

const reconnecting = (cause: 'device-offline' | 'daemon-unreachable' | 'relay-unreachable' | 'unknown') =>
  ({
    kind: 'reconnecting',
    since: 0,
    attempt: 1,
    nextAttemptAt: null,
    failures: [],
    cause,
    stalled: false,
  }) as const satisfies ConnectionHealthState;

describe('the carrier choice to blame for an unreachable machine', () => {
  test('a narrowed preference is blamed while the machine is in an outage', () => {
    for (const chosen of ['tunnel', 'webrtc', 'relay'] as const)
      expect(stuckPreference(chosen, reconnecting('daemon-unreachable'))).toBe(chosen);
  });

  test('Auto, the default and a machine that is reached are never blamed', () => {
    expect(stuckPreference('auto', reconnecting('unknown'))).toBeUndefined();
    expect(stuckPreference(undefined, reconnecting('unknown'))).toBeUndefined();
    expect(stuckPreference('tunnel', { kind: 'connected' })).toBeUndefined();
    expect(stuckPreference('tunnel', { kind: 'unknown' })).toBeUndefined();
  });

  test('the device being offline is not the preference’s fault', () => {
    expect(stuckPreference('tunnel', reconnecting('device-offline'))).toBeUndefined();
  });
});
