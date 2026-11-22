import { describe, expect, test } from 'bun:test';
import { DEFAULT_GATE_CONFIG, DEFAULT_GATE_SECURITY } from '../../../../contract/index.ts';
import { admit, fleetConfigure, world } from '../support.ts';

/**
 * L129. A window-0 step-up is spent by the admission that rode on it, and that admission's standing keeps the right to
 * take the proof it was admitted with (`spentAtAdmission`). The right is the admitting REQUEST's: it ends when that
 * request settles, even while the carrying session stays open, so work the call spawns and a later claim of the same
 * standing take nothing.
 *
 * Every request here has the PRODUCTION signal shape (`support.ts` `request`): one session signal shared by all the
 * session's requests, joined with the request's own settle. A device (the only caller with a step-up subject) always
 * arrives on a session, so a test that gave each request nothing but its own controller would hide the case.
 */

const windowZero = {
  ...DEFAULT_GATE_CONFIG,
  security: { ...DEFAULT_GATE_SECURITY, stepUpOnActions: true, stepUpWindowMinutes: 0 },
};
const SUBJECT = { deviceId: 'phone', appSession: 's-phone' };

function setup() {
  const w = world({ policy: windowZero });
  w.enrol('phone');
  const session = new AbortController();
  const admitRequest = () => {
    w.stepUps.grant(SUBJECT);
    const { decision, call } = admit(w, fleetConfigure, { device: 'phone', session: session.signal });
    if (decision.outcome !== 'admitted') throw new Error('expected admitted');
    return { standing: decision.standing, settle: call.settle };
  };
  return { admitRequest, session };
}

describe('a step-up spend lasts only for its own request (L129)', () => {
  test('a claim made inside the admitting request takes the proof it was admitted with, once', () => {
    const { admitRequest } = setup();
    const { standing } = admitRequest();
    expect(standing.claimFreshStepUp?.()).toBe(true);
    expect(standing.claimFreshStepUp?.()).toBe(false);
  });

  test('normal completion: once A is answered, a continuation claim answers false with the session still open', () => {
    const { admitRequest, session } = setup();
    const { standing, settle } = admitRequest();
    settle();
    expect(session.signal.aborted).toBe(false);
    expect(standing.claimFreshStepUp?.()).toBe(false);
  });

  test('a claim made before the request settled took the proof; the one after it takes nothing', () => {
    const { admitRequest, session } = setup();
    const { standing, settle } = admitRequest();
    expect(standing.claimFreshStepUp?.()).toBe(true);
    settle();
    expect(session.signal.aborted).toBe(false);
    expect(standing.claimFreshStepUp?.()).toBe(false);
  });

  test('error completion: a handler that failed settles the request the same way', () => {
    const { admitRequest, session } = setup();
    const { standing, settle } = admitRequest();
    try {
      throw new Error('the handler failed');
    } catch {
      settle(); // the session layer settles in `finally`, answered or failed
    }
    expect(session.signal.aborted).toBe(false);
    expect(standing.claimFreshStepUp?.()).toBe(false);
  });

  test("the session ending ends the right too, and one request settling leaves the session's next request its own", () => {
    const { admitRequest, session } = setup();
    const first = admitRequest();
    first.settle();
    const second = admitRequest();
    expect(second.standing.claimFreshStepUp?.()).toBe(true);
    const third = admitRequest();
    session.abort();
    expect(third.standing.claimFreshStepUp?.()).toBe(false);
  });
});
