import { MemoryStateFolder, fixedClock } from '@ferretry/kernel/testing';
import { MoveInflightFiles } from '../../../../../contract/state/moves.state.ts';
import type { SessionMoveNeeds } from '../../../../../daemon/modules/session-move.ts';

/**
 * THE `session-move` MODULE'S TEST CONSTRUCTION.
 *
 * The REAL `sessionMoveModule.build(needs, seams, lifecycle)` over test inputs, so the route snapshot and the contract
 * checks consume what production builds. Only the INPUTS are doubles: a memory state folder holding no report, and ports
 * that REFUSE to be used (each answers any call with a throw naming it, because the build only captures its inputs and
 * the fixture never moves a session). Building starts nothing — the process probe is lazy and the report store is
 * constructed over its input and reads nothing — so there is nothing to leave
 * behind in the shared unit process (CI runs every non-PWA unit test in ONE process, and a leftover timer breaks
 * `unit-determinism.test.ts`).
 */

/** A port that throws, naming itself, the moment any member of it is called. */
function refusing<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get: (_target, member) => () => {
      throw new Error(`${name}.${String(member)} is not exercised by the session-move fixture`);
    },
  });
}

/** The inputs the host hands the module, over doubles. */
export function sessionMoveNeedsForTest(overrides: Partial<SessionMoveNeeds> = {}): SessionMoveNeeds {
  return {
    state: new MemoryStateFolder().port([MoveInflightFiles]),
    spawn: refusing('spawn'),
    host: refusing('host'),
    clock: fixedClock(),
    log: { warn: () => {} },
    storage: refusing('storage'),
    sessions: refusing('sessions'),
    launch: refusing('launch'),
    preflight: refusing('preflight'),
    pane: () => refusing('pane'),
    restart: refusing('restart'),
    login: refusing('login'),
    askAgent: async () => {
      throw new Error('askAgent is not exercised by the session-move fixture');
    },
    transcripts: refusing('transcripts'),
    paneIdentity: async () => undefined,
    signals: refusing('signals'),
    ...overrides,
  };
}
