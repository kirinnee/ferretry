import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { LimitsFile } from '@ferretry/core-ferrets/contract';
import { ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import * as hostFacts from '../../../daemon/adapters/cgroups/host-facts.ts';
import { SpawnCgroupCommands } from '../../../daemon/adapters/cgroups/spawn-cgroup-commands.ts';
import { buildTerminals } from '../../../daemon/index.ts';
import { CgroupLaunchPlanner, EnforcementRuntime, FleetMemoryWatcher } from '../../../daemon/lib/cgroups/index.ts';
import { GIBIBYTE, LimitsViewSchema } from '../../../daemon/lib/protocol/limits.ts';
import manifest from '../../../manifest.ts';
import { fakeFerrets, fakeVault, FERRET, ScriptedTmux } from '../../support/daemon/half.ts';

afterEach(() => mock.restore());

async function subject(effectiveLimits?: () => Promise<LimitsFile>, platform = 'linux') {
  spyOn(hostFacts, 'hostCgroupFacts').mockResolvedValue({
    platform,
    unifiedHierarchy: platform === 'linux',
    cpus: 4,
    physicalBytes: 8 * GIBIBYTE,
    memoryCeilingBytes: 8 * GIBIBYTE,
    ceilingSource: 'fixture',
    swapBytes: 0,
  });
  const commands: { program: string; args: readonly string[] }[] = [];
  const tmux = new ScriptedTmux();
  let caller: 'ferret' | 'owner' = 'ferret';
  const ferrets = fakeFerrets();
  if (effectiveLimits !== undefined) ferrets.effectiveLimits = effectiveLimits;
  const plugin = implementDaemon(manifest, {
    build: ctx => buildTerminals(ctx, { tmux, socketPath: '/fixture/state/terminals/tmux.sock' }),
  });
  const host = await testHost({
    plugins: [plugin],
    fakes: { ferrets, vault: fakeVault([]) },
    gate: new StandInAdmission(() => (caller === 'ferret' ? ferretStanding(FERRET) : ownerStanding())),
    spawn: (program, args) => {
      commands.push({ program, args });
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    },
  });
  return {
    host,
    tmux,
    commands,
    asOwner: () => {
      caller = 'owner';
    },
    asFerret: () => {
      caller = 'ferret';
    },
  };
}

const launched = (calls: (readonly string[])[]) => {
  const argv = calls.findLast(call => call[0] === 'new-session') ?? [];
  return argv.slice(argv.indexOf('-y') + 2, argv.indexOf(';'));
};

describe('production Terminals resource composition', () => {
  it('passes the agent opener and terminal launch kind through the default runtime and uses the limited argv', async () => {
    const command = spyOn(CgroupLaunchPlanner.prototype, 'command').mockImplementation(async (_ferret, argv) => [
      'limited-shell',
      ...argv,
    ]);
    const { host, tmux } = await subject();

    const result = await host.tool('terminal_open', { name: 'dev' });

    expect(result.isError).not.toBe(true);
    expect(command).toHaveBeenCalledTimes(1);
    expect(command.mock.calls[0]?.[0]).toBe(FERRET);
    expect(command.mock.calls[0]?.[2]).toEqual({ terminal: true });
    expect(launched(tmux.calls)[0]).toBe('limited-shell');
    expect(launched(tmux.calls).at(-1)).toBe('-l');
    await host.stop();
  });

  it('keeps person-opened shells exempt from the planner', async () => {
    const command = spyOn(CgroupLaunchPlanner.prototype, 'command');
    const { host, tmux, asOwner } = await subject();
    asOwner();

    const result = await host.request('POST', `/v1/ferrets/${FERRET}/terminals`, { body: {} });

    expect(result.status).toBe(201);
    expect(command).not.toHaveBeenCalled();
    expect(launched(tmux.calls)).toHaveLength(2);
    expect(launched(tmux.calls).at(-1)).toBe('-l');
    await host.stop();
  });

  it('reads the effective lower caps afresh for launches, the status view and the memory watcher', async () => {
    let config: LimitsFile = {
      enabled: true,
      ionice: false,
      fleet: { memoryHigh: '1G', memoryMax: '2G' },
      perFerret: { memoryHigh: '256M', memoryMax: '512M' },
    };
    const read = mock(async () => config);
    // Fixture enforcement: no real system manager is involved.
    spyOn(EnforcementRuntime.prototype, 'current').mockResolvedValue({ kind: 'cgroups', ionice: false });
    const execute = spyOn(SpawnCgroupCommands.prototype, 'execute').mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: '',
    });
    const tick = spyOn(FleetMemoryWatcher.prototype, 'tickLinux').mockResolvedValue(undefined);
    const { host, tmux, asOwner, asFerret } = await subject(read);

    const opened = await host.tool('terminal_open', { name: 'dev' });
    expect(opened.isError).not.toBe(true);
    expect(execute.mock.calls.some(([args]) => args.includes('MemoryHigh=1073741824'))).toBe(true);
    expect(execute.mock.calls.some(([args]) => args.includes('MemoryMax=536870912'))).toBe(true);

    asOwner();
    const response = await host.request('GET', '/v1/cgroups/config');
    expect(response.status).toBe(200);
    const view = LimitsViewSchema.parse(JSON.parse(response.body));
    expect(view.explicit).toBe(true);
    expect(view.configured?.fleet.memoryMaxBytes).toBe(2 * GIBIBYTE);
    expect(view.configured?.perFerret.memoryMaxBytes).toBe(GIBIBYTE / 2);
    expect(view.warnings.join(' ')).not.toContain('built-in defaults');

    const reads = read.mock.calls.length;
    await host.runJob('ferret-limits');
    expect(read.mock.calls.length).toBe(reads + 1);
    expect(tick).toHaveBeenCalledTimes(1);

    config = { enabled: false };
    await host.runJob('ferret-limits');
    expect(tick).toHaveBeenCalledTimes(1);
    const disabled = await host.request('GET', '/v1/cgroups/config');
    expect(LimitsViewSchema.parse(JSON.parse(disabled.body)).switchedOn).toBe(false);
    asFerret();
    const limitedCommands = execute.mock.calls.length;
    expect((await host.tool('terminal_open', { name: 'disabled' })).isError).not.toBe(true);
    expect(launched(tmux.calls)).toHaveLength(2);
    expect(execute.mock.calls.length).toBe(limitedCommands);
    await host.stop();
  });

  it('passes the effective memory caps to the macOS memory watcher on each tick', async () => {
    const tick = spyOn(FleetMemoryWatcher.prototype, 'tickWatch').mockResolvedValue(undefined);
    const { host } = await subject(async () => ({ perFerret: { memoryHigh: '256M', memoryMax: '512M' } }), 'darwin');

    await host.runJob('ferret-limits');

    expect(tick).toHaveBeenCalledTimes(1);
    expect(tick.mock.calls[0]?.[0].perFerret.memoryHigh).toBe(GIBIBYTE / 4);
    expect(tick.mock.calls[0]?.[0].perFerret.memoryMax).toBe(GIBIBYTE / 2);
    await host.stop();
  });

  it('honors explicit enabled true by refusing an unconfined agent terminal', async () => {
    spyOn(EnforcementRuntime.prototype, 'current').mockResolvedValue({
      kind: 'direct',
      reason: 'fixture: no user manager',
      ionice: false,
    });
    const { host, tmux } = await subject(async () => ({ enabled: true }));

    await expect(host.tool('terminal_open', { name: 'dev' })).rejects.toThrow('cannot be applied');
    expect(tmux.calls.some(call => call[0] === 'new-session')).toBe(false);
    await host.stop();
  });

  it('honors enabled false in the planner and discloses defaults when the provider is absent', async () => {
    const disabled = await subject(async () => ({ enabled: false }));
    expect((await disabled.host.tool('terminal_open', { name: 'dev' })).isError).not.toBe(true);
    expect(launched(disabled.tmux.calls)).toHaveLength(2);
    await disabled.host.stop();

    const defaults = await subject();
    defaults.asOwner();
    const response = await defaults.host.request('GET', '/v1/cgroups/config');
    const view = LimitsViewSchema.parse(JSON.parse(response.body));
    expect(view.switchedOn).toBe(true);
    expect(view.explicit).toBe(false);
    expect(view.warnings).toContain('Ferrets does not provide effective limits; using built-in defaults.');
    await defaults.host.stop();
  });
});
