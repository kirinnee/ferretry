/** A login's limit read off a pane (today's `usage/pane-limit.ts`, owned by Usage). */
export interface PaneLimit {
  /** The harness's own sentence. */
  readonly notice: string;
  /** Whether it is a spend limit (money), as opposed to a usage window. */
  readonly spend: boolean;
  /** When the login is usable again, epoch milliseconds; absent when the harness gave no time. */
  readonly retryAt?: number;
}

/** Whether a limit still holds at `nowMs`: one with a reset time ends there, one without ends with its sessions. */
export const paneLimitHolds = (limit: PaneLimit, nowMs: number): boolean =>
  limit.retryAt === undefined || limit.retryAt > nowMs;
