/**
 * The routes that change configuration a screen shows WITHOUT changing a configuration file — a
 * login's state, a speed-up, an MCP sign-in — and the kinds each one moves (docs/config-files.md
 * "Live changes").
 *
 * A change to a file needs no row here: the load that finds it announces it, whoever made it. These
 * are the rest, and the fleet's apply, which is listed so another device hears about it at once rather
 * than when the watcher next finds the file. The WHOLE table is decorated, as the audit log is, so a
 * relayed request announces exactly like a direct one.
 *
 * A route announces only once it has answered with success: a refused change moved nothing.
 */

import type { ConfigChangeKind } from '@ferretry/protocol';
import type { ApiRoute } from '../api/route.ts';
import type { ConfigChangeSink } from './changes.ts';

export interface AnnouncedRouteRule {
  readonly method: ApiRoute['method'];
  readonly path: string;
  readonly kinds: readonly ConfigChangeKind[];
}

const FLEET: readonly ConfigChangeKind[] = ['files', 'machine', 'credentials', 'components', 'profiles', 'runtimes'];
const LOGIN: readonly ConfigChangeKind[] = ['credentials', 'runtimes'];
const SECRET: readonly ConfigChangeKind[] = ['speedups', 'credentials', 'runtimes'];

export const ANNOUNCED_ROUTES: readonly AnnouncedRouteRule[] = [
  { method: 'POST', path: '/v1/fleet/proposals/:proposalId/apply', kinds: FLEET },
  // Check now records the status word every runtime on the login reads.
  { method: 'POST', path: '/v1/fleet/credentials/:credentialId/check', kinds: LOGIN },
  { method: 'POST', path: '/v1/fleet/machine/tools/install', kinds: ['machine', 'speedups'] },
  { method: 'POST', path: '/v1/speedups/:provider/test', kinds: ['speedups'] },
  // A secret is what a speed-up's key is, and what a login's `${secret:NAME}` names: setting or removing one
  // moves both, though no file changed.
  { method: 'POST', path: '/v1/secrets', kinds: SECRET },
  { method: 'DELETE', path: '/v1/secrets/:name', kinds: SECRET },
  // An MCP sign-in is a component's state: the rail and the components page show it.
  { method: 'POST', path: '/v1/fleet/mcp-auth/flows/:flowId', kinds: ['components'] },
  { method: 'DELETE', path: '/v1/fleet/mcp-auth/:component', kinds: ['components'] },
];

/** Decorate every listed route so a success announces its kinds. Unlisted routes pass unchanged. */
export function configAnnouncedRoutes(
  sink: ConfigChangeSink,
  routes: readonly ApiRoute[],
  rules: readonly AnnouncedRouteRule[] = ANNOUNCED_ROUTES,
): readonly ApiRoute[] {
  return routes.map(route => {
    const rule = rules.find(candidate => candidate.method === route.method && candidate.path === route.path);
    if (rule === undefined) return route;
    return {
      ...route,
      handle: async context => {
        const response = await route.handle(context);
        if (response.status < 300) sink.announce(rule.kinds);
        return response;
      },
    };
  });
}
