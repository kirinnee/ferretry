/** How often a request that outlived its time is found and ended, so its card does not wait for the next event. */
export const INPUT_REQUEST_SWEEP_MS = 15_000;

/** The session statuses that mean a ferret has finished: its requests, copies and plans end with it. */
export const INPUT_ENDED_SESSION_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'stopped']);
