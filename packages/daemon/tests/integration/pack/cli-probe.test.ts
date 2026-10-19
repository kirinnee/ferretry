import { describe, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  bunProbeSpawn,
  CliPackProbe,
  type ProbeEnvironment,
  type ProbeSpawn,
  probeCommand,
} from '../../../src/adapters/pack/cli-probe.ts';
import { type PackProbeRequest, PROBE_PROMPT } from '../../../src/lib/pack/probe.ts';

const request = (overrides: Partial<PackProbeRequest> = {}): PackProbeRequest => ({
  wrapper: '/bin/claude-work',
  harness: 'claude',
  cwd: '/work',
  timeoutMs: 45_000,
  ...overrides,
});

describe('probeCommand', () => {
  it('should run a Claude wrapper one-shot, on the model asked for', () => {
    // Arrange + Act + Assert
    should(probeCommand(request({ model: 'opus' }))).eql(['/bin/claude-work', '-p', PROBE_PROMPT, '--model', 'opus']);
  });

  it('should run a Claude wrapper on its own default model when none is named', () => {
    should(probeCommand(request())).eql(['/bin/claude-work', '-p', PROBE_PROMPT]);
  });

  it('should run a Codex wrapper at low effort, on the model asked for', () => {
    // Arrange + Act + Assert
    should(probeCommand(request({ harness: 'codex', wrapper: '/bin/codex-work', model: 'gpt-x' }))).eql([
      '/bin/codex-work',
      'exec',
      '--skip-git-repo-check',
      '-c',
      'model_reasoning_effort="low"',
      '-m',
      'gpt-x',
      PROBE_PROMPT,
    ]);
  });

  it('should run a Codex wrapper on its default model when none is named', () => {
    should(probeCommand(request({ harness: 'codex', wrapper: '/bin/codex-work' }))).eql([
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
  environment?: ProbeEnvironment['forWrapper'];
  base?: Record<string, string>;
  clock?: number[];
}) {
  const ticks = [...(options.clock ?? [0, 250])];
  let last = 0;
  const environment: ProbeEnvironment = { forWrapper: options.environment ?? (async () => ({})) };
  return new CliPackProbe(environment, options.spawn, options.base ?? {}, () => {
    last = ticks.shift() ?? last;
    return last;
  });
}

describe('CliPackProbe', () => {
  it('should pass when the CLI answers OK, timing the run and merging the login over the base environment', async () => {
    // Arrange
    const spawned: Array<Parameters<ProbeSpawn>[0]> = [];
    const probe = build({
      base: { PATH: '/usr/bin', TOKEN: 'base' },
      environment: async (wrapper): Promise<Record<string, string>> =>
        wrapper === '/bin/claude-work' ? { TOKEN: 'login' } : {},
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
        env: { PATH: '/usr/bin', TOKEN: 'login' },
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
      should(outcome).eql({ kind: 'exited', code: 7, stdout: 'nope\n' });
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
      const probe = new CliPackProbe({ forWrapper: async () => ({}) }, bunProbeSpawn, {}, () => performance.now());

      // Act
      const outcome = await probe.probe({ wrapper: fake.path, harness: 'claude', cwd: fake.dir, timeoutMs: 10_000 });

      // Assert
      should(outcome.ok).be.true();
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });
});
