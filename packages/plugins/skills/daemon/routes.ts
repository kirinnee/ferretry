import {
  ApiError,
  type CallContext,
  decodeParameter,
  jsonResponse,
  queryValue,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import { SkillFileSchema } from '../contract/index.ts';
import type { SkillsApi } from '../contract/index.ts';

function ferretId(call: CallContext): string {
  const decoded = decodeParameter(call.params.get('ferretId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the ferret id in the path is not usable', 'invalid_ferret_id');
  return decoded;
}

/** The four reads of the skills inventory (today's `catalogs.ts` skill routes). */
export function inventoryRoutes(skills: SkillsApi): {
  readonly 'GET /v1/ferrets/:ferretId/skills': RouteHandler;
  readonly 'GET /v1/ferrets/:ferretId/skills/inventory': RouteHandler;
  readonly 'GET /v1/skills': RouteHandler;
  readonly 'GET /v1/skills/file': RouteHandler;
} {
  return {
    'GET /v1/ferrets/:ferretId/skills': async call => {
      const id = ferretId(call);
      const listed = await skills.forComposer(id);
      if (listed === undefined) throw new ApiError(404, `no ferret ${id}`, 'not-found');
      return jsonResponse(listed);
    },
    'GET /v1/ferrets/:ferretId/skills/inventory': async call => {
      const id = ferretId(call);
      const listed = await skills.ferretInventory(id);
      if (listed === undefined) throw new ApiError(404, `no ferret ${id}`, 'not-found');
      return jsonResponse(listed);
    },
    'GET /v1/skills': async () => jsonResponse(await skills.inventory()),
    // The inventory's Open: the one route that returns SKILL.md text, and only for a path the inventory lists.
    'GET /v1/skills/file': async call => {
      const path = queryValue(call.request, 'path');
      if (path === undefined || path === '')
        throw new ApiError(400, 'query parameter "path" is required', 'invalid_path');
      const owner = queryValue(call.request, 'ferretId');
      const ferret = owner === undefined || owner === '' ? undefined : owner;
      if (ferret !== undefined && (await skills.ferretInventory(ferret)) === undefined)
        throw new ApiError(404, `no ferret ${ferret}`, 'not-found');
      const content = await skills.file(path, ferret);
      if (content === undefined) throw new ApiError(404, 'no listed skill has that path', 'not-found');
      return jsonResponse(SkillFileSchema.parse({ path, content }));
    },
  };
}
