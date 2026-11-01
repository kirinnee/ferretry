import { type StateHomes, stateHomeByName } from '@ferretry/fleet';
import { isAgentCaller } from './agent-caller.ts';
import { ApiError } from './error.ts';
import type { RouteContext } from './route.ts';

/**
 * The daemon's own directories — its state home, then its state and config directories — as the disk has
 * them now, through the one state-home guard (`@ferretry/fleet`'s `resolveStateHomes`). The port a route asks
 * before it reads or starts anything for an AGENT in a folder of its choosing (docs/agent-tools.md § "The
 * state home").
 */
export interface StateHomeReach {
  /** Every directory, resolved now. Throws when one cannot be: the caller then refuses (fail closed). */
  resolve(): Promise<StateHomes>;
  /** The real path of `path`, or `undefined` when nothing is there yet. */
  realpath(path: string): Promise<string | undefined>;
}

/** The code an agent's start in the state home is refused with. */
const STATE_HOME_CODE = 'state_home';

/** The homes resolved, or the refusal an agent gets when they cannot be. */
export async function resolvedStateHomes(reach: StateHomeReach | undefined): Promise<StateHomes> {
  try {
    if (reach === undefined) throw new Error('no state home');
    return await reach.resolve();
  } catch {
    throw new ApiError(
      503,
      'this daemon cannot resolve its own state home, so it does nothing for an agent that could reach it',
      'state_home_unresolved',
    );
  }
}

/**
 * Refuses an AGENT's start of a session whose working folder is inside the daemon's state home — named
 * there, or reached through a link. A session's folder is what its agent reads and writes freely, so a
 * ferret that could start one in `~/.ferretry` would hand its child the tokens and the vault key. A person
 * is unchanged: the owner may start a session anywhere.
 */
export async function stateHomeLaunchRefusal(
  context: RouteContext,
  reach: StateHomeReach | undefined,
  cwd: string | undefined,
): Promise<void> {
  if (cwd === undefined || !isAgentCaller(context)) return;
  const homes = await resolvedStateHomes(reach);
  const real = await reach?.realpath(cwd).catch(() => undefined);
  const verdict = [cwd, ...(real === undefined ? [] : [real])]
    .map(path => stateHomeByName(homes, path))
    .find(answer => answer.inside);
  if (verdict?.inside === true)
    throw new ApiError(
      403,
      `a ferret never starts a session inside this daemon's state home (${verdict.home}), which holds this machine's credentials: choose a project folder`,
      STATE_HOME_CODE,
    );
}
