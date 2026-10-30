import type { IFyApiClient } from '@ferretry/protocol';

/** The three restart calls the protocol client owns: restart now-or-queue, read the status, clear the queue. */
export type IRestartGateway = Pick<IFyApiClient, 'restart' | 'restartStatus' | 'cancelRestarts'>;
