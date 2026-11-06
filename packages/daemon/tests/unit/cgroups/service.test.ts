import { describe, it } from 'bun:test';
import { GIBIBYTE, LimitsViewSchema } from '@ferretry/protocol';
import should from 'should';
import {
  type CgroupHostFacts,
  EnforcementRuntime,
  FLEET_SLICE,
  FleetMemoryWatcher,
  LimitsService,
  type LimitsServicePorts,
} from '../../../src/lib/cgroups/index.ts';

const HOST: CgroupHostFacts = {
  platform: 'linux',
  unifiedHierarchy: true,
  cpus: 32,
  physicalBytes: 61 * GIBIBYTE,
  memoryCeilingBytes: 48 * GIBIBYTE,
  ceilingSource: 'memory.high of user-1000.slice',
  swapBytes: 0,
};

async function subject(over: Partial<LimitsServicePorts> = {}) {
  const enforcement = new EnforcementRuntime(
    async () => ({ kind: 'cgroups', ionice: true }),
    () => 0,
  );
  const watcher = new FleetMemoryWatcher({
    fleet: { read: async () => undefined, largest: async () => [] },
    memory: { sessions: async () => [], total: async () => 0 },
    notes: { note: async () => undefined, callsign: async () => undefined },
    now: () => 0,
    iso: ms => new Date(ms).toISOString(),
  });
  await enforcement.current();
  return new LimitsService({
    limits: async () => ({}),
    host: HOST,
    enforcement,
    disk: { read: async () => ({ device: 'nvme0n1', scheduler: 'none' }) },
    services: { read: async () => ({ daemon: 1000, voice: 200, voiceState: 'running' }) },
    watcher,
    placements: { placement: async () => '0::/user.slice/user-1000.slice/user@1000.service/app.slice/fyd.service' },
    daemonPid: 4242,
    file: 'limits.yaml',
    uid: 1000,
    clock: iso => iso.slice(11, 16),
    ...over,
  });
}

describe('what the limits panel reads', () => {
  it('should give a view that parses, with no warning when the daemon sits outside the fleet slice', async () => {
    // Arrange / Act
    const view = await (await subject()).view();

    // Assert
    should(() => LimitsViewSchema.parse(view)).not.throw();
    should(view.warnings).deepEqual([]);
    should(view.lines[0]).containEql('44 GiB soft');
  });

  it('should warn when the daemon is inside the slice it caps', async () => {
    // Arrange
    const service = await subject({
      placements: { placement: async () => `0::/user.slice/user@1000.service/${FLEET_SLICE}/fyd.service` },
    });

    // Act
    const view = await service.view();

    // Assert
    should(view.warnings[0]).containEql('restart it outside the slice');
  });

  it('should say it could not prove where the daemon is, rather than say nothing', async () => {
    // Arrange
    const service = await subject({
      placements: {
        placement: async () => {
          throw new Error('no /proc');
        },
      },
    });

    // Act
    const view = await service.view();

    // Assert
    should(view.warnings[0]).containEql('could not prove this daemon is outside');
  });

  it('should show the weights the kernel holds for the daemon and the voice worker', async () => {
    // Arrange
    const service = await subject();

    // Act
    const view = await service.view();

    // Assert
    should(view.daemonCpuWeight).equal(1000);
    should(view.voiceCpuWeight).equal(200);
    should(view.voiceState).equal('running');
    should(view.lines[0]).containEql('(daemon 1000, voice 200)');
  });

  it('should say unknown, not a constant, when the weights cannot be read', async () => {
    // Arrange
    const service = await subject({
      services: {
        read: async () => {
          throw new Error('no cgroupfs');
        },
      },
    });

    // Act
    const view = await service.view();

    // Assert
    should(view.daemonCpuWeight).be.undefined();
    should(view.voiceCpuWeight).be.undefined();
    should(view.voiceState).equal('unknown');
    should(view.lines[0]).containEql('(daemon unknown, voice unknown)');
    should(() => LimitsViewSchema.parse(view)).not.throw();
  });

  it('should skip the proof off Linux, and survive an unreadable disk', async () => {
    // Arrange
    const service = await subject({
      host: { ...HOST, platform: 'darwin', unifiedHierarchy: false },
      disk: {
        read: async () => {
          throw new Error('no sysfs');
        },
      },
    });

    // Act
    const view = await service.view();

    // Assert
    should(view.warnings).deepEqual([]);
    should(view.platform).equal('darwin');
  });

  it('should report the last launch failure, once there was one', async () => {
    // Arrange
    const enforcement = new EnforcementRuntime(
      async () => ({ kind: 'cgroups', ionice: true }),
      () => 0,
    );
    await enforcement.current();
    enforcement.recordLaunchFailure('the user manager did not answer');

    // Act
    const view = await (await subject({ enforcement })).view();

    // Assert
    should(view.notEnforcedBecause).containEql('the user manager did not answer');
  });
});
