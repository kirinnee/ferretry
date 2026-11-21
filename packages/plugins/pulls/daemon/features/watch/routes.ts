import {
  ApiError,
  type CallContext,
  decodeParameter,
  errorResponse,
  jsonResponse,
  parseBody,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import type { GitAccount } from '@ferretry/plugin-git-accounts/contract';
import type { ProjectInfo } from '@ferretry/plugin-projects/contract';
import {
  nextSetting,
  PULLS_CODES,
  PullsConfigDef,
  settingsOf,
  WatchOverviewSchema,
  WatchPatchSchema,
  WatchProjectIdSchema,
  type PullsConfig,
} from '../../../contract/index.ts';
import type { ConfigDoor } from './config-door.ts';
import { hasReader } from './repos.ts';
import type { WatchService } from './service.ts';

const BODY_LIMIT = { maxBytes: 4 * 1024 } as const;

export interface WatchRouteDeps {
  readonly service: WatchService;
  readonly door: ConfigDoor | undefined;
  readonly config: () => PullsConfig | undefined;
  readonly projects: () => Promise<readonly ProjectInfo[]>;
  readonly accounts: () => Promise<readonly GitAccount[]>;
}

/**
 * `GET /v1/pulls/watch`: every project's watch status (and the choices it is under); `PATCH /v1/pulls/watch/:project`:
 * turn a project's watch on or off and choose which events notify, written to `config/pulls.yaml` through the kernel's
 * door (so the file stays the source of truth, comments kept). The PATCH names only what changes.
 */
export function watchRoutes(deps: WatchRouteDeps) {
  return {
    'GET /v1/pulls/watch': async () => jsonResponse(WatchOverviewSchema.parse(await deps.service.overview())),

    'PATCH /v1/pulls/watch/:project': async (call: CallContext) => {
      const id = WatchProjectIdSchema.safeParse(decodeParameter(call.params.get('project') ?? ''));
      const project = id.success ? (await deps.projects()).find(each => each.id === id.data) : undefined;
      if (!id.success || project === undefined) throw new ApiError(404, 'no such project', PULLS_CODES.notFound);
      const patch = await parseBody(call.request, WatchPatchSchema, BODY_LIMIT);
      if (deps.door === undefined)
        return errorResponse(503, 'this daemon cannot change its settings yet', PULLS_CODES.refused);
      const config = deps.config();
      const own = config?.projects[id.data];
      // Only what the patch names changes: a notify-only patch keeps the stored watch (absent stays the default).
      const next = nextSetting(own, patch);
      const written = await deps.door.write(PullsConfigDef, undefined, {
        patch: { projects: { ...(config?.projects ?? {}), [id.data]: next } },
      });
      if (written.kind === 'refused')
        return errorResponse(422, `the setting was refused: ${written.reason}`, PULLS_CODES.refused, {
          issues: written.issues,
        });
      const view = {
        project: id.data,
        ...settingsOf(
          { projects: { [id.data]: next } as PullsConfig['projects'] },
          id.data,
          hasReader(project, await deps.accounts()),
        ),
      };
      return written.kind === 'held' ? jsonResponse({ held: written.sentences, view }, 202) : jsonResponse({ view });
    },
  } satisfies Record<string, RouteHandler>;
}
