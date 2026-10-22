import { describe, it } from 'bun:test';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  bunProbeSpawn,
  CliPackProbe,
  type ProbeEnvironment,
  type ProbeLauncher,
  type ProbeSpawn,
  probeCommand,
} from '../../../src/adapters/pack/cli-probe.ts';
import type { ExecutableResolverPort } from '../../../src/lib/core/harness-readiness.ts';
import type { CoreAccount } from '../../../src/lib/core/inventory.ts';
import { resolveStartAccount } from '../../../src/lib/fleet/start-resolution.ts';
import { type PackProbeRequest, PROBE_PROMPT } from '../../../src/lib/pack/probe.ts';

const request = (overrides: Partial<PackProbeRequest> = {}): PackProbeRequest => ({
  wrapper: 'claude-work',
  harness: 'claude',
  cwd: '/work',
  timeoutMs: 45_000,
  ...overrides,
});

describe('probeCommand', () => {
  it('should run a Claude wrapper one-shot, on the model asked for', () => {
    // Arrange + Act + Assert
    should(probeCommand(request({ model: 'opus' }), '/bin/claude-work')).eql([
      '/bin/claude-work',
      '-p',
      PROBE_PROMPT,
      '--model',
      'opus',
    ]);
  });

  it('should carry the start’s own --effort, so an argument only the start adds is tried before a pane exists', () => {
    // Arrange + Act + Assert
    should(probeCommand(request({ model: 'glm-5.3', effort: 'max' }), '/bin/claude-zai')).eql([
      '/bin/claude-zai',
      '-p',
      PROBE_PROMPT,
      '--model',
      'glm-5.3',
      '--effort',
      'max',
    ]);
  });

  it('should run a Claude wrapper on its own default model when none is named', () => {
    should(probeCommand(request(), '/bin/claude-work')).eql(['/bin/claude-work', '-p', PROBE_PROMPT]);
  });

  it('should run a Codex wrapper at low effort, on the model asked for', () => {
    // Arrange + Act + Assert
    should(probeCommand(request({ harness: 'codex', wrapper: 'codex-work', model: 'gpt-x' }), '/bin/codex-work')).eql([
      '/bin/codex-work',
      'exec',
      '--skip-git-repo-check',
      '-c',
      'model_reasoning_effort="low"',
      '--model',
      'gpt-x',
      PROBE_PROMPT,
    ]);
  });

  it('should run a Codex wrapper on its default model when none is named', () => {
    should(probeCommand(request({ harness: 'codex', wrapper: 'codex-work' }), '/bin/codex-work')).eql([
      '/bin/codex-work',
      'exec',
      '--skip-git-repo-check',
      '-c',
      'model_reasoning_effort="low"',
      PROBE_PROMPT,
    ]);
  });
});

function build(options: {
  spawn: ProbeSpawn;
  launcher?: ProbeLauncher['resolve'];
  environment?: ProbeEnvironment['forWrapper'];
  base?: Record<string, string>;
  clock?: number[];
}) {
  const ticks = [...(options.clock ?? [0, 250])];
  let last = 0;
  const environment: ProbeEnvironment = { forWrapper: options.environment ?? (async () => ({})) };
  const launcher: ProbeLauncher = { resolve: options.launcher ?? (async wrapper => `/bin/${wrapper}`) };
  return new CliPackProbe(launcher, environment, options.spawn, options.base ?? {}, () => {
    last = ticks.shift() ?? last;
    return last;
  });
}

describe('CliPackProbe', () => {
  it('should pass when the CLI answers OK, timing the run and merging the login over the base environment', async () => {
    // Arrange — the login is looked up by the ABSOLUTE launcher, as a pane's is, and never sets HOME.
    const spawned: Array<Parameters<ProbeSpawn>[0]> = [];
    const probe = build({
      base: { PATH: '/usr/bin', TOKEN: 'base', HOME: '/home/owner' },
      environment: async (wrapper): Promise<Record<string, string>> =>
        wrapper === '/bin/claude-work' ? { TOKEN: 'login', HOME: '/elsewhere' } : {},
      spawn: async input => {
        spawned.push(input);
        return { kind: 'exited', code: 0, stdout: 'OK\n' };
      },
    });

    // Act
    const outcome = await probe.probe(request({ model: 'opus' }));

    // Assert
    should(outcome).eql({ ok: true, ms: 250 });
    should(spawned).eql([
      {
        cmd: ['/bin/claude-work', '-p', PROBE_PROMPT, '--model', 'opus'],
        cwd: '/work',
        env: { PATH: '/usr/bin', TOKEN: 'login', HOME: '/home/owner' },
        timeoutMs: 45_000,
      },
    ]);
  });

  it('should fail when it answers something other than OK', async () => {
    // Arrange
    const probe = build({ spawn: async () => ({ kind: 'exited', code: 0, stdout: 'I cannot do that' }) });

    // Act + Assert
    should(await probe.probe(request())).eql({ ok: false, ms: 250, reason: 'it answered, but not OK' });
  });

  it('should name a failure the CLI reports — quota, sign-in, a missing model — without repeating its words', async () => {
    // Arrange
    const said = (stdout: string, stderr: string, code = 1) =>
      build({ spawn: async () => ({ kind: 'exited', code, stdout, stderr }) }).probe(request());

    // Act
    const quota = await said('', 'Error: Claude AI usage limit reached|1761156000');
    const login = await said('Invalid API key · Please run /login', '');
    const model = await said('', 'API Error: 404 model: claude-nope does not exist');
    const answered = await said("You've hit your rate limit.", '', 0);
    const other = await said('', 'segfault');

    // Assert
    should(quota).eql({
      ok: false,
      ms: 250,
      reason: 'it exited 1: its login is out of quota or rate-limited',
      code: 'out_of_quota',
    });
    should(login).eql({
      ok: false,
      ms: 250,
      reason: 'it exited 1: its login is not signed in or its key was refused',
      code: 'not_logged_in',
    });
    should(model).eql({
      ok: false,
      ms: 250,
      reason: 'it exited 1: the provider does not serve that model',
      code: 'model_unavailable',
    });
    should(answered).eql({
      ok: false,
      ms: 250,
      reason: 'it answered, but not OK: its login is out of quota or rate-limited',
      code: 'out_of_quota',
    });
    should(other).eql({ ok: false, ms: 250, reason: 'it exited 1' });
    should(JSON.stringify([quota, login, model])).not.containEql('1761156000');
  });

  it('should fail with the exit code when the CLI exits non-zero', async () => {
    // Arrange
    const probe = build({ spawn: async () => ({ kind: 'exited', code: 3, stdout: 'OK' }) });

    // Act + Assert
    should(await probe.probe(request())).eql({ ok: false, ms: 250, reason: 'it exited 3' });
  });

  it('should fail with the allowed seconds when it times out', async () => {
    // Arrange
    const probe = build({ spawn: async () => ({ kind: 'timeout' }) });

    // Act + Assert
    should(await probe.probe(request({ timeoutMs: 20_000 }))).eql({
      ok: false,
      ms: 250,
      reason: 'no answer within 20s',
    });
  });

  it('should fail, not throw, when the process cannot be started', async () => {
    // Arrange
    const thrown = build({
      spawn: async () => {
        throw new Error('ENOENT: no such file');
      },
    });
    const notAnError = build({
      spawn: async () => {
        throw 'plain string';
      },
    });

    // Act + Assert
    should(await thrown.probe(request())).eql({
      ok: false,
      ms: 250,
      reason: 'it could not be started (ENOENT: no such file)',
    });
    should(await notAnError.probe(request())).eql({
      ok: false,
      ms: 250,
      reason: 'it could not be started (plain string)',
    });
  });

  it("should fail with the start's own refusal when its launcher cannot be resolved, never spawning", async () => {
    // Arrange
    let spawned = false;
    const probe = build({
      launcher: async () => {
        throw new Error(
          'the fleet publishes claude-work at /fy/fleet/bin/claude-work, but this host cannot run that file',
        );
      },
      spawn: async () => {
        spawned = true;
        return { kind: 'timeout' };
      },
    });
    const opaque = build({
      launcher: async () => {
        throw 42;
      },
      spawn: async () => ({ kind: 'timeout' }),
    });

    // Act + Assert
    should(await probe.probe(request())).eql({
      ok: false,
      ms: 250,
      reason:
        'it cannot be launched: the fleet publishes claude-work at /fy/fleet/bin/claude-work, but this host cannot run that file',
    });
    should(await opaque.probe(request())).eql({
      ok: false,
      ms: 250,
      reason: 'it cannot be launched: its launcher is unknown',
    });
    should(spawned).be.false();
  });

  it('should fail with the reason when its login cannot be read, never spawning', async () => {
    // Arrange
    let spawned = false;
    const probe = build({
      environment: async () => {
        throw new Error('secret NAME is not set');
      },
      spawn: async () => {
        spawned = true;
        return { kind: 'timeout' };
      },
    });
    const opaque = build({
      environment: async () => {
        throw 42;
      },
      spawn: async () => ({ kind: 'timeout' }),
    });

    // Act + Assert
    should(await probe.probe(request())).eql({ ok: false, ms: 250, reason: 'secret NAME is not set' });
    should(await opaque.probe(request())).eql({ ok: false, ms: 250, reason: 'its login could not be read' });
    should(spawned).be.false();
  });

  it('should never report negative time when the clock steps backwards', async () => {
    // Arrange
    const probe = build({ clock: [100, 40], spawn: async () => ({ kind: 'exited', code: 0, stdout: 'ok' }) });

    // Act + Assert
    should(await probe.probe(request())).eql({ ok: true, ms: 0 });
  });
});

describe('bunProbeSpawn', () => {
  async function script(body: string): Promise<{ readonly dir: string; readonly path: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'ferretry-pack-probe-'));
    const path = join(dir, 'cli.sh');
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return { dir, path };
  }

  it('should run the command in its folder with exactly the given environment and return its output', async () => {
    // Arrange
    const fake = await script('echo "OK from $PROBE_LOGIN in $(pwd)"');
    try {
      // Act
      const outcome = await bunProbeSpawn({
        cmd: [fake.path, 'ignored'],
        cwd: fake.dir,
        env: { PROBE_LOGIN: 'login-1', PATH: process.env.PATH ?? '' },
        timeoutMs: 10_000,
      });

      // Assert
      should(outcome.kind).equal('exited');
      if (outcome.kind === 'exited') {
        should(outcome.code).equal(0);
        should(outcome.stdout).startWith('OK from login-1 in ');
        should(outcome.stdout).containEql('ferretry-pack-probe-');
      }
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });

  it('should report a non-zero exit with the code', async () => {
    // Arrange
    const fake = await script('echo nope; exit 7');
    try {
      // Act
      const outcome = await bunProbeSpawn({ cmd: [fake.path], cwd: fake.dir, env: {}, timeoutMs: 10_000 });

      // Assert
      should(outcome).eql({ kind: 'exited', code: 7, stdout: 'nope\n', stderr: '' });
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });

  it('should time out and kill a CLI that sleeps past the deadline', async () => {
    // Arrange
    const fake = await script('sleep 30');
    try {
      const started = performance.now();

      // Act
      const outcome = await bunProbeSpawn({
        cmd: [fake.path],
        cwd: fake.dir,
        env: { PATH: process.env.PATH ?? '' },
        timeoutMs: 150,
      });

      // Assert — it returned at the deadline, not after the sleep.
      should(outcome).eql({ kind: 'timeout' });
      should(performance.now() - started).be.below(5_000);
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });

  it('should work end to end through CliPackProbe with a fake CLI that prints OK', async () => {
    // Arrange
    const fake = await script('echo OK');
    try {
      const probe = new CliPackProbe(
        { resolve: async () => fake.path },
        { forWrapper: async () => ({}) },
        bunProbeSpawn,
        {},
        () => performance.now(),
      );

      // Act
      const outcome = await probe.probe({ wrapper: 'cli.sh', harness: 'claude', cwd: fake.dir, timeoutMs: 10_000 });

      // Assert
      should(outcome.ok).be.true();
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });
});

/**
 * The bug this guards: a runtime's launcher lives in `$FY_HOME/fleet/bin`, which is NOT on a service
 * daemon's `PATH`. A probe that spawned the bare runtime name failed every candidate with "Executable not
 * found in $PATH" while the start it guarded — which runs the published absolute path — would have worked.
 */
describe("CliPackProbe through the start's own launcher resolution", () => {
  /** This host's runnable check, as the daemon's resolver answers it. */
  const host: ExecutableResolverPort = {
    resolve: () => undefined,
    runnable: path => {
      try {
        accessSync(path, fsConstants.X_OK);
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
  };

  async function fleet(): Promise<{ readonly home: string; readonly launcher: string; readonly account: CoreAccount }> {
    const home = await mkdtemp(join(tmpdir(), 'ferretry-pack-launcher-'));
    const bin = join(home, 'fleet', 'bin');
    await mkdir(bin, { recursive: true });
    const launcher = join(bin, 'claude-default');
    const account: CoreAccount = {
      secretEnv: {},
      id: 'account-default',
      agent: 'claude-default',
      wrapper: launcher,
      home: join(home, 'fleet', 'homes', 'claude-default'),
      kind: 'claude',
      mode: 'auto',
      displayName: 'Claude default',
      defaultModel: null,
      models: [],
      available: true,
      unavailableReason: null,
    };
    return { home, launcher, account };
  }

  function probeOver(
    account: CoreAccount,
    environment: ProbeEnvironment['forWrapper'] = async () => ({}),
  ): CliPackProbe {
    return new CliPackProbe(
      {
        resolve: async wrapper =>
          (await resolveStartAccount({ accounts: async () => [account] }, wrapper, host, 'fy')).executable,
      },
      { forWrapper: environment },
      bunProbeSpawn,
      // A daemon's PATH: system directories only, never the fleet's bin.
      { PATH: '/usr/bin:/bin' },
      () => performance.now(),
    );
  }

  it('should run a launcher that is in the fleet bin directory but not on PATH, with its login and model', async () => {
    // Arrange
    const { home, launcher, account } = await fleet();
    await writeFile(launcher, '#!/bin/sh\necho "$@" > "$0.argv"\necho "$PROBE_LOGIN" > "$0.env"\necho OK\n');
    await chmod(launcher, 0o755);
    const looked: string[] = [];
    try {
      const probe = probeOver(account, async wrapper => {
        looked.push(wrapper);
        return { PROBE_LOGIN: 'from-profile' };
      });

      // Act
      const outcome = await probe.probe({
        wrapper: 'claude-default',
        harness: 'claude',
        model: 'claude-sonnet-5-5',
        cwd: home,
        timeoutMs: 10_000,
      });

      // Assert
      should(outcome.ok).be.true();
      should(looked).eql([launcher]);
      should((await Bun.file(`${launcher}.argv`).text()).trim()).equal(`-p ${PROBE_PROMPT} --model claude-sonnet-5-5`);
      should((await Bun.file(`${launcher}.env`).text()).trim()).equal('from-profile');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("should refuse a launcher that is truly absent with the start's refusal, naming the path", async () => {
    // Arrange — the manifest publishes the runtime, but nothing is at its launcher's path.
    const { home, launcher, account } = await fleet();
    try {
      const probe = probeOver(account);

      // Act
      const outcome = await probe.probe({ wrapper: 'claude-default', harness: 'claude', cwd: home, timeoutMs: 10_000 });

      // Assert
      should(outcome.ok).be.false();
      if (!outcome.ok) {
        should(outcome.reason).startWith('it cannot be launched: ');
        should(outcome.reason).containEql(launcher);
        should(outcome.reason).not.containEql('$PATH');
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
