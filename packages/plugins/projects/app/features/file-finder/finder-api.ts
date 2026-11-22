/**
 * THE FINDER'S THREE ROUTES (&F6061 U5's wire, read here). Every answer is parsed by the contract's own schema, so the
 * finder never draws a shape the daemon did not promise, and a refusal reaches the page as the daemon worded it.
 *
 * Search runs on the daemon: a phone is sent the top matches (50 by default), never the list of every file.
 */
import {
  DEFAULT_PROJECT_FILE_MATCHES,
  type ProjectFilesAnswer,
  ProjectFilesAnswerSchema,
  type ProjectFilesStatus,
  ProjectFilesStatusSchema,
} from '../../../contract/index.ts';
import type { ProjectsClient } from '../../lib/client.ts';

const FILES_ROUTE = 'GET /v1/projects/:id/files';
const STATUS_ROUTE = 'GET /v1/projects/:id/files/status';
const RESCAN_ROUTE = 'POST /v1/projects/:id/files/rescan';

/** The best matches for `query` (empty lists the top of the index). */
export const findFiles = async (
  client: ProjectsClient,
  projectId: string,
  query: string,
  limit: number = DEFAULT_PROJECT_FILE_MATCHES,
  signal?: AbortSignal,
): Promise<ProjectFilesAnswer> =>
  ProjectFilesAnswerSchema.parse(
    await client.call(FILES_ROUTE, {
      params: { id: projectId },
      query: { ...(query === '' ? {} : { q: query }), limit: String(limit) },
      ...(signal === undefined ? {} : { signal }),
    }),
  );

/** Whether a build is running and what the last one saw, never waiting for one. */
export const filesStatus = async (
  client: ProjectsClient,
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectFilesStatus> =>
  ProjectFilesStatusSchema.parse(
    await client.call(STATUS_ROUTE, { params: { id: projectId }, ...(signal === undefined ? {} : { signal }) }),
  );

/** Starts a rebuild (or joins the one running) and answers at once. */
export const rescanFiles = async (client: ProjectsClient, projectId: string): Promise<ProjectFilesStatus> =>
  ProjectFilesStatusSchema.parse(await client.call(RESCAN_ROUTE, { params: { id: projectId } }));
