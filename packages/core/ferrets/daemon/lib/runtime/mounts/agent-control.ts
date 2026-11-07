import { isAgentCaller } from '../../api/agent-caller.ts';
import { ApiError } from '../../api/error.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import type { SocketRoute } from '../../api/socket.ts';
import { controlRefusal } from '../../agent-tools/policy.ts';
import type { AgentControlKind, AgentControlPolicy } from '../../fleet/agent-control.ts';

/**
 * "WHAT AGENTS MAY CONTROL", ON EVERY ROUTE AN AGENT CAN REACH — not only on the agent tools.
 *
 * The tools ask the machine's switches themselves. But an agent that identifies itself (`peer:`, or a
 * warden) can also reach the ordinary surface routes — open a terminal, attach to one, drive the
 * browser, read the session's files — and a switch that only bound the tools would be a switch an
 * agent walks around. So every route whose capability is a terminal, the browser or the filesystem is
 * wrapped here: for an agent caller, the matching switch is read fresh and an "off" is refused with the
 * sentence naming the setting. A person — the CLI, the app, a paired device — is never asked.
 *
 * The switches still bind honest clients only: an agent holding the host token and not identifying
 * itself reads as the person at the machine (see `isHumanAdminActor`). They describe what Ferretry
 * offers agents, not a sandbox.
 */

const KIND_OF_CAPABILITY: Readonly<Record<string, AgentControlKind>> = {
  terminal: 'terminal',
  browser: 'browser',
  filesystem: 'files',
};

async function gate(policy: AgentControlPolicy, kind: AgentControlKind, context: RouteContext): Promise<void> {
  if (!isAgentCaller(context) || (await policy.allows(kind))) return;
  throw new ApiError(403, controlRefusal(kind), 'agent_control_off');
}

/** The request/response table, with each surface route asking the switch for an agent caller. */
export function agentControlledRoutes(policy: AgentControlPolicy, routes: readonly ApiRoute[]): readonly ApiRoute[] {
  return routes.map(route => {
    const kind = route.capability === undefined ? undefined : KIND_OF_CAPABILITY[route.capability.capability];
    if (kind === undefined) return route;
    return {
      ...route,
      handle: async context => {
        await gate(policy, kind, context);
        return await route.handle(context);
      },
    };
  });
}

/** The socket table, the same way: an agent attaching to a terminal or the browser asks first. */
export function agentControlledSockets(
  policy: AgentControlPolicy,
  routes: readonly SocketRoute[],
): readonly SocketRoute[] {
  return routes.map(route => {
    const kind = route.capability === undefined ? undefined : KIND_OF_CAPABILITY[route.capability.capability];
    if (kind === undefined) return route;
    return {
      ...route,
      accept: async context => {
        await gate(policy, kind, context);
        return await route.accept(context);
      },
    };
  });
}
