import { describe, expect, test } from 'bun:test';
import { authenticate, bearerDigest } from '../../../../daemon/lib/api/authentication.ts';
import { SESSION_ID_HEADER } from '../../../../daemon/lib/api/admission.ts';
import { isFerretToken } from '../../../../contract/index.ts';
import { ADMIN, admit, carried, descriptor, FERRET, FERRET_TOKEN, fleetUse, local, world } from '../support.ts';

// The Gate half of the Appendix D rows the `fy` shell shares (P90, S52–S60). The shell's half (what it reads, orders,
// refuses to send) is tested in packages/cli; what a daemon does with the credential it is handed is pinned here,
// through Gate's own authentication and admission.

const person = (fields = {}) => descriptor({ caller: 'person', ...fields });
const STRANGER = `fys_${'A'.repeat(43)}`;
const ferretCall = { bearer: FERRET_TOKEN, arrival: local(true) };

describe('what the daemon does with the credential a shell presents', () => {
  test('P90 a remote daemon takes only its own admin token: no bearer and a wrong bearer are anonymous', () => {
    const w = world();
    expect(admit(w, fleetUse, { arrival: carried() }).outcome).toBe('401 unauthorized');
    expect(admit(w, fleetUse, { bearer: 'not-the-token', arrival: carried() }).outcome).toBe('401 unauthorized');
    const tokens = { admin: ADMIN } as never;
    expect(authenticate(tokens, undefined, { bearer: ADMIN, privilegedLocal: false })).toEqual({
      kind: 'authenticated',
      tokenClass: 'admin',
    });
    expect(authenticate(tokens, undefined, { bearer: 'not-the-token', privilegedLocal: false })).toEqual({
      kind: 'anonymous',
    });
  });

  test('S52 each presented bearer is classified as its own class: the admin token as admin, a fys_ token as its ferret', () => {
    const w = world();
    const admin = admit(w, fleetUse, { bearer: ADMIN, arrival: local() });
    const ferret = admit(w, fleetUse, ferretCall);
    if (admin.decision.outcome !== 'admitted' || ferret.decision.outcome !== 'admitted')
      throw new Error('expected admitted');
    expect(admin.decision.standing.credential).toMatchObject({ kind: 'authenticated', tokenClass: 'admin' });
    expect(ferret.decision.standing.credential).toEqual({
      kind: 'authenticated',
      tokenClass: 'ferret',
      ferret: FERRET,
    });
    expect(isFerretToken(FERRET_TOKEN)).toBe(true);
    expect(isFerretToken(ADMIN)).toBe(false);
  });

  test('S53 a fys_ bearer is a ferret on its own, with no session id header, and is never the admin token', () => {
    const w = world();
    const { decision } = admit(w, fleetUse, ferretCall);
    if (decision.outcome !== 'admitted') throw new Error('expected admitted');
    expect(decision.actor).toBe('ferret');
    expect(decision.standing.credential).not.toMatchObject({ tokenClass: 'admin' });
    // an unprefixed pane value is not a credential at all
    expect(isFerretToken(FERRET_TOKEN.slice('fys_'.length))).toBe(false);
  });

  test('S54 a refusal is final: the same call is refused the same way again, and the ferret never gains the admin token', () => {
    const w = world();
    const first = admit(w, person(), ferretCall);
    const again = admit(w, person(), ferretCall);
    expect(first.outcome).toBe('403 owner_only');
    expect(again.outcome).toBe(first.outcome);
    // a ferret token the directory does not know is a stranger's: 401, never promoted to anything else
    expect(admit(w, fleetUse, { bearer: STRANGER, arrival: local(true) }).outcome).toBe('401 unauthorized');
  });

  test('S57 a ferret token is looked up only on the privileged local listener, never from a carrier', () => {
    const w = world();
    expect(admit(w, fleetUse, { bearer: FERRET_TOKEN, arrival: local(true) }).outcome).toBe('admitted');
    expect(admit(w, fleetUse, { bearer: FERRET_TOKEN, arrival: local(false) }).outcome).toBe('401 unauthorized');
    expect(admit(w, fleetUse, { bearer: FERRET_TOKEN, arrival: carried() }).outcome).toBe('401 unauthorized');
    expect(bearerDigest(FERRET_TOKEN)).not.toContain(FERRET_TOKEN);
  });

  test("S58 the session id header keeps a pane's acts the ferret's: the admin token naming a session is refused on a person route", () => {
    const w = world();
    expect(
      admit(w, person(), { bearer: ADMIN, arrival: local(), headers: { [SESSION_ID_HEADER]: FERRET } }).outcome,
    ).toBe('403 owner_only');
    expect(admit(w, person(), { bearer: ADMIN, arrival: local() }).outcome).toBe('admitted');
  });

  test('S59 the daemon refuses a person route to a pane again with 403 owner_only, before the body is read', () => {
    const w = world();
    const { outcome, call } = admit(w, person(), ferretCall);
    expect(outcome).toBe('403 owner_only');
    expect(call.bodyRead()).toBe(false);
  });

  test('S60 the admin token with no session named is the owner: why FY_TOKEN in a pane silently takes a ferret off its own credential', () => {
    const w = world();
    const { decision } = admit(w, person(), { bearer: ADMIN, arrival: local() });
    expect(decision.outcome).toBe('admitted');
    // the ferret's own credential on the same route is refused: the two are not interchangeable
    expect(admit(w, person(), ferretCall).outcome).toBe('403 owner_only');
  });
});
