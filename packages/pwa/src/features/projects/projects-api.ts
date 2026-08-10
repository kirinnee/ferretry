/**
 * THE BROWSER'S HALF OF PROJECT REGISTRATION.
 *
 * `POST /v1/projects` has been served since the registry landed and, until this
 * module, nothing anywhere dialled it: the only way to enrol a folder was to
 * hand-edit the daemon's `projects.json`. This is the first client, which is why
 * the change that introduces it also deletes that route's line from
 * `scripts/validate/route-agreement-allowlist.txt`.
 *
 * `@ferretry/protocol` OWNS BOTH DIRECTIONS. The request is parsed by
 * `RegisterProjectRequestSchema` before it is sent and the answer by
 * `ProjectInfoSchema`, so a draft this browser assembled wrongly is refused here
 * rather than becoming a 422 the reader has to interpret, and there is no third
 * declaration of either shape to drift.
 *
 * REGISTERING IS NOT IDEMPOTENT-BY-LUCK, IT IS IDEMPOTENT BY DESIGN, and the
 * caller has to be able to tell. The daemon answers a folder it already holds
 * with the RECORD IT ALREADY HELD — same `id`, original `createdAt`, original
 * `source` — rather than minting a second one. So a 200 does not prove anything
 * was created, and a surface that says "added" over an existing record is lying
 * in the one case a reader most needs the truth: they thought this folder was
 * new. `registeredProjectOutcome` is the comparison that separates the two, made
 * against the rows the browser already has.
 */

import {
  ProjectInfoSchema,
  type ProjectInfo,
  RegisterProjectRequestSchema,
  type RegisterProjectRequest,
} from '@ferretry/protocol';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { daemonRequest } from '../../lib/daemon-transport.ts';
import type { FleetProject } from '../../lib/fleet-grouping.ts';
import { browserFetch, type DaemonFetch, DaemonResponseError } from '../../lib/runtime-models.ts';

export const PROJECT_REGISTRY_PATH = '/v1/projects';

const responseError = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

/**
 * Registers one folder on exactly the paired daemon and answers with the record
 * that daemon now holds for it.
 *
 * Every variant of the request goes through this one call, including
 * `confirmed-discovery`: confirming a folder a session used is the same
 * deliberate write as adding one by hand, and giving it a second entry point
 * would be the first step towards a scan that enrols without being asked.
 */
export const registerProject = async (
  connection: DaemonConnection,
  request: RegisterProjectRequest,
  fetcher: DaemonFetch = browserFetch,
): Promise<ProjectInfo> => {
  const sent = daemonRequest(connection, PROJECT_REGISTRY_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(RegisterProjectRequestSchema.parse(request)),
  });
  const response = await fetcher(sent.url, sent.init);
  if (!response.ok) throw await responseError(response);
  return ProjectInfoSchema.parse(await response.json());
};

/**
 * Whether the daemon's answer is a folder it had already registered.
 *
 * Decided by record `id` against the rows this browser already read, because
 * `id` is what the registry treats as identity — `ProjectInfoSchema` says in as
 * many words that a path is not one. Comparing paths instead would call a
 * genuinely new record "already registered" whenever a reader typed a path that
 * resolves to a folder registered under a different spelling, and that is the
 * exact case where the dedupe is worth reporting rather than hiding.
 *
 * IT PROVES ONE DIRECTION ONLY. `true` means this browser had already read that
 * record. `false` means it had not — which covers "the daemon created it just
 * now" AND "the registry could not be read at all", and those are different
 * facts. So a surface may say "already registered" on `true` and must not turn
 * `false` into "created": the honest sentence there names the folder and claims
 * nothing about which of the two happened.
 */
export const alreadyRegistered = (known: readonly FleetProject[], answered: ProjectInfo): boolean =>
  known.some(project => project.id === answered.id);
