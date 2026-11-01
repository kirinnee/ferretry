import { describe, it } from 'bun:test';
import should from 'should';
import { callerIsAgent } from '../../../src/lib/api/agent-caller.ts';
import type { AuthenticatedCredential } from '../../../src/lib/api/authentication.ts';

/**
 * The ONE answer to "is this caller a ferret or a person?" — the boundary refuses an agent on a person
 * route with it, and every handler's second line asks it too.
 */
describe('callerIsAgent', () => {
  const ADMIN: AuthenticatedCredential = { kind: 'authenticated', tokenClass: 'admin' };
  const SESSION: AuthenticatedCredential = { kind: 'authenticated', tokenClass: 'session', sessionId: 's1' };
  const WARDEN: AuthenticatedCredential = { kind: 'authenticated', tokenClass: 'warden' };
  const DEVICE: AuthenticatedCredential = { kind: 'authenticated', tokenClass: 'device', deviceId: 'd1' };

  const cases: readonly (readonly [string, AuthenticatedCredential | undefined, string | undefined, boolean])[] = [
    ['a ferret’s own credential', SESSION, 'peer:s1', true],
    // Keyed on the CLASS: even an actor that reads as the owner's CLI does not make a session a person.
    ['a ferret’s own credential, whatever its actor says', SESSION, 'admin-cli', true],
    ['a warden', WARDEN, 'warden:w1', true],
    ['the admin token naming a ferret’s session', ADMIN, 'peer:s1', true],
    ['the admin token naming a warden’s session', ADMIN, 'warden:w1', true],
    ['the owner’s CLI', ADMIN, 'admin-cli', false],
    ['the app at the machine', ADMIN, 'admin-ui', false],
    ['a paired device', DEVICE, 'device:d1', false],
    ['a public route’s caller', undefined, undefined, false],
  ];

  for (const [who, credential, actor, agent] of cases) {
    it(`should answer ${agent ? 'agent' : 'person'} for ${who}`, () => {
      // Act / Assert
      should(callerIsAgent(credential, actor)).equal(agent);
    });
  }
});
