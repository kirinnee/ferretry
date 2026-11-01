import type { StateHomes } from '@ferretry/fleet';
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
  /**
   * The home `path` is inside, judged the way the guard judges (`judgeOutsideStateHomes`): as named, at every link
   * hop, by real path and by IDENTITY up to `/` — so case folding and a bind mount do not hide it. `undefined` when
   * it is outside every home or not there at all; throws when the homes cannot be resolved.
   */
  holding(path: string): Promise<string | undefined>;
}

/**
 * Who asked for a start, as the boundary decided it (`callerIsAgent`): carried beside the request rather than in
 * it, because a body is the caller's to write. A start the daemon makes for itself (the Warden, Pack clean-up) has
 * no caller and is not an agent's.
 */
export interface StartCaller {
  readonly agent: boolean;
}

/** The daemon's own start: no agent asked for it. */
export const DAEMON_START: StartCaller = { agent: false };

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
  const home = await stateHomeHoldingCwd(reach, cwd).catch(() => {
    throw new ApiError(
      503,
      'this daemon cannot resolve its own state home, so it does nothing for an agent that could reach it',
      'state_home_unresolved',
    );
  });
  if (home !== undefined) throw new ApiError(403, stateHomeStartMessage(home), STATE_HOME_CODE);
}

/** The home a start's working folder is in, or `undefined`. Throws when the homes cannot be resolved. */
export async function stateHomeHoldingCwd(reach: StateHomeReach | undefined, cwd: string): Promise<string | undefined> {
  if (reach === undefined) throw new Error('no state home');
  return await reach.holding(cwd);
}

/** What a start refused for its folder is told. */
export const stateHomeStartMessage = (home: string): string =>
  `a ferret never starts a session inside this daemon's state home (${home}), which holds this machine's credentials: choose a project folder`;
