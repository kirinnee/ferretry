import { expect, test } from 'bun:test';
import { cap, FULL_DEVICE_GRANTS } from '../../../../contract/index.ts';
import { admit, descriptor, world } from '../support.ts';
const FLEET = cap('fleet', 'use');
const VOICE = descriptor({ capability: cap('voice', 'use') });
const narrowed = { ...FULL_DEVICE_GRANTS, fleet: { use: false, configure: false } };
const open = (w: ReturnType<typeof world>) => {
  const decision = admit(w, VOICE, { device: 'phone' }).decision;
  if (decision.outcome !== 'admitted') throw new Error('synthetic voice admission failed');
  return decision.standing.governance!;
};
test('E-440 an already admitted Voice caller loses fleet.use when its device grant is cut', () => {
  const w = world();
  w.enrol('phone');
  const governance = open(w);
  expect(governance.decide(FLEET).allowed).toBe(true);
  w.enrol('phone', narrowed);
  expect(governance.decide(FLEET).allowed).toBe(false);
});
test('E-440 live governance can only narrow the device and machine snapshot', () => {
  const w = world();
  w.enrol('phone', narrowed);
  const governance = open(w);
  w.enrol('phone');
  expect(governance.decide(FLEET).allowed).toBe(false);
});
test('E-440 unavailable device provider fails closed on an already admitted caller', () => {
  const w = world();
  w.enrol('phone');
  const governance = open(w);
  w.devicesOff = true;
  expect(governance.decide(FLEET).allowed).toBe(false);
});

test('E-440 grant refresh preserves the proof spent by this admission at a zero-minute window', async () => {
  const { DEFAULT_GATE_CONFIG, DEFAULT_GATE_SECURITY } = await import('../../../../contract/index.ts');
  const w = world({
    policy: {
      ...DEFAULT_GATE_CONFIG,
      security: { ...DEFAULT_GATE_SECURITY, stepUpOnActions: true, stepUpWindowMinutes: 0 },
    },
  });
  w.enrol('phone');
  w.stepUps.grant({ deviceId: 'phone', appSession: 's-phone' });
  const decision = admit(w, descriptor({ method: 'POST', capability: cap('fleet', 'configure') }), {
    device: 'phone',
  }).decision;
  if (decision.outcome !== 'admitted') throw new Error('expected admission');
  expect(decision.standing.governance?.decide(cap('terminal', 'use')).allowed).toBe(true);
  w.enrol('phone', narrowed);
  expect(decision.standing.governance?.decide(FLEET).allowed).toBe(false);
});

test('E-440 a slow provider cannot turn an unanswerable standing into permission', () => {
  const w = world();
  w.enrol('phone');
  const governance = open(w);
  w.devices.standing = (() => new Promise(() => {})) as never;
  expect(governance.decide(FLEET).allowed).toBe(false);
});
