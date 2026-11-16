import { milliseconds } from '@ferretry/std';
import { INDEX_REBUILD_JOB, runIndexRebuild } from '../modules/index-rebuild.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

function register(f: FerretsContext): FeatureContribution | undefined {
  const { kernel, log, sessionStore, storeLoaded } = f;
  // The session index rebuilt in slices when its cache file was lost (BG-049). Not on the housekeeping lane: the
  // readers of the session list are empty until it has run. A stop aborts it between sessions.
  kernel.jobs.add({
    id: INDEX_REBUILD_JOB,
    schedule: { onceAfterStart: true },
    run: async signal => {
      // An archive that did not load names no archived session, and a rebuild would index them: wait for it.
      if (
        !(await storeLoaded.then(
          () => true,
          () => false,
        ))
      )
        return;
      await runIndexRebuild(
        {
          storage: sessionStore,
          yieldToLoop: async () => await kernel.clock.sleep(milliseconds(0)),
          nowMs: () => kernel.clock.nowMs(),
          log,
        },
        signal,
      ).catch((error: unknown) =>
        log.warn('the session index rebuild stopped early', { error: error instanceof Error ? error.name : 'unknown' }),
      );
    },
  });

  return undefined;
}

export default { id: 'index-rebuild', register } satisfies FerretsFeature;
