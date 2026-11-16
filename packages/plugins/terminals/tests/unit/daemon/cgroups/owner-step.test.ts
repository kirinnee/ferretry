import { describe, it } from 'bun:test';
import { GIBIBYTE } from '../../../../daemon/lib/protocol/limits.ts';
import should from 'should';
import { buildLimitsView, type CgroupHostFacts, ownerStep } from '../../../../daemon/lib/cgroups/index.ts';

/** This box: 61 GiB of RAM under a 48 GiB MemoryHigh set by a drop-in on the user slice. */
const CAPPED: CgroupHostFacts = {
  platform: 'linux',
  unifiedHierarchy: true,
  cpus: 32,
  physicalBytes: 61 * GIBIBYTE + 512 * 1024 ** 2,
  memoryCeilingBytes: 48 * GIBIBYTE,
  ceilingSource: 'memory.high of user-1000.slice',
  swapBytes: 0,
  ceilingCap: {
    unit: 'user-1000.slice',
    file: 'memory.high',
    dropIn: '/etc/systemd/system/user-1000.slice.d/50-devbox-memory.conf',
  },
};

describe('the one-time owner step', () => {
  it('should say what is capped, where it was set and what the ferrets get, then give the exact commands', () => {
    // Arrange / Act
    const actual = ownerStep(CAPPED, 1000);

    // Assert
    should(actual?.sentence).equal(
      'your user slice caps memory at 48 GiB (set in /etc/systemd/system/user-1000.slice.d/50-devbox-memory.conf); ferrets get 44 GiB. To give them RAM - 4 GiB, an owner runs:',
    );
    should(actual?.commands).deepEqual([
      'sudo mkdir -p /etc/systemd/system/user-1000.slice.d',
      "printf '[Slice]\\nMemoryHigh=61G\\nMemoryMax=infinity\\n' | sudo tee /etc/systemd/system/user-1000.slice.d/60-ferretry-memory.conf",
      'sudo systemctl daemon-reload',
      'sudo systemctl set-property user-1000.slice MemoryHigh=61G MemoryMax=infinity',
      'sudo systemctl set-property user@1000.service MemoryLow=4G',
    ]);
  });

  it('should say where it was set without a file when none was found, and name another unit as itself', () => {
    // Arrange
    const host = { ...CAPPED, ceilingCap: { unit: 'user.slice', file: 'memory.max' as const } };

    // Act
    const actual = ownerStep(host, 1000);

    // Assert
    should(actual?.sentence).startWith(
      'the user.slice limit caps memory at 48 GiB (set by your systemd configuration);',
    );
    should(actual?.commands[0]).equal('sudo mkdir -p /etc/systemd/system/user.slice.d');
  });

  it('should say nothing when nothing above the daemon holds the budget below the RAM, or off Linux', () => {
    // Arrange / Act / Assert
    should(ownerStep({ ...CAPPED, memoryCeilingBytes: CAPPED.physicalBytes, ceilingCap: undefined }, 1000)).equal(
      undefined,
    );
    should(ownerStep({ ...CAPPED, platform: 'darwin' }, 501)).equal(undefined);
  });

  it('should reach the status lines and the view, so the app and fy print the same words', () => {
    // Arrange / Act
    const view = buildLimitsView({
      config: {},
      host: CAPPED,
      enforcement: { kind: 'cgroups', ionice: true },
      disk: { scheduler: 'none' },
      services: { daemon: 1000, voiceState: 'not-running' as const },
      live: { throttled: [], fleetSlowed: false, killed: [], overBudget: [] },
      file: 'limits.yaml',
      uid: 1000,
      warnings: [],
      clock: iso => iso,
    });

    // Assert
    const step = ownerStep(CAPPED, 1000);
    should(view.lines).containEql(step?.sentence);
    should(view.lines).containEql('  sudo systemctl daemon-reload');
    should(view.ownerStep).deepEqual(step?.commands);
  });

  it('should leave the view without an owner step on a machine whose budget is its RAM', () => {
    // Arrange / Act
    const view = buildLimitsView({
      config: {},
      host: { ...CAPPED, memoryCeilingBytes: CAPPED.physicalBytes, ceilingCap: undefined },
      enforcement: { kind: 'cgroups', ionice: true },
      disk: {},
      services: { daemon: 1000, voiceState: 'not-running' as const },
      live: { throttled: [], fleetSlowed: false, killed: [], overBudget: [] },
      file: 'limits.yaml',
      uid: 1000,
      warnings: [],
      clock: iso => iso,
    });

    // Assert
    should(view.ownerStep).equal(undefined);
  });
});
