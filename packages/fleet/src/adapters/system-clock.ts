import type { FleetUsageClock } from '../lib/usage.ts';

/**
 * The real clock. It lives in the adapter tier because reading the wall clock is IO: the domain
 * takes a {@link FleetUsageClock} so a test can pin an instant instead of tolerating drift.
 */
export const systemFleetUsageClock: FleetUsageClock = { now: () => Date.now() };
