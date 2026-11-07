import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { HandoverFiles } from '../../../../../contract/handover-state.ts';
import type { SessionHandoverNeeds } from '../../../../../daemon/modules/session-handover.ts';

/**
 * THE `session-handover` MODULE'S TEST CONSTRUCTION.
 *
 * The REAL `sessionHandoverModule.build(needs, seams, lifecycle)` over test inputs, so the route snapshot and the
 * contract checks consume what production builds. Only the INPUTS are doubles: a memory state folder holding no
 * receipt, and ports that REFUSE to be used (each answers any call with a throw naming it, because the build only
 * captures its inputs and the fixture never begins a handover). Building starts nothing — the reconcile loop's timers
 * are created by `jobs.arm()` on the injected `every`, which the fixture arms only where a case says so.
 */

/** A port that throws, naming itself, the moment any member of it is called. */
function refusing<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get: (_target, member) => () => {
      throw new Error(`${name}.${String(member)} is not exercised by the session-handover fixture`);
    },
  });
}

/** The inputs the host hands the module, over doubles. */
export function sessionHandoverNeedsForTest(overrides: Partial<SessionHandoverNeeds> = {}): SessionHandoverNeeds {
  return {
    state: new MemoryStateFolder().port([HandoverFiles]),
    storage: refusing('storage'),
    sessions: refusing('sessions'),
    startAccount: async () => {
      throw new Error('startAccount is not exercised by the session-handover fixture');
    },
    planner: refusing('planner'),
    clock: { now: () => '2026-02-01T00:00:00.000Z' },
    every: () => {
      throw new Error('the reconcile timer is not armed by the session-handover fixture');
    },
    ...overrides,
  };
}
