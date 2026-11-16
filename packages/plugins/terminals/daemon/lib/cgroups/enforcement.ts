/**
 * What this machine can actually enforce right now, found out by asking — not by assuming.
 *
 * LIMITS ARE ON BY DEFAULT and degrade LOUDLY. Linux with the unified hierarchy is not enough: the
 * scope launch needs the user's systemd manager to answer, and a host with the hierarchy but no
 * reachable manager (a system service, a container, a plain `su`) would otherwise fail EVERY session
 * start. So the daemon probes once at boot and again after any launch that fails; when the manager is
 * unreachable it launches directly, as it always did, and the status says "limits not enforced:
 * <reason>". An owner who WROTE `enabled: true` in `limits.yaml` asked for a guarantee instead, and
 * keeps the old behaviour: the launch fails rather than run unlimited (see `launch.ts`).
 *
 * Every wrapper is proven before it is used (`ionice -c2 -n7 true`), because a wrapper that is missing
 * or refuses its flags would turn every ferret start into an error.
 */

import { failureText } from './apply.ts';
import type { CgroupCommandPort, CgroupHostFacts } from './ports.ts';
import { IONICE_PROBE, MACOS_NICE_PROBE, MACOS_PROBE, USER_MANAGER_PROBE } from './scope.ts';
import { cgroupsSupported } from './support.ts';

/** How a launch is to be wrapped, as proven. */
export type EnforcementState =
  | {
      readonly kind: 'cgroups';
      /** `ionice` works on this host. */
      readonly ionice: boolean;
    }
  | {
      /** macOS: lower CPU priority only. `taskpolicy` is the QoS clamp; `nice` is all that is left without it. */
      readonly kind: 'priority';
      readonly wrapper: 'taskpolicy' | 'nice' | 'none';
    }
  | {
      /** Nothing is enforced, and this is why, in words. */
      readonly kind: 'direct';
      readonly reason: string;
      /** `ionice` still works without cgroups. */
      readonly ionice: boolean;
    };

/** Asks the host what it can enforce. */
export async function probeEnforcement(host: CgroupHostFacts, commands: CgroupCommandPort): Promise<EnforcementState> {
  const works = async (argv: readonly string[]): Promise<boolean> =>
    await commands.execute(argv).then(
      result => result.code === 0,
      () => false,
    );
  if (host.platform === 'darwin') {
    if (await works(MACOS_PROBE)) return { kind: 'priority', wrapper: 'taskpolicy' };
    return { kind: 'priority', wrapper: (await works(MACOS_NICE_PROBE)) ? 'nice' : 'none' };
  }
  if (host.platform !== 'linux')
    return { kind: 'direct', reason: `${host.platform} has no resource-limit support`, ionice: false };
  const ionice = await works(IONICE_PROBE);
  if (!cgroupsSupported(host))
    return {
      kind: 'direct',
      reason: 'this Linux does not use the unified cgroup hierarchy (cgroup v2)',
      ionice,
    };
  try {
    const manager = await commands.execute(USER_MANAGER_PROBE);
    if (manager.code !== 0)
      return {
        kind: 'direct',
        reason: `the user’s systemd manager does not answer (${manager.stderr.trim() || `exit ${manager.code}`})`,
        ionice,
      };
  } catch (error) {
    return { kind: 'direct', reason: `the user’s systemd manager could not be asked (${failureText(error)})`, ionice };
  }
  return { kind: 'cgroups', ionice };
}
