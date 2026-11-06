import { join } from 'node:path';
import { PASSIVE_LEARNING_ENV } from '@ferretry/fleet';
import type { AnalyticsPricingRate, LearningConfig } from '@ferretry/protocol';
import { KeyedSerialExecutor } from '../../src/adapters/atomic-file/index.ts';
import {
  CatalogPrices,
  ConfigFileLearningSettings,
  DirectoryLessonSessions,
  FileLearningStore,
  FleetGlobalLessons,
  LEARNING_MINER_LABEL,
  LearningMiner,
  NodeLessonFiles,
  SessionPassiveChannel,
} from '../../src/adapters/learning/index.ts';
import {
  type CredentialAgentIdentities,
  type FoundationPaths,
  LessonsService,
  type LearningSubsystem,
  type SessionControlSubsystem,
  type SessionDirectorySubsystem,
  type SessionTranscriptReader,
  learningContribution,
} from '../../src/lib/index.ts';
import type { StateFileSystem, SystemClock } from '../../src/adapters/index.ts';
import type { ConfigFilesService } from '../../src/lib/config-files/index.ts';
import type { DaemonModule } from '../../src/lib/runtime/modules.ts';

/**
 * A MODULE FILE — what one of these owns, for the next builder.
 *
 * `bin/modules/<id>.ts` is one feature's wiring: the `create*` helper that assembles its services from adapters
 * (`src/adapters/<id>`) and domain code (`src/lib/<id>`), and the `DaemonModule` that `fyd.ts` builds with one
 * `<id>Module.build(needs, seamsOf.<id>(world), lifecycle)` line — no `await`, `build` is synchronous — at the point in
 * `createSubsystems` where the feature was constructed before. It owns four things and nothing else:
 *
 * - `Seams`: the production adapters a test may replace, read from the EFFECTIVE `DaemonWorld` by `seamsOf.<id>`
 *   in `./seams.ts`. A module never reads the world itself.
 * - `Needs`: everything else it takes, typed, in `fyd.ts`'s own words — the opened storage, decided configuration,
 *   and the `provides` of the modules it depends on. Nothing is looked up by name, and a module imports another
 *   module only with `import type`. A value built by a module constructed LATER arrives as a `LateBound<T>`.
 * - `provides`: what other modules and `fyd.ts` may use of it (here the `LearningSubsystem`).
 * - `jobs` and `contributes`: the jobs `start()` arms (each with its own signature, armed on the line `start()`
 *   already had) and the routes, sockets, audit rules and protocol feature names it adds to the daemon.
 *
 * A job that starts WHILE the subsystem is built stays inside `build` at the same point, and a release is
 * registered through `lifecycle.onRelease` at the moment it was registered before. EXTRACTING IS MOVING: the body
 * of `build` is the old construction, statement for statement. This module has no jobs and no releases.
 *
 * Its tests live beside it, one fragment per module: `tests/unit/modules/<id>/route-contract.ts` (who may call each
 * route) and `tests/unit/modules/<id>/fixture.ts` (the REAL `build` over test inputs, registered in
 * `tests/unit/modules/fixtures.ts`), so the surface tests consume what production builds.
 */

/** The production adapters a test may replace: the user home the lessons' global instructions resolve against. */
export interface LearningSeams {
  readonly userHome: string;
}

/** What the learning subsystem is built from, beyond the state home's own learning directory. */
export interface LearningNeeds {
  readonly paths: FoundationPaths;
  readonly files: StateFileSystem;
  readonly clock: SystemClock;
  readonly sessions: SessionDirectorySubsystem;
  readonly transcripts: SessionTranscriptReader;
  readonly sessionControl: SessionControlSubsystem;
  readonly config: () => LearningConfig;
  readonly configFiles: ConfigFilesService;
  readonly identities: CredentialAgentIdentities;
  /** The name of the CLI a human drives, which a lesson tells a ferret to run. */
  readonly binaryName: string;
  /** A ferret's launch environment, merged under that session's own lock. */
  readonly mergeEnvironment: (sessionId: string, variables: Readonly<Record<string, string>>) => Promise<void>;
  /** A queued, non-interrupting send. */
  readonly send: (sessionId: string, message: string, sendId: string) => Promise<void>;
  readonly pricing: () => Promise<readonly AnalyticsPricingRate[]>;
}

/**
 * The learning review board, passive lessons, Apply and the explicit scan.
 *
 * Apply writes outside the state home — the fleet's global lessons document under the asset tree, or a
 * project's AGENTS.md / CLAUDE.md — through `NodeLessonFiles`, and only after the route authorized it.
 */
function createLearningSubsystem(needs: LearningNeeds, seams: LearningSeams): LearningSubsystem {
  const { paths, files, clock, config } = needs;
  // The learning review board, over the state home's own `learning/` directory.
  //
  // ONE executor for the whole process, keyed on the board: a verdict is a read-decide-rewrite of a
  // single JSON snapshot, so two landing together would otherwise lose one. The key is a constant
  // because there is exactly one board per state home — unlike the task boards, which are per session.
  // Its own executor: a learning verdict must not queue behind another document's transaction, and the
  // snapshots share no file.
  const serial = new KeyedSerialExecutor();
  const store = new FileLearningStore(paths, files, clock);
  const now = () => clock.now();
  const miner = new LearningMiner(
    paths,
    files,
    store,
    needs.sessions,
    needs.transcripts,
    needs.sessionControl,
    config,
    now,
  );
  const settings = new ConfigFileLearningSettings(needs.configFiles);
  const lessons = new LessonsService({
    store,
    sessions: new DirectoryLessonSessions(needs.sessions, needs.transcripts),
    files: new NodeLessonFiles(),
    global: new FleetGlobalLessons({
      assetsDirectory: join(paths.fleet, 'assets'),
      userHome: seams.userHome,
      model: () => needs.configFiles.current().evaluation.effective.model,
      writeComponent: async file => await settings.writeLessonsComponent(file),
    }),
    passive: new SessionPassiveChannel({
      variable: PASSIVE_LEARNING_ENV,
      mergeEnvironment: needs.mergeEnvironment,
      send: needs.send,
    }),
    miner,
    prices: new CatalogPrices(needs.pricing, now),
    config,
    now,
    binaryName: needs.binaryName,
    minerLabel: LEARNING_MINER_LABEL,
  });
  return {
    store,
    transaction: async work => await serial.run('learning', work),
    config,
    now,
    run: async spawn => await miner.run(spawn),
    lessons,
    identities: needs.identities,
    writeConfig: async patch => await settings.writePassiveDefault(patch.passiveDefault),
  };
}

export const learningModule: DaemonModule<LearningSeams, LearningNeeds, LearningSubsystem> = {
  id: 'learning',
  build: (needs, seams) => {
    const subsystem = createLearningSubsystem(needs, seams);
    return {
      id: 'learning',
      provides: subsystem,
      jobs: {},
      contributes: learningContribution(subsystem),
    };
  },
};
