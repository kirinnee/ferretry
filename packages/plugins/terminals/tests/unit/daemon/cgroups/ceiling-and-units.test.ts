import { describe, it } from 'bun:test';
import { GIBIBYTE, resolveLimits } from '../../../../daemon/lib/protocol/limits.ts';
import should from 'should';
import {
  ancestorPaths,
  type CgroupHostFacts,
  eventsGrowth,
  ferretScopeProperties,
  fleetSliceProperties,
  memoryCeiling,
  ownCgroupPath,
  parseMemoryCap,
  parseMemoryEvents,
  parseSwapTotal,
  sessionOfScope,
  userManagerPath,
} from '../../../../daemon/lib/cgroups/index.ts';

/** This box: 61 GiB of RAM, a 48 GiB MemoryHigh on the user slice, 32 cores. */
const THIS_BOX: CgroupHostFacts = {
  platform: 'linux',
  unifiedHierarchy: true,
  cpus: 32,
  physicalBytes: 61 * GIBIBYTE,
  memoryCeilingBytes: 48 * GIBIBYTE,
  ceilingSource: 'memory.high of user-1000.slice',
  swapBytes: 32 * GIBIBYTE,
};

describe('the memory budget', () => {
  const own = '/user.slice/user-1000.slice/user@1000.service/app.slice/fyd.service';

  it('should read the daemon’s own cgroup path out of /proc/self/cgroup text', () => {
    // Arrange / Act / Assert
    should(ownCgroupPath(`0::${own}\n`)).equal(own);
    should(ownCgroupPath('12:memory:/legacy\n')).equal(undefined);
    should(ownCgroupPath('')).equal(undefined);
  });

  it('should list every ancestor, root-most first, the cgroup itself last', () => {
    // Arrange / Act
    const actual = ancestorPaths('/a/b/c');

    // Assert
    should(actual).deepEqual(['/a', '/a/b', '/a/b/c']);
  });

  it('should treat `max` and junk as no cap', () => {
    // Arrange / Act / Assert
    should(parseMemoryCap('max\n')).equal(undefined);
    should(parseMemoryCap('')).equal(undefined);
    should(parseMemoryCap('51539607552\n')).equal(48 * GIBIBYTE);
    should(parseMemoryCap('9223372036854771712')).equal(undefined);
  });

  it('should take the smallest finite cap above the daemon: 48 GiB on a 61 GiB machine', () => {
    // Arrange
    const caps = [
      { path: '/user.slice', file: 'memory.high' as const, bytes: 58 * GIBIBYTE },
      { path: '/user.slice/user-1000.slice', file: 'memory.high' as const, bytes: 48 * GIBIBYTE },
      { path: '/user.slice/user-1000.slice', file: 'memory.max' as const, bytes: 60 * GIBIBYTE },
    ];

    // Act
    const actual = memoryCeiling(61 * GIBIBYTE, caps);

    // Assert
    should(actual).match({ bytes: 48 * GIBIBYTE, source: 'memory.high of user-1000.slice' });
    should(actual.cap?.path).equal('/user.slice/user-1000.slice');
  });

  it('should fall back to the machine’s memory when nothing above is capped', () => {
    // Arrange / Act
    const actual = memoryCeiling(16 * GIBIBYTE, []);

    // Assert
    should(actual.bytes).equal(16 * GIBIBYTE);
    should(actual.source).equal('the machine’s memory');
  });

  it('should find the user manager the fleet slice lives under', () => {
    // Arrange / Act / Assert
    should(userManagerPath(own)).equal('/user.slice/user-1000.slice/user@1000.service');
    should(userManagerPath('/system.slice/fyd.service')).equal(undefined);
  });

  it('should read swap in bytes', () => {
    // Arrange / Act / Assert
    should(parseSwapTotal('MemTotal: 1 kB\nSwapTotal:  8388604 kB\n')).equal(8388604 * 1024);
    should(parseSwapTotal('MemTotal: 1 kB\n')).equal(0);
  });
});

describe('the unit properties for this box', () => {
  const resolved = resolveLimits({}, { memoryCeilingBytes: THIS_BOX.memoryCeilingBytes });

  it('should put the worked example on the fleet slice, with the quota written empty so a removed one is removed', () => {
    // Arrange / Act
    const actual = fleetSliceProperties(resolved.fleet, THIS_BOX);

    // Assert — 44 GiB soft (budget − 4), 46 GiB hard (budget − 2), 4.8 GiB swap.
    should(actual).deepEqual([
      'CPUWeight=50',
      'CPUQuota=',
      `MemoryHigh=${44 * GIBIBYTE}`,
      `MemoryMax=${46 * GIBIBYTE}`,
      `MemorySwapMax=${Math.floor(4.8 * GIBIBYTE)}`,
      'TasksMax=16384',
    ]);
  });

  it('should give a ferret its share and leave the quota off by default', () => {
    // Arrange / Act
    const sub = ferretScopeProperties(resolved.perFerret, THIS_BOX, false);

    // Assert
    should(sub).deepEqual([
      'CPUWeight=100',
      'CPUQuota=',
      `MemoryHigh=${12 * GIBIBYTE}`,
      `MemoryMax=${Math.floor(14.4 * GIBIBYTE)}`,
      'TasksMax=4096',
    ]);
  });

  it('should weigh a ferret a person started above a sub-ferret', () => {
    // Arrange / Act
    const mine = ferretScopeProperties(resolved.perFerret, THIS_BOX, true);

    // Assert
    should(mine[0]).equal('CPUWeight=200');
  });

  it('should turn an operator’s quota into a share of the WHOLE machine', () => {
    // Arrange
    const limits = resolveLimits(
      { fleet: { cpuPercent: 50 }, perFerret: { cpuPercent: 25 } },
      { memoryCeilingBytes: 48 * GIBIBYTE },
    );

    // Act
    const fleet = fleetSliceProperties(limits.fleet, THIS_BOX);
    const ferret = ferretScopeProperties(limits.perFerret, THIS_BOX, false);

    // Assert — 50 % of 32 CPUs is 16 of them: 1600 %.
    should(fleet).containEql('CPUQuota=1600%');
    should(ferret).containEql('CPUQuota=800%');
  });

  it('should write infinity for a cap the operator took away', () => {
    // Arrange
    const limits = resolveLimits(
      { fleet: { memoryMax: 'infinity', tasksMax: 'infinity' } },
      { memoryCeilingBytes: 48 * GIBIBYTE },
    );

    // Act
    const actual = fleetSliceProperties(limits.fleet, THIS_BOX);

    // Assert
    should(actual).containEql('MemoryMax=infinity');
    should(actual).containEql('TasksMax=infinity');
  });
});

describe('memory.events', () => {
  const text = 'low 0\nhigh 5\nmax 0\noom 1\noom_kill 1\noom_group_kill 0\n';

  it('should read the four counters', () => {
    // Arrange / Act
    const actual = parseMemoryEvents(text);

    // Assert
    should(actual).deepEqual({ high: 5, max: 0, oom: 1, oomKill: 1 });
  });

  it('should refuse text that is not counters', () => {
    // Arrange / Act / Assert
    should(parseMemoryEvents('')).equal(undefined);
    should(parseMemoryEvents('nope')).equal(undefined);
  });

  it('should treat a first look as a baseline and a smaller number as no growth', () => {
    // Arrange
    const now = { high: 5, max: 0, oom: 1, oomKill: 1 };

    // Act
    const first = eventsGrowth(undefined, now);
    const reset = eventsGrowth({ high: 9, max: 0, oom: 4, oomKill: 3 }, now);
    const grew = eventsGrowth({ high: 2, max: 0, oom: 1, oomKill: 0 }, now);

    // Assert
    should(first).deepEqual({ high: 0, max: 0, oom: 0, oomKill: 0 });
    should(reset).deepEqual({ high: 0, max: 0, oom: 0, oomKill: 0 });
    should(grew).deepEqual({ high: 3, max: 0, oom: 0, oomKill: 1 });
  });
});

describe('finding a session from its scope', () => {
  it('should read the session id back out of the scope name', () => {
    // Arrange / Act / Assert
    should(sessionOfScope('ferretry-agent-0a1b2c3d-4e5f-6789-abcd-ef0123456789-a1b2c3d4.scope')).equal(
      '0a1b2c3d-4e5f-6789-abcd-ef0123456789',
    );
    should(sessionOfScope('tmux-spawn-1.scope')).equal(undefined);
  });
});
