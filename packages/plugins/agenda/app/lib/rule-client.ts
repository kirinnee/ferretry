/**
 * THE RULE CLIENT OVER A MACHINE'S CLIENT: the sweep of answered rule suggestions reads Accounts' owner list
 * (`GET /v1/sign-in-rules/suggestions`) by path, and this binds that read to the one client a machine's runtime holds.
 * The answer is parsed with the caller's schema, so this half reads only the part it needs (each suggestion's id).
 */

import type { RuleClient } from '../hooks/use-answered-suggestion-sweep.ts';
import { type AgendaCall, agendaCall } from './agenda-call.ts';

export const ruleClientOf = (client: AgendaCall): RuleClient => ({
  request: async (path, schema) => schema.parse(await agendaCall(client, `GET ${path}`)),
});
