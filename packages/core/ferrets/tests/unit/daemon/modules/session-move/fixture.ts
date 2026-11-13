import { MemoryStateFolder, fixedClock } from '@ferretry/kernel/testing';
import { MoveInflightFiles } from '../../../../../contract/move-state.ts';
import type { SessionMoveNeeds } from '../../../../../daemon/modules/session-move.ts';
import { testToolkit } from '../../../../support/daemon/move-toolkit.ts';

/**
 * THE `session-move` MODULE'S TEST CONSTRUCTION.
 *
 * The REAL `sessionMoveModule.build(needs, seams, lifecycle)` over test inputs, so the route snapshot and the contract
 * checks consume what production builds. Only the INPUTS are doubles: a memory state folder holding no report, and ports
 * that REFUSE to be used (each answers any call with a throw naming it, because the build only captures its inputs and
 * the fixture never moves a session). Building starts nothing — the process probe is lazy, the report store, the
 * conversation files and the checks are constructed over their inputs and read nothing — so there is nothing to leave
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
    roots: refusing('roots'),
    spawn: refusing('spawn'),
    host: refusing('host'),
    clock: fixedClock(),
    storage: refusing('storage'),
    sessions: refusing('sessions'),
    resume: refusing('resume'),
    launch: refusing('launch'),
    preflight: refusing('preflight'),
    askAgent: async () => {
      throw new Error('askAgent is not exercised by the session-move fixture');
    },
    planner: refusing('planner'),
    sessionDirectory: id => `/nonexistent/session-move-fixture/${id}`,
    conversationId: () => 'fixture-conversation-id',
    accounts: refusing('accounts'),
    accountResolver: refusing('accountResolver'),
    transcripts: refusing('transcripts'),
    transcriptProvenance: refusing('transcriptProvenance'),
    codexRollouts: refusing('codexRollouts'),
    toolkit: testToolkit(),
    conversionCheck: refusing('conversionCheck'),
    harnessVersion: refusing('harnessVersion'),
    rolloutFormat: refusing('rolloutFormat'),
    locateHarness: () => undefined,
    readableHandoffs: () => [],
    paneIdentity: async () => undefined,
    persistedReasoningEffort: async () => undefined,
    contextWindowForSession: () => 200_000,
    signals: refusing('signals'),
    clientName: 'fy',
    ...overrides,
  };
}
