/**
 * A proved-agent resolver over a fixed fleet, for the suites that draw agent references without a chat page around them.
 * The chat's own `:agent` proof is `app/chat/reference-surface.ts` (Ferrets' addressing rule); a suite that draws a
 * single row drives the renderer's linked branch through the shell's `agentReferenceResolver` port with this: a ferret
 * is proved by its id or its callsign.
 */

import type { AgentReferenceResolver, DaemonId } from '@ferretry/app';
import type { FerretView } from '@ferretry/core-ferrets/contract';

export const fleetAgentResolver =
  (daemonId: DaemonId, fleet: readonly FerretView[]): AgentReferenceResolver =>
  ({ sessionId, name }) => {
    const found = fleet.find(
      view =>
        (sessionId !== undefined && view.config.id === sessionId) ||
        (name !== undefined && view.config.teammate?.toLowerCase() === name),
    );
    if (found === undefined) return null;
    return { daemonId, sessionId: found.config.id, name: found.config.teammate ?? found.config.id };
  };
