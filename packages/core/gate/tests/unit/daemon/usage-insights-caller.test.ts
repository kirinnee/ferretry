import { expect, test } from 'bun:test';
import { ferretOf } from '../../../contract/index.ts';
import { ADMIN, admit, declaredRoute, FERRET, FERRET_TOKEN, local, world } from './support.ts';

/**
 * M4 / audit A fix 1, the Gate half. Usage narrows `GET /v1/usage/insights` to the caller's lineage from
 * `ferretOf(call)`. This runs the REAL `GateAdmission` over the route as the shipped Usage manifest declares it
 * (`minimum: operator`, `caller: any`): a ferret bearer is admitted, and the standing it is admitted with names that
 * ferret; the owner's admin token names none. (The kernel host test
 * `core/kernel/tests/integration/host/usage-insights-lineage.test.ts` composes the real Ferrets and Usage halves behind
 * the stand-in admission, whose `ferretStanding` has this same shape; the kernel cannot import Gate's daemon.)
 */

test('M4 a ferret bearer is admitted to the insights route as that ferret, the admin token as nobody', async () => {
  const w = world();
  const route = await declaredRoute('GET /v1/usage/insights');
  const asFerret = admit(w, route, { bearer: FERRET_TOKEN, arrival: local(true) });
  const asOwner = admit(w, route, { bearer: ADMIN, arrival: local() });
  if (asFerret.decision.outcome !== 'admitted' || asOwner.decision.outcome !== 'admitted')
    throw new Error('expected both callers admitted');
  expect(ferretOf({ credential: asFerret.decision.standing.credential, actor: asFerret.decision.standing.actor })).toBe(
    FERRET,
  );
  expect(
    ferretOf({ credential: asOwner.decision.standing.credential, actor: asOwner.decision.standing.actor }),
  ).toBeUndefined();
});
