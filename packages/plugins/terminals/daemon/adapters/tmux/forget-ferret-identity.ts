/** The variables a ferret's own pane carries (its token, board capability and id): never left on the server. */
const FERRET_IDENTITY_VARIABLES = ['FY_SESSION_TOKEN', 'FY_SESSION_BOARD_CAPABILITY', 'FY_SESSION_ID'] as const;
import type { TmuxCommandPort } from '../../lib/tmux/contracts.ts';
import { TIMED_OUT, within } from './bounded.ts';
import type { ControlTimer } from './control-tmux-process.ts';

/** How long one `set-environment` client may take at boot before the scrub gives up on a wedged server. */
export const IDENTITY_SCRUB_TIMEOUT_MS = 2_000;

/**
 * How long the scrub waits for each client. The port it is handed must kill each child at the same bound
 * (`boundedSpawn`), so a client left behind on a wedged server is killed rather than left running.
 */
export interface IdentityScrubBound {
  readonly after: ControlTimer;
  readonly timeoutMs: number;
  /** Told once, when a client did not answer in time; the scrub then asks nothing more. */
  readonly stalled: () => void;
}

/**
 * Clears every ferret identity variable from the tmux server's GLOBAL environment, at boot.
 *
 * The daemon drops them from its own environment (`dropFerretIdentity`), but its tmux server outlives it: a
 * server first started by an earlier daemon that was itself started inside a ferret's pane still holds that
 * ferret's `FY_SESSION_TOKEN`, and every terminal it opens without `-e` inherits it. Session panes are not at
 * risk (they are handed their own credential and id explicitly); terminals are.
 *
 * `set-environment -g -u` never starts a server: with none running, each call fails and there is nothing to
 * clear. A failure is never a boot failure. Answers the names the server confirmed it no longer holds. With a
 * `bound`, a server that does not answer one client in time is asked nothing more: one wedged server costs one
 * bound, not one per name.
 */
export async function forgetFerretIdentity(
  tmux: TmuxCommandPort,
  bound?: IdentityScrubBound,
): Promise<readonly string[]> {
  const cleared: string[] = [];
  for (const name of FERRET_IDENTITY_VARIABLES) {
    const asked = tmux.execute(['set-environment', '-g', '-u', name]).catch(() => undefined);
    const result = bound === undefined ? await asked : await within(asked, bound.timeoutMs, bound.after);
    if (result === TIMED_OUT) {
      bound?.stalled();
      break;
    }
    if (result?.code === 0) cleared.push(name);
  }
  return cleared;
}
