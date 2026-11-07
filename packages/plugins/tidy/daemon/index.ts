import { implementDaemon } from '@ferretry/kernel/manifest';
import { hours } from '@ferretry/std';
import {
  HousekeepingFile,
  SCRATCH_DEFAULTS,
  TidyConfigFile,
  TidyConfigSchema,
  type TidyTotals,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { rootAsFolders, ScratchCollector } from './lib/scratch-collector.ts';
import { tidyRoutes } from './lib/routes.ts';
import { TidyService } from './lib/service.ts';

/** How often the automatic sweep looks; a ferret stopping looks sooner (below). */
const SWEEP_EVERY = hours(1);
const SWEEP_JOB = 'scratch-sweep';

/**
 * Tidy (daemon half, §2.3): the scratch collector (`/v1/gc`), one ferret's tidy plan (`/v1/tidy/plan`) and an hourly
 * sweep when `config/tidy.yaml` leaves it on. Nothing here starts a timer of its own: the sweep is a kernel job, and the
 * lifetime counters live in `state/tidy/housekeeping.json`.
 */
export default implementDaemon(manifest, {
  build: ({ needs, uses, kernel }) => {
    const settings = () => kernel.config.file(TidyConfigFile) ?? TidyConfigSchema.parse({});
    const collector = new ScratchCollector({
      ferrets: needs.ferrets,
      worktrees: rootAsFolders(kernel.roots.root('worktrees')),
      nowMs: () => kernel.clock.nowMs(),
      config: () => settings().scratch ?? SCRATCH_DEFAULTS,
      record: async ({ ferrets, bytes }) => {
        const at = kernel.clock.now();
        const done = await kernel.state.update(HousekeepingFile, current => ({
          format: 1 as const,
          reclaimedFerrets: (current?.reclaimedFerrets ?? 0) + ferrets,
          reclaimedBytes: (current?.reclaimedBytes ?? 0) + bytes,
          lastSweepAt: at,
        }));
        if (!done.ok) kernel.log.warn('could not record a scratch sweep', { file: done.error.file });
      },
    });
    const planner = new TidyService({ ferrets: needs.ferrets, asks: needs.asks, board: () => uses.board.current() });

    kernel.jobs.add({
      id: SWEEP_JOB,
      schedule: { every: SWEEP_EVERY },
      run: async () => {
        const swept = await collector.sweep(false);
        if (swept.ferrets > 0 || swept.failures > 0) kernel.log.info('swept scratch', { ...swept });
      },
    });

    return {
      routes: tidyRoutes(collector, planner),
      provides: {
        tidy: {
          totals: async (): Promise<TidyTotals> => {
            const kept = await kernel.state.read(HousekeepingFile);
            const value = kept.ok ? kept.value : undefined;
            return {
              enabled: settings().scratch.enabled,
              reclaimedFerrets: value?.reclaimedFerrets ?? 0,
              reclaimedBytes: value?.reclaimedBytes ?? 0,
            };
          },
        },
      },
      hooks: {
        // A ferret stopping is the natural moment to look; the sweep itself still honours the wait and the switch.
        'ferret.changed': payload => {
          if (payload.change === 'stopped') kernel.jobs.kick(SWEEP_JOB);
        },
      },
    };
  },
});
