/**
 * How long `browser page wait` waits, in all: it asks the daemon in slices of at most the contract's
 * `BROWSER_WAIT_MAX_MS`, so no single request outlives the daemon's idle timeout (v4's `AGENT_TOOL_MAX_TOTAL_WAIT_MS`).
 */
export const BROWSER_WAIT_TOTAL_MAX_MS = 120_000;
/** The budget a wait has when `--timeout` is not given. */
export const BROWSER_WAIT_DEFAULT_TOTAL_MS = 10_000;
