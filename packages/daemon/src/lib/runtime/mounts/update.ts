import type { AuditedRouteRule } from '../../audit/routes.ts';
import type { HarnessUpdateSubsystem } from '../../harness-update/index.ts';
import type { DaemonUpdateSubsystem } from '../../update/index.ts';
import type { ModuleContribution } from '../modules.ts';
import { daemonUpdateRoutes } from './daemon-update.ts';
import { harnessUpdateRoutes } from './harness-update.ts';

/**
 * The security log's rules for the update module's mutating routes.
 *
 * Updating this machine runs new code on it, and turning on automatic updates lets it do so unasked: both are
 * kept as changes to the machine's security, like its settings. Updating an agent CLI puts new code on the machine
 * that every new ferret then runs as.
 */
const UPDATE_AUDIT_RULES: readonly AuditedRouteRule[] = [
  { method: 'POST', path: '/v1/daemon/update', event: 'security.changed', fixedSubject: 'daemon-update' },
  { method: 'POST', path: '/v1/harnesses/update', event: 'security.changed', fixedSubject: 'harness-update' },
  {
    method: 'PATCH',
    path: '/v1/daemon/update/settings',
    event: 'security.changed',
    fixedSubject: 'daemon-update-settings',
    responseSettings: [],
  },
];

/**
 * What the update module adds to the daemon: the daemon's own update, then the agent CLIs'.
 *
 * Every daemon-update path is a fixed literal under `/v1/daemon`, and every harness-update path under
 * `/v1/harnesses`; neither prefix is used by any other subsystem, so no table can shadow or be shadowed by
 * anything around it.
 */
export function updateContribution(
  daemon: DaemonUpdateSubsystem,
  harnesses: HarnessUpdateSubsystem,
): ModuleContribution {
  return {
    routes: [...daemonUpdateRoutes(daemon), ...harnessUpdateRoutes(harnesses)],
    audit: { routes: UPDATE_AUDIT_RULES },
  };
}
