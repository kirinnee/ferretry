import type { IFyApiClient } from '@ferretry/protocol';

/**
 * The destructive, request-id-protected migration call owned by the protocol client, and the read that
 * previews a cross-harness conversion before it.
 */
export type IMigrationGateway = Pick<IFyApiClient, 'migrate' | 'conversionPreview'>;
