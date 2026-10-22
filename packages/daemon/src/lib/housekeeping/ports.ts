import type { HousekeepingJob, HousekeepingJobValues } from './protocol.ts';

/**
 * Where housekeeping jobs run: the housekeeping worker, or — switched off, or retired after crashing —
 * the main thread. Both run the same job code, so a caller cannot tell which answered.
 */
export interface HousekeepingJobs {
  run<J extends HousekeepingJob>(job: J): Promise<HousekeepingJobValues[J['kind']]>;
}
