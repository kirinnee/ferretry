import { type SessionForkNeeds, sessionForkModule } from '../../../../bin/modules/session-fork.ts';
import type { SessionForkSubsystem } from '../../../../src/lib/runtime/mounts/session-fork.ts';
import type { BuiltModule, ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';
import { transferModule } from '../../../../bin/modules/transfer.ts';

/**
 * THE `session-fork` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment (see `../learning/fixture.ts`).
 *
 * The REAL `sessionForkModule.build(needs, seams, lifecycle)` over test inputs, so the route snapshot and the contract
 * checks consume what production builds. Only the INPUTS are doubles, and every one of them REFUSES to be used: each port
 * answers any call with a throw naming it, because the build only captures its inputs and the fixture never sends a fork.
 * Building starts nothing — no timer, no file read, no async work — so there is nothing to leave behind in the shared unit
 * process (CI runs every non-PWA unit test in ONE process, and a leftover timer breaks `unit-determinism.test.ts`).
 *
 * The transfer ports are the real factory of the real transfer module (pure construction over a path that does not exist).
 */

/** A port that throws, naming itself, the moment any member of it is called. */
function refusing<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get: (_target, member) => () => {
      throw new Error(`${name}.${String(member)} is not exercised by the session-fork fixture`);
    },
  });
}

/** The inputs `fyd.ts` hands the module, over doubles. */
export function sessionForkNeedsForTest(overrides: Partial<SessionForkNeeds> = {}): SessionForkNeeds {
  const transfer = transferModule.build(
    {
      stateDirectory: '/nonexistent/session-fork-fixture-state-home',
      daemonId: 'session-fork-fixture-daemon',
      sessions: { get: async () => undefined },
    },
    undefined,
    LIFECYCLE,
  );
  return {
    storage: refusing('storage'),
    paths: refusing('paths'),
    attachmentStore: transfer.provides.store,
    attachmentOriginals: transfer.provides.originals,
    transferPorts: transfer.provides.transferPorts,
    transcriptSources: [],
    gateway: refusing('gateway'),
    accounts: async () => {
      throw new Error('accounts is not exercised by the session-fork fixture');
    },
    planner: refusing('planner'),
    harness: refusing('harness'),
    catalog: refusing('catalog'),
    createLifecycle: () => {
      throw new Error('createLifecycle is not exercised by the session-fork fixture');
    },
    transcripts: refusing('transcripts'),
    messageTokens: refusing('messageTokens'),
    redactor: refusing('redactor'),
    environment: refusing('environment'),
    runtime: refusing('runtime'),
    view: async () => undefined,
    ids: refusing('ids'),
    clock: refusing('clock'),
    ...overrides,
  };
}

const LIFECYCLE: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

/** The module as production builds it, over the fixture's inputs. */
export function builtSessionFork(): BuiltModule<SessionForkSubsystem> {
  return sessionForkModule.build(sessionForkNeedsForTest(), undefined, LIFECYCLE);
}
