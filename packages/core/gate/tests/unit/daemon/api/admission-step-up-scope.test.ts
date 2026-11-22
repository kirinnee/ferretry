import { describe, expect, test } from 'bun:test';
import { DEFAULT_GATE_CONFIG, DEFAULT_GATE_SECURITY } from '../../../../contract/index.ts';
import { admit, fleetConfigure, world } from '../support.ts';

/**
 * L129. A window-0 step-up is spent by the admission that rode on it, and that admission's standing keeps the right to
 * take the proof it was admitted with (`spentAtAdmission`). The right is the admitting REQUEST's: it ends with the
 * request, so work the call spawns and a later claim of the same standing take nothing.
 */

const windowZero = {
  ...DEFAULT_GATE_CONFIG,
  security: { ...DEFAULT_GATE_SECURITY, stepUpOnActions: true, stepUpWindowMinutes: 0 },
};
const SUBJECT = { deviceId: 'phone', appSession: 's-phone' };

function admitted(signal: AbortSignal) {
  const w = world({ policy: windowZero });
  w.enrol('phone');
  w.stepUps.grant(SUBJECT);
  const { decision } = admit(w, fleetConfigure, { device: 'phone', signal });
  if (decision.outcome !== 'admitted') throw new Error('expected admitted');
  return decision.standing;
}

describe('a step-up spend lasts only for its own request (L129)', () => {
  test('a claim made inside the admitting request still takes the proof it was admitted with', () => {
    const request = new AbortController();
    expect(admitted(request.signal).claimFreshStepUp?.()).toBe(true);
  });

  test('after the request ends, a continuation claim of the same standing answers false', () => {
    const request = new AbortController();
    const standing = admitted(request.signal);
    request.abort();
    expect(standing.claimFreshStepUp?.()).toBe(false);
  });

  test('ending the request does not take the proof away from a claim made before it ended, and it is taken once', () => {
    const request = new AbortController();
    const standing = admitted(request.signal);
    expect(standing.claimFreshStepUp?.()).toBe(true);
    request.abort();
    expect(standing.claimFreshStepUp?.()).toBe(false);
  });
});
