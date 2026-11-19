/** The watch's composition: one `watchFeature(...)` hands `daemon/index.ts` its routes, job and event handlers. */
import type { JobsPort, Log } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import type { ConfigDoor } from './config-door.ts';
import { watchRoutes } from './routes.ts';
import { WatchService, type WatchDeps } from './service.ts';

/** The finest cadence is 30 s (CI running); a look at a project that is not due yet costs nothing. */
const WATCH_TICK_MS = 30_000;

export interface WatchFeatureDeps extends WatchDeps {
  readonly jobs: JobsPort;
  readonly door: ConfigDoor | undefined;
  readonly log: Log;
}

export function watchFeature(deps: WatchFeatureDeps) {
  const service = new WatchService(deps);
  deps.jobs.add({
    id: 'pulls-watch',
    schedule: { every: milliseconds(WATCH_TICK_MS) },
    lane: 'worker',
    run: async () => await service.tick(),
  });
  return {
    service,
    routes: watchRoutes({ service, door: deps.door, config: deps.config, projects: deps.projects }),
  };
}
