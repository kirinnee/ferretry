import { expect, test } from 'bun:test';
import { ferretOf } from '../../../contract/index.ts';
import { ADMIN, admit, declaredRoute, FERRET, FERRET_TOKEN, local, world } from './support.ts';

/**
 * Audit A fix 7, the Gate half. Asks narrows what a ferret reads of a Warden notice from `ferretOf(call)`: its own lineage's as
 * fixed sentences, another lineage's not at all. This runs the REAL `GateAdmission` over the six per-ferret board reads as the
 * shipped Asks manifest declares them (`caller: any`, v4 parity — who may read a board in general is unchanged): each admits a
 * ferret bearer AS THAT ferret, so the projection's caller is the credential's, and the admin token as nobody, so the owner reads
 * whole. (The kernel host test `core/kernel/tests/integration/host/asks-warden-ferret-reads.test.ts` composes the real Ferrets,
 * Asks and Warden halves behind the stand-in admission, whose `ferretStanding` has this same shape.)
 */

const BOARD_READS = [
  'GET /v1/ferrets/:ferretId/agenda',
  'GET /v1/ferrets/:ferretId/agenda/:id',
  'GET /v1/ferrets/:ferretId/agenda/:id/conversation',
  'GET /v1/ferrets/:ferretId/agenda/:id/versions',
  'GET /v1/ferrets/:ferretId/agenda/:id/versions/:version',
] as const;

for (const key of BOARD_READS) {
  test(`audit A fix 7 ${key} admits a ferret bearer as that ferret and the admin token as nobody`, async () => {
    const w = world();
    const route = await declaredRoute(key);
    expect(route.caller).toBe('any');
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

test('audit A fix 7 the board write answers with a board too, so it admits a ferret as that ferret', async () => {
  const w = world();
  const route = await declaredRoute('POST /v1/ferrets/:ferretId/agenda');
  const asFerret = admit(w, route, { bearer: FERRET_TOKEN, arrival: local(true) });
  if (asFerret.decision.outcome !== 'admitted')
    throw new Error('expected the ferret bearer admitted to the board write');
  expect(ferretOf({ credential: asFerret.decision.standing.credential, actor: asFerret.decision.standing.actor })).toBe(
    FERRET,
  );
});
