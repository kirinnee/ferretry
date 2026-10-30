import { AgendaClearAgentsRequestSchema, AgendaClearAgentsResultSchema } from '@ferretry/protocol';
import type { AgendaAgentClearer } from '../../agenda/index.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute } from '../../api/route.ts';
import { agendaActor } from './agenda.ts';

/**
 * The owner's "Clear all from agent ferrets" (docs/agenda.md § Clearing the agent ferrets' backlog).
 *
 * Owner only, decided from the actor the authorization boundary resolved: a ferret's credential is refused,
 * so an agent can never empty the boards it does not own. `dryRun` answers what a clear would dismiss.
 */
export function agendaClearRoutes(clearer: AgendaAgentClearer): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/agenda/clear-agents',
      minimum: 'operator',
      noStore: true,
      handle: async context => {
        const actor = agendaActor(context.actor);
        if (actor.kind !== 'human') {
          throw new ApiError(403, 'only the owner can clear the agent ferrets’ agenda items', 'forbidden');
        }
        const request = await parseBody(context.request, AgendaClearAgentsRequestSchema);
        const result = request.dryRun === true ? await clearer.preview() : await clearer.clear(actor);
        return jsonResponse(AgendaClearAgentsResultSchema.parse(result));
      },
    },
  ];
}
