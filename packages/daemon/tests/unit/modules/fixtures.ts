import type { BuiltModule } from '../../../src/lib/runtime/modules.ts';
import { builtAgentTools } from './agent-tools/fixture.ts';
import { builtAnalytics } from './analytics/fixture.ts';
import { builtCgroups } from './cgroups/fixture.ts';
import { builtFleetLogin } from './fleet-login/fixture.ts';
import { builtInputRequests } from './input-requests/fixture.ts';
import { builtLearning } from './learning/fixture.ts';
import { builtMcp } from './mcp/fixture.ts';
import { builtModels } from './models/fixture.ts';
import { builtRenders } from './renders/fixture.ts';
import { builtSharedDrafts } from './shared-drafts/fixture.ts';
import { builtUpdate } from './update/fixture.ts';
import { builtUsage } from './usage/fixture.ts';
import { builtVoice } from './voice/fixture.ts';
import { builtWorkSearch } from './work-search/fixture.ts';
import { builtWorktrees } from './worktrees/fixture.ts';

/**
 * THE EXTRACTED MODULES, AS PRODUCTION BUILDS THEM, ONE FIXTURE FRAGMENT PER MODULE.
 *
 * Each module's `tests/unit/modules/<id>/fixture.ts` runs that module's REAL `<id>Module.build(...)` over test
 * inputs (see `learning/fixture.ts`). EXTRACTING A MODULE adds its builder to the list below — one line — and the
 * mounted-surface fixture (`../runtime/mounts/surface-mounted.ts`) composes whatever this returns.
 *
 * A test that needs a module built over its own inputs (a shared draft over sessions it knows) passes it as a
 * replacement: it stands in for the default build of the module with the same id.
 */
export const builtModules = (
  replacements: readonly BuiltModule<unknown, object>[] = [],
): readonly BuiltModule<unknown, object>[] =>
  defaultBuiltModules().map(built => replacements.find(replacement => replacement.id === built.id) ?? built);

const defaultBuiltModules = (): readonly BuiltModule<unknown, object>[] => [
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
  builtUsage(),
  builtMcp(),
  builtSharedDrafts(),
];
