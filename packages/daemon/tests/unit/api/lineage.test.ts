import { describe, it } from 'bun:test';
import should from 'should';
import { ApiError } from '../../../src/lib/api/error.ts';
import { lineageOf } from '../../../src/lib/api/lineage.ts';
import type { RouteContext } from '../../../src/lib/api/route.ts';
import { request } from './support.ts';

/** The lineage rule on a route context, by who the boundary says is calling. */

const contextOf = (overrides: Partial<RouteContext>): RouteContext =>
  ({ request: request(), params: new Map(), ...overrides }) as RouteContext;

const DEVICE = {
  actor: 'device:d1',
  credential: { kind: 'authenticated', tokenClass: 'device', deviceId: 'd1' },
} as const;

describe('the parent a started session gets', () => {
  it('should leave a paired device untouched, whether or not the request carries a session header', () => {
    // Arrange
    const bare = contextOf(DEVICE);
    const headed = contextOf({ ...DEVICE, request: request({ headers: { 'x-ferretry-session-id': 'ferret-own' } }) });

    // Act + Assert — a device names any parent or none; the header is not read for it.
    should(lineageOf(bare, {})).eql({});
    should(lineageOf(bare, { parent: 'someone-else' })).eql({ parent: 'someone-else' });
    should(lineageOf(headed, {})).eql({});
    should(lineageOf(headed, { parent: 'someone-else' })).eql({ parent: 'someone-else' });
  });

  it('should refuse a session id that is not one with a 400, not an opaque failure', () => {
    // Arrange
    const odd = contextOf({
      actor: 'peer:Foo Bar',
      credential: { kind: 'authenticated', tokenClass: 'admin' },
    });

    // Act
    const refusal = (() => {
      try {
        lineageOf(odd, {});
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    // Assert
    should(refusal).be.instanceOf(ApiError);
    should((refusal as ApiError).status).equal(400);
    should((refusal as ApiError).code).equal('invalid_session_id');
  });

  it('should word a mismatch as read from the session, which an admin token with a header has no credential for', () => {
    // Arrange
    const ferret = contextOf({ actor: 'peer:ferret-own', credential: { kind: 'authenticated', tokenClass: 'admin' } });

    // Act + Assert
    should(() => lineageOf(ferret, { parent: 'someone-else' })).throw(/from your session/u);
  });
});
