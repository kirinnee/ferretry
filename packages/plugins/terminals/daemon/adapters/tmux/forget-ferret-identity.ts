import { FERRET_IDENTITY_VARIABLES } from '../../lib/session/lifecycle/policy.ts';
import type { TmuxCommandPort } from '../../lib/tmux/contracts.ts';

/**
 * Clears every ferret identity variable from the tmux server's GLOBAL environment, at boot.
 *
 * The daemon drops them from its own environment (`dropFerretIdentity`), but its tmux server outlives it: a
 * server first started by an earlier daemon that was itself started inside a ferret's pane still holds that
 * ferret's `FY_SESSION_TOKEN`, and every terminal it opens without `-e` inherits it. Session panes are not at
 * risk (they are handed their own credential and id explicitly); terminals are.
 *
 * `set-environment -g -u` never starts a server: with none running, each call fails and there is nothing to
 * clear. A failure is never a boot failure. Answers the names the server confirmed it no longer holds.
 */
export async function forgetFerretIdentity(tmux: TmuxCommandPort): Promise<readonly string[]> {
  const cleared: string[] = [];
  for (const name of FERRET_IDENTITY_VARIABLES) {
    const result = await tmux.execute(['set-environment', '-g', '-u', name]).catch(() => undefined);
    if (result?.code === 0) cleared.push(name);
  }
  return cleared;
}
