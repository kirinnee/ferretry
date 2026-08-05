/**
 * The login port with a recorded spawn and a real filesystem.
 *
 * No test launches a harness, opens a browser, or reads the invoking user's homes: the spawn is a seam
 * and every wrapper it is pointed at lives in a temporary directory this test created.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import {
  type FleetBinaryLookup,
  type FleetLoginSpawn,
  ProcessFleetLoginPort,
  readFleetWrapperScript,
  spawnFleetLoginProcess,
  whichHarnessBinary,
} from '../../src/adapters/process-login.ts';
import type { FleetLoginTarget } from '../../src/lib/login.ts';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'fy-fleet-login-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const target = (overrides: Partial<FleetLoginTarget> = {}): FleetLoginTarget => ({
  accountId: '00000000-0000-4000-8000-000000000001',
  kind: 'claude',
  wrapper: '/absent/bin/alias-claude-with-hyphens',
  home: '/absent/homes/claude',
  ...overrides,
});

interface Recorded {
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
}

/** A spawn that records instead of launching anything. */
const recorder =
  (calls: Recorded[], code = 0): FleetLoginSpawn =>
  (command, options) => {
    calls.push({
      command,
      environment: options.environment,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    return { exited: Promise.resolve(code) };
  };

const neverInstalled: FleetBinaryLookup = () => undefined;

/** A wrapper on disk, so the port takes its "the wrapper exists" branch honestly. */
async function wrapperFile(script = '#!/bin/sh\nexec true "$@"\n'): Promise<string> {
  const directory = await temporaryDirectory();
  const wrapper = path.join(directory, 'alias-claude-with-hyphens');
  await writeFile(wrapper, script);
  return wrapper;
}

describe('ProcessFleetLoginPort', () => {
  it('should launch the wrapper the manifest published, without parsing its filename', async () => {
    // Arrange
    const calls: Recorded[] = [];
    const wrapper = await wrapperFile();
    const subject = new ProcessFleetLoginPort({
      spawn: recorder(calls),
      environment: { FY_TEST_TOKEN: 'placeholder' },
      readWrapper: readFleetWrapperScript,
      which: neverInstalled,
      cwd: '/absent/cwd',
    });

    // Act
    const actual = await subject.login(target({ wrapper }));

    // Assert
    should(actual).deepEqual({ status: 'logged-in' });
    should(calls).have.length(1);
    should(calls[0]?.command).deepEqual([wrapper, '/login']);
    should(calls[0]?.cwd).equal('/absent/cwd');
  });

  it('should use the harness-appropriate login argument', async () => {
    // Arrange
    const calls: Recorded[] = [];
    const wrapper = await wrapperFile();
    const subject = new ProcessFleetLoginPort({
      spawn: recorder(calls),
      environment: {},
      readWrapper: readFleetWrapperScript,
      which: neverInstalled,
    });

    // Act
    await subject.login(target({ wrapper, kind: 'codex' }));

    // Assert
    should(calls[0]?.command).deepEqual([wrapper, 'login']);
    should(calls[0]?.cwd).be.undefined();
  });

  it('should strip the caller’s provider credentials before launching', async () => {
    // Arrange — running a login inside an agent session used to authenticate that session's account.
    const calls: Recorded[] = [];
    const wrapper = await wrapperFile();
    const subject = new ProcessFleetLoginPort({
      spawn: recorder(calls),
      environment: {
        ANTHROPIC_API_KEY: 'placeholder-caller-key',
        ANTHROPIC_BASE_URL: 'https://example.invalid',
        CLAUDE_CONFIG_DIR: '/absent/other-home',
        PATH: '/usr/bin',
      },
      readWrapper: readFleetWrapperScript,
      which: neverInstalled,
    });

    // Act
    await subject.login(target({ wrapper }));

    // Assert
    should(calls[0]?.environment).deepEqual({ PATH: '/usr/bin' });
  });

  it('should preserve a variable the wrapper deliberately reads from its surroundings', async () => {
    // Arrange — `env: { OPENAI_API_KEY: "$OPENAI_API_KEY" }` is a supported, documented shape.
    const calls: Recorded[] = [];
    const wrapper = await wrapperFile('#!/bin/sh\nexport OPENAI_API_KEY="${OPENAI_API_KEY}"\nexec true "$@"\n');
    const subject = new ProcessFleetLoginPort({
      spawn: recorder(calls),
      environment: { OPENAI_API_KEY: 'placeholder-secret', ANTHROPIC_API_KEY: 'placeholder-caller-key' },
      readWrapper: readFleetWrapperScript,
      which: neverInstalled,
    });

    // Act
    await subject.login(target({ wrapper }));

    // Assert — removing it would break the very account the caller is trying to fix.
    should(calls[0]?.environment).deepEqual({ OPENAI_API_KEY: 'placeholder-secret' });
  });

  it('should fall back to the harness CLI on a host where the wrapper was never generated', async () => {
    // Arrange — a fresh machine is exactly when somebody needs to log in.
    const calls: Recorded[] = [];
    const subject = new ProcessFleetLoginPort({
      spawn: recorder(calls),
      environment: { ANTHROPIC_API_KEY: 'placeholder-caller-key', PATH: '/usr/bin' },
      readWrapper: readFleetWrapperScript,
      which: binary => (binary === 'claude' ? '/absent/local/bin/claude' : undefined),
    });

    // Act
    const actual = await subject.login(target());

    // Assert — a bare CLI references nothing, so nothing inherited is preserved for it.
    should(actual).deepEqual({ status: 'logged-in' });
    should(calls[0]?.command).deepEqual(['/absent/local/bin/claude', '/login']);
    should(calls[0]?.environment).deepEqual({ PATH: '/usr/bin' });
  });

  it('should look up the CLI matching the harness, not a fixed one', async () => {
    // Arrange
    const requested: string[] = [];
    const subject = new ProcessFleetLoginPort({
      spawn: recorder([]),
      environment: {},
      readWrapper: readFleetWrapperScript,
      which: binary => {
        requested.push(binary);
        return '/absent/local/bin/codex';
      },
    });

    // Act
    await subject.login(target({ kind: 'codex' }));

    // Assert
    should(requested).deepEqual(['codex']);
  });

  it('should say which of the two is missing when the host has neither', async () => {
    // Arrange
    const calls: Recorded[] = [];
    const subject = new ProcessFleetLoginPort({
      spawn: recorder(calls),
      environment: {},
      readWrapper: readFleetWrapperScript,
      which: neverInstalled,
    });

    // Act
    const actual = await subject.login(target({ kind: 'codex' }));

    // Assert — an actionable message beats an exit code.
    should(calls).deepEqual([]);
    should(actual.status).equal('failed');
    should(actual).have.property('message').match(/"codex" CLI is on this host/u);
    should(actual).have.property('message').match(/fy fleet apply/u);
  });

  it('should report a non-zero exit as a failure naming the code', async () => {
    // Arrange
    const wrapper = await wrapperFile();
    const subject = new ProcessFleetLoginPort({
      spawn: recorder([], 7),
      environment: {},
      readWrapper: readFleetWrapperScript,
      which: neverInstalled,
    });

    // Act
    const actual = await subject.login(target({ wrapper }));

    // Assert
    should(actual).deepEqual({ status: 'failed', message: 'login process exited with code 7' });
  });
});

describe('readFleetWrapperScript', () => {
  it('should read a wrapper that is there', async () => {
    // Arrange
    const wrapper = await wrapperFile('#!/bin/sh\nexport A="${B}"\n');

    // Act / Assert
    should(await readFleetWrapperScript(wrapper)).equal('#!/bin/sh\nexport A="${B}"\n');
  });

  it('should yield nothing for a wrapper that is absent', async () => {
    should(await readFleetWrapperScript(path.join(await temporaryDirectory(), 'absent'))).be.undefined();
  });
});

describe('whichHarnessBinary', () => {
  it('should find a binary this host has', () => {
    should(whichHarnessBinary('sh')).be.a.String();
  });

  it('should yield nothing for a binary this host does not have', () => {
    should(whichHarnessBinary('definitely-not-installed-fy-test')).be.undefined();
  });
});

describe('spawnFleetLoginProcess', () => {
  it('should run a real command and report its exit code', async () => {
    // Arrange
    const shell = Bun.which('sh') ?? '/bin/sh';

    // Act
    const started = spawnFleetLoginProcess([shell, '-c', 'exit 3'], { environment: { PATH: '/usr/bin' } });

    // Assert
    should(await started.exited).equal(3);
  });

  it('should run inside a supplied working directory', async () => {
    // Arrange
    const directory = await temporaryDirectory();
    const shell = Bun.which('sh') ?? '/bin/sh';

    // Act — the marker can only appear if the working directory was honoured.
    const started = spawnFleetLoginProcess([shell, '-c', ': > marker'], {
      environment: { PATH: '/usr/bin:/bin' },
      cwd: directory,
    });
    await started.exited;

    // Assert
    should(await Bun.file(path.join(directory, 'marker')).exists()).be.true();
  });
});
