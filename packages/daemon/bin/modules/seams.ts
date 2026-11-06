import type { BuiltModule } from '../../src/lib/runtime/modules.ts';
import type { DaemonWorld } from '../fyd.ts';
import type { HarnessLoginService } from '../../src/lib/fleet-login/service.ts';
import type { LearningSubsystem, LimitsService, ManagedWorktreeService, RenderService } from '../../src/lib/index.ts';
import type { SttEnhancementSubsystem } from '../../src/lib/runtime/mounts/stt.ts';
import type { WorkSearchService } from '../../src/lib/work-search/index.ts';
import type { AnalyticsJobs, AnalyticsProvides } from './analytics.ts';
import type { AgentToolsProvides } from './agent-tools.ts';
import type { InputRequestsProvides } from './input-requests.ts';
import type { LearningSeams } from './learning.ts';
import type { ModelsJobs, ModelsProvides } from './models.ts';
import type { UpdateJobs, UpdateProvides } from './update.ts';
import type { VoiceSeams } from './voice.ts';

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
  /** No seam: the module replaces no adapter `DaemonWorld` carries (the file tools and the pin lists are built directly; the terminals, the browser and the ports to other modules are needs). */
  agentTools: (_world: DaemonWorld): void => undefined,
  /** No seam: the module replaces no adapter `DaemonWorld` carries (the analytics store is opened by `start()`, a need). */
  analytics: (_world: DaemonWorld): void => undefined,
  /** No seam: the module replaces no adapter `DaemonWorld` carries (the measured host is a `buildWorld` seam, a need). */
  cgroups: (_world: DaemonWorld): void => undefined,
  /** No seam: the module replaces no adapter `DaemonWorld` carries (the child launcher, the callback delivery, the timer and the port reader are fixed production adapters; the credential catalog, the clock and the environment are needs). */
  fleetLogin: (_world: DaemonWorld): void => undefined,
  /** No seam: the module replaces no adapter `DaemonWorld` carries (the tmux, the terminals, the agenda and the vault are needs). */
  inputRequests: (_world: DaemonWorld): void => undefined,
  learning: (world: DaemonWorld): LearningSeams => ({ userHome: world.userHome }),
  /** No seam: the module replaces no adapter `DaemonWorld` carries (the outbound holder is a `buildWorld` value, a need). */
  models: (_world: DaemonWorld): void => undefined,
  /** No seam: the module replaces no adapter `DaemonWorld` carries (the saved-pictures store is a need). */
  renders: (_world: DaemonWorld): void => undefined,
  /** No seam: the module replaces no adapter `DaemonWorld` carries (the user home and the harness resolution are needs). */
  update: (_world: DaemonWorld): void => undefined,
  /** No seam: the module replaces no adapter `DaemonWorld` carries (the Git operations arrive in `WorktreeComposition`, a need). */
  worktrees: (_world: DaemonWorld): void => undefined,
  /** The dictation enhancer spends the operator's provider credential, so `DaemonWorld` carries it as `sttEnhancement` and a test replaces it. */
  voice: (world: DaemonWorld): VoiceSeams => ({ enhancement: world.sttEnhancement }),
  /** No seam: the module replaces no adapter `DaemonWorld` carries (the board, the agenda ledgers and the file-event hub are needs). */
  workSearch: (_world: DaemonWorld): void => undefined,
} as const satisfies SeamReaders;

/**
 * The extracted modules, as the default `createSubsystems` factory hands them back to `start()`, which
 * composes their routes and arms their jobs. Each extraction adds its own field, typed with its own `provides`
 * and `jobs`. Deleted in the same tidy-up PR as {@link seamsOf}.
 */
export interface ModuleHandles {
  readonly agentTools: BuiltModule<AgentToolsProvides>;
  readonly analytics: BuiltModule<AnalyticsProvides, AnalyticsJobs>;
  readonly cgroups: BuiltModule<LimitsService>;
  readonly fleetLogin: BuiltModule<HarnessLoginService>;
  readonly inputRequests: BuiltModule<InputRequestsProvides>;
  readonly learning: BuiltModule<LearningSubsystem>;
  readonly models: BuiltModule<ModelsProvides, ModelsJobs>;
  readonly renders: BuiltModule<RenderService>;
  readonly update: BuiltModule<UpdateProvides, UpdateJobs>;
  readonly voice: BuiltModule<SttEnhancementSubsystem>;
  readonly workSearch: BuiltModule<WorkSearchService>;
  readonly worktrees: BuiltModule<ManagedWorktreeService>;
}
