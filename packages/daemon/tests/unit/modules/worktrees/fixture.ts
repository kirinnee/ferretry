import type { CatalogSubsystem } from '../../../../src/lib/runtime/mounts/catalogs.ts';
import type {
  ManagedWorktreeOperations,
  ManagedWorktreeRegistry,
  ManagedWorktreeService,
  SessionDirectorySubsystem,
  TerminalRuntimePort,
} from '../../../../src/lib/index.ts';
import type { BuiltModule, ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';
import { type WorktreesNeeds, worktreesModule } from '../../../../bin/modules/worktrees.ts';

/**
 * THE `worktrees` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment (see `../learning/fixture.ts`).
 *
 * The REAL `worktreesModule.build(needs, seams, lifecycle)` over test inputs, so the route snapshot and the contract
 * checks consume what production builds. Only the INPUTS are doubles: a registry, Git operations, a session
 * directory, a terminal runtime and a catalogue that nothing here asks anything of. Building starts nothing — the
 * service is inert until a request — so there is no timer or async work to leave behind in the shared unit process.
 */

const NOT_EXERCISED = (what: string) => () => {
  throw new Error(`${what} is not exercised by the mounted-surface fixture`);
};

/** The inputs `fyd.ts` hands the module, over doubles. */
function worktreesNeeds(): WorktreesNeeds {
  return {
    composition: {
      operations: {} as unknown as ManagedWorktreeOperations,
      registry: {} as unknown as ManagedWorktreeRegistry,
      managedRoot: undefined,
    },
    sessions: { list: NOT_EXERCISED('the session directory') } as unknown as Pick<SessionDirectorySubsystem, 'list'>,
    terminals: { list: NOT_EXERCISED('the terminal runtime') } as unknown as Pick<TerminalRuntimePort, 'list'>,
    catalogs: { projects: NOT_EXERCISED('the project catalogue') } as unknown as Pick<CatalogSubsystem, 'projects'>,
    clock: { nowIso: () => '1970-01-01T00:00:00.000Z' },
  };
}

const LIFECYCLE: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

/** The module as production builds it, over the fixture's inputs. */
export function builtWorktrees(): BuiltModule<ManagedWorktreeService> {
  return worktreesModule.build(worktreesNeeds(), undefined, LIFECYCLE);
}
