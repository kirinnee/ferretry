/**
 * The skills on ONE machine, regardless of any session, PATH INCLUDED: what My catalogs' Publish skills picker lists
 * (`GET /v1/skills`). The picker names a skill by its SKILL.md path, which is what publishing takes; a skill another
 * one of the same name hides (`shadowedBy`) is still listed there, because a person may publish it on purpose.
 */

import { MachineSkillsInventorySchema, type SkillEntry } from '@ferretry/protocol';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { daemonRequest } from '../../lib/daemon-transport.ts';
import { browserFetch, type DaemonFetch, DaemonResponseError } from '../../lib/runtime-models.ts';

const responseError = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

/** Every skill on this machine as the inventory lists it: the account homes first, then the projects. */
export const fetchMachineSkillEntries = async (
  connection: DaemonConnection,
  fetcher: DaemonFetch = browserFetch,
  signal?: AbortSignal,
): Promise<readonly SkillEntry[]> => {
  const request = daemonRequest(connection, '/v1/skills', signal === undefined ? {} : { signal });
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await responseError(response);
  const inventory = MachineSkillsInventorySchema.parse(await response.json());
  return [...inventory.homes.flatMap(home => home.skills), ...inventory.projects.flatMap(project => project.skills)];
};

/** Reads this machine's skills, path included. A seam for tests and the harness. */
export type MachineSkillEntriesLoader = (signal: AbortSignal) => Promise<readonly SkillEntry[]>;
