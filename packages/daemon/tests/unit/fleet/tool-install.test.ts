/**
 * Installing a harness tool on this machine (`docs/design/account-model.md` §8.6, §9.6, E1, E2).
 *
 * The claims: the command comes only from the declared table and never contains `sudo`; the manager is
 * picked per system from what the machine has; a machine without one, and a manager that needs admin
 * rights, each answer with the exact command for a person; a caller off this machine owes the operator
 * password once per request, and every refusal facts can answer is given before it is spent; one
 * install runs at a time; "installed" means the daemon can find the tool afterwards.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type { CallerGovernance, ChangeConfirmation } from '../../../src/lib/api/capability.ts';
import type { ExecutableResolverPort, HarnessLocation } from '../../../src/lib/core/harness-readiness.ts';
import type { HarnessKind } from '../../../src/lib/core/inventory.ts';
import {
  classifyInstallResult,
  installEnvironment,
  managerOrder,
  manualCommand,
  type PackageInstallResult,
  type PackageInstallRun,
  planToolInstall,
  TOOL_PACKAGES,
  type ToolInstallPlan,
  type ToolInstallProgress,
  ToolInstallRefusal,
  ToolInstallService,
  type ToolInstallServiceOptions,
} from '../../../src/lib/fleet/tool-install.ts';

/** A machine whose `PATH` holds `onPath` (name → path) and on which `files` can be run. */
function machine(onPath: Record<string, string> = {}, files: readonly string[] = []): ExecutableResolverPort {
  return { resolve: name => onPath[name], runnable: path => files.includes(path) };
}

const governed = (confirmChange = true): CallerGovernance => ({
  governed: true,
  passwordSet: true,
  confirmChange,
  decide: () => ({ allowed: true }) as never,
});

const loopback: CallerGovernance = { ...governed(false), governed: false };

type Runnable = Extract<ToolInstallPlan, { kind: 'runnable' }>;

const npmPlan: Runnable = {
  harness: 'claude',
  kind: 'runnable',
  manager: 'npm',
  executable: '/usr/bin/npm',
  args: ['install', '-g', '@anthropic-ai/claude-code'],
  command: 'npm install -g @anthropic-ai/claude-code',
};

const brewPlan: Runnable = {
  harness: 'codex',
  kind: 'runnable',
  manager: 'brew',
  executable: '/opt/homebrew/bin/brew',
  args: ['install', '--cask', 'codex'],
  command: 'brew install --cask codex',
};

interface Harness {
  readonly service: ToolInstallService;
  readonly runs: PackageInstallRun[];
  readonly confirmations: string[];
  readonly installed: Map<HarnessKind, string>;
}

/** A service over fakes. `installs` names where each harness lands when its run exits zero. */
function harness(
  patch: Partial<ToolInstallServiceOptions> & {
    readonly result?: PackageInstallResult;
    readonly confirmation?: ChangeConfirmation;
    readonly installs?: Partial<Record<HarnessKind, string>>;
    readonly present?: Partial<Record<HarnessKind, string>>;
  } = {},
): Harness {
  const runs: PackageInstallRun[] = [];
  const confirmations: string[] = [];
  const installed = new Map<HarnessKind, string>(Object.entries(patch.present ?? {}) as [HarnessKind, string][]);
  const locate = (kind: HarnessKind): HarnessLocation => {
    const path = installed.get(kind);
    return path === undefined
      ? { kind, outcome: 'absent', searched: [] }
      : { kind, outcome: 'located', path, rule: 'inherited environment', declaredBy: 'PATH' };
  };
  const service = new ToolInstallService({
    platform: 'darwin',
    executables: machine({ brew: '/opt/homebrew/bin/brew' }),
    locate,
    run: async run => {
      runs.push(run);
      const result = patch.result ?? { kind: 'exited', code: 0, tail: [] };
      if (result.kind === 'exited' && result.code === 0) {
        const harnessOf = (Object.keys(TOOL_PACKAGES) as HarnessKind[]).find(kind =>
          Object.values(TOOL_PACKAGES[kind]).some(args => args?.join(' ') === run.args.join(' ')),
        ) as HarnessKind;
        const lands = patch.installs?.[harnessOf];
        if (lands !== undefined) installed.set(harnessOf, lands);
      }
      return result;
    },
    environment: { PATH: '/usr/bin', HOME: '/home/op' },
    confirmChange: async password => {
      confirmations.push(password);
      return patch.confirmation ?? { kind: 'confirmed' };
    },
    clientName: 'fy',
    ...patch,
  });
  return { service, runs, confirmations, installed };
}

async function refusal(work: Promise<unknown>): Promise<ToolInstallRefusal> {
  const thrown = await work.then(
    () => undefined,
    (error: unknown) => error,
  );
  should(thrown).be.instanceOf(ToolInstallRefusal);
  return thrown as ToolInstallRefusal;
}

describe('the declared table', () => {
  it('spells every package once, offers no apt package and never contains sudo', () => {
    should(TOOL_PACKAGES).eql({
      claude: { brew: ['install', '--cask', 'claude-code'], npm: ['install', '-g', '@anthropic-ai/claude-code'] },
      codex: { brew: ['install', '--cask', 'codex'], npm: ['install', '-g', '@openai/codex'] },
    });
    const every = Object.values(TOOL_PACKAGES).flatMap(entry => Object.values(entry).flat());
    should(every).not.containEql('sudo');
  });

  it('orders managers per system: Homebrew then npm on macOS, apt then npm on Linux, npm elsewhere', () => {
    should(managerOrder('darwin')).eql(['brew', 'npm']);
    should(managerOrder('linux')).eql(['apt', 'npm']);
    should(managerOrder('win32')).eql(['npm']);
  });
});

describe('planToolInstall', () => {
  it('uses Homebrew on macOS when it is on PATH, with the exact command shown', () => {
    should(planToolInstall('claude', 'darwin', machine({ brew: '/usr/local/bin/brew', npm: '/usr/bin/npm' }))).eql({
      harness: 'claude',
      kind: 'runnable',
      manager: 'brew',
      executable: '/usr/local/bin/brew',
      args: ['install', '--cask', 'claude-code'],
      command: 'brew install --cask claude-code',
    });
  });

  it("finds Homebrew at its usual prefix when the daemon's PATH leaves it out", () => {
    const plan = planToolInstall('codex', 'darwin', machine({}, ['/opt/homebrew/bin/brew']));
    should(plan).containEql({
      kind: 'runnable',
      executable: '/opt/homebrew/bin/brew',
      command: 'brew install --cask codex',
    });
  });

  it('falls back to npm on macOS without Homebrew', () => {
    const plan = planToolInstall('codex', 'darwin', machine({ npm: '/usr/local/bin/npm' }));
    should(plan).containEql({ manager: 'npm', command: 'npm install -g @openai/codex' });
  });

  it('never offers apt on Linux, because no harness publishes an apt package', () => {
    const plan = planToolInstall('claude', 'linux', machine({ 'apt-get': '/usr/bin/apt-get' }, ['/usr/bin/npm']));
    should(plan).containEql({ manager: 'npm', executable: '/usr/bin/npm' });
    should(planToolInstall('claude', 'linux', machine({ 'apt-get': '/usr/bin/apt-get' }))).containEql({
      kind: 'no-package-manager',
    });
  });

  it('uses npm on any other system', () => {
    should(planToolInstall('claude', 'freebsd', machine({ npm: '/usr/local/bin/npm' }))).containEql({
      manager: 'npm',
    });
  });

  it('hands a machine with no manager the command to run once it has one (E2)', () => {
    should(planToolInstall('claude', 'darwin', machine())).eql({
      harness: 'claude',
      kind: 'no-package-manager',
      reason:
        'Claude Code is installed with Homebrew or npm, and this machine has neither; install Homebrew first, then run the command yourself',
      manualCommand: 'brew install --cask claude-code',
    });
    should(planToolInstall('codex', 'linux', machine())).containEql({
      reason:
        'Codex is installed with npm, and this machine has neither; install npm first, then run the command yourself',
      manualCommand: 'npm install -g @openai/codex',
    });
  });
});

describe('manualCommand', () => {
  it('prefixes sudo for npm and apt only when admin rights were the problem', () => {
    should(manualCommand('npm', ['install', '-g', 'x'], true)).equal('sudo npm install -g x');
    should(manualCommand('apt', ['install', 'x'], true)).equal('sudo apt-get install x');
    should(manualCommand('npm', ['install', '-g', 'x'], false)).equal('npm install -g x');
  });

  it('never prefixes sudo for Homebrew, which must run as the person', () => {
    should(manualCommand('brew', ['install', '--cask', 'codex'], true)).equal('brew install --cask codex');
  });
});

describe('classifyInstallResult', () => {
  it('reads a zero exit as no failure', () => {
    should(classifyInstallResult(npmPlan, { kind: 'exited', code: 0, tail: ['added 1 package'] }, 15)).be.undefined();
  });

  it('reads npm EACCES as needs-admin and hands back the sudo command (E2)', () => {
    should(
      classifyInstallResult(
        npmPlan,
        { kind: 'exited', code: 243, tail: ['npm error code EACCES', 'npm error path /usr/lib/node_modules'] },
        15,
      ),
    ).eql({
      harness: 'claude',
      outcome: 'failed',
      cause: 'needs-admin',
      reason:
        "npm needs admin rights and the account this daemon runs as isn't an admin, so nothing was installed. Ferretry never runs sudo; run the command yourself.",
      manualCommand: 'sudo npm install -g @anthropic-ai/claude-code',
    });
  });

  it("reads a cask installer's sudo refusal as needs-admin without a sudo prefix", () => {
    const failure = classifyInstallResult(
      brewPlan,
      { kind: 'exited', code: 1, tail: ['\u001b[31msudo: a terminal is required to read the password\u001b[0m'] },
      15,
    );
    should(failure).containEql({
      cause: 'needs-admin',
      reason:
        'Homebrew needs your password to finish installing Codex, and this daemon cannot type one. Run the command in your own terminal.',
      manualCommand: 'brew install --cask codex',
    });
  });

  it('quotes the last thing a failed manager said, without colour and bounded', () => {
    const long = `\u001b[1mError:\u001b[0m ${'x'.repeat(300)}`;
    const failure = classifyInstallResult(brewPlan, { kind: 'exited', code: 1, tail: ['first', long, '  '] }, 15);
    should(failure?.cause).equal('failed');
    should(failure?.reason).equal(
      `Homebrew stopped with exit code 1. It said: ${`Error: ${'x'.repeat(300)}`.slice(0, 200)}`,
    );
    should(failure?.manualCommand).equal('brew install --cask codex');
  });

  it('says a manager that ran out of time was stopped, quoting it when it said anything', () => {
    should(classifyInstallResult(npmPlan, { kind: 'timed-out', tail: ['fetching'] }, 15)).containEql({
      cause: 'timed-out',
      reason: 'npm did not finish within 15 minutes, so it was stopped. It said: fetching',
    });
    should(classifyInstallResult(npmPlan, { kind: 'timed-out', tail: [] }, 2)).containEql({
      reason: 'npm did not finish within 2 minutes, so it was stopped.',
    });
  });

  it('says a manager that could not start, naming why', () => {
    should(classifyInstallResult(npmPlan, { kind: 'not-started', reason: 'ENOENT' }, 15)).containEql({
      cause: 'could-not-start',
      reason: 'npm could not be started here: ENOENT',
      manualCommand: 'npm install -g @anthropic-ai/claude-code',
    });
  });
});

describe('installEnvironment', () => {
  it("puts the manager's own directory first on PATH and asks Homebrew never to stop", () => {
    should(installEnvironment('/opt/homebrew/bin/npm', { PATH: '/usr/bin', HOME: '/h' })).eql({
      PATH: '/opt/homebrew/bin:/usr/bin',
      HOME: '/h',
      NONINTERACTIVE: '1',
    });
  });

  it('builds a PATH from the directory alone when none was inherited', () => {
    should(installEnvironment('/usr/bin/npm', {}).PATH).equal('/usr/bin');
    should(installEnvironment('/npm', { PATH: '' }).PATH).equal('/');
  });
});

describe('ToolInstallService.plans', () => {
  it('reports a found harness by path and a missing one by the command an install would run', () => {
    const { service, runs } = harness({ present: { codex: '/usr/local/bin/codex' } });
    should(service.plans(['claude', 'codex'])).eql([
      {
        harness: 'claude',
        installed: false,
        plan: {
          harness: 'claude',
          kind: 'runnable',
          manager: 'brew',
          executable: '/opt/homebrew/bin/brew',
          args: ['install', '--cask', 'claude-code'],
          command: 'brew install --cask claude-code',
        },
      },
      { harness: 'codex', installed: true, path: '/usr/local/bin/codex' },
    ]);
    should(runs).be.empty();
  });
});

describe('ToolInstallService.install — who may', () => {
  it('refuses when nothing can say where the caller stands', async () => {
    const { service, runs } = harness();
    const refused = await refusal(service.install({ harnesses: ['claude'] }, undefined));
    should(refused.code).equal('tool_install_unauthorized');
    should(runs).be.empty();
  });

  it('refuses an empty request without spending a password attempt', async () => {
    const { service, confirmations } = harness();
    const refused = await refusal(service.install({ harnesses: [], operatorPassword: 'pw' }, governed()));
    should(refused.code).equal('tool_install_invalid');
    should(confirmations).be.empty();
  });

  it('asks a governed caller for the operator password and runs nothing without it', async () => {
    const { service, runs } = harness();
    const refused = await refusal(service.install({ harnesses: ['claude'] }, governed()));
    should(refused).containEql({
      code: 'tool_install_unauthorized',
      message:
        "installing software from off this machine needs this machine's operator password, entered for this install",
    });
    should(runs).be.empty();
  });

  it('refuses a wrong password, a lockout and a machine with no password, each in its own words', async () => {
    const wrong = harness({ confirmation: { kind: 'refused', reason: 'wrong-password' } });
    should(
      (await refusal(wrong.service.install({ harnesses: ['claude'], operatorPassword: 'no' }, governed()))).message,
    ).equal("that is not this machine's operator password, so nothing was installed");
    should(wrong.runs).be.empty();
    const locked = harness({ confirmation: { kind: 'refused', reason: 'rate-limited' } });
    should(
      (await refusal(locked.service.install({ harnesses: ['claude'], operatorPassword: 'no' }, governed()))).message,
    ).equal(
      'too many wrong operator passwords have been tried on this machine, so it is not checking any more for now; nothing was installed. Wait for the lockout to pass, or clear it on the machine with `fy daemon password set`.',
    );
    const none = harness({ confirmation: { kind: 'refused', reason: 'no-password' } });
    should(
      (await refusal(none.service.install({ harnesses: ['claude'], operatorPassword: 'x' }, governed()))).message,
    ).equal('this machine has no operator password, so this install could not be confirmed');
  });

  it('spends ONE password attempt for a request naming two tools (E1)', async () => {
    const { service, confirmations, runs } = harness({
      installs: { claude: '/opt/homebrew/bin/claude', codex: '/opt/homebrew/bin/codex' },
    });
    const outcomes = await service.install({ harnesses: ['claude', 'codex'], operatorPassword: 'pw' }, governed());
    should(confirmations).eql(['pw']);
    should(runs.map(run => [run.executable, ...run.args].join(' '))).eql([
      '/opt/homebrew/bin/brew install --cask claude-code',
      '/opt/homebrew/bin/brew install --cask codex',
    ]);
    should(outcomes.map(outcome => outcome.outcome)).eql(['installed', 'installed']);
  });

  it('asks a caller on this machine for nothing', async () => {
    const { service, confirmations } = harness({ installs: { claude: '/opt/homebrew/bin/claude' } });
    await service.install({ harnesses: ['claude'] }, loopback);
    should(confirmations).be.empty();
  });
});

describe('ToolInstallService.install — what happens', () => {
  it('runs the declared command with the machine environment and reports progress', async () => {
    const { service, runs } = harness({ installs: { claude: '/opt/homebrew/bin/claude' } });
    const steps: ToolInstallProgress[] = [];
    const outcomes = await service.install({ harnesses: ['claude', 'claude'] }, loopback, step => steps.push(step));
    should(runs).eql([
      {
        executable: '/opt/homebrew/bin/brew',
        args: ['install', '--cask', 'claude-code'],
        environment: { PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/home/op', NONINTERACTIVE: '1' },
        timeoutMs: 15 * 60_000,
      },
    ]);
    const installed = {
      harness: 'claude',
      outcome: 'installed',
      command: 'brew install --cask claude-code',
      path: '/opt/homebrew/bin/claude',
    } as const;
    should(outcomes).eql([installed]);
    should(steps).eql([
      { harness: 'claude', stage: 'running', command: 'brew install --cask claude-code' },
      { harness: 'claude', stage: 'finished', outcome: installed },
    ]);
  });

  it('honours a configured deadline', async () => {
    const { service, runs } = harness({ timeoutMinutes: 2 });
    await service.install({ harnesses: ['codex'] }, loopback);
    should(runs[0]?.timeoutMs).equal(120_000);
  });

  it('skips a tool that is already installed and runs nothing for it', async () => {
    const { service, runs } = harness({ present: { claude: '/usr/bin/claude' } });
    should(await service.install({ harnesses: ['claude'] }, loopback)).eql([
      { harness: 'claude', outcome: 'already-installed', path: '/usr/bin/claude' },
    ]);
    should(runs).be.empty();
  });

  it('answers a machine without a manager with the command to run by hand', async () => {
    const { service, runs } = harness({ executables: machine() });
    const [outcome] = await service.install({ harnesses: ['codex'] }, loopback);
    should(outcome).containEql({
      outcome: 'failed',
      cause: 'no-package-manager',
      manualCommand: 'brew install --cask codex',
    });
    should(runs).be.empty();
  });

  it('carries a failed run through as its classified failure', async () => {
    const { service } = harness({
      executables: machine({ npm: '/usr/bin/npm' }),
      result: { kind: 'exited', code: 243, tail: ['npm error code EACCES'] },
    });
    const [outcome] = await service.install({ harnesses: ['claude'] }, loopback);
    should(outcome).containEql({
      cause: 'needs-admin',
      manualCommand: 'sudo npm install -g @anthropic-ai/claude-code',
    });
  });

  it('refuses to call a tool installed when the daemon still cannot find it', async () => {
    const { service } = harness({ executables: machine({ npm: '/usr/bin/npm' }) });
    const [outcome] = await service.install({ harnesses: ['codex'] }, loopback);
    should(outcome).eql({
      harness: 'codex',
      outcome: 'failed',
      cause: 'not-found-after-install',
      reason:
        "npm finished, but this daemon still cannot find `codex`. It was probably installed somewhere outside this daemon's PATH: tell the daemon where it is with FY_CODEX_BIN or the harness block in config/daemon.json, then restart it.",
      manualCommand: 'npm install -g @openai/codex',
    });
  });
});

describe('ToolInstallService.install — one at a time', () => {
  it('refuses a second install while one runs, before spending its password, and frees up afterwards', async () => {
    let release: (result: PackageInstallResult) => void = () => undefined;
    const confirmations: string[] = [];
    const { service } = harness({
      run: () =>
        new Promise<PackageInstallResult>(resolve => {
          release = resolve;
        }),
      confirmChange: async password => {
        confirmations.push(password);
        return { kind: 'confirmed' };
      },
    });
    const first = service.install({ harnesses: ['claude'] }, loopback);
    await Bun.sleep(0);
    const refused = await refusal(service.install({ harnesses: ['codex'], operatorPassword: 'pw' }, governed()));
    should(refused).containEql({
      code: 'tool_install_in_progress',
      message: 'an install is already running on this machine; wait for it to finish',
    });
    should(confirmations).be.empty();
    release({ kind: 'exited', code: 1, tail: [] });
    await first;
    const again = service.install({ harnesses: ['codex'] }, loopback);
    await Bun.sleep(0);
    release({ kind: 'exited', code: 1, tail: [] });
    should(await again).have.length(1);
  });

  it('refuses a request whose confirmation finished after another install had started', async () => {
    let confirm: () => void = () => undefined;
    let release: (result: PackageInstallResult) => void = () => undefined;
    const { service, runs } = harness({
      run: async run => {
        runs.push(run);
        return new Promise<PackageInstallResult>(resolve => {
          release = resolve;
        });
      },
      confirmChange: () =>
        new Promise<ChangeConfirmation>(resolve => {
          confirm = () => resolve({ kind: 'confirmed' });
        }),
    });
    const confirming = service.install({ harnesses: ['claude'], operatorPassword: 'pw' }, governed());
    await Bun.sleep(0);
    const running = service.install({ harnesses: ['codex'] }, loopback);
    await Bun.sleep(0);
    confirm();
    should((await refusal(confirming)).code).equal('tool_install_in_progress');
    release({ kind: 'exited', code: 1, tail: [] });
    await running;
    should(runs.map(run => run.args.at(-1))).eql(['codex']);
  });
});
