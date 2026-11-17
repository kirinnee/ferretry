import { Runners } from '../../contract/index.ts';
import { StorageResumeRepository } from '../adapters/session/resume/storage-resume-repository.ts';
import { buildInterruptedLaunches, INTERRUPTED_LAUNCH_JOB } from '../modules/interrupted-launches.ts';
import { buildInterruptedMoves } from '../modules/interrupted-moves.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

function register(f: FerretsContext): FeatureContribution | undefined {
  const { kernel, hooks, registry, sessionStore, sessionFiles, log, ready, storeLoaded, appendHistory } = f;
  // The launches a host restart interrupted (today's `InterruptedLaunchReconciler`, run at boot): a record the dead daemon
  // left `created` or `starting`, whose terminal the runner PROVES is not there, is recorded failed with the reason, so it
  // stops counting as a running sub-ferret and reads as what it is. Once the daemon serves, under each ferret's own queue,
  // at most one pass cap of them; a launch this process began since it booted is never touched.
  const pass = buildInterruptedLaunches({
    repository: new StorageResumeRepository(sessionStore),
    serial: sessionFiles.serial,
    gate: sessionFiles.launchGate,
    record: ferret => registry.get(ferret),
    bootedAtMs: kernel.clock.nowMs(),
    gone: async ferret => {
      const runner = hooks.provider(Runners, 'tmux');
      return runner === 'unavailable' || runner.gone === undefined ? undefined : await runner.gone(ferret);
    },
    history: appendHistory,
    clock: { now: () => kernel.clock.now() },
    log,
  });
  // The moves a crash cut in half, settled in the same boot job (one job, no new registration): config.json restamped for a
  // target while the record and the pane are still on the source is put back to the source (`interrupted-moves.ts`).
  const moves = buildInterruptedMoves({
    storage: sessionStore,
    serial: sessionFiles.serial,
    record: ferret => registry.get(ferret),
    bootedAtMs: kernel.clock.nowMs(),
    history: appendHistory,
    log,
  });
  kernel.jobs.add({
    id: INTERRUPTED_LAUNCH_JOB,
    schedule: { onceAfterStart: true },
    run: async () => {
      await ready();
      await storeLoaded.catch(() => undefined);
      await pass.run().catch((error: unknown) =>
        log.warn('the interrupted-launch pass stopped early', {
          error: error instanceof Error ? error.name : 'unknown',
        }),
      );
      await moves.run().catch((error: unknown) =>
        log.warn('the interrupted-move pass stopped early', {
          error: error instanceof Error ? error.name : 'unknown',
        }),
      );
    },
  });

  return undefined;
}

export default { id: 'interrupted-launches', register } satisfies FerretsFeature;
