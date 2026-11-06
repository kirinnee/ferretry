import { sharedDraftsModule, type SharedDraftsNeeds } from '../../../../bin/modules/shared-drafts.ts';
import { StateFileSystem } from '../../../../src/adapters/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../../src/lib/index.ts';
import type { FileSystemPort } from '../../../../src/lib/index.ts';
import type { BuiltModule, ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';
import type { SharedDraftService } from '../../../../src/lib/shared-drafts/index.ts';

/**
 * THE `shared-drafts` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment (see `../learning/fixture.ts`).
 *
 * The REAL `sharedDraftsModule.build(needs, seams, lifecycle)` over test inputs, so the route snapshot and the
 * contract checks consume what production builds. Only the INPUTS are doubles: a state home that does not exist, an
 * agenda with no ledgers and no paired devices, none of which anything here asks anything of. Building starts
 * nothing — the draft's write timer is armed only by an edit — so there is no timer or async work to leave behind in
 * the shared unit process.
 */

/** A state home that does not exist: every document reads as absent. */
const FIXTURE_HOME = '/nonexistent/shared-drafts-fixture-state-home';

/** The inputs `fyd.ts` hands the module, over doubles. */
function sharedDraftsNeeds(): SharedDraftsNeeds {
  const paths = createFoundationPaths(resolveStateHome({ fyHome: FIXTURE_HOME, homeDirectory: '/unused' }));
  return {
    paths,
    stateFiles: new StateFileSystem(paths),
    agendaBoards: { read: async () => null },
    clock: { now: () => '2026-10-20T12:00:00.000Z' },
    pairing: { devices: async () => [] },
  };
}

const LIFECYCLE: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

/**
 * The module over a state home where exactly `known` sessions exist and nothing else is on disk. A draft's write
 * lands in memory, so a test can edit, read back and close without touching a file; the caller closes the service
 * (`provides.close()`) so its debounce timer is cancelled and does not outlive the test.
 */
export function builtSharedDraftsKnowing(known: readonly string[]): BuiltModule<SharedDraftService> {
  const needs = sharedDraftsNeeds();
  const written = new Map<string, string>();
  const files = {
    information: async (path: string) =>
      known.some(id => path.endsWith(`/${id}/session-version`)) ? ({} as never) : undefined,
    readText: async (path: string) => written.get(path),
    writeTextAtomic: async (path: string, text: string) => {
      written.set(path, text);
    },
    removeFile: async (path: string) => {
      written.delete(path);
    },
    listDirectory: async () => [],
  } as unknown as FileSystemPort;
  return sharedDraftsModule.build({ ...needs, stateFiles: files }, undefined, LIFECYCLE);
}

/** The module as production builds it, over the fixture's inputs. */
export function builtSharedDrafts(): BuiltModule<SharedDraftService> {
  return sharedDraftsModule.build(sharedDraftsNeeds(), undefined, LIFECYCLE);
}
