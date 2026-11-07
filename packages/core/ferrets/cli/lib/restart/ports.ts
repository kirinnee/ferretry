import type { RestartCancelResult, RestartRequest, RestartResult, RestartStatus } from '../../../contract/index.ts';

/** The three restart calls (`/v1/restarts`): restart now-or-queue, read the status, clear the queue. */
export interface IRestartGateway {
  restart(request: RestartRequest): Promise<RestartResult>;
  restartStatus(): Promise<RestartStatus>;
  cancelRestarts(): Promise<RestartCancelResult>;
}
