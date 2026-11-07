import { describe, it } from 'bun:test';
import { GIBIBYTE, type LimitsConfig } from '@ferretry/protocol';
import should from 'should';
import {
  type CgroupCommandPort,
  CgroupError,
  type CgroupHostFacts,
  CgroupLaunchPlanner,
  EnforcementRuntime,
  type EnforcementState,
  type SessionSpawnFacts,
} from '../../../src/lib/cgroups/index.ts';
import { WARDEN_LABEL } from '../../../src/lib/warden/index.ts';

const HOST: CgroupHostFacts = {
  platform: 'linux',
  unifiedHierarchy: true,
  cpus: 32,
  physicalBytes: 61 * GIBIBYTE,
  memoryCeilingBytes: 48 * GIBIBYTE,
  ceilingSource: 'memory.high of user-1000.slice',
  swapBytes: 0,
};

interface Setup {
  readonly config?: LimitsConfig;
  readonly host?: CgroupHostFacts;
  readonly state: EnforcementState;
  readonly sessions?: Readonly<Record<string, SessionSpawnFacts>>;
  readonly systemctl?: { readonly code: number; readonly stderr?: string };
  /** Overrides the answer to one command by its argv (the scope proof, the Mac wrapper proof). */
  readonly respond?: (argv: readonly string[]) => { readonly code: number; readonly stderr?: string } | undefined;
}

function subject(setup: Setup) {
  const ran: (readonly string[])[] = [];
  const commands: CgroupCommandPort = {
    execute: async argv => {
      ran.push(argv);
      const result = setup.respond?.(argv) ?? setup.systemctl ?? { code: 0 };
      return { code: result.code, stdout: '', stderr: result.stderr ?? '' };
    },
  };
  let probes = 0;
  const enforcement = new EnforcementRuntime(
    async () => {
      probes += 1;
      return setup.state;
    },
    () => 1_000_000,
  );
  const warnings: string[] = [];
  const planner = new CgroupLaunchPlanner({
    warn: message => warnings.push(message),
    limits: async () => setup.config ?? {},
    host: setup.host ?? HOST,
    commands,
    sessions: { facts: async id => setup.sessions?.[id] ?? {} },
    enforcement,
    nonce: () => 'a1b2c3d4',
  });
  return { planner, ran, warnings, enforcement, probes: () => probes };
}

const CLAUDE = ['claude', '--model', 'x'];

describe('the argv a ferret execs on Linux', () => {
  it('should wrap in a scope under the fleet slice, with ionice, by default', async () => {
    // Arrange
    const { planner, ran } = subject({ state: { kind: 'cgroups', ionice: true } });

    // Act
    const actual = await planner.command('s1', CLAUDE);

    // Assert — the slice is configured first, then the scope carries the per-ferret share.
    should(ran).have.length(3);
    should(ran[0]?.slice(0, 5)).deepEqual(['systemctl', '--user', 'set-property', '--runtime', 'ferretry_fleet.slice']);
    should(ran[0]).containEql('CPUWeight=50');
    should(actual.slice(0, 8)).deepEqual([
      'systemd-run',
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '--unit=ferretry-agent-s1-a1b2c3d4.scope',
      '--slice=ferretry_fleet-s1.slice',
      '--',
    ]);
    should(actual.slice(-8)).deepEqual(['--', 'ionice', '-c2', '-n7', '--', 'claude', '--model', 'x'].slice(-8));
    should(ran[1]).containEql('TasksMax=4096');
  });

  it('should give the ferret a person started the heavier weight', async () => {
    // Arrange
    const { planner, ran } = subject({
      state: { kind: 'cgroups', ionice: true },
      sessions: { s1: { interactive: true } },
    });

    // Act
    const actual = await planner.command('s1', CLAUDE);

    // Assert
    should(ran[1]).containEql('CPUWeight=200');
    should(actual).containEql('--slice=ferretry_fleet-s1.slice');
  });

  it('should leave ionice out when the config turns it off or the host has none', async () => {
    // Arrange
    const off = subject({ config: { ionice: false }, state: { kind: 'cgroups', ionice: true } });
    const none = subject({ state: { kind: 'cgroups', ionice: false } });

    // Act
    const a = await off.planner.command('s1', CLAUDE);
    const b = await none.planner.command('s1', CLAUDE);

    // Assert
    should(a).not.containEql('ionice');
    should(b).not.containEql('ionice');
  });

  it('should be byte-for-byte direct execution when limits are switched off', async () => {
    // Arrange
    const { planner, ran, probes } = subject({ config: { enabled: false }, state: { kind: 'cgroups', ionice: true } });

    // Act
    const actual = await planner.command('s1', CLAUDE);

    // Assert
    should(actual).deepEqual(CLAUDE);
    should(ran).deepEqual([]);
    should(probes()).equal(0);
  });

  it('should never wrap supervision, nor what it spawned', async () => {
    // Arrange
    const { planner, ran } = subject({
      state: { kind: 'cgroups', ionice: true },
      sessions: { w1: { label: WARDEN_LABEL }, child: { parent: 'w1' } },
    });

    // Act
    const warden = await planner.command('w1', CLAUDE);
    const child = await planner.command('child', CLAUDE);

    // Assert
    should(warden).deepEqual(CLAUDE);
    should(child).deepEqual(CLAUDE);
    should(ran).deepEqual([]);
  });

  it('should apply the operator’s caps to the slice and the scope', async () => {
    // Arrange
    const { planner, ran } = subject({
      config: { fleet: { memoryMax: '30G', cpuPercent: 50 }, perFerret: { memoryMax: '5G', cpuPercent: 10 } },
      state: { kind: 'cgroups', ionice: true },
    });

    // Act
    const actual = await planner.command('s1', CLAUDE);

    // Assert
    should(ran[0]).containEql(`MemoryMax=${30 * GIBIBYTE}`);
    should(ran[0]).containEql('CPUQuota=1600%');
    should(ran[1]).containEql(`MemoryMax=${5 * GIBIBYTE}`);
    should(actual).containEql('--slice=ferretry_fleet-s1.slice');
    should(ran[1]).containEql('CPUQuota=320%');
  });
});

describe('when the machine cannot enforce', () => {
  const direct: EnforcementState = {
    kind: 'direct',
    reason: 'the user’s systemd manager does not answer',
    ionice: true,
  };

  it('should launch directly (with the disk priority that still works) and say why in the status', async () => {
    // Arrange
    const { planner, ran } = subject({ state: direct });

    // Act
    const actual = await planner.command('s1', CLAUDE);

    // Assert
    should(actual).deepEqual(['ionice', '-c2', '-n7', '--', ...CLAUDE]);
    should(ran).deepEqual([]);
  });

  it('should FAIL the launch when the owner wrote enabled: true themselves', async () => {
    // Arrange
    const { planner } = subject({ config: { enabled: true }, state: direct });

    // Act
    const failure = await planner.command('s1', CLAUDE).catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceOf(CgroupError);
    should((failure as CgroupError).failure).equal('unsupported');
    should((failure as CgroupError).message).match(/does not answer/u);
  });

  it('should launch directly and remember the failure when the slice cannot be configured', async () => {
    // Arrange
    const { planner, enforcement } = subject({
      state: { kind: 'cgroups', ionice: false },
      systemctl: { code: 1, stderr: 'Failed to connect to bus' },
    });

    // Act
    const actual = await planner.command('s1', CLAUDE);

    // Assert
    should(actual).deepEqual(CLAUDE);
    should(enforcement.lastLaunchFailure()).match(/Failed to connect to bus/u);
  });

  it('should keep failing the launch for the owner who asked for a guarantee', async () => {
    // Arrange
    const { planner } = subject({
      config: { enabled: true },
      state: { kind: 'cgroups', ionice: false },
      systemctl: { code: 1, stderr: 'Failed to connect to bus' },
    });

    // Act
    const failure = await planner.command('s1', CLAUDE).catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceOf(CgroupError);
    should((failure as CgroupError).failure).equal('failed');
  });

  it('should forget the failure once a later launch is limited', async () => {
    // Arrange
    const { planner, enforcement } = subject({ state: { kind: 'cgroups', ionice: false } });
    enforcement.recordLaunchFailure('an old problem');

    // Act
    await planner.command('s1', CLAUDE);

    // Assert
    should(enforcement.lastLaunchFailure()).equal(undefined);
  });
});

describe('the argv a ferret execs on macOS', () => {
  const MAC: CgroupHostFacts = { ...HOST, platform: 'darwin', unifiedHierarchy: false };

  it('should lower CPU priority with the QoS clamp, never the background class', async () => {
    // Arrange
    const { planner, ran } = subject({ host: MAC, state: { kind: 'priority', wrapper: 'taskpolicy' } });

    // Act
    const actual = await planner.command('s1', CLAUDE);

    // Assert
    should(actual).deepEqual(['taskpolicy', '-c', 'utility', 'nice', '-n', '10', ...CLAUDE]);
    should(actual).not.containEql('-b');
    // The wrapper is proven around `true` before a ferret is wrapped in it.
    should(ran).deepEqual([['taskpolicy', '-c', 'utility', 'nice', '-n', '10', 'true']]);
  });

  it('should fall back to nice alone when taskpolicy is not there, and to nothing when neither is', async () => {
    // Arrange
    const nice = subject({ host: MAC, state: { kind: 'priority', wrapper: 'nice' } });
    const none = subject({ host: MAC, state: { kind: 'priority', wrapper: 'none' } });
    const strict = subject({ host: MAC, config: { enabled: true }, state: { kind: 'priority', wrapper: 'none' } });

    // Act
    const a = await nice.planner.command('s1', CLAUDE);
    const b = await none.planner.command('s1', CLAUDE);
    const c = await strict.planner.command('s1', CLAUDE);

    // Assert
    should(a).deepEqual(['nice', '-n', '10', ...CLAUDE]);
    should(b).deepEqual(CLAUDE);
    // macOS is best effort: even `enabled: true` cannot demand a guarantee a Mac cannot give.
    should(c).deepEqual(CLAUDE);
  });

  it('should start the ferret unwrapped, loudly, when the wrapper stops working after the boot probe', async () => {
    // Arrange
    const { planner, enforcement, warnings } = subject({
      host: MAC,
      state: { kind: 'priority', wrapper: 'taskpolicy' },
      respond: argv => (argv.at(-1) === 'true' ? { code: 1, stderr: 'taskpolicy: not permitted' } : undefined),
    });

    // Act
    const actual = await planner.command('s1', CLAUDE);

    // Assert
    should(actual).deepEqual(CLAUDE);
    should(enforcement.lastLaunchFailure()).match(/not permitted/u);
    should(warnings[0]).match(/without a lower priority/u);
  });
});

describe('a scope that cannot be started after the slice was prepared', () => {
  const cgroups: EnforcementState = { kind: 'cgroups', ionice: true };
  const refusesScopes = (argv: readonly string[]) =>
    argv[0] === 'systemd-run'
      ? { code: 1, stderr: 'Failed to start transient scope unit: Connection refused' }
      : undefined;

  it('should prove the exact scope around `true` before wrapping the ferret in it', async () => {
    // Arrange
    const { planner, ran } = subject({ state: cgroups });

    // Act
    const actual = await planner.command('s1', CLAUDE);

    // Assert
    const proof = ran[2] as readonly string[];
    should(proof[0]).equal('systemd-run');
    should(proof.at(-1)).equal('true');
    should(proof).containEql('--slice=ferretry_fleet-s1.slice');
    should(ran[1]).containEql('MemoryMax=15461882265');
    should(proof).not.containEql('--property=MemoryMax=15461882265');
    should(proof.some(word => word.startsWith('--unit=ferretry-probe-'))).be.true();
    should(actual).containEql('--unit=ferretry-agent-s1-a1b2c3d4.scope');
  });

  it('should start the ferret unconfined, warn out loud and re-probe, instead of a pane that dies at once', async () => {
    // Arrange
    const { planner, enforcement, warnings, probes } = subject({ state: cgroups, respond: refusesScopes });
    await enforcement.current();

    // Act
    const actual = await planner.command('s1', CLAUDE);

    // Assert — the ferret runs (with the disk priority that still works); it is not wrapped in a scope that fails
    should(actual).deepEqual(['ionice', '-c2', '-n7', '--', ...CLAUDE]);
    should(enforcement.lastLaunchFailure()).match(/Connection refused/u);
    should(warnings[0]).match(/starting s1 without ferret limits: .*Connection refused/u);
    should(probes()).be.aboveOrEqual(1);
  });

  it('should still fail the launch for the owner who wrote enabled: true', async () => {
    // Arrange
    const { planner } = subject({ config: { enabled: true }, state: cgroups, respond: refusesScopes });

    // Act
    const failure = await planner.command('s1', CLAUDE).catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceOf(CgroupError);
    should((failure as CgroupError).message).match(/Connection refused/u);
  });

  it('should name a terminal’s scope apart from the harness’s, under the same session', async () => {
    // Arrange
    const { planner } = subject({ state: cgroups });

    // Act
    const actual = await planner.command('s1', ['/bin/zsh', '-l'], { terminal: true });

    // Assert
    should(actual).containEql('--unit=ferretry-agent-s1-ta1b2c3d4.scope');
  });
});
