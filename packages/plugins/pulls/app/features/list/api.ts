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

/** Only what the screen reads of a project: its id and its name. Looser than Projects' own record on purpose. */
const ProjectNameSchema = z.looseObject({ id: z.string().min(1), name: z.string().min(1) });

/** Project names by id. A failure is an empty map: a project then shows by its short id, and the PRs still draw. */
export async function readNames(client: ListClient, signal?: AbortSignal): Promise<ReadonlyMap<string, string>> {
  try {
    const list = z
      .array(ProjectNameSchema)
      .parse(await client.call(PROJECTS_ROUTE, { quiet: true, ...(signal ? { signal } : {}) }));
    return new Map(list.map(project => [project.id, project.name]));
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
