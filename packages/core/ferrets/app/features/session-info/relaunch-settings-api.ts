/**
 * The dial behind Info › Runtime's "Running with older settings — Restart to apply": whether a Restart
 * would relaunch this ferret on different settings (`GET /v1/sessions/:id/relaunch-settings`; the
 * daemon side is `mounts/session-migrate.ts`, because a Restart is a migration onto the same login).
 *
 * The answer is PARSED through the shared schema, so a body this page cannot read is a failed read
 * rather than a claim about the ferret.
 */
import { type SessionRelaunchSettings, SessionRelaunchSettingsSchema } from '@ferretry/protocol';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { daemonRequest } from '../../lib/daemon-transport.ts';
import { type DaemonFetch, DaemonResponseError } from '../../lib/runtime-models.ts';

/** Reads one ferret's answer from exactly the daemon that owns it. */
export const readRelaunchSettings = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher: DaemonFetch,
  signal?: AbortSignal,
): Promise<SessionRelaunchSettings> => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('the connection does not own this session scope');
  const target = daemonRequest(daemon, `/v1/sessions/${encodeURIComponent(scope.sessionId)}/relaunch-settings`, {
    method: 'GET',
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  });
  const response = await fetcher(target.url, target.init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
    const message = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
    throw new DaemonResponseError(response.status, message, typeof body.code === 'string' ? body.code : undefined);
  }
  const parsed = SessionRelaunchSettingsSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new DaemonResponseError(502, 'the daemon answered with a body this page cannot read');
  return parsed.data;
};
