import { FerretSearchQuerySchema } from '@ferretry/core-ferrets/contract';
import {
  ApiError,
  type CallContext,
  decodeParameter,
  jsonResponse,
  queryValue,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import {
  DEFAULT_PROJECT_FILE_MATCHES,
  MAX_PROJECT_FILE_MATCHES,
  type ProjectFilesAnswer,
  type ProjectFilesStatus,
  ProjectIdSchema,
  type ProjectInfo,
} from '../../../contract/index.ts';
import type { ProjectRegistry } from '../../lib/registry.ts';
import { belowHome } from '../folders/fence.ts';
import { outsideHomeGate } from '../folders/outside-gate.ts';
import { ProjectFolderRefused } from './build.ts';
import { type CachedStatus, IndexCacheBusy, type ProjectIndexCache } from './cache.ts';
import { searchFiles } from './search.ts';

/** The project a request names, or the 400/404 that says why not. */
async function projectOf(registry: ProjectRegistry, raw: string | undefined): Promise<ProjectInfo> {
  const id = ProjectIdSchema.safeParse(decodeParameter(raw ?? ''));
  if (!id.success) throw new ApiError(400, 'the project id in the path is not usable', 'invalid_project_id');
  const project = await registry.find(id.data);
  if (project === undefined) throw new ApiError(404, `no project ${id.data}`, 'not-found');
  return project;
}

/** `?q=` as the finder takes it: absent or empty lists the top of the index; text is validated like every file search. */
function queryOf(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = FerretSearchQuerySchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, 'the search text is not usable', 'invalid_query');
  return parsed.data;
}

/** `?limit=`: a whole number from 1 to {@link MAX_PROJECT_FILE_MATCHES}. */
function limitOf(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PROJECT_FILE_MATCHES;
  const limit = /^\d{1,4}$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROJECT_FILE_MATCHES)
    throw new ApiError(400, `limit is a whole number from 1 to ${String(MAX_PROJECT_FILE_MATCHES)}`, 'invalid_limit');
  return limit;
}

/** A folder that cannot be indexed is told apart: private (403) from not there (404). Nothing else is said about it. */
function refusal(error: unknown): never {
  if (error instanceof ProjectFolderRefused)
    throw error.reason === 'private'
      ? new ApiError(403, 'this project folder is private and is not indexed', 'project_folder_private')
      : new ApiError(404, 'this project folder is not available', 'project_folder_unavailable');
  if (error instanceof IndexCacheBusy)
    throw new ApiError(503, 'the file index is busy building other projects; try again shortly', 'index_busy');
  throw error;
}

/** Where a registered path really is: the owner's home, and what a path resolves to (`undefined`: nothing is there). */
export interface FilePlace {
  readonly home: () => Promise<string>;
  readonly resolve: (path: string) => Promise<string | undefined>;
}

/**
 * Asked before ANY of the three routes touches the cache or starts a build (owner decision D3, the gate U4 built for the
 * folder explorer and the repository scan): a project folder OUTSIDE the home is read only by a caller that passes
 * `filesystem.configure` (a passkey step-up for a remote device; the caller at the machine is ungoverned, and the gate says
 * so from how the request ARRIVED). The decision is on the registered spelling AND on where it really resolves, before
 * anything is read or answered from memory; it is made once per request, so a step-up is spent once.
 *
 * Then a registered place that resolves somewhere else is no longer the project: what was indexed there is forgotten and
 * nothing is answered from memory (nor is a rebuild started on it).
 */
async function admit(
  call: CallContext,
  cache: ProjectIndexCache,
  project: ProjectInfo,
  place: FilePlace,
): Promise<void> {
  const home = await place.home();
  let decided: Promise<void> | undefined;
  const gate = (): Promise<void> => {
    decided ??= outsideHomeGate(call)();
    return decided;
  };
  if (belowHome(project.path, home) === undefined) await gate();
  const resolved = await place.resolve(project.path);
  if (resolved !== undefined && belowHome(resolved, home) === undefined) await gate();
  if (resolved === project.path.replace(/(?<=.)\/+$/u, '')) return;
  cache.evict(project.id);
  throw new ProjectFolderRefused('unavailable');
}

const statusOf = (held: CachedStatus): ProjectFilesStatus => ({
  rebuilding: held.rebuilding,
  ...(held.index === undefined ? {} : { index: held.index.summary }),
});

/**
 * `GET /v1/projects/:id/files?q=<text>&limit=<1..200, default 50>`: the best matches in the project's file index, and what
 * the index could and could not see. The FIRST read of a project waits for its build; later ones answer from memory.
 * Search runs here, so a phone over a relay is sent a few rows and never the list.
 */
export const filesRoute =
  (registry: ProjectRegistry, cache: ProjectIndexCache, place: FilePlace): RouteHandler =>
  async call => {
    for (const [name] of call.request.query) {
      if (name !== 'q' && name !== 'limit')
        throw new ApiError(400, `unknown files parameter ${name}`, 'unknown_parameter');
    }
    const project = await projectOf(registry, call.params.get('id'));
    const query = queryOf(queryValue(call.request, 'q'));
    const limit = limitOf(queryValue(call.request, 'limit'));
    const held = await admit(call, cache, project, place)
      .then(() => cache.read(project.id, project.path))
      .catch(refusal);
    const matches = searchFiles(held.index.files, query, limit);
    const answer: ProjectFilesAnswer = {
      files: [...matches.files],
      total: matches.total,
      rebuilding: held.rebuilding,
      index: held.index.summary,
    };
    return jsonResponse(answer);
  };

/** `GET /v1/projects/:id/files/status`: the coverage block alone, never waiting for a build, for a badge. */
export const filesStatusRoute =
  (registry: ProjectRegistry, cache: ProjectIndexCache, place: FilePlace): RouteHandler =>
  async call => {
    const project = await projectOf(registry, call.params.get('id'));
    const held = await admit(call, cache, project, place)
      .then(() => cache.status(project.id, project.path))
      .catch(refusal);
    return jsonResponse(statusOf(held));
  };

/** `POST /v1/projects/:id/files/rescan`: starts a rebuild (or joins the one running) and answers at once. */
export const filesRescanRoute =
  (registry: ProjectRegistry, cache: ProjectIndexCache, place: FilePlace): RouteHandler =>
  async call => {
    const project = await projectOf(registry, call.params.get('id'));
    const held = await admit(call, cache, project, place)
      .then(() => cache.rescan(project.id, project.path))
      .catch(refusal);
    return jsonResponse(statusOf(held));
  };
