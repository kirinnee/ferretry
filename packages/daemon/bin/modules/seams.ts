import type { BuiltModule } from '../../src/lib/runtime/modules.ts';
import type { DaemonWorld } from '../fyd.ts';
import type { LearningSubsystem, LimitsService } from '../../src/lib/index.ts';
import type { AnalyticsJobs, AnalyticsProvides } from './analytics.ts';
import type { LearningSeams } from './learning.ts';

/**
 * The production adapters a test may replace, as each module sees them: one reader per module, over the
 * EFFECTIVE `DaemonWorld` — the world `start()` was given, overrides included — so
 * `buildWorld(overrides)` keeps working while the wiring moves out of `fyd.ts`.
 *
 * An extraction PR adds exactly one entry, named like its module, and builds the module in the default
 * `createSubsystems` factory with `seamsOf.<id>(world)`. The readers go when the tidy-up PR moves the module
 * wiring into `start()` and the seams become plain constructor inputs.
 */
type SeamReaders = Readonly<Record<string, (world: DaemonWorld) => unknown>>;

export const seamsOf = {
  /** No seam: the module replaces no adapter `DaemonWorld` carries (the analytics store is opened by `start()`, a need). */
  analytics: (_world: DaemonWorld): void => undefined,
  /** No seam: the module replaces no adapter `DaemonWorld` carries (the measured host is a `buildWorld` seam, a need). */
  cgroups: (_world: DaemonWorld): void => undefined,
  learning: (world: DaemonWorld): LearningSeams => ({ userHome: world.userHome }),
} as const satisfies SeamReaders;

/**
 * The extracted modules, as the default `createSubsystems` factory hands them back to `start()`, which
 * composes their routes and arms their jobs. Each extraction adds its own field, typed with its own `provides`
 * and `jobs`. Deleted in the same tidy-up PR as {@link seamsOf}.
 */
export interface ModuleHandles {
  readonly analytics: BuiltModule<AnalyticsProvides, AnalyticsJobs>;
  readonly cgroups: BuiltModule<LimitsService>;
  readonly learning: BuiltModule<LearningSubsystem>;
}
