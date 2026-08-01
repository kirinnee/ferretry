/**
 * The session skills catalog read, bound to one paired daemon.
 *
 * Ported from kteam's `skillsRequest`/`loadSkillsCatalog`
 * (`ui/src/components/composer-autocomplete-providers.ts:137-162`), which
 * fetched a page-origin-relative `/v1/sessions/:id/skills` because the UI was
 * served BY the daemon. Ferretry's PWA is a public static site, so the daemon
 * origin arrives at runtime through pairing and every request goes through
 * `daemonRequest`.
 *
 * The catalog is required to be `(daemonId, sessionId)`-scoped, which is why
 * this takes a `DaemonSessionScope` rather than a bare session id: two paired
 * daemons routinely carry the same session id, and a `claude` session on one
 * has an entirely unrelated skills directory from a `claude` session on the
 * other.
 *
 * Sorting happens here, not on the screen, so the side pane and any future
 * autocomplete provider cannot drift into two different orders.
 */

import { SessionSkillsSchema } from '@ferretry/protocol';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { daemonRequest } from '../../lib/daemon-transport.ts';
import { type DaemonFetch, DaemonResponseError } from '../../lib/runtime-models.ts';
import type { SkillsCatalog } from './skills-catalog.ts';

const skillsPath = (sessionId: string): string => `/v1/sessions/${encodeURIComponent(sessionId)}/skills`;

const responseError = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

/**
 * Reads one session's catalog from exactly the daemon that owns the session.
 *
 * The connection is checked against the scope rather than trusted: a screen
 * that has switched daemons mid-flight would otherwise ask daemon B for daemon
 * A's session and render whatever came back.
 */
export const fetchSessionSkills = async (
  connection: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher: DaemonFetch = fetch,
  signal?: AbortSignal,
): Promise<SkillsCatalog> => {
  if (connection.daemonId !== scope.daemonId) throw new Error('the connection does not own this session scope');
  const request = daemonRequest(connection, skillsPath(scope.sessionId), signal === undefined ? {} : { signal });
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await responseError(response);
  const catalog = SessionSkillsSchema.parse(await response.json());
  return {
    harness: catalog.harness,
    skills: [...catalog.skills].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }),
    ),
  };
};

/** The loader shape the surface takes, so a test never needs a transport. */
export type SkillsCatalogLoader = (scope: DaemonSessionScope, signal: AbortSignal) => Promise<SkillsCatalog>;

/** Binds a live connection into the loader the surface expects. */
export const skillsCatalogLoader =
  (connection: DaemonConnection, fetcher: DaemonFetch = fetch): SkillsCatalogLoader =>
  (scope, signal) =>
    fetchSessionSkills(connection, scope, fetcher, signal);
