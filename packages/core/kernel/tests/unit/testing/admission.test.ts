import { describe, expect, test } from 'bun:test';
import type { ApiRequest } from '../../../contract/http.ts';
import type { ScopedRoute } from '../../../contract/route.ts';
import {
  device,
  ferret,
  owner,
  standInAdmission,
  type TestCaller,
  type TestTokenClass,
  tokenClassOf,
  warden,
} from '../../../testing/admission.ts';

/** Today's dispatcher function, verbatim (rebuild-ref packages/daemon/src/lib/api/dispatcher.ts), as the oracle. */
function todaysMeetsMinimum(tokenClass: TestTokenClass, minimum: ScopedRoute['minimum']): boolean {
  switch (minimum) {
    case 'none':
    case 'authenticated':
      return true;
    case 'operator':
      return tokenClass !== 'warden';
    case 'admin-token':
      return tokenClass === 'admin';
  }
}

const MINIMUMS: readonly ScopedRoute['minimum'][] = ['none', 'authenticated', 'operator', 'admin-token'];
const CALLERS: readonly TestCaller[] = [owner(), ferret('f-1'), device('phone'), warden(['restart'])];

function decide(caller: TestCaller, minimum: ScopedRoute['minimum']): string {
  const admission = standInAdmission(() => caller);
  const descriptor = { minimum, caller: 'any', wardenRemedy: 'restart' } as unknown as ScopedRoute;
  const request = { method: 'GET', path: '/v1/accounts/hint', arrival: { kind: 'carried' } } as unknown as ApiRequest;
  return admission.admit({ table: 'route', descriptor, request, params: {} as never }).outcome;
}

describe('the Admission stand-in: the minimum is today’s meetsMinimum', () => {
  for (const minimum of MINIMUMS)
    for (const caller of CALLERS)
      test(`${minimum} x ${caller.kind}`, () => {
        const tokenClass = tokenClassOf(caller);
        if (tokenClass === undefined) throw new Error('every listed caller presents a credential');
        expect(decide(caller, minimum)).toBe(todaysMeetsMinimum(tokenClass, minimum) ? 'admitted' : 'refused');
      });

  test('a ferret reaches an operator route with caller any (GET /v1/accounts/hint)', () => {
    expect(decide(ferret('f-1'), 'operator')).toBe('admitted');
  });
});
