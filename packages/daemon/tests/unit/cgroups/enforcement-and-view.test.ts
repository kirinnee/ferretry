import { describe, it } from 'bun:test';
import { GIBIBYTE, LimitsViewSchema } from '@ferretry/protocol';
import should from 'should';
import {
  buildLimitsView,
  type CgroupCommandPort,
  type CgroupHostFacts,
  diskEffect,
  EnforcementRuntime,
  type EnforcementState,
  formatBytes,
  probeEnforcement,
  REPROBE_INTERVAL_MS,
} from '../../../src/lib/cgroups/index.ts';

const THIS_BOX: CgroupHostFacts = {
  platform: 'linux',
  unifiedHierarchy: true,
  cpus: 32,
  physicalBytes: 61 * GIBIBYTE,
  memoryCeilingBytes: 48 * GIBIBYTE,
  ceilingSource: 'memory.high of user-1000.slice',
  swapBytes: 32 * GIBIBYTE,
  pidMax: 4_194_304,
};

/** Answers each probe argv by its executable, so a test says which tools "exist". */
const tools = (answers: Readonly<Record<string, { code: number; stderr?: string } | 'throw'>>): CgroupCommandPort => ({
  execute: async argv => {
    const key = argv[0] === 'systemctl' ? 'systemctl' : argv[0] === 'nice' ? 'nice' : (argv[0] as string);
    const answer = answers[key] ?? { code: 127, stderr: 'not found' };
    if (answer === 'throw') throw new Error('spawn failed');
    return { code: answer.code, stdout: '', stderr: answer.stderr ?? '' };
  },
});

describe('probing what the machine can enforce', () => {
  it('should find cgroups with a user manager and ionice', async () => {
    // Arrange / Act
    const actual = await probeEnforcement(THIS_BOX, tools({ systemctl: { code: 0 }, ionice: { code: 0 } }));

    // Assert
    should(actual).deepEqual({ kind: 'cgroups', ionice: true });
  });

  it('should degrade, with the manager’s own words, when the user manager does not answer', async () => {
    // Arrange / Act
    const actual = await probeEnforcement(
      THIS_BOX,
      tools({ systemctl: { code: 1, stderr: 'Failed to connect to bus: No medium found' }, ionice: { code: 0 } }),
    );

    // Assert
    should(actual.kind).equal('direct');
    should((actual as { reason: string }).reason).match(/Failed to connect to bus/u);
    should((actual as { ionice: boolean }).ionice).equal(true);
  });

  it('should take a probe that cannot even start as “not available”', async () => {
    // Arrange / Act
    const actual = await probeEnforcement(THIS_BOX, tools({ systemctl: { code: 0 }, ionice: 'throw' }));

    // Assert
    should(actual).deepEqual({ kind: 'cgroups', ionice: false });
  });

  it('should degrade when the hierarchy is not cgroup v2', async () => {
    // Arrange / Act
    const actual = await probeEnforcement({ ...THIS_BOX, unifiedHierarchy: false }, tools({ systemctl: { code: 0 } }));

    // Assert
    should(actual.kind).equal('direct');
    should((actual as { reason: string }).reason).match(/cgroup v2/u);
  });

  it('should degrade when asking the manager throws', async () => {
    // Arrange / Act
    const actual = await probeEnforcement(THIS_BOX, tools({ systemctl: 'throw', ionice: { code: 0 } }));

    // Assert
    should(actual.kind).equal('direct');
  });

  it('should only use ionice if the exact wrapper runs', async () => {
    // Arrange / Act
    const actual = await probeEnforcement(THIS_BOX, tools({ systemctl: { code: 0 }, ionice: { code: 1 } }));

    // Assert
    should(actual).deepEqual({ kind: 'cgroups', ionice: false });
  });

  it('should pick the macOS wrapper that works: taskpolicy, else nice, else none', async () => {
    // Arrange
    const mac = { ...THIS_BOX, platform: 'darwin', unifiedHierarchy: false };

    // Act
    const both = await probeEnforcement(mac, tools({ taskpolicy: { code: 0 }, nice: { code: 0 } }));
    const niceOnly = await probeEnforcement(mac, tools({ taskpolicy: { code: 1 }, nice: { code: 0 } }));
    const neither = await probeEnforcement(mac, tools({}));

    // Assert
    should(both).deepEqual({ kind: 'priority', wrapper: 'taskpolicy' });
    should(niceOnly).deepEqual({ kind: 'priority', wrapper: 'nice' });
    should(neither).deepEqual({ kind: 'priority', wrapper: 'none' });
  });
});

describe('a platform with nothing to enforce', () => {
  it('should say so, and run no command', async () => {
    // Arrange
    const run: string[][] = [];

    // Act
    const actual = await probeEnforcement(
      { ...THIS_BOX, platform: 'win32' },
      { execute: async argv => (run.push([...argv]), { code: 0, stdout: '', stderr: '' }) },
    );

    // Assert
    should(actual).deepEqual({ kind: 'direct', reason: 'win32 has no resource-limit support', ionice: false });
    should(run).deepEqual([]);
  });
});

describe('the probe, kept', () => {
  const cgroups: EnforcementState = { kind: 'cgroups', ionice: true };

  it('should have no answer before the first probe, and the same one after it', async () => {
    // Arrange
    const runtime = new EnforcementRuntime(
      async () => cgroups,
      () => 0,
    );

    // Act
    const before = runtime.last();
    await runtime.current();

    // Assert
    should(before).equal(undefined);
    should(runtime.last()).equal(cgroups);
  });

  it('should probe once and share one probe between concurrent callers', async () => {
    // Arrange
    let probes = 0;
    const runtime = new EnforcementRuntime(
      async () => {
        probes += 1;
        return cgroups;
      },
      () => 0,
    );

    // Act
    await Promise.all([runtime.current(), runtime.current(), runtime.current()]);
    await runtime.current();

    // Assert
    should(probes).equal(1);
  });

  it('should ask again after a failure, but not on every one', async () => {
    // Arrange
    let probes = 0;
    let now = 0;
    const runtime = new EnforcementRuntime(
      async () => {
        probes += 1;
        return cgroups;
      },
      () => now,
    );
    await runtime.current();

    // Act
    await runtime.afterFailure();
    now += REPROBE_INTERVAL_MS + 1;
    await runtime.afterFailure();

    // Assert
    should(probes).equal(2);
  });
});

describe('saying it in plain words', () => {
  const live = { throttled: [], killed: [], overBudget: [] };
  const base = {
    config: {},
    host: THIS_BOX,
    enforcement: { kind: 'cgroups', ionice: true } as EnforcementState,
    disk: { device: 'nvme0n1', scheduler: 'none' },
    live,
    file: 'limits.yaml',
    uid: 1000,
    warnings: [],
    clock: (iso: string) => iso.slice(11, 16),
  };

  it('should say what is in force for this box, to the word', () => {
    // Arrange / Act
    const view = buildLimitsView(base);

    // Assert
    should(view.lines[0]).equal(
      'ferrets: memory 44 GiB soft / 46 GiB hard of a 48 GiB user budget · CPU weight 50 (daemon 100, voice 200) · disk priority: no effect on this disk (scheduler none)',
    );
    should(view.enforcement).equal('cgroups');
    should(view.disk.effect).equal('none');
    should(() => LimitsViewSchema.parse(view)).not.throw();
  });

  it('should say how many ferrets are slowed and who was killed, and when', () => {
    // Arrange
    const live2 = {
      throttled: [{ sessionId: 's1', callsign: 'gertrude' }, { sessionId: 's2' }, { sessionId: 's3' }],
      killed: [
        {
          sessionId: 's1',
          callsign: 'gertrude',
          at: '2026-11-05T23:04:00Z',
          what: 'bun test',
          bytes: Math.floor(9.1 * GIBIBYTE),
        },
      ],
      overBudget: [],
    };

    // Act
    const view = buildLimitsView({ ...base, live: live2 });

    // Assert
    should(view.lines).containEql('3 ferrets slowed for memory now: gertrude, s2, s3');
    should(view.lines).containEql('killed for memory: gertrude 23:04 (bun test, 9.1 GiB)');
  });

  it('should say what disk priority does on each kind of scheduler, or that it is off or missing', () => {
    // Arrange / Act
    const text = (over: Partial<typeof base>) => buildLimitsView({ ...base, ...over }).lines[0];
    const bfq = text({ disk: { device: 'sda', scheduler: 'bfq' } });
    const deadline = text({ disk: { device: 'sda', scheduler: 'mq-deadline' } });
    const off = text({ config: { ionice: false } });
    const missing = text({ enforcement: { kind: 'cgroups', ionice: false } as EnforcementState });

    // Assert
    should(bfq).containEql('ferrets read and write at the lowest priority (scheduler bfq)');
    should(deadline).containEql('works by class only (scheduler mq-deadline)');
    should(off).containEql('disk priority: switched off');
    should(missing).containEql('not available on this machine (no ionice)');
  });

  it('should name a killed ferret with no callsign and no process', () => {
    // Arrange / Act
    const view = buildLimitsView({
      ...base,
      live: { ...live, killed: [{ sessionId: 's1', at: '2026-11-05T23:04:00Z' }] },
    });

    // Assert
    should(view.lines).containEql('killed for memory: a ferret 23:04');
  });

  it('should say a single ferret in the singular', () => {
    // Arrange / Act
    const view = buildLimitsView({
      ...base,
      live: { ...live, throttled: [{ sessionId: 's1', callsign: 'gertrude' }] },
    });

    // Assert
    should(view.lines).containEql('1 ferret slowed for memory now: gertrude');
  });

  it('should say why nothing is enforced instead of showing numbers that are not in force', () => {
    // Arrange / Act
    const view = buildLimitsView({
      ...base,
      enforcement: { kind: 'direct', reason: 'the user’s systemd manager does not answer', ionice: false },
    });

    // Assert
    should(view.enforcement).equal('none');
    should(view.lines[0]).equal('limits not enforced: the user’s systemd manager does not answer');
    should(view.notEnforcedBecause).match(/does not answer/u);
  });

  it('should say a launch that could not be limited, until a later one is', () => {
    // Arrange / Act
    const view = buildLimitsView({ ...base, launchFailure: 'Failed to connect to bus' });

    // Assert
    should(view.enforcement).equal('none');
    should(view.lines[0]).match(/last ferret could not be limited \(Failed to connect to bus\)/u);
  });

  it('should say limits are switched off, and that the owner’s explicit word fails a launch', () => {
    // Arrange / Act
    const off = buildLimitsView({ ...base, config: { enabled: false } });
    const explicit = buildLimitsView({
      ...base,
      config: { enabled: true },
      enforcement: { kind: 'direct', reason: 'no user manager', ionice: false },
    });

    // Assert
    should(off.switchedOn).equal(false);
    should(off.lines[0]).equal('limits not enforced: limits are switched off in limits.yaml');
    should(explicit.lines.join('\n')).match(/enabled: true, so a ferret that cannot be limited will not start/u);
  });

  it('should say, on macOS, exactly what is and is not done', () => {
    // Arrange / Act
    const view = buildLimitsView({
      ...base,
      host: { ...THIS_BOX, platform: 'darwin', unifiedHierarchy: false },
      enforcement: { kind: 'priority', wrapper: 'taskpolicy' },
      live: { ...live, overBudget: [{ sessionId: 's1', callsign: 'gertrude', bytes: 13 * GIBIBYTE }] },
    });

    // Assert
    should(view.enforcement).equal('priority');
    should(view.lines[0]).equal('macOS: lower CPU and disk priority only; memory is watched, not capped');
    should(view.lines.join('\n')).match(/1 ferret is over their memory share now \(not capped\): gertrude 13 GiB/u);
  });

  it('should tell a disk where priority works from one where it does not', () => {
    // Arrange / Act / Assert
    should(diskEffect('bfq')).equal('full');
    should(diskEffect('mq-deadline')).equal('class-only');
    should(diskEffect('none')).equal('none');
    should(diskEffect('kyber')).equal('none');
    should(diskEffect(undefined)).equal('unknown');
  });

  it('should format sizes the way a person reads them', () => {
    // Arrange / Act / Assert
    should(formatBytes(48 * GIBIBYTE)).equal('48 GiB');
    should(formatBytes(Math.floor(40.8 * GIBIBYTE))).equal('40.8 GiB');
    should(formatBytes(512 * 1024 ** 2)).equal('512 MiB');
  });
});
