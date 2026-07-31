/** The non-restartable exit code used when an address already has a responder. */
export const EXIT_ALREADY_RUNNING = 78;

/**
 * The three host capabilities a boot needs, declared where the boot policy lives.
 *
 * They used to sit in a `readiness.ts` beside a copy of the CLI's readiness decision table. That
 * table was the daemon waiting for a daemon to come up, which is not something this process ever
 * does — `fy daemon start` is the only caller there has ever been, and `packages/cli` owns its own
 * copy because the split forbids it importing this package. The table went with the waiter that
 * used it; these ports stayed, because the probe, the binder and every clock-reading route are real.
 */
export interface DaemonFetchPort {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export interface MillisecondClockPort {
  now(): number;
}

export interface SleepPort {
  sleep(milliseconds: number): Promise<void>;
}

export interface BindRetryPolicy {
  readonly backoffMs: number;
  readonly totalMs: number;
  readonly maxAttempts: number;
}

export const defaultBindRetryPolicy = (): BindRetryPolicy => ({ backoffMs: 500, totalMs: 30_000, maxAttempts: 61 });

/** Builds the health endpoint without retaining any trailing slash. */
export function healthEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}/v1/health`;
}

/** A bind conflict is transient only while another owner may still be draining. */
export function shouldRetryBind(
  error: unknown,
  nowMs: number,
  deadlineMs: number,
  attempts: number,
  policy: BindRetryPolicy,
): boolean {
  return isAddressInUse(error) && attempts < policy.maxAttempts && nowMs + policy.backoffMs <= deadlineMs;
}

function isAddressInUse(error: unknown): boolean {
  return (
    (error as { readonly code?: unknown } | null)?.code === 'EADDRINUSE' ||
    /EADDRINUSE|address already in use/iu.test(String(error))
  );
}
