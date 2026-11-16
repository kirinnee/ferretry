/**
 * A `fy` released before 5.0, running in a ferret's pane, decides from `GET /v1/health` whether to present the ferret's
 * own credential, and after a `401` whether to fall back to the host's admin token (kac2 R6 note). This daemon's health
 * must never read as "an older daemon" to that rule: its `401` is the answer. Only health that PROVES an older daemon
 * (no `session.credential.1`) leaves the older CLI its fallback.
 */
import { describe, expect, test } from 'bun:test';
import { HealthSchema, SESSION_CREDENTIAL_FEATURE } from '../../../contract/kernel.ts';
import { type KernelHalfSources, kernelRoutes } from '../../../host/kernel-half.ts';

/**
 * The older CLI's rule, copied as an oracle from today's `cli/src/lib/daemon/credential.ts`
 * (`presentsSessionBearer`, `mayFallBackAfterRefusal`) and its health reader (`features ?? []`).
 */
const olderCli = {
  facts: (health: unknown) => ({ features: (health as { readonly features?: readonly string[] }).features ?? [] }),
  presentsSessionBearer: (facts: { readonly features: readonly string[] }) =>
    facts.features.includes('session.credential.1'),
  mayFallBackAfterRefusal: (status: number, fresh: { readonly features: readonly string[] }) =>
    status === 401 && !olderCli.presentsSessionBearer(fresh),
};

/** This daemon's own `GET /v1/health` answer: the handler needs nothing but the version. */
async function health(): Promise<unknown> {
  const routes = kernelRoutes({ version: '5.0.0', config: {} } as unknown as KernelHalfSources);
  const response = await routes['GET /v1/health']({} as never);
  expect(response.status).toBe(200);
  return JSON.parse(response.body);
}

describe('a fy from before 5.0 never opens the admin token against this daemon', () => {
  test('R-0097 health lists session.credential.1, and still parses as this release’s health', async () => {
    const answer = await health();
    expect(SESSION_CREDENTIAL_FEATURE).toBe('session.credential.1');
    expect(answer).toEqual({ protocol: expect.any(Number), version: '5.0.0', features: [SESSION_CREDENTIAL_FEATURE] });
    expect(HealthSchema.safeParse(answer).success).toBe(true);
    // A daemon or a test double that leaves the list out is still a daemon to this release's own readers.
    expect(HealthSchema.safeParse({ protocol: (answer as { protocol: number }).protocol, version: 'x' }).success).toBe(
      true,
    );
  });

  test('R-0097 a current daemon’s 401: the older CLI presents the ferret credential and does NOT fall back', async () => {
    const facts = olderCli.facts(await health());
    expect(olderCli.presentsSessionBearer(facts)).toBe(true);
    for (const status of [401, 403, 404, 500]) expect(olderCli.mayFallBackAfterRefusal(status, facts)).toBe(false);
  });

  test('R-0097 an older daemon PROVEN by its health (no feature listed) still allows the older CLI’s fallback, on a 401 only', () => {
    const older = olderCli.facts({ protocol: 1, version: '4.9.0' });
    expect(olderCli.presentsSessionBearer(older)).toBe(false);
    expect(olderCli.mayFallBackAfterRefusal(401, older)).toBe(true);
    for (const status of [403, 404, 500]) expect(olderCli.mayFallBackAfterRefusal(status, older)).toBe(false);
  });
});
