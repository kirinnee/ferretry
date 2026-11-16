/**
 * Installing a harness tool on explicit request: which package manager is chosen from what the machine has,
 * the exact command shown before anything runs, every way a run can end in words a person can act on, and
 * the refusals that keep two installs, or an unknown caller, from ever starting a manager.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type { CallerGovernance } from '@ferretry/core-gate/contract';
import type { HarnessKind } from '../../../daemon/lib/manifest.ts';
import type { ExecutableResolverPort, HarnessLocation } from '../../../daemon/lib/service/foreign.ts';
import {
  ToolInstallRefusal,
  ToolInstallService,
  type ToolInstallOutcome,
} from '../../../daemon/lib/service/tool-install.ts';

const OWNER: CallerGovernance = { governed: false, decide: () => ({ allowed: true, refusal: 'granted' as const }) };

type Run = Parameters<ConstructorParameters<typeof ToolInstallService>[0]['run']>[0];
type RunResult = Awaited<ReturnType<ConstructorParameters<typeof ToolInstallService>[0]['run']>>;

interface WorldOptions {
  readonly platform?: string;
  /** Bare manager names the inherited PATH resolves, to the absolute executable. */
  readonly onPath?: Readonly<Record<string, string>>;
  /** Absolute paths the host can run. */
  readonly runnable?: readonly string[];
  /** Harnesses found now; an entry flips to found once a run has happened when `foundAfterRun` is set. */
  readonly found?: readonly HarnessKind[];
  readonly foundAfterRun?: readonly HarnessKind[];
  readonly result?: RunResult | (() => Promise<RunResult>);
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMinutes?: number;
}

function world(options: WorldOptions = {}) {
  const runs: Run[] = [];
  const ran = new Set<string>();
  const executables: ExecutableResolverPort = {
    resolve: name => options.onPath?.[name],
    runnable: path => options.runnable?.includes(path) ?? false,
  };
  const locate = (harness: HarnessKind): HarnessLocation => {
    const found = options.found?.includes(harness) || (ran.has(harness) && options.foundAfterRun?.includes(harness));
    return found
      ? { kind: harness, outcome: 'located', path: `/bin/${harness}` }
      : { kind: harness, outcome: 'absent', searched: [] };
  };
  const service = new ToolInstallService({
    platform: options.platform ?? 'darwin',
    executables,
    locate,
    environment: options.environment ?? { PATH: '/usr/bin' },
    ...(options.timeoutMinutes === undefined ? {} : { timeoutMinutes: options.timeoutMinutes }),
    run: async run => {
      runs.push(run);
      for (const harness of ['claude', 'codex']) if (run.args.some(arg => arg.includes(harness))) ran.add(harness);
      const result = options.result ?? { kind: 'exited', code: 0, tail: [] };
      return typeof result === 'function' ? await result() : result;
    },
  });
  return { service, runs };
}

const failed = (outcome: ToolInstallOutcome | undefined) => {
  if (outcome?.outcome !== 'failed') throw new Error(`expected a failure, got ${JSON.stringify(outcome)}`);
  return outcome;
};

describe('ToolInstallService.plans', () => {
  it('should report a harness the daemon already finds as installed, with no plan', () => {
    const { service } = world({ found: ['claude'] });
    should(service.plans(['claude'])).deepEqual([{ harness: 'claude', installed: true, path: '/bin/claude' }]);
  });

  it('should plan Homebrew first on macOS when brew is on the inherited PATH', () => {
    const { service } = world({ onPath: { brew: '/opt/x/brew', npm: '/opt/x/npm' } });
    should(service.plans(['claude', 'codex'])).deepEqual([
      {
        harness: 'claude',
        installed: false,
        plan: {
          harness: 'claude',
          kind: 'runnable',
          manager: 'brew',
          executable: '/opt/x/brew',
          args: ['install', '--cask', 'claude-code'],
          command: 'brew install --cask claude-code',
        },
      },
      {
        harness: 'codex',
        installed: false,
        plan: {
          harness: 'codex',
          kind: 'runnable',
          manager: 'brew',
          executable: '/opt/x/brew',
          args: ['install', '--cask', 'codex'],
          command: 'brew install --cask codex',
        },
      },
    ]);
  });

  it("should find a manager at its usual location when the daemon's PATH does not say", () => {
    const { service } = world({ runnable: ['/usr/local/bin/brew'] });
    const [preview] = service.plans(['codex']);
    should(preview).containEql({ installed: false });
    should(preview).have.propertyByPath('plan', 'executable').equal('/usr/local/bin/brew');
  });

  it('should fall through to npm when macOS has no Homebrew', () => {
    const { service } = world({ onPath: { npm: '/opt/x/npm' } });
    const [preview] = service.plans(['claude']);
    should(preview).have.propertyByPath('plan', 'command').equal('npm install -g @anthropic-ai/claude-code');
  });

  it('should never offer apt on Linux, because neither harness publishes an apt package', () => {
    const { service } = world({
      platform: 'linux',
      onPath: { 'apt-get': '/usr/bin/apt-get' },
      runnable: ['/usr/bin/apt-get'],
    });
    should(service.plans(['codex'])[0])
      .have.propertyByPath('plan', 'kind')
      .equal('no-package-manager');
    const withNpm = world({ platform: 'linux', onPath: { npm: '/usr/bin/npm' } });
    should(withNpm.service.plans(['codex'])[0])
      .have.propertyByPath('plan', 'command')
      .equal('npm install -g @openai/codex');
  });

  it('should hand a person the command for Homebrew when macOS has no manager at all', () => {
    const { service } = world();
    should(service.plans(['claude'])[0])
      .have.propertyByPath('plan')
      .deepEqual({
        harness: 'claude',
        kind: 'no-package-manager',
        reason:
          'Claude Code is installed with Homebrew or npm, and this machine has neither; install Homebrew first, then run the command yourself',
        manualCommand: 'brew install --cask claude-code',
      });
  });

  it('should hand a person the npm command on a system that offers only npm', () => {
    const { service } = world({ platform: 'freebsd' });
    should(service.plans(['codex'])[0])
      .have.propertyByPath('plan')
      .deepEqual({
        harness: 'codex',
        kind: 'no-package-manager',
        reason:
          'Codex is installed with npm, and this machine has neither; install npm first, then run the command yourself',
        manualCommand: 'npm install -g @openai/codex',
      });
  });
});

describe('ToolInstallService.install refusals', () => {
  it('should refuse a caller nobody can place, before anything runs', async () => {
    const { service, runs } = world({ onPath: { npm: '/x/npm' } });
    const error = await service.install({ harnesses: ['claude'] }, undefined).catch((e: unknown) => e);
    should(error).be.instanceOf(ToolInstallRefusal);
    should((error as ToolInstallRefusal).code).equal('tool_install_unauthorized');
    should((error as ToolInstallRefusal).name).equal('ToolInstallRefusal');
    should(runs).have.length(0);
  });

  it('should refuse a request that names no tool', async () => {
    const { service } = world();
    const error = await service.install({ harnesses: [] }, OWNER).catch((e: unknown) => e);
    should((error as ToolInstallRefusal).code).equal('tool_install_invalid');
    should((error as ToolInstallRefusal).message).equal('name at least one tool to install');
  });

  it('should refuse a second install while one is running, then accept one once it finished', async () => {
    let release: (value: RunResult) => void = () => undefined;
    const { service, runs } = world({
      onPath: { npm: '/x/npm' },
      platform: 'linux',
      result: () => new Promise<RunResult>(resolve => (release = resolve)),
    });
    const first = service.install({ harnesses: ['claude'] }, OWNER);
    const error = await service.install({ harnesses: ['codex'] }, OWNER).catch((e: unknown) => e);
    should((error as ToolInstallRefusal).code).equal('tool_install_in_progress');
    should(runs).have.length(1);
    release({ kind: 'exited', code: 0, tail: [] });
    await first;
    const second = service.install({ harnesses: ['codex'] }, OWNER);
    release({ kind: 'exited', code: 0, tail: [] });
    should((await second)[0]?.harness).equal('codex');
  });

  it('should let the next install start after one threw', async () => {
    const { service } = world({
      onPath: { npm: '/x/npm' },
      platform: 'linux',
      result: () => Promise.reject(new Error('port broke')),
    });
    await service.install({ harnesses: ['claude'] }, OWNER).catch(() => undefined);
    const error = await service.install({ harnesses: ['claude'] }, OWNER).catch((e: unknown) => e);
    should((error as Error).message).equal('port broke');
  });
});

describe('ToolInstallService.install outcomes', () => {
  it('should report an installed tool as already installed without running anything', async () => {
    const { service, runs } = world({ found: ['claude'] });
    should(await service.install({ harnesses: ['claude'] }, OWNER)).deepEqual([
      { harness: 'claude', outcome: 'already-installed', path: '/bin/claude' },
    ]);
    should(runs).have.length(0);
  });

  it('should fail with the manual command when the machine has no manager', async () => {
    const { service, runs } = world();
    const outcome = failed((await service.install({ harnesses: ['codex'] }, OWNER))[0]);
    should(outcome.cause).equal('no-package-manager');
    should(outcome.manualCommand).equal('brew install --cask codex');
    should(outcome.reason).containEql('Homebrew or npm');
    should(runs).have.length(0);
  });

  it('should run the declared argv once per distinct harness, report progress, and confirm with the resolver', async () => {
    const { service, runs } = world({
      onPath: { brew: '/opt/homebrew/bin/brew' },
      foundAfterRun: ['claude', 'codex'],
      environment: { PATH: '/usr/bin', HOME: '/home/person' },
    });
    const steps: string[] = [];
    const outcomes = await service.install({ harnesses: ['claude', 'claude', 'codex'] }, OWNER, step =>
      steps.push(step.stage === 'running' ? `running ${step.command}` : `finished ${step.outcome.outcome}`),
    );
    should(outcomes).deepEqual([
      { harness: 'claude', outcome: 'installed', command: 'brew install --cask claude-code', path: '/bin/claude' },
      { harness: 'codex', outcome: 'installed', command: 'brew install --cask codex', path: '/bin/codex' },
    ]);
    should(steps).deepEqual([
      'running brew install --cask claude-code',
      'finished installed',
      'running brew install --cask codex',
      'finished installed',
    ]);
    should(runs).have.length(2);
    should(runs[0]).deepEqual({
      executable: '/opt/homebrew/bin/brew',
      args: ['install', '--cask', 'claude-code'],
      environment: { PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/home/person', NONINTERACTIVE: '1' },
      timeoutMs: 15 * 60_000,
    });
  });

  it("should put the manager's directory alone on PATH when the daemon inherited none", async () => {
    for (const environment of [{}, { PATH: '' }] as const) {
      const { service, runs } = world({ platform: 'linux', onPath: { npm: '/opt/node/bin/npm' }, environment });
      await service.install({ harnesses: ['claude'] }, OWNER);
      should(runs[0]?.environment.PATH).equal('/opt/node/bin');
    }
  });

  it('should use the root directory for a manager that sits directly under it', async () => {
    const { service, runs } = world({ platform: 'linux', onPath: { npm: '/npm' } });
    await service.install({ harnesses: ['claude'] }, OWNER);
    should(runs[0]?.environment.PATH).equal('/:/usr/bin');
  });

  it('should honour a configured timeout in the run and in the words', async () => {
    const { service, runs } = world({
      platform: 'linux',
      onPath: { npm: '/x/npm' },
      timeoutMinutes: 2,
      result: { kind: 'timed-out', tail: ['\u001b[31mdownloading\u001b[0m', '   ', ''] },
    });
    const outcome = failed((await service.install({ harnesses: ['claude'] }, OWNER))[0]);
    should(runs[0]?.timeoutMs).equal(120_000);
    should(outcome.cause).equal('timed-out');
    should(outcome.reason).equal('npm did not finish within 2 minutes, so it was stopped. It said: downloading');
    should(outcome.manualCommand).equal('npm install -g @anthropic-ai/claude-code');
  });

  it('should say a manager could not be started here', async () => {
    const { service } = world({
      platform: 'linux',
      onPath: { npm: '/x/npm' },
      result: { kind: 'not-started', reason: 'spawn ENOENT' },
    });
    const outcome = failed((await service.install({ harnesses: ['claude'] }, OWNER))[0]);
    should(outcome.cause).equal('could-not-start');
    should(outcome.reason).equal('npm could not be started here: spawn ENOENT');
  });

  it('should tell a person to run sudo themselves when npm needs admin rights', async () => {
    const { service } = world({
      platform: 'linux',
      onPath: { npm: '/x/npm' },
      result: { kind: 'exited', code: 243, tail: ['npm error code EACCES'] },
    });
    const outcome = failed((await service.install({ harnesses: ['codex'] }, OWNER))[0]);
    should(outcome.cause).equal('needs-admin');
    should(outcome.manualCommand).equal('sudo npm install -g @openai/codex');
    should(outcome.reason).containEql('Ferretry never runs sudo');
  });

  it('should send a Homebrew password prompt to the persons own terminal, without sudo', async () => {
    const { service } = world({
      onPath: { brew: '/x/brew' },
      result: { kind: 'exited', code: 1, tail: ['sudo: a terminal is required to read the password'] },
    });
    const outcome = failed((await service.install({ harnesses: ['codex'] }, OWNER))[0]);
    should(outcome.cause).equal('needs-admin');
    should(outcome.manualCommand).equal('brew install --cask codex');
    should(outcome.reason).equal(
      'Homebrew needs your password to finish installing Codex, and this daemon cannot type one. Run the command in your own terminal.',
    );
  });

  it('should recognise each wording of a manager that needs admin rights', async () => {
    const lines = [
      'Error: EPERM: operation not permitted',
      'Permission denied (publickey)',
      'sudo: a password is required',
      'sudo: no tty present and no askpass program specified',
      'Need sudo access on macOS',
      'Are you root?',
    ];
    for (const line of lines) {
      const { service } = world({
        platform: 'linux',
        onPath: { npm: '/x/npm' },
        result: { kind: 'exited', code: 1, tail: [line] },
      });
      should(failed((await service.install({ harnesses: ['claude'] }, OWNER))[0]).cause).equal('needs-admin');
    }
  });

  it('should quote the last thing a failing manager said, bounded to 200 characters', async () => {
    const { service } = world({
      platform: 'linux',
      onPath: { npm: '/x/npm' },
      result: { kind: 'exited', code: 7, tail: ['first', `\u001b[1m${'x'.repeat(250)}\u001b[0m`] },
    });
    const outcome = failed((await service.install({ harnesses: ['claude'] }, OWNER))[0]);
    should(outcome.cause).equal('failed');
    should(outcome.reason).equal(`npm stopped with exit code 7. It said: ${'x'.repeat(200)}`);
    should(outcome.manualCommand).equal('npm install -g @anthropic-ai/claude-code');
  });

  it('should fail with no quote when a manager that stopped said nothing', async () => {
    const { service } = world({
      platform: 'linux',
      onPath: { npm: '/x/npm' },
      result: { kind: 'exited', code: 2, tail: [] },
    });
    should(failed((await service.install({ harnesses: ['claude'] }, OWNER))[0]).reason).equal(
      'npm stopped with exit code 2.',
    );
  });

  it('should fail when the manager exited zero but the daemon still cannot find the tool', async () => {
    const { service } = world({ platform: 'linux', onPath: { npm: '/x/npm' } });
    const outcome = failed((await service.install({ harnesses: ['codex'] }, OWNER))[0]);
    should(outcome.cause).equal('not-found-after-install');
    should(outcome.manualCommand).equal('npm install -g @openai/codex');
    should(outcome.reason).containEql('FY_CODEX_BIN');
  });
});
