import { StateFileSystem, SystemClock } from '../../../../src/adapters/index.ts';
import type { ConfigFilesService } from '../../../../src/lib/config-files/index.ts';
import {
  type CredentialAgentIdentities,
  createFoundationPaths,
  type LearningSubsystem,
  resolveStateHome,
} from '../../../../src/lib/index.ts';
import type { BuiltModule, ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';
import type { SessionTranscriptReader } from '../../../../src/lib/session/transcript/reader.ts';
import { learningModule, type LearningNeeds, type LearningSeams } from '../../../../bin/modules/learning.ts';
import { FakeSessionControl, LEARNING_CONFIG, sessionDirectory } from '../../runtime/mounts/support.ts';

/**
 * THE `learning` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment.
 *
 * The mounted-surface fixture (`../../runtime/mounts/surface-world.ts`) never reconstructs an extracted module by
 * hand: it asks `./fixtures.ts`, which asks each module's own `fixture.ts` (this file) to run the REAL
 * `learningModule.build(needs, seams, lifecycle)` over test inputs. So a route snapshot, a caller or audit
 * completeness check, or a dispatch proof that consumes this module is consuming what production builds: delete
 * `contributes.routes` from the real build and those checks fail. A later change to the module edits this file and
 * the module's own files, not the shared fixture.
 *
 * Only the INPUTS are doubles: an empty state home nothing was ever written to, the shared in-memory session
 * directory and session control, and ports that fail loudly if a surface test reaches one it never meant to.
 */

/** A state home that does not exist: every read answers "not there", and a write would be refused as missing. */
const FIXTURE_HOME = '/nonexistent/learning-fixture-state-home';

const NOT_EXERCISED = (what: string) => () => {
  throw new Error(`${what} is not exercised by the mounted-surface fixture`);
};

/** The inputs `fyd.ts` hands the module, over doubles. */
function learningNeeds(): LearningNeeds {
  const paths = createFoundationPaths(resolveStateHome({ fyHome: FIXTURE_HOME, homeDirectory: '/unused' }));
  return {
    paths,
    files: new StateFileSystem(paths),
    clock: new SystemClock(),
    sessions: sessionDirectory(),
    transcripts: {
      read: NOT_EXERCISED('a transcript read'),
    } as unknown as SessionTranscriptReader,
    sessionControl: new FakeSessionControl(),
    config: () => LEARNING_CONFIG,
    configFiles: { current: NOT_EXERCISED('the configuration files') } as unknown as ConfigFilesService,
    identities: { resolve: async () => undefined } as unknown as CredentialAgentIdentities,
    binaryName: 'fy',
    mergeEnvironment: async () => undefined,
    send: async () => undefined,
    pricing: async () => [],
  };
}

/** The seams `seamsOf.learning` would read from the effective world. */
function learningSeams(): LearningSeams {
  return { userHome: '/nonexistent/learning-fixture-user-home' };
}

const LIFECYCLE: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

/** The module as production builds it, over the fixture's inputs. */
export function builtLearning(): BuiltModule<LearningSubsystem> {
  return learningModule.build(learningNeeds(), learningSeams(), LIFECYCLE);
}
