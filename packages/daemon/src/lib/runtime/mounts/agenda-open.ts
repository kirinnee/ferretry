import { AgendaOpenPageSchema, AgendaOpenQuerySchema } from '@ferretry/protocol';
import type { AgendaRollup } from '../../agenda/index.ts';
import { ApiError } from '../../api/error.ts';
import { queryValue } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';

/** The page asked for, from the URL's query string. A field given empty is a field not given. */
const queryOf = (context: RouteContext) => {
  const input: Record<string, unknown> = {};
  const after = queryValue(context.request, 'after');
  if (after !== undefined && after !== '') input.after = after;
  const limit = queryValue(context.request, 'limit');
  if (limit !== undefined && limit !== '') input.limit = /^[0-9]+$/u.test(limit) ? Number(limit) : limit;
  const parsed = AgendaOpenQuerySchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError(
      400,
      `the page is not usable: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
      'invalid',
    );
  }
  return parsed.data;
};

/**
 * `GET /v1/agenda/open`: every conversation's open and parked agenda items on this machine, paged
 * (docs/agenda.md § The roll-up).
 *
 * The same grants as reading one conversation's board — `operator`, no capability, gated by who asks
 * (docs/grants.md) — with one narrowing: `caller: 'person'`. A board read names the one session it reads; this names
 * every session and every item on the machine at once, which a ferret has no use for and must not be handed.
 * `noStore`, for the reason a board is: a cached page shows a question that has been answered.
 */
export function agendaOpenRoutes(rollup: AgendaRollup): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/agenda/open',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      handle: async context => {
        const page = AgendaOpenPageSchema.parse(await rollup.page(queryOf(context)));
        return jsonResponse(page);
      },
    },
  ];
}
