/**
 * THE APP'S HALF OF PROJECT REGISTRATION.
 *
 * `@ferretry/plugin-projects/contract` OWNS BOTH DIRECTIONS. The request is parsed by `RegisterProjectRequestSchema`
 * before it is sent and the answer by `ProjectInfoSchema`, so a draft this app assembled wrongly is refused here
 * rather than becoming a 422 the reader has to interpret, and there is no third declaration of either shape.
 *
 * REGISTERING IS IDEMPOTENT BY DESIGN, and the caller has to be able to tell. The daemon answers a folder it already
 * holds with the RECORD IT ALREADY HELD — same `id`, original `createdAt`, original `source` — rather than minting a
 * second one. So a 200 does not prove anything was created, and a surface that says "added" over an existing record is
 * lying in the one case a reader most needs the truth. `alreadyRegistered` is the comparison that separates the two,
 * made against the rows the app already has.
 */
import {
  type ProjectInfo,
  ProjectInfoSchema,
  ProjectListSchema,
  type RegisterProjectRequest,
  RegisterProjectRequestSchema,
} from '../../contract/index.ts';
import type { ProjectsClient } from './client.ts';

export const LIST_ROUTE = 'GET /v1/projects';
export const REGISTER_ROUTE = 'POST /v1/projects';
export const REMOVE_ROUTE = 'DELETE /v1/projects/:id';

/** The registry, parsed whole: a row keeps its `id`, `source`, `createdAt` and git attachment. */
export const fetchProjects = async (client: ProjectsClient): Promise<readonly ProjectInfo[]> =>
  ProjectListSchema.parse(await client.call(LIST_ROUTE));

/**
 * Registers one folder on exactly the paired daemon and answers with the record that daemon now holds for it. Every
 * variant of the request goes through this one call, including `confirmed-discovery`: confirming a folder a ferret
 * used is the same deliberate write as adding one by hand, and a second entry point would be the first step towards a
 * scan that enrols without being asked.
 */
export const registerProject = async (client: ProjectsClient, request: RegisterProjectRequest): Promise<ProjectInfo> =>
  ProjectInfoSchema.parse(await client.call(REGISTER_ROUTE, { body: RegisterProjectRequestSchema.parse(request) }));

/** Forgets one project (the folder is left alone) and answers the record removed. */
export const removeProject = async (client: ProjectsClient, id: string): Promise<ProjectInfo> =>
  ProjectInfoSchema.parse(await client.call(REMOVE_ROUTE, { params: { id } }));

/**
 * Whether the daemon's answer is a folder it had already registered, decided by record `id` against the rows already
 * read — `id` is what the registry treats as identity; a path is not one.
 *
 * IT PROVES ONE DIRECTION ONLY. `true` means this app had already read that record. `false` means it had not — which
 * covers "the daemon created it just now" AND "the registry could not be read at all". So a surface may say "already
 * registered" on `true` and must not turn `false` into "created".
 */
export const alreadyRegistered = (known: readonly ProjectInfo[], answered: ProjectInfo): boolean =>
  known.some(project => project.id === answered.id);
