import { expect, test } from 'bun:test';
import { cap, DEFAULT_GATE_CONFIG, DEFAULT_GATE_SECURITY } from '../../../../contract/index.ts';
import { admit, descriptor, world } from '../support.ts';

for (const window of [0, 15]) {
  test(`a handler atomically claims the admitted step-up; ${window}-minute windows keep their configured reuse`, async () => {
    const w = world({
      policy: {
        ...DEFAULT_GATE_CONFIG,
        security: {
          ...DEFAULT_GATE_SECURITY,
          unlockOnOpen: false,
          stepUpOnActions: false,
          stepUpWindowMinutes: window,
        },
      },
    });
    w.enrol('phone');
    w.stepUps.grant({ deviceId: 'phone', appSession: 's-phone' });
    const route = descriptor({ capability: cap('fleet', 'configure', { promptsAsUse: true }) });
    const bothAdmitted = Promise.withResolvers<void>();
    let admitted = 0;
    const request = async () => {
      const { decision } = admit(w, route, { device: 'phone' });
      if (decision.outcome !== 'admitted') throw new Error('ordinary start must admit without prompting');
      if (++admitted === 2) bothAdmitted.resolve();
      await bothAdmitted.promise;
      return decision.standing.claimStepUp?.() === true;
    };
    const results = await Promise.all([request(), request()]);
    expect(admitted).toBe(2);
    expect(results.filter(Boolean)).toHaveLength(window === 0 ? 1 : 2);
  });
}

test('a proof spent by the start admission belongs to that request alone and may be claimed once', () => {
  const w = world({
    policy: {
      ...DEFAULT_GATE_CONFIG,
      security: {
        ...DEFAULT_GATE_SECURITY,
        unlockOnOpen: false,
        stepUpOnActions: true,
        stepUpWindowMinutes: 0,
      },
    },
  });
  w.enrol('phone');
  w.stepUps.grant({ deviceId: 'phone', appSession: 's-phone' });
  const route = descriptor({ capability: cap('fleet', 'configure', { promptsAsUse: true }) });
  const first = admit(w, route, { device: 'phone' }).decision;
  expect(first.outcome).toBe('admitted');
  if (first.outcome !== 'admitted') throw new Error('first start must admit');
  expect(first.standing.claimStepUp?.()).toBe(true);
  expect(first.standing.claimStepUp?.()).toBe(false);
  expect(admit(w, route, { device: 'phone' }).outcome).toBe('403 grant_step_up_required');
});
