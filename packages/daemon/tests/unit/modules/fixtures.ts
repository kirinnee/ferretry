import type { BuiltModule } from '../../../src/lib/runtime/modules.ts';
import { builtAgentTools } from './agent-tools/fixture.ts';
import { builtAnalytics } from './analytics/fixture.ts';
import { builtCgroups } from './cgroups/fixture.ts';
import { builtFleetLogin } from './fleet-login/fixture.ts';
import { builtInputRequests } from './input-requests/fixture.ts';
import { builtLearning } from './learning/fixture.ts';
import { builtModels } from './models/fixture.ts';
import { builtRenders } from './renders/fixture.ts';
import { builtUpdate } from './update/fixture.ts';
import { builtVoice } from './voice/fixture.ts';
import { builtWorkSearch } from './work-search/fixture.ts';
import { builtWorktrees } from './worktrees/fixture.ts';

/**
 * THE EXTRACTED MODULES, AS PRODUCTION BUILDS THEM, ONE FIXTURE FRAGMENT PER MODULE.
 *
 * Each module's `tests/unit/modules/<id>/fixture.ts` runs that module's REAL `<id>Module.build(...)` over test
 * inputs (see `learning/fixture.ts`). EXTRACTING A MODULE adds its builder to the list below — one line — and the
 * mounted-surface fixture (`../runtime/mounts/surface-mounted.ts`) composes whatever this returns.
 */
export const builtModules = (): readonly BuiltModule<unknown, object>[] => [
  builtLearning(),
  builtCgroups(),
  builtAnalytics(),
  builtUpdate(),
  builtWorktrees(),
  builtRenders(),
  builtVoice(),
  builtWorkSearch(),
  builtInputRequests(),
  builtAgentTools(),
  builtFleetLogin(),
  builtModels(),
];
