import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { ferretStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import type { HostFactsPort } from '@ferretry/kernel/contract';
import * as hostFacts from '../../../daemon/adapters/cgroups/host-facts.ts';
import { SpawnCgroupCommands } from '../../../daemon/adapters/cgroups/spawn-cgroup-commands.ts';
import { buildTerminals } from '../../../daemon/index.ts';
import { EnforcementRuntime, FleetMemoryWatcher } from '../../../daemon/lib/cgroups/index.ts';
import { GIBIBYTE } from '../../../daemon/lib/protocol/limits.ts';
import manifest from '../../../manifest.ts';
import { ALL_ON, fakeFerrets, fakeVault, FERRET, ScriptedTmux } from '../../support/daemon/half.ts';

afterEach(() => mock.restore());

/** A daemon a test booted: the kernel's launch guard is armed, so the machine's real fleet slice is not its to touch. */
const armedHostFacts = {
  launchGuard: () => ({ active: true, searchPath: '/nonexistent' }),
} as unknown as HostFactsPort;

describe('a test daemon never reaches the machine fleet slice', () => {
  it('keeps limits off, whatever the home says: no host-manager command and no memory tick', async () => {
    spyOn(hostFacts, 'hostCgroupFacts').mockResolvedValue({
      platform: 'linux',
      unifiedHierarchy: true,
      cpus: 4,
      physicalBytes: 8 * GIBIBYTE,
      memoryCeilingBytes: 8 * GIBIBYTE,
      ceilingSource: 'fixture',
      swapBytes: 0,
    });
    spyOn(EnforcementRuntime.prototype, 'current').mockResolvedValue({ kind: 'cgroups', ionice: false });
    const execute = spyOn(SpawnCgroupCommands.prototype, 'execute').mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: '',
    });
    const tick = spyOn(FleetMemoryWatcher.prototype, 'tickLinux').mockResolvedValue(undefined);
    const ferrets = fakeFerrets();
    ferrets.effectiveLimits = async () => ({ enabled: true });
    const host = await testHost({
      hostFacts: armedHostFacts,
      plugins: [
        implementDaemon(manifest, {
          build: ctx =>
            buildTerminals(ctx, { tmux: new ScriptedTmux(), socketPath: '/fixture/state/terminals/tmux.sock' }),
        }),
      ],
      fakes: { ferrets, vault: fakeVault([]) },
      uses: { agentControl: ALL_ON },
      gate: new StandInAdmission(() => ferretStanding(FERRET)),
      spawn: () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
    });

    await host.tool('terminal_open', { name: 'dev' }).catch(() => undefined);
    await host.runJob('ferret-limits');

    expect(execute.mock.calls.some(([args]) => args.some(word => word.includes('ferretry_fleet')))).toBe(false);
    expect(tick).not.toHaveBeenCalled();
    await host.stop();
  });
});
