/** The non-restartable exit code used when an address already has a responder. */
export const EXIT_ALREADY_RUNNING = 78;

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
