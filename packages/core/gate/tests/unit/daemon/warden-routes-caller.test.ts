import { expect, test } from 'bun:test';
import { ferretOf } from '../../../contract/index.ts';
import { ADMIN, admit, declaredRoute, FERRET, FERRET_TOKEN, local, world } from './support.ts';

/**
 * Audit A fix 4, the Gate half. Warden narrows every read a ferret can make to the caller's lineage from `ferretOf(call)`.
 * This runs the REAL `GateAdmission` over the routes as the shipped Warden manifest declares them: the five a ferret reads
 * (`status`, `verdicts`, `report`, `agenda`, `run`) admit a ferret bearer AS THAT ferret and the admin token as nobody, so
 * the route's scope is exactly the caller's; the three that write as a person (`investigate`, `leave`, `PATCH config`)
 * refuse a ferret outright, so none of them is a read-returning write a ferret can reach. (The kernel host test
 * `core/kernel/tests/integration/host/warden-ferret-view-caller.test.ts` composes the real Ferrets and Warden halves behind
 * the stand-in admission, whose `ferretStanding` has this same shape; the kernel cannot import Gate's daemon.)
 */

const FERRET_READS = [
  'GET /v1/warden/status',
  'GET /v1/warden/verdicts',
  'GET /v1/warden/report',
  'GET /v1/warden/agenda',
  'POST /v1/warden/run',
] as const;
const PERSON_ONLY = ['POST /v1/warden/investigate', 'POST /v1/warden/leave', 'PATCH /v1/warden/config'] as const;

for (const key of FERRET_READS) {
  test(`audit A fix 4 ${key} admits a ferret bearer as that ferret and the admin token as nobody`, async () => {
    const w = world();
    const route = await declaredRoute(key);
    const asFerret = admit(w, route, { bearer: FERRET_TOKEN, arrival: local(true) });
    const asOwner = admit(w, route, { bearer: ADMIN, arrival: local() });
    if (asFerret.decision.outcome !== 'admitted' || asOwner.decision.outcome !== 'admitted')
      throw new Error(`expected both callers admitted to ${key}`);
    expect(
      ferretOf({ credential: asFerret.decision.standing.credential, actor: asFerret.decision.standing.actor }),
    ).toBe(FERRET);
    expect(
      ferretOf({ credential: asOwner.decision.standing.credential, actor: asOwner.decision.standing.actor }),
    ).toBeUndefined();
  });
}

for (const key of PERSON_ONLY) {
  test(`audit A fix 4 ${key} refuses a ferret bearer: a person's route, never a read a ferret can make`, async () => {
    const w = world();
    const route = await declaredRoute(key);
    expect(route.caller).toBe('person');
    expect(admit(w, route, { bearer: FERRET_TOKEN, arrival: local(true) }).outcome).toBe('403 owner_only');
  });
}
