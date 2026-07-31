/** The non-restartable exit code used when an address already has a responder. */
export const EXIT_ALREADY_RUNNING = 78;

export interface BindRetryPolicy {
  readonly backoffMs: number;
  readonly totalMs: number;
}

export const defaultBindRetryPolicy = (): BindRetryPolicy => ({ backoffMs: 500, totalMs: 30_000 });

/** Builds the health endpoint without accepting a duplicate trailing slash. */
export function healthEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/u, '')}/v1/health`;
}

/** A bind conflict is transient only while another owner may still be draining. */
export function shouldRetryBind(error: unknown, nowMs: number, deadlineMs: number, policy: BindRetryPolicy): boolean {
  return isAddressInUse(error) && nowMs + policy.backoffMs <= deadlineMs;
}

function isAddressInUse(error: unknown): boolean {
  return (
    (error as { readonly code?: unknown } | null)?.code === 'EADDRINUSE' ||
    /EADDRINUSE|address already in use/iu.test(String(error))
  );
}
