/**
 * The login port with a recorded spawn and a real filesystem.
 *
 * No test launches a harness, opens a browser, or reads the invoking user's homes: the spawn is a seam
 * and every wrapper it is pointed at lives in a temporary directory this test created.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { FleetConfigSchema } from '../../src/lib/config.ts';
import type { FleetLoginTarget } from '../../src/lib/login.ts';
import { resolveAccounts } from '../../src/lib/profiles.ts';
import { renderWrapperScript } from '../../src/lib/wrappers.ts';

/** The value, or a failure naming what was missing rather than a `TypeError` three lines later. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what}`);
  return value;
}

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
    should(actual)
      .have.property('message')
      .match(/"codex" CLI is on this host/u);
    should(actual)
      .have.property('message')
      .match(/fy fleet apply/u);
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

/**
 * WHAT THE COMPOSED COMMAND LINE ACTUALLY IS, AND WHY THAT IS A DEFECT.
 *
 * This block is DOCUMENTATION OF A DEFECT, not an approval of one. It is green because the behaviour it
 * describes is the behaviour that ships; read it as the reproduction, not as the contract.
 *
 * `renderWrapperScript` ends a generated wrapper with `exec <binary> <account flags> "$@"`
 * (`packages/fleet/src/lib/wrappers.ts:259`), and both login paths launch `[wrapper, <login argv>]` —
 * this port at `process-login.ts:78`, and the daemon's browser-driven flow at
 * `packages/daemon/src/lib/fleet-login/service.ts:536`. So an account's declared SESSION flags arrive
 * ahead of a SUBCOMMAND, which is a position no harness promises to accept them in.
 *
 * Measured on this host, at codex-cli 0.145.0 and claude-code 2.1.220:
 *
 *     codex login --device-auth                                       -> prints a URL and a user code
 *     codex --full-auto login --device-auth                           -> error: unexpected argument
 *                                                                        '--full-auto' found
 *     codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen login --device-auth -> works
 *     claude --dangerously-skip-permissions --disallowed-tools=AskUserQuestion auth login --claudeai
 *                                                                     -> works
 *
 * Codex's parser (clap) refuses an unknown ROOT argument outright; Claude's (commander) passes root
 * flags through to the subcommand. Both harnesses' SHIPPED starter flags survive at these versions, so
 * what breaks is an operator-declared codex root-only flag — and it bites hardest on an identity with no
 * interactive lane, because `chooseLoginMember` then falls back to the auto lane, which is exactly where
 * the aggressive flags live. The failure is silent in the worst way: the harness prints no URL and no
 * code, so the daemon reports that this host's harness offered no browser-drivable sign-in and names
 * `fy fleet login` — which composes the same flags and fails identically.
 *
 * Deliberately NOT fixed here: every honest fix changes the bytes of the executables Ferretry writes
 * into somebody's home, which is its own change with its own review.
 */
describe('the composed login command line', () => {
  it('should place the account’s declared harness flags BEFORE the login subcommand — pinned as the DEFECT it is', async () => {
    // Arrange — a real generated wrapper for a real resolved account, and a stand-in for the harness
    // binary the wrapper execs BY NAME off `PATH`, so what is asserted is the argv a harness would see.
    const root = await temporaryDirectory();
    const bin = path.join(root, 'bin');
    await mkdir(bin, { recursive: true });
    const argv = path.join(root, 'argv');
    const harness = path.join(bin, 'codex');
    await writeFile(harness, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argv)}\n`);
    await chmod(harness, 0o700);

    const config = FleetConfigSchema.parse({
      // The lane with no interactive sibling, which is the case `chooseLoginMember` falls back into.
      variants: { auto: { mode: 'auto', codex: { flags: ['--full-auto'] } } },
      agents: [
        {
          name: 'unattended',
          kind: 'codex',
          routes: {
            auto: {
              id: '00000000-0000-4000-8000-0000000000aa',
              wrapper: 'codex-unattended',
              home: path.join(root, 'home'),
              defaultModel: 'model-one',
              models: ['model-one'],
            },
          },
        },
      ],
    });
    const account = resolveAccounts(config)[0];
    const wrapper = path.join(bin, 'codex-unattended');
    await writeFile(wrapper, renderWrapperScript(must(account, 'the resolved account')));
    await chmod(wrapper, 0o700);

    const subject = new ProcessFleetLoginPort({
      spawn: spawnFleetLoginProcess,
      environment: { PATH: bin },
      readWrapper: readFleetWrapperScript,
      which: neverInstalled,
    });

    // Act
    const actual = await subject.login(target({ kind: 'codex', wrapper, home: path.join(root, 'home') }));

    // Assert — the flag precedes `login`. A harness whose parser refuses a root flag in that position
    // never reaches its own login at all, and this port reports only the exit code.
    should(actual).deepEqual({ status: 'logged-in' });
    should((await readFile(argv, 'utf8')).split('\n').filter(line => line !== '')).deepEqual(['--full-auto', 'login']);
  });

  it('should compose a flagless account’s command line as the harness’s own login and nothing else', async () => {
    // The control case, and the reason the one above is a defect rather than a design: with no declared
    // flags the wrapper hands the harness exactly the login argument, which is what every harness accepts.
    // Arrange
    const root = await temporaryDirectory();
    const bin = path.join(root, 'bin');
    await mkdir(bin, { recursive: true });
    const argv = path.join(root, 'argv');
    const harness = path.join(bin, 'codex');
    await writeFile(harness, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argv)}\n`);
    await chmod(harness, 0o700);

    const config = FleetConfigSchema.parse({
      variants: { default: {} },
      agents: [
        {
          name: 'attended',
          kind: 'codex',
          routes: {
            default: {
              id: '00000000-0000-4000-8000-0000000000bb',
              wrapper: 'codex-attended',
              home: path.join(root, 'home'),
              defaultModel: 'model-one',
              models: ['model-one'],
            },
          },
        },
      ],
    });
    const wrapper = path.join(bin, 'codex-attended');
    await writeFile(wrapper, renderWrapperScript(must(resolveAccounts(config)[0], 'the resolved account')));
    await chmod(wrapper, 0o700);

    const subject = new ProcessFleetLoginPort({
      spawn: spawnFleetLoginProcess,
      environment: { PATH: bin },
      readWrapper: readFleetWrapperScript,
      which: neverInstalled,
    });

    // Act
    await subject.login(target({ kind: 'codex', wrapper, home: path.join(root, 'home') }));

    // Assert
    should((await readFile(argv, 'utf8')).split('\n').filter(line => line !== '')).deepEqual(['login']);
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
