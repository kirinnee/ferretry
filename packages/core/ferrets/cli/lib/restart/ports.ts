import type { RestartCancelResult, RestartRequest, RestartResult, RestartStatus } from '../../../contract/index.ts';

/** The three restart calls (`/v1/restarts`): restart now-or-queue, read the status, clear the queue. */
export interface IRestartGateway {
  /** `requestId` is the caller's idempotency key (`--request-id`): a repeat with the same key is answered, not run again. */
  restart(request: RestartRequest, requestId?: string): Promise<RestartResult>;
  restartStatus(): Promise<RestartStatus>;
  cancelRestarts(): Promise<RestartCancelResult>;
}
