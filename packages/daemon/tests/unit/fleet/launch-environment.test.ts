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
import should from 'should';
import type { FleetManifestAccount } from '@ferretry/fleet';
import { MissingFleetSecretsError } from '@ferretry/fleet';
import type { SecretName } from '@ferretry/protocol';
import {
  FleetLaunchEnvironment,
  launchEnvironment,
  type LaunchAccountInventory,
  type LaunchSecretValues,
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
});
