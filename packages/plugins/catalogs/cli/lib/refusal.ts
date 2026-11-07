/**
 * The daemon's refusal as the fy shell's guarded client throws it (`DaemonRefusal`: a sentence, the HTTP status and
 * the daemon's code). A plugin half does not import the shell, so it reads the refusal by its shape; today's
 * equivalent was the protocol client's `FyHttpError`.
 */
export interface DaemonRefusal {
  readonly message: string;
  readonly status: number;
  readonly code?: string;
}

export function daemonRefusal(error: unknown): DaemonRefusal | undefined {
  if (!(error instanceof Error)) return undefined;
  const { status, code } = error as { status?: unknown; code?: unknown };
  if (typeof status !== 'number') return undefined;
  return { message: error.message, status, ...(typeof code === 'string' ? { code } : {}) };
}
