import { SystemClock } from '../../../../src/adapters/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../../src/lib/index.ts';
import type { BuiltModule, ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';
import {
  type SessionMigrateSubsystem,
  sessionMigrateContribution,
} from '../../../../src/lib/runtime/mounts/session-migrate.ts';
import {
  type SessionMigrateNeeds,
  type SessionMigrateProvides,
  sessionMigrateModule,
} from '../../../../bin/modules/session-migrate.ts';

/**
 * THE `session-migrate` MODULE'S TEST CONSTRUCTION — a per-module fragment (see `../learning/fixture.ts`).
 *
 * The REAL `sessionMigrateModule.build(needs, seams, lifecycle)` over test inputs, so the route snapshot and the contract
 * checks consume what production builds. Only the INPUTS are doubles: a state home that does not exist, and ports that
 * REFUSE to be used (each answers any call with a throw naming it, because the build only captures its inputs and the
 * fixture never moves a session). Building starts nothing — the process probe is lazy, the report store, the conversation
 * files and the checks are constructed over their inputs and read nothing — so there is nothing to leave behind in the
 * shared unit process (CI runs every non-PWA unit test in ONE process, and a leftover timer breaks
 * `unit-determinism.test.ts`).
 */

/** A state home that does not exist: every session directory is a path nothing reads. */
const FIXTURE_HOME = '/nonexistent/session-migrate-fixture-state-home';

/** A port that throws, naming itself, the moment any member of it is called. */
function refusing<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get: (_target, member) => () => {
      throw new Error(`${name}.${String(member)} is not exercised by the session-migrate fixture`);
    },
  });
}

/** The inputs `fyd.ts` hands the module, over doubles. */
export function sessionMigrateNeedsForTest(overrides: Partial<SessionMigrateNeeds> = {}): SessionMigrateNeeds {
  return {
    paths: createFoundationPaths(resolveStateHome({ fyHome: FIXTURE_HOME, homeDirectory: '/unused' })),
    storage: refusing('storage'),
    sessions: refusing('sessions'),
    resume: refusing('resume'),
    preflight: refusing('preflight'),
    askAgent: async () => {
      throw new Error('askAgent is not exercised by the session-migrate fixture');
    },
    planner: refusing('planner'),
    accounts: refusing('accounts'),
    executables: refusing('executables'),
    clock: new SystemClock(),
    createTranscriptReader: () => refusing('transcripts'),
    transcriptProvenance: refusing('transcriptProvenance'),
    codexRollouts: refusing('codexRollouts'),
    locateHarness: () => undefined,
    readableHandoffs: () => [],
    fixedSettings: async () => undefined,
    paneIdentity: async () => undefined,
    createSessionLaunch: () => refusing('launch'),
    clientName: 'fy',
    ...overrides,
  };
}

const LIFECYCLE: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

/** The module as production builds it, over the fixture's inputs. */
export function builtSessionMigrate(): BuiltModule<SessionMigrateProvides> {
  return sessionMigrateModule.build(sessionMigrateNeedsForTest(), undefined, LIFECYCLE);
}

/**
 * The module's contribution over a migration subsystem the TEST owns: the same four routes and the same audit rule the real
 * build contributes, driving the test's subsystem instead of the refusing doubles — for a test that dispatches a migrate.
 */
export function builtSessionMigrateOver(subsystem: SessionMigrateSubsystem): BuiltModule<SessionMigrateSubsystem> {
  return {
    id: 'sessionMigrate',
    provides: subsystem,
    jobs: {},
    contributes: sessionMigrateContribution(subsystem),
  };
}
