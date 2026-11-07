/**
 * Moving one ferret onto another runtime, over the daemon's client: Ferrets' declared move route
 * (`POST /v1/ferrets/:ferretId/move`, R-0355). Removing a runtime asks it once per ferret still running on the runtime,
 * exactly as today's remove dialog asked the old migrate route. Pure over an injected client.
 */

import { type MoveConversation, MoveSessionRequestSchema } from '@ferretry/core-ferrets/contract';
import type { RuntimesClient } from './client.ts';

/** Ferrets' move, written with the parameter name Ferrets declares (`:ferretId`). */
export const MOVE_ROUTE = 'POST /v1/ferrets/:ferretId/move' as const;

/** The Ferrets move of one ferret onto `runtime`, resumed on the same CLI or converted across to the other. */
export type MoveFerret = (sessionId: string, runtime: string, conversation: MoveConversation) => Promise<void>;

const requestId = (): string => crypto.randomUUID();

/**
 * The move a remove dialog offers, over `client`. Each move carries its own request id (`x-fy-request-id`): the route
 * refuses a move without one, because a retried POST without it would kill and relaunch the pane a second time. A
 * refusal (the ferret is mid-turn, its conversation cannot be resumed, Ferrets cannot start it there yet) is thrown as
 * the client threw it, so the dialog words it the way it words any refused change.
 */
export const moveFerretWith =
  (client: RuntimesClient, mintRequestId: () => string = requestId): MoveFerret =>
  async (sessionId, runtime, conversation) => {
    await client.call(MOVE_ROUTE, {
      params: { ferretId: sessionId },
      body: MoveSessionRequestSchema.parse({
        agent: runtime,
        allowContextDowngrade: false,
        forceInflight: false,
        conversation,
      }),
      headers: { 'x-fy-request-id': mintRequestId() },
    });
  };
