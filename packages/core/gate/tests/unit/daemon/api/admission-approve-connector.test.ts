import { expect, test } from 'bun:test';
import { cap, FULL_DEVICE_GRANTS, STEP_UP_ACTS } from '../../../../contract/index.ts';
import { admit, descriptor, FERRET_TOKEN, local, world } from '../support.ts';

/**
 * The route the Claude connector's `approve` is declared as (`packages/plugins/connector`: caller person, `pairing.configure`
 * with the `approve-connector` act), judged by the REAL admission: the connector's own tests hand its handler a derived
 * context, so what Gate really derives for these callers is pinned here.
 */
const approve = descriptor({
  method: 'POST',
  path: '/v1/connector/requests/:id/approve',
  caller: 'person',
  capability: cap('pairing', 'configure', { act: STEP_UP_ACTS.approveConnector }),
});

test('a governed, unlocked device is admitted with NO approve-connector proof to claim, so the route can refuse it', () => {
  const w = world();
  w.enrol('d1', FULL_DEVICE_GRANTS, true);
  const { decision } = admit(w, approve, { device: 'd1' });
  if (decision.outcome !== 'admitted') throw new Error('Gate refused the device before the handler');
  expect(decision.standing.claimFreshStepUp?.(STEP_UP_ACTS.approveConnector)).toBe(false);
  // the unlock buys no other act's proof either
  expect(decision.standing.claimFreshStepUp?.(STEP_UP_ACTS.catalogInstall)).toBe(false);
});

test('a ferret presenting its REAL credential from its own pane is refused as an agent, not as an unknown bearer', () => {
  const w = world();
  expect(admit(w, approve, { bearer: FERRET_TOKEN, arrival: local(true) }).outcome).toBe('403 owner_only');
  const open = descriptor({ ...approve, caller: 'any', capability: undefined });
  expect(admit(w, open, { bearer: FERRET_TOKEN, arrival: local(true) }).outcome).toBe('admitted');
});
