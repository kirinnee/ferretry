import type { IFyApiClient } from '@ferretry/protocol';

/**
 * The destructive, request-id-protected move call owned by the protocol client, and the read that
 * previews a cross-harness conversion before it.
 */
export type IMoveGateway = Pick<IFyApiClient, 'move' | 'conversionPreview'>;
