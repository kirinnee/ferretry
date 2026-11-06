import type { BuiltModule } from '../../../src/lib/runtime/modules.ts';
import { builtLearning } from './learning/fixture.ts';

/**
 * THE EXTRACTED MODULES, AS PRODUCTION BUILDS THEM, ONE FIXTURE FRAGMENT PER MODULE.
 *
 * Each module's `tests/unit/modules/<id>/fixture.ts` runs that module's REAL `<id>Module.build(...)` over test
 * inputs (see `learning/fixture.ts`). EXTRACTING A MODULE adds its builder to the list below — one line — and the
 * mounted-surface fixture (`../runtime/mounts/surface-mounted.ts`) composes whatever this returns.
 */
export const builtModules = (): readonly BuiltModule<unknown, object>[] => [builtLearning()];
