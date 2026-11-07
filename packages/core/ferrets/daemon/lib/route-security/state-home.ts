import { ApiError } from '@ferretry/kernel/contract';

/** Today's api/state-homes.ts holding seam: identity and link-hop checks belong to the kernel. */
export interface StateHomeLaunchReach {
  holding(path: string): Promise<string | undefined>;
}

/** Copied from today: an agent starts no child inside state home; an unresolved fence refuses the launch. */
export async function stateHomeLaunchRefusal(
  agent: boolean,
  reach: StateHomeLaunchReach | undefined,
  cwd: string,
): Promise<void> {
  if (!agent) return;
  const home = await (async () => {
    if (reach === undefined) throw new Error('no state home');
    return await reach.holding(cwd);
  })().catch(() => {
    throw new ApiError(
      503,
      'this daemon cannot resolve its own state home, so it does nothing for an agent that could reach it',
      'state_home_unresolved',
    );
  });
  if (home !== undefined)
    throw new ApiError(
      403,
      `a ferret never starts a session inside this daemon's state home (${home}), which holds this machine's credentials: choose a project folder`,
      'state_home',
    );
}
