/**
 * What a refused call looks like to the move page: the shell client's `DaemonCallError` fields (`status`, `code`,
 * `message`), read structurally, and the refusal's JSON body when the client carries one. The body is where a daemon
 * attaches data to a refusal (the in-flight inventory of `move_refused`, the numbers of `context_downgrade_refused`);
 * a client that does not carry it leaves the sentence alone, and every reader below works from the sentence then.
 */
export interface MoveCallFailure {
  readonly status?: number;
  readonly code?: string;
  readonly message: string;
  readonly body?: unknown;
}

export const moveCallFailure = (error: unknown): MoveCallFailure => {
  if (typeof error !== 'object' || error === null) return { message: String(error) };
  const fields = error as { status?: unknown; code?: unknown; message?: unknown; body?: unknown };
  return {
    message: typeof fields.message === 'string' ? fields.message : String(error),
    ...(typeof fields.status === 'number' ? { status: fields.status } : {}),
    ...(typeof fields.code === 'string' ? { code: fields.code } : {}),
    ...(fields.body === undefined ? {} : { body: fields.body }),
  };
};
