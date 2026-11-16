import type { AgentControlReader, FerretId } from '@ferretry/kernel/contract';
import type { AgentControlPolicy } from './service.ts';

/**
 * "What agents may control" for the browser tools: asks core's `AgentControlPort` (Ferrets, the ONE reader of the
 * owner's switches), fresh on every call, so a switch the owner turns off applies to the ferret's very next act.
 *
 * Fails closed: the port unbound (Ferrets not serving), a port lookup that throws, a reader that throws, or any answer that is not exactly
 * `true` refuses. `reader` is read on every call, never captured, because the port binds after build.
 */
export function agentControlPolicy(reader: () => AgentControlReader | undefined): AgentControlPolicy {
  return {
    allows: async (ferret, kind) => {
      try {
        // Inside the `try`: the kernel's `uses.current()` can itself throw while a plugin is still building.
        const bound = reader();
        if (bound === undefined) return false;
        return (await bound.allows(ferret as FerretId, kind)) === true;
      } catch {
        return false;
      }
    },
  };
}
