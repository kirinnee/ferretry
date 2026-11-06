import type { BuiltModule } from '../../src/lib/runtime/modules.ts';
import type { DaemonWorld } from '../fyd.ts';

/**
 * The production adapters a test may replace, as each module sees them: one reader per module, over the
 * EFFECTIVE `DaemonWorld` — the world `start()` was given, overrides included — so
 * `buildWorld(overrides)` keeps working while the wiring moves out of `fyd.ts`.
 *
 * EMPTY ON PURPOSE. An extraction PR adds exactly one entry, named like its module:
 *
 * ```ts
 * export const seamsOf = {
 *   learning: (world: DaemonWorld): LearningSeams => ({ clock: world.clock, ... }),
 * } as const satisfies SeamReaders;
 * ```
 *
 * and builds its module in the default `createSubsystems` factory with `seamsOf.learning(world)`. The
 * readers go when the tidy-up PR moves the module wiring into `start()` and the seams become plain
 * constructor inputs.
 */
type SeamReaders = Readonly<Record<string, (world: DaemonWorld) => unknown>>;

export const seamsOf = {} as const satisfies SeamReaders;

/**
 * The extracted modules, as the default `createSubsystems` factory hands them back to `start()`, which
 * composes their routes and arms their jobs. Empty until the first extraction; each one adds its own
 * field, typed with its own `provides` and `jobs`. Deleted in the same tidy-up PR as {@link seamsOf}.
 */
export type ModuleHandles = Readonly<Record<never, BuiltModule<unknown, object>>>;
