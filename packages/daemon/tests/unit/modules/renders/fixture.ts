import { StateFileSystem } from '../../../../src/adapters/index.ts';
import { createFoundationPaths, type RenderService, resolveStateHome } from '../../../../src/lib/index.ts';
import type { BuiltModule, ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';
import { rendersModule } from '../../../../bin/modules/renders.ts';

/**
 * THE `renders` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment (see `../learning/fixture.ts`).
 *
 * The REAL `rendersModule.build(needs, seams, lifecycle)` over a state home that does not exist: nothing is read or
 * written until a request, and no surface test sends one. Building starts nothing, so there is no timer or async
 * work to leave behind in the shared unit process.
 */

/** A state home that does not exist, so the saved-pictures store is empty. */
const FIXTURE_HOME = '/nonexistent/renders-fixture-state-home';

const LIFECYCLE: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

/** The module as production builds it, over the fixture's inputs. */
export function builtRenders(): BuiltModule<RenderService> {
  const paths = createFoundationPaths(resolveStateHome({ fyHome: FIXTURE_HOME, homeDirectory: '/unused' }));
  return rendersModule.build(
    { paths, stateFiles: new StateFileSystem(paths), clock: { now: () => '1970-01-01T00:00:00.000Z' } },
    undefined,
    LIFECYCLE,
  );
}
