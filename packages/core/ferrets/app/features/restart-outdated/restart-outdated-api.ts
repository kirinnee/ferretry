/**
 * `POST /v1/restarts`: restart the ferrets that run on out-of-date instructions. The daemon restarts the idle ones, queues
 * the busy ones for their next idle moment, and never forces past the in-flight inventory.
 *
 * The answer is PARSED through the contract's schema, so a body this page cannot read is a failed read rather than a claim
 * about what restarted.
 */
import {
  type RestartRequest,
  RestartRequestSchema,
  type RestartResult,
  RestartResultSchema,
} from '../../../contract/index.ts';
import type { FerretsClient } from '../../lib/client.ts';

const RESTART_ROUTE = 'POST /v1/restarts' as const;

export const restartFerrets = async (client: FerretsClient, request: RestartRequest): Promise<RestartResult> =>
  RestartResultSchema.parse(await client.call(RESTART_ROUTE, { body: RestartRequestSchema.parse(request) }));
