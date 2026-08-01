import type { IFyApiClient } from '@ferretry/protocol';

/** The destructive, request-id-protected migration call owned by the protocol client. */
export type IMigrationGateway = Pick<IFyApiClient, 'migrate'>;
