/**
 * The PRs screen, the wire half (r9 E3): the reads and the one write this folder makes, each parsed whole by E1/E2's
 * schemas so a shape the daemon did not mean is refused here instead of drawn wrong.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import { WatchOverviewSchema, type WatchOverview, type WatchPatch } from '../../../contract/index.ts';

/** What this folder needs of the generated client: calls, and the daemon's wake-ups. */
export type ListClient = Pick<PluginClient, 'call'> & Partial<Pick<PluginClient, 'subscribe'>>;

const WATCH_ROUTE = 'GET /v1/pulls/watch';
const PATCH_ROUTE = 'PATCH /v1/pulls/watch/:project';
/** Projects' own list, read by route key like every half that needs a project's name (it is not a dependency). */
const PROJECTS_ROUTE = 'GET /v1/projects';

export const readOverview = async (client: ListClient, signal?: AbortSignal): Promise<WatchOverview> =>
  WatchOverviewSchema.parse(await client.call(WATCH_ROUTE, { quiet: true, ...(signal ? { signal } : {}) }));

/** What the screen reads of a project: its id, its name and, when the record has one, the repositories last found in it. */
const ProjectFactsSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  repos: z.array(z.unknown()).optional(),
});

export interface ProjectFacts {
  readonly name: string;
  /** The project record says its folder holds no repository (a scan found none). Absent or unscanned is not "none". */
  readonly noRepo: boolean;
}

/** Project facts by id. A failure is an empty map: a project then shows by its short id, and the PRs still draw. */
export async function readProjects(
  client: ListClient,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, ProjectFacts>> {
  try {
    const list = z
      .array(ProjectFactsSchema)
      .parse(await client.call(PROJECTS_ROUTE, { quiet: true, ...(signal ? { signal } : {}) }));
    return new Map(list.map(project => [project.id, { name: project.name, noRepo: project.repos?.length === 0 }]));
  } catch {
    return new Map();
  }
}

/** Only `held` is read: the screen reads the truth again after a change, so the echoed `view` is not trusted or drawn. */
const PatchAnswerSchema = z.looseObject({ held: z.array(z.string().max(500)).max(20).optional() });

export interface PatchResult {
  /** The sentences the daemon says the owner must confirm first (a loosening change is held); none when it applied. */
  readonly held: readonly string[];
}

export async function patchWatch(client: ListClient, project: string, patch: WatchPatch): Promise<PatchResult> {
  const answer = PatchAnswerSchema.parse(await client.call(PATCH_ROUTE, { params: { project }, body: patch }));
  return { held: answer.held ?? [] };
}
