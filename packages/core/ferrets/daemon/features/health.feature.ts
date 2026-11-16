import { milliseconds } from '@ferretry/std';
import manifest from '../../manifest.ts';
import { buildHealth, HEALTH_JOB } from '../modules/health.ts';
import { INDEX_REBUILD_JOB } from '../modules/index-rebuild.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

function register(f: FerretsContext): FeatureContribution | undefined {
  const { kernel, log, sessionStore, storeLoaded } = f;
  // What the session store said when it loaded, for the report's bootstrap facts: a load that failed is named, not hidden.
  let finished = false;
  const errors: string[] = [];
  void storeLoaded.then(
    () => {
      finished = true;
    },
    (error: unknown) => {
      finished = true;
      errors.push(error instanceof Error ? error.message : 'the session store did not load');
    },
  );
  // The daemon's self-check (J-0032, J-0118): wedge and index incoherence, written to `health.jsonl` and
  // `self-restart.json`. REPORT-ONLY (modules/health.ts). No Ferrets route reads it: the kernel's `/healthz` is the one
  // health surface.
  const health = buildHealth({
    state: kernel.state,
    storage: sessionStore,
    clock: { now: () => kernel.clock.now(), nowMs: () => kernel.clock.nowMs() },
    loop: kernel.loop,
    version: manifest.version,
    bootstrap: { finished: () => finished, errors: () => errors },
    log,
  });
  kernel.jobs.add({
    id: HEALTH_JOB,
    schedule: { every: milliseconds(health.settings.selfCheckIntervalMs) },
    // The first look waits for the index rebuild: an index still being refilled reads as a fleet of sessions it lost.
    after: [INDEX_REBUILD_JOB],
    run: async () => {
      // An archive that did not load names no archived session, and a pass would read every one of them as live.
      if (
        !(await storeLoaded.then(
          () => true,
          () => false,
        ))
      )
        return;
      await health.tick();
    },
  });

  return undefined;
}

export default { id: 'health', register } satisfies FerretsFeature;
