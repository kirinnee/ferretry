import { describe, expect, test } from 'bun:test';
import type { CallStanding } from '@ferretry/kernel/contract';
import {
  type CapabilityGrants,
  DEFAULT_GATE_CONFIG,
  DEFAULT_GATE_SECURITY,
  FULL_DEVICE_GRANTS,
} from '../../../contract/index.ts';
import { filesystemConfigure } from '../../../../../plugins/projects/contract/index.ts';
import { ADMIN, admit, declaredRoute, local, world } from './support.ts';

/**
 * F6061 U4 review (PR 2303), the Gate half of the outside-the-home proof. Projects lets a caller look at, or start a scan
 * of, a folder outside the home only after TWO stages: the route's own `filesystem.use` (admission, below) and then
 * `filesystem.configure`, which the handler asks of the standing admission handed it (`outsideHomeGate`, which maps the
 * answer to the 403 and its code; its own unit test pins that mapping). The Projects route stubs prove only that the handler
 * DEMANDS it; this runs the REAL `GateAdmission` over the routes as the shipped Projects manifest declares them and reads
 * the decision the standing gives for that demand. Fixture values only.
 *
 *   use-only device                            → stage 1 admits, stage 2 is refused (`device-not-granted`)
 *   configure, per-act step-up not yet proved → stage 1 admits, stage 2 asks for the step-up
 *   configure, step-up proved                  → both pass, and the standing carries what spends the step-up
 *   configure under the default unlock         → both pass
 *   the admin token at the machine             → ungoverned: both pass
 */

const useOnly: CapabilityGrants = {
  ...FULL_DEVICE_GRANTS,
  filesystem: { use: true, configure: false },
} as CapabilityGrants;
/** The machine asks a step-up for every act, so `configure` is refused until one is proved. */
const perAct = { ...DEFAULT_GATE_CONFIG, security: { ...DEFAULT_GATE_SECURITY, stepUpOnActions: true } };
const ROUTES = ['GET /v1/projects/folders', 'GET /v1/projects/:id/repos'] as const;

/** The standing of an admitted call: what the handler is handed. */
function standingOf(decision: ReturnType<typeof admit>['decision']) {
  if (decision.outcome !== 'admitted') throw new Error(`expected admitted, got ${decision.outcome}`);
  return decision.standing as CallStanding & {
    governance?: {
      governed: boolean;
      decide: (demand: typeof filesystemConfigure) => { allowed: boolean; refusal: string; steppedUp?: boolean };
    };
    spendStepUp?: () => void;
  };
}

describe('the two-stage check for a place outside the home, through the real GateAdmission', () => {
  test('the Projects routes declare filesystem.use (stage 1); the demand the handler adds is filesystem.configure (stage 2)', async () => {
    for (const key of ROUTES)
      expect((await declaredRoute(key)).capability).toMatchObject({ capability: 'filesystem', axis: 'use' });
    expect(filesystemConfigure).toMatchObject({ capability: 'filesystem', axis: 'configure' });
  });

  for (const key of ROUTES) {
    describe(key, () => {
      test('a use-only device is admitted by the route and refused configure', async () => {
        const w = world();
        w.enrol('phone', useOnly);
        const admitted = admit(w, await declaredRoute(key), { device: 'phone' });
        expect(admitted.outcome).toBe('admitted');
        const standing = standingOf(admitted.decision);
        expect(standing.governance?.governed).toBe(true);
        expect(standing.governance?.decide(filesystemConfigure)).toEqual({
          allowed: false,
          refusal: 'device-not-granted',
        });
      });

      test('configure WITHOUT the per-act step-up is told to step up', async () => {
        const w = world({ policy: perAct });
        w.enrol('phone');
        const admitted = admit(w, await declaredRoute(key), { device: 'phone' });
        expect(admitted.outcome).toBe('admitted');
        expect(standingOf(admitted.decision).governance?.decide(filesystemConfigure)).toEqual({
          allowed: false,
          refusal: 'step-up-required',
        });
      });

      test('configure WITH the step-up passes, and the standing hands the handler what spends it', async () => {
        const w = world({ policy: perAct });
        w.enrol('phone');
        w.stepUps.grant({ deviceId: 'phone', appSession: 's-phone' });
        const admitted = admit(w, await declaredRoute(key), { device: 'phone' });
        expect(admitted.outcome).toBe('admitted');
        const standing = standingOf(admitted.decision);
        expect(standing.governance?.decide(filesystemConfigure)).toMatchObject({ allowed: true, steppedUp: true });
        expect(typeof standing.spendStepUp).toBe('function');
      });

      test('a device holding configure under the default unlock passes', async () => {
        const w = world();
        w.enrol('phone');
        const admitted = admit(w, await declaredRoute(key), { device: 'phone' });
        expect(admitted.outcome).toBe('admitted');
        expect(standingOf(admitted.decision).governance?.decide(filesystemConfigure)).toMatchObject({
          allowed: true,
          refusal: 'granted',
        });
      });

      test('the admin token at the machine is ungoverned: both stages pass', async () => {
        const w = world({ policy: perAct });
        const admitted = admit(w, await declaredRoute(key), { bearer: ADMIN, arrival: local() });
        expect(admitted.outcome).toBe('admitted');
        const standing = standingOf(admitted.decision);
        expect(standing.governance?.governed).toBe(false);
        expect(standing.governance?.decide(filesystemConfigure)).toMatchObject({ allowed: true });
      });
    });
  }
});
