import { describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import {
  type FleetLoginSpawn,
  ProcessFleetLoginPort,
  readFleetWrapperScript,
  spawnFleetLoginProcess,
} from '../../src/adapters/process-login.ts';
import type { FleetManifestAccount } from '../../src/lib/manifest.ts';

const account = (kind: FleetManifestAccount['kind']): FleetManifestAccount => ({
  id: kind === 'claude' ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002',
  kind,
  mode: 'auto',
  wrapper: `/tmp/fy-test/bin/alias-${kind}-with-hyphens`,
  home: `/tmp/fy-test/homes/${kind}`,
  displayName: `Placeholder ${kind}`,
  defaultModel: 'model-one',
  models: [{ id: 'model-one', displayName: 'Model One', available: true }],
  available: true,
  unavailableReason: null,
});

describe('ProcessFleetLoginPort', () => {
  it('should execute the manifest wrapper attribute without parsing its filename', async () => {
    // Arrange
    const calls: Array<{ command: readonly string[]; cwd?: string }> = [];
    const spawn: FleetLoginSpawn = (command, options) => {
      calls.push({ command, cwd: options.cwd });
      return { exited: Promise.resolve(0) };
    };
    const subject = new ProcessFleetLoginPort(
      spawn,
      { FY_TEST_TOKEN: 'placeholder' },
      () => true,
      () => Promise.resolve(undefined),
      '/tmp/fy-test',
    );
    const target = account('claude');

    // Act
    const actual = await subject.login(target);

    // Assert
    should(calls).deepEqual([{ command: [target.wrapper, '/login'], cwd: '/tmp/fy-test' }]);
    should(actual).deepEqual({ status: 'logged-in' });
  });

  it('should use the Codex login subcommand and report a non-zero exit', async () => {
    // Arrange
    const commands: string[][] = [];
    const spawn: FleetLoginSpawn = command => {
      commands.push([...command]);
      return { exited: Promise.resolve(7) };
    };
    const subject = new ProcessFleetLoginPort(
      spawn,
      {},
      () => true,
      () => Promise.resolve(undefined),
    );
    const target = account('codex');

    // Act
    const actual = await subject.login(target);

    // Assert
    should(commands).deepEqual([[target.wrapper, 'login']]);
    should(actual).deepEqual({ status: 'failed', message: 'login process exited with code 7' });
  });

  it('should skip accounts whose configured authentication does not require login', async () => {
    // Arrange
    let spawned = false;
    const spawn: FleetLoginSpawn = () => {
      spawned = true;
      return { exited: Promise.resolve(0) };
    };
    const subject = new ProcessFleetLoginPort(
      spawn,
      {},
      () => false,
      () => Promise.resolve(undefined),
    );

    // Act
    const actual = await subject.login(account('claude'));

    // Assert
    should(spawned).be.false();
    should(actual).deepEqual({ status: 'not-required' });
  });

  it("should strip the caller's provider credentials so a login cannot use the wrong account", async () => {
    // Arrange — the environment an agent session running `fy fleet login` would actually carry.
    let environment: Readonly<Record<string, string | undefined>> = {};
    const spawn: FleetLoginSpawn = (_command, options) => {
      environment = options.environment;
      return { exited: Promise.resolve(0) };
    };
    const subject = new ProcessFleetLoginPort(
      spawn,
      {
        ANTHROPIC_API_KEY: 'placeholder-caller-key',
        ANTHROPIC_BASE_URL: 'https://example.invalid',
        CLAUDE_CONFIG_DIR: '/somebody/elses/home',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'placeholder-model',
        PATH: '/usr/bin',
      },
      () => true,
      () => Promise.resolve(undefined),
    );

    // Act
    await subject.login(account('claude'));

    // Assert
    should(environment).deepEqual({ PATH: '/usr/bin' });
  });

  it('should preserve a variable the account’s own wrapper reads from the environment', async () => {
    // Arrange
    const directory = await mkdtemp(path.join(tmpdir(), 'fy-fleet-login-wrapper-'));
    const wrapper = path.join(directory, 'fy-claude-work');
    await Bun.write(
      wrapper,
      ['#!/bin/sh', 'export ANTHROPIC_AUTH_TOKEN="${FY_TEST_TOKEN}"', "export OPENAI_API_KEY='literal'", ''].join('\n'),
    );

    let environment: Readonly<Record<string, string | undefined>> = {};
    const spawn: FleetLoginSpawn = (_command, options) => {
      environment = options.environment;
      return { exited: Promise.resolve(0) };
    };
    const subject = new ProcessFleetLoginPort(
      spawn,
      { FY_TEST_TOKEN: 'placeholder', OPENAI_API_KEY: 'placeholder-caller-key' },
      () => true,
      readFleetWrapperScript,
    );

    try {
      // Act — the wrapper references FY_TEST_TOKEN, which is not harness state and survives anyway;
      // OPENAI_API_KEY is exported as a literal, so the caller's copy is still stripped.
      await subject.login({ ...account('claude'), wrapper });

      // Assert
      should(environment).deepEqual({ FY_TEST_TOKEN: 'placeholder' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('should preserve nothing when the wrapper cannot be read', async () => {
    // Arrange
    let environment: Readonly<Record<string, string | undefined>> = {};
    const spawn: FleetLoginSpawn = (_command, options) => {
      environment = options.environment;
      return { exited: Promise.resolve(0) };
    };
    const subject = new ProcessFleetLoginPort(
      spawn,
      { OPENAI_API_KEY: 'placeholder-caller-key', HOME: '/home/somebody' },
      () => true,
      readFleetWrapperScript,
    );

    // Act — the wrapper path does not exist, so its intentions are unknown.
    await subject.login({ ...account('claude'), wrapper: path.join(tmpdir(), 'fy-fleet-absent-wrapper') });

    // Assert
    should(environment).deepEqual({ HOME: '/home/somebody' });
  });
});

describe('readFleetWrapperScript', () => {
  it('should read a wrapper that exists and answer nothing for one that does not', async () => {
    // Arrange
    const directory = await mkdtemp(path.join(tmpdir(), 'fy-fleet-wrapper-source-'));
    const wrapper = path.join(directory, 'fy-claude-work');
    await Bun.write(wrapper, '#!/bin/sh\nexec claude "$@"\n');

    try {
      // Act
      const present = await readFleetWrapperScript(wrapper);
      const absent = await readFleetWrapperScript(path.join(directory, 'nothing-here'));

      // Assert
      should(present).equal('#!/bin/sh\nexec claude "$@"\n');
      should(absent).be.undefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('spawnFleetLoginProcess', () => {
  it('should run the given command and resolve its exit code', async () => {
    // Arrange — a trivial local shell, never a harness and never a real provider.
    const command = ['/bin/sh', '-c', 'exit 0'];

    // Act
    const actual = await spawnFleetLoginProcess(command, { environment: { FY_TEST_TOKEN: 'placeholder' } }).exited;

    // Assert
    should(actual).equal(0);
  });

  it('should surface a non-zero exit and honour the working directory', async () => {
    // Arrange
    const directory = await mkdtemp(path.join(tmpdir(), 'fy-fleet-login-test-'));
    const marker = path.join(directory, 'ran-here');

    try {
      // Act
      const actual = await spawnFleetLoginProcess(['/bin/sh', '-c', 'touch ran-here; exit 5'], {
        environment: {},
        cwd: directory,
      }).exited;

      // Assert
      should(actual).equal(5);
      should(await Bun.file(marker).exists()).be.true();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
