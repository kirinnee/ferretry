/**
 * Resolving a profile's credential for the launch it was resolved for.
 *
 * The claims: an account that binds nothing never opens the store, a missing secret refuses the
 * launch rather than resolving to nothing, a damaged vault refuses too, and the session's own
 * variables always beat a profile's.
 *
 * NO REAL CREDENTIAL APPEARS HERE. Every "value" is a fixture string, and the assertions are about
 * where one goes rather than what it is.
 */
import { describe, it } from 'bun:test';
import type { FleetManifestAccount } from '@ferretry/fleet';
import { MissingFleetSecretsError } from '@ferretry/fleet';
import type { SecretName } from '@ferretry/protocol';
import should from 'should';
import {
  FleetLaunchEnvironment,
  FolderSettingsOverrideError,
  FolderSettingsUnreadableError,
  type FolderSettingsVariables,
  type LaunchAccountInventory,
  type LaunchSecretValues,
  launchEnvironment,
} from '../../../src/lib/fleet/launch-environment.ts';

const ID_ONE = '00000000-0000-4000-8000-000000000001';

const account = (overrides: Partial<FleetManifestAccount> = {}): FleetManifestAccount => ({
  id: ID_ONE,
  kind: 'claude',
  mode: 'auto',
  wrapper: '/state/fleet/bin/claude-auto-kirin',
  home: '/state/fleet/homes/auto-kirin',
  displayName: 'Kirin (auto)',
  defaultModel: 'model-one',
  models: [{ id: 'model-one', available: true }],
  available: true,
  unavailableReason: null,
  secretEnv: {},
  ...overrides,
});

const inventory = (...accounts: readonly FleetManifestAccount[]): LaunchAccountInventory => ({
  accounts: async () => accounts,
});

/** A store that counts its own reads, so "never opened" is a fact rather than an impression. */
const store = (entries: Record<string, string> = {}): LaunchSecretValues & { opened: number } => {
  const values = new Map<SecretName, string>(Object.entries(entries));
  const port = {
    opened: 0,
    values: async (): Promise<ReadonlyMap<SecretName, string>> => {
      port.opened += 1;
      return values;
    },
  };
  return port;
};

describe('FleetLaunchEnvironment', () => {
  it('should give an MCP sign-in its chance to refresh the secrets a launch is about to resolve, first', async () => {
    // Arrange — the renewal writes a fresh value before the store is opened (docs/mcp-oauth.md).
    const values: Record<string, string> = { MCP_X_ACCESS: 'stale-value' };
    const asked: (readonly SecretName[])[] = [];
    const subject = new FleetLaunchEnvironment(
      inventory(account({ secretEnv: { FY_TOKEN: '${secret:MCP_X_ACCESS}', OTHER: 'a ${secret:MCP_X_ACCESS} b' } })),
      { values: async () => new Map(Object.entries(values)) },
      {
        refreshForLaunch: async names => {
          asked.push(names);
          values.MCP_X_ACCESS = 'fresh-value';
        },
      },
    );

    // Act
    const actual = await subject.forWrapper('/state/fleet/bin/claude-auto-kirin');

    // Assert — asked once, with each name once, and the launch read what it wrote.
    should(asked).deepEqual([['MCP_X_ACCESS']]);
    should(actual).deepEqual({ FY_TOKEN: 'fresh-value', OTHER: 'a fresh-value b' });
  });

  it('should resolve the account published at this executable, by the name it publishes', async () => {
    // Arrange
    const secrets = store({ WORK_KEY: 'fixture-value' });
    const subject = new FleetLaunchEnvironment(
      inventory(account({ secretEnv: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' } })),
      secrets,
    );

    // Act
    const actual = await subject.forWrapper('/state/fleet/bin/claude-auto-kirin');

    // Assert
    should(actual).deepEqual({ ANTHROPIC_API_KEY: 'fixture-value' });
  });

  it('should find the account even when the caller holds a differently-rooted path to the same name', async () => {
    // Arrange — a session record written before a state home moved still names the same wrapper.
    const subject = new FleetLaunchEnvironment(
      inventory(account({ secretEnv: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' } })),
      store({ WORK_KEY: 'fixture-value' }),
    );

    // Act
    const actual = await subject.forWrapper('/elsewhere/bin/claude-auto-kirin');

    // Assert
    should(actual).deepEqual({ ANTHROPIC_API_KEY: 'fixture-value' });
  });

  it('should never open the store for an account that binds nothing, which is the default case', async () => {
    // Arrange
    const secrets = store({ WORK_KEY: 'fixture-value' });
    const subject = new FleetLaunchEnvironment(inventory(account()), secrets);

    // Act
    const actual = await subject.forWrapper('/state/fleet/bin/claude-auto-kirin');

    // Assert
    should(actual).deepEqual({});
    should(secrets.opened).equal(0);
  });

  it('should add a project’s signed-in MCP variables for the folder a pane starts in, the profile winning a clash', async () => {
    // Arrange
    const asked: { agent: string; cwd: string }[] = [];
    const subject = new FleetLaunchEnvironment(
      inventory(account({ secretEnv: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' } })),
      store({ WORK_KEY: 'fixture-value' }),
      undefined,
      {
        forLaunch: async (agent, cwd) => {
          asked.push({ agent, cwd });
          return { FY_MCP_DOCS_0A_TOKEN: 'project-token', ANTHROPIC_API_KEY: 'never-this' };
        },
      },
    );

    // Act
    const withFolder = await subject.forWrapper('/state/fleet/bin/claude-auto-kirin', '/work/app');
    const without = await subject.forWrapper('/state/fleet/bin/claude-auto-kirin');

    // Assert
    should(withFolder).deepEqual({ FY_MCP_DOCS_0A_TOKEN: 'project-token', ANTHROPIC_API_KEY: 'fixture-value' });
    should(without).deepEqual({ ANTHROPIC_API_KEY: 'fixture-value' });
    should(asked).deepEqual([{ agent: '/state/fleet/bin/claude-auto-kirin', cwd: '/work/app' }]);
  });

  it('should have no opinion about an executable this daemon does not publish', async () => {
    // Arrange — refusing here would turn "I have no opinion" into "you may not start".
    const secrets = store();
    const subject = new FleetLaunchEnvironment(inventory(account()), secrets);

    // Act
    const actual = await subject.forWrapper('/usr/local/bin/claude');

    // Assert
    should(actual).deepEqual({});
    should(secrets.opened).equal(0);
  });

  it('should answer nothing on a host with no published fleet at all', async () => {
    // Act
    const actual = await new FleetLaunchEnvironment(inventory(), store()).forWrapper('/state/fleet/bin/claude-kirin');

    // Assert
    should(actual).deepEqual({});
  });

  it('should refuse the launch naming every secret the store does not hold', async () => {
    // Arrange
    const subject = new FleetLaunchEnvironment(
      inventory(account({ secretEnv: { A_KEY: '${secret:ONE}', B_KEY: '${secret:TWO}' } })),
      store(),
    );

    // Act
    const raised = await subject.forWrapper('/state/fleet/bin/claude-auto-kirin').catch((error: unknown) => error);

    // Assert — an empty credential would be a 401 from a remote service with nothing to point at.
    should(raised).be.instanceof(MissingFleetSecretsError);
    should((raised as MissingFleetSecretsError).names).deepEqual(['ONE', 'TWO']);
  });

  it('should refuse the launch when the store cannot be opened, rather than launch as if it were empty', async () => {
    // Arrange
    const damaged: LaunchSecretValues = {
      values: async () => {
        throw new Error('the vault key does not open the stored secrets');
      },
    };
    const subject = new FleetLaunchEnvironment(
      inventory(account({ secretEnv: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' } })),
      damaged,
    );

    // Act
    const raised = await subject.forWrapper('/state/fleet/bin/claude-auto-kirin').catch((error: unknown) => error);

    // Assert
    should((raised as Error).message).match(/vault key/u);
  });

  it('should let a manifest this daemon cannot read take the launch down with it', async () => {
    // Arrange — a present-but-unreadable manifest is damaged state, and a start already refuses on it.
    const broken: LaunchAccountInventory = {
      accounts: async () => {
        throw new Error('the fleet manifest is not valid JSON');
      },
    };

    // Act
    const raised = await new FleetLaunchEnvironment(broken, store())
      .forWrapper('/state/fleet/bin/claude-kirin')
      .catch((error: unknown) => error);

    // Assert
    should((raised as Error).message).match(/manifest/u);
  });
});

describe('launchEnvironment', () => {
  it('should let the session keep its own variables when a profile names the same one', () => {
    // Arrange — a profile is shared; a session's board capability names that one session.
    const account_ = { FY_SESSION_BOARD_CAPABILITY: 'from-the-profile', ANTHROPIC_API_KEY: 'fixture-value' };
    const session = { FY_SESSION_BOARD_CAPABILITY: 'this-session-only' };

    // Act
    const actual = launchEnvironment(account_, session);

    // Assert
    should(actual).deepEqual({
      FY_SESSION_BOARD_CAPABILITY: 'this-session-only',
      ANTHROPIC_API_KEY: 'fixture-value',
    });
  });

  it('should carry both halves when they name different variables', () => {
    // Act
    const actual = launchEnvironment({ ANTHROPIC_API_KEY: 'fixture-value' }, { FY_SESSION_ID: 'abc' });

    // Assert
    should(actual).deepEqual({ ANTHROPIC_API_KEY: 'fixture-value', FY_SESSION_ID: 'abc' });
  });

  it("should never hand the pane a HOME, so a runtime keeps the person's real one", () => {
    // Act
    const actual = launchEnvironment({ HOME: '/elsewhere', A: '1' }, { HOME: '/also-elsewhere', B: '2' });

    // Assert
    should(actual).deepEqual({ A: '1', B: '2' });
  });
});

describe('FleetLaunchEnvironment — a folder that would blank the login', () => {
  const secretAccount = account({ secretEnv: { ANTHROPIC_AUTH_TOKEN: '${secret:LOGE_KEY}' } });
  const folder = (...files: { file: string; names: readonly string[] }[]): FolderSettingsVariables => ({
    variables: async () => files,
  });

  it('should refuse the start, naming the file and the key but never a value', async () => {
    // Arrange
    const secrets = store({ LOGE_KEY: 'fixture-value' });
    const launcher = new FleetLaunchEnvironment(
      inventory(secretAccount),
      secrets,
      undefined,
      undefined,
      folder({ file: '.claude/settings.local.json', names: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'] }),
    );

    // Act
    const refused = await launcher.forWrapper(secretAccount.wrapper, '/work/pe').then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    // Assert
    should(refused).be.instanceOf(FolderSettingsOverrideError);
    should(refused?.message).containEql('.claude/settings.local.json');
    should(refused?.message).containEql('ANTHROPIC_AUTH_TOKEN');
    should(refused?.message).not.containEql('fixture-value');
    should(secrets.opened).equal(0);
  });

  it('should refuse the start, with the reason, when the folder’s settings cannot be looked for', async () => {
    // Arrange: the adapter could not complete its walk to the repository root.
    const secrets = store({ LOGE_KEY: 'fixture-value' });
    const launcher = new FleetLaunchEnvironment(inventory(secretAccount), secrets, undefined, undefined, {
      variables: async () => {
        throw new FolderSettingsUnreadableError('looking for the repository failed at /work/.git (EACCES)');
      },
    });

    // Act
    const refused = await launcher.forWrapper(secretAccount.wrapper, '/work/pe').then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    // Assert
    should(refused).be.instanceOf(FolderSettingsUnreadableError);
    should(refused?.name).equal('FolderSettingsUnreadableError');
    should(refused?.message).containEql('EACCES');
    should(refused?.message).not.containEql('fixture-value');
    should(secrets.opened).equal(0);
  });

  it('should start when the folder sets only variables the login pins itself', async () => {
    // Arrange
    const launcher = new FleetLaunchEnvironment(
      inventory(secretAccount),
      store({ LOGE_KEY: 'fixture-value' }),
      undefined,
      undefined,
      folder({ file: '.claude/settings.json', names: ['ANTHROPIC_BASE_URL'] }),
    );

    // Act / Assert
    should(await launcher.forWrapper(secretAccount.wrapper, '/work/pe')).deepEqual({
      ANTHROPIC_AUTH_TOKEN: 'fixture-value',
    });
  });

  it('should not look at a folder for an account that takes nothing from the store', async () => {
    // Arrange
    const launcher = new FleetLaunchEnvironment(
      inventory(account()),
      store(),
      undefined,
      undefined,
      folder({ file: '.claude/settings.json', names: ['ANTHROPIC_AUTH_TOKEN'] }),
    );

    // Act / Assert
    should(await launcher.forWrapper(account().wrapper, '/work/pe')).deepEqual({});
  });

  it('should refuse a folder that blanks a variable the login takes from the environment by bare reference', async () => {
    // Arrange: nothing in the secret store; the login's token is a bare reference resolved when the wrapper runs.
    const referenced = account({ referencedEnv: ['ANTHROPIC_AUTH_TOKEN'] });
    const secrets = store();
    const launcher = new FleetLaunchEnvironment(
      inventory(referenced),
      secrets,
      undefined,
      undefined,
      folder({ file: '/work/.claude/settings.local.json', names: ['ANTHROPIC_AUTH_TOKEN'] }),
    );

    // Act
    const refused = await launcher.forWrapper(referenced.wrapper, '/work/pe/child').then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    // Assert: named by its path and key, and the store was never opened for it.
    should(refused).be.instanceOf(FolderSettingsOverrideError);
    should(refused?.message).containEql('/work/.claude/settings.local.json');
    should(refused?.message).containEql('ANTHROPIC_AUTH_TOKEN');
    should(secrets.opened).equal(0);
  });

  it('should start, with nothing to resolve, when the folder sets only other variables than the referenced ones', async () => {
    // Arrange
    const referenced = account({ referencedEnv: ['ANTHROPIC_AUTH_TOKEN'] });
    const launcher = new FleetLaunchEnvironment(
      inventory(referenced),
      store(),
      undefined,
      undefined,
      folder({ file: '.claude/settings.json', names: ['SOMETHING_ELSE'] }),
    );

    // Act / Assert
    should(await launcher.forWrapper(referenced.wrapper, '/work/pe')).deepEqual({});
  });
});
