import { ApiError, jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
import type { AgendaActor } from '../agenda/index.ts';
import {
  type AgendaClearAgentsResult,
  AgendaClearAgentsRequestSchema,
  AgendaClearAgentsResultSchema,
} from '../protocol/agenda.ts';
import { agendaActor } from './agenda.ts';
import { parseBody } from './body.ts';

/**
 * The owner's "Clear all from agent ferrets" (docs/agenda.md § Clearing the agent ferrets' backlog).
 *
 * Owner only, decided from the actor the authorization boundary resolved: a ferret's credential is refused,
 * so an agent can never empty the boards it does not own. `dryRun` answers what a clear would dismiss.
 */
/**
 * Which ferrets' boards a clear empties, and the dismissing (today's `AgendaAgentClearer`). The engine is the Agenda
 * plugin's (it reads which ferrets are agent ferrets); absent, the route answers `503 unavailable`.
 */
export interface AgendaAgentClearer {
  preview(): Promise<AgendaClearAgentsResult>;
  clear(actor: AgendaActor): Promise<AgendaClearAgentsResult>;
}

export function agendaClearRoutes(clearer: AgendaAgentClearer | undefined) {
  return {
    'POST /v1/agenda/clear-agents': (async context => {
        const actor = agendaActor(context.actor);
        if (actor.kind !== 'human') {
          throw new ApiError(403, 'only the owner can clear the agent ferrets’ agenda items', 'forbidden');
        }
        const request = await parseBody(context.request, AgendaClearAgentsRequestSchema);
        if (clearer === undefined)
          throw new ApiError(503, 'this daemon cannot tell which ferrets are agent ferrets yet, so nothing was cleared', 'unavailable');
        const result = request.dryRun === true ? await clearer.preview() : await clearer.clear(actor);
        return jsonResponse(AgendaClearAgentsResultSchema.parse(result));
    }) satisfies RouteHandler,
  } as const;
}
