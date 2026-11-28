/**
 * The tool installer as this daemon composes it: the service, over the daemon's command lookups, its system fact and the
 * real package-manager run.
 *
 * It lives apart from the host assembly so a test can build THIS composition over a fake spawn and a fake lookup: the
 * property it pins is that the install's own check is made from a FRESH lookup, never from the answer cached before the
 * manager ran.
 */
import type { Clock, SpawnPort } from '@ferretry/kernel/contract';
import type { CommandCache } from './command-cache.ts';
import type { HostPlatform } from './host-platform.ts';
import { packageRunner } from './package-run.ts';
import { supportedKinds } from '../lib/harness-kind.ts';
import type { HarnessLocation } from '../lib/service/foreign.ts';
import { ToolInstallService } from '../lib/service/tool-install.ts';

/** The commands an install looks up afresh: the harnesses, and the managers it chooses among. */
const INSTALL_LOOKUPS: readonly string[] = [...supportedKinds(), 'npm', 'brew', 'apt-get'];

export function toolInstaller(deps: {
  readonly commands: Pick<CommandCache, 'which' | 'refresh'>;
  readonly platform: Pick<HostPlatform, 'name' | 'prime'>;
  readonly spawn: () => SpawnPort | undefined;
  readonly clock: Clock;
  readonly timeoutMinutes?: number;
}): ToolInstallService {
  const { commands, platform } = deps;
  return new ToolInstallService({
    // Runtimes declares no `hostFacts`: the system is asked once with `uname -s`, primed with the command lookups.
    platform: () => platform.name(),
    executables: { resolve: name => commands.which(name), runnable: () => false },
    locate: (kind): HarnessLocation => {
      const path = commands.which(kind);
      return path === undefined ? { kind, outcome: 'absent', searched: [] } : { kind, outcome: 'located', path };
    },
    // Past the cache, both before an install plans and after the manager ran: a cached "not found" must neither hide the
    // manager from the install nor hide the tool from the check that follows it.
    refresh: async () => {
      await Promise.all([commands.refresh(INSTALL_LOOKUPS), platform.prime()]);
    },
    run: packageRunner(() => {
      const spawn = deps.spawn();
      if (spawn === undefined) throw new Error('this daemon gives no way to start a program');
      return spawn;
    }, deps.clock),
    // The manager's own directory goes first (tool-install.ts); this is the system part a daemon with a minimal PATH lacks.
    environment: { PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' },
    ...(deps.timeoutMinutes === undefined ? {} : { timeoutMinutes: deps.timeoutMinutes }),
  });
}
