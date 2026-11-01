/**
 * The skills on ONE machine, regardless of any session: the Sharing page's Skills tab.
 *
 * `SkillsSurface` was written for a session's catalog. The machine-wide inventory (`GET /v1/skills`) says
 * the same thing about every runtime home and project, so it is folded here into that one catalog shape
 * rather than giving the surface a second input. A skill that exists in both harnesses is one row marked
 * `both`; a skill another skill of the same name hides (`shadowedBy`) is not what the harness loads, so it
 * is left out.
 */

import { MachineSkillsInventorySchema, type SkillEntry } from '@ferretry/protocol';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { daemonRequest } from '../../lib/daemon-transport.ts';
import { browserFetch, type DaemonFetch, DaemonResponseError } from '../../lib/runtime-models.ts';
import type { SkillsCatalogLoader } from './skills-api.ts';
import type { SkillsCatalog } from './skills-catalog.ts';

/** The stand-in session id: the surface wants a `(daemon, session)` pair and a machine has no session. */
export const MACHINE_SKILLS_SESSION = 'machine';

type CatalogSkill = SkillsCatalog['skills'][number];

const responseError = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

/** Folds the machine inventory into one name-sorted catalog; exported so the fold has a direct test. */
export const machineSkillsCatalog = (entries: readonly SkillEntry[]): SkillsCatalog => {
  const byKey = new Map<string, CatalogSkill>();
  for (const entry of entries) {
    if (entry.shadowedBy !== undefined) continue;
    const scope = entry.scope === 'project' ? 'project' : 'global';
    const key = `${scope}:${entry.name}`;
    const known = byKey.get(key);
    if (known === undefined) {
      byKey.set(key, { name: entry.name, description: entry.description, scope, origin: entry.harness });
    } else if (known.origin !== entry.harness) {
      byKey.set(key, { ...known, origin: 'both' });
    }
  }
  return {
    harness: 'claude',
    skills: [...byKey.values()].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }),
    ),
  };
};

export const fetchMachineSkills = async (
  connection: DaemonConnection,
  fetcher: DaemonFetch = browserFetch,
  signal?: AbortSignal,
): Promise<SkillsCatalog> => {
  const request = daemonRequest(connection, '/v1/skills', signal === undefined ? {} : { signal });
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await responseError(response);
  const inventory = MachineSkillsInventorySchema.parse(await response.json());
  return machineSkillsCatalog([
    ...inventory.homes.flatMap(home => home.skills),
    ...inventory.projects.flatMap(project => project.skills),
  ]);
};

/** Binds one machine into the loader the surface expects; the scope's session id is only a placeholder. */
export const machineSkillsLoader =
  (connection: DaemonConnection, fetcher: DaemonFetch = browserFetch): SkillsCatalogLoader =>
  (_scope, signal) =>
    fetchMachineSkills(connection, fetcher, signal);
