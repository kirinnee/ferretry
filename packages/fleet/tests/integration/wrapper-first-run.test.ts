import { describe, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import type { ResolvedAccount } from '../../src/lib/profiles.ts';
import { renderWrapperScript } from '../../src/lib/wrappers.ts';

/**
 * The first-run seeding is embedded shell, and the unit tests can only prove what the *text* says.
 * These run it: a real `sh`, a real `jq`, a disposable home, and a stand-in for the harness. Nothing
 * here launches an agent or touches a real account — the fake on `PATH` prints its arguments.
 *
 * This is the tier that would catch a quoting mistake, and a quoting mistake in a generated launcher
 * is the kind of defect that only ever appears on somebody else's machine.
 */

const account = (home: string, env: Record<string, string> = {}): ResolvedAccount =>
  ({
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'claude',
    mode: 'auto',
    wrapper: 'fy-claude-work',
    home,
    displayName: 'Claude (work)',
    agent: 'work',
    variant: 'auto',
    identity: 'work',
    auth: 'oauth',
    available: true,
    unavailableReason: null,
    defaultModel: null,
    models: [],
    env,
    flags: [],
    settings: [],
    memory: undefined,
    skills: undefined,
    hooks: undefined,
    hooksDir: undefined,
    mcp: undefined,
  }) as ResolvedAccount;

interface Sandbox {
  readonly home: string;
  readonly cwd: string;
  /** Runs the wrapper for an account whose home is {@link home}. */
  readonly run: (env?: Record<string, string>, accountEnv?: Record<string, string>) => Promise<number>;
  readonly config: () => Promise<Record<string, unknown> | undefined>;
}

const withSandbox = async (run: (sandbox: Sandbox) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(path.join(tmpdir(), 'fy-first-run-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'cwd');
  const bin = path.join(root, 'bin');
  const harness = path.join(bin, 'claude');
  await Bun.write(harness, '#!/bin/sh\nprintf "harness-ran\\n"\n');
  await chmod(harness, 0o755);
  await Bun.write(path.join(cwd, '.keep'), '');

  try {
    await run({
      home,
      cwd,
      run: async (environment = {}, accountEnv = {}) => {
        const script = path.join(root, 'wrapper.sh');
        await Bun.write(script, renderWrapperScript(account(home, accountEnv)));
        const spawned = Bun.spawn({
          cmd: ['/bin/sh', script],
          cwd,
          env: { PATH: `${bin}:${process.env.PATH ?? ''}`, ...environment },
          stdout: 'ignore',
          stderr: 'ignore',
        });
        return await spawned.exited;
      },
      config: async () => {
        try {
          return JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8')) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe('the generated wrapper’s first-run seeding', () => {
  it('should seed a home that has never been used, and still launch', async () => {
    await withSandbox(async sandbox => {
      // Act
      const code = await sandbox.run();

      // Assert
      should(code).equal(0);
      const config = await sandbox.config();
      should(config).match({
        hasCompletedOnboarding: true,
        hasCompletedClaudeInChromeOnboarding: true,
        claudeInChromeDefaultEnabled: false,
      });
      const projects = (config?.projects ?? {}) as Record<string, unknown>;
      should(projects[sandbox.cwd]).match({ hasTrustDialogAccepted: true });
    });
  });

  it('should write the seeded file privately', async () => {
    await withSandbox(async sandbox => {
      // Act
      await sandbox.run();

      // Assert — it sits beside credentials in a home the fleet created at 0700.
      should((await stat(path.join(sandbox.home, '.claude.json'))).mode & 0o777).equal(0o600);
    });
  });

  it('should write nothing on a second launch, because everything is already set', async () => {
    await withSandbox(async sandbox => {
      // Arrange
      await sandbox.run();
      const before = await stat(path.join(sandbox.home, '.claude.json'));

      // Act
      await sandbox.run();

      // Assert — an ordinary launch must not fight the harness for its own file.
      const after = await stat(path.join(sandbox.home, '.claude.json'));
      should(after.mtimeMs).equal(before.mtimeMs);
    });
  });

  it('should keep a deliberate browser choice and every unrelated key', async () => {
    await withSandbox(async sandbox => {
      // Arrange — a home somebody has used: browser on, and an account identity the harness wrote.
      await sandbox.run();
      await Bun.write(
        path.join(sandbox.home, '.claude.json'),
        JSON.stringify({
          claudeInChromeDefaultEnabled: true,
          oauthAccount: { emailAddress: 'someone@example.invalid' },
        }),
      );

      // Act
      await sandbox.run();

      // Assert
      const config = await sandbox.config();
      should(config?.claudeInChromeDefaultEnabled).be.true();
      should(config?.oauthAccount).match({ emailAddress: 'someone@example.invalid' });
      should(config?.hasCompletedOnboarding).be.true();
    });
  });

  it('should approve the key the account exports, keeping only its tail', async () => {
    await withSandbox(async sandbox => {
      // Act — a long value, as a real provider key is.
      await sandbox.run({}, { ANTHROPIC_API_KEY: 'placeholder-value-abcdefghij0123456789' });

      // Assert — the harness records an interactive approval the same way, by the last 20 characters.
      const config = await sandbox.config();
      should(config?.customApiKeyResponses).match({ approved: ['abcdefghij0123456789'] });
    });
  });

  it('should approve a short key verbatim', async () => {
    await withSandbox(async sandbox => {
      // Act
      await sandbox.run({}, { ANTHROPIC_API_KEY: 'short-placeholder' });

      // Assert
      const config = await sandbox.config();
      should(config?.customApiKeyResponses).match({ approved: ['short-placeholder'] });
    });
  });

  it('should seed nothing when the launch opts out', async () => {
    await withSandbox(async sandbox => {
      // Act
      const code = await sandbox.run({ FY_SEED_FIRST_RUN: '0' });

      // Assert
      should(code).equal(0);
      should(await sandbox.config()).be.undefined();
    });
  });

  it('should leave no temporary file behind', async () => {
    await withSandbox(async sandbox => {
      // Act
      await sandbox.run({}, { ANTHROPIC_API_KEY: 'short-placeholder' });

      // Assert
      const leftovers = [...new Bun.Glob('.claude.json.fy-*').scanSync({ cwd: sandbox.home, dot: true })];
      should(leftovers).be.empty();
    });
  });
});
