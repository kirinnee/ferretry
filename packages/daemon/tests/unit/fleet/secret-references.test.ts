/**
 * The fleet as a place that names secrets, so an account whose credential is missing is a line on a
 * screen before it is a session that dies at start.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { type FleetConfig, FleetConfigSchema } from '@ferretry/fleet';
import { FleetSecretReferences } from '../../../src/lib/fleet/secret-references.ts';

const ID_ONE = '00000000-0000-4000-8000-000000000001';

const declared = (input: Record<string, unknown>): FleetConfig => FleetConfigSchema.parse(input);

const withProfile = (env: Record<string, string>): FleetConfig =>
  declared({
    profiles: { work: { env } },
    agents: [
      {
        name: 'kirin',
        kind: 'claude',
        auth: 'api-key',
        profiles: ['work'],
        routes: {
          default: {
            id: ID_ONE,
            wrapper: 'claude-kirin',
            home: 'claude-kirin',
            defaultModel: 'model-one',
            models: ['model-one'],
          },
        },
      },
    ],
  });

describe('FleetSecretReferences', () => {
  it('should name each account that reaches for a secret, and the profile that set it', async () => {
    // Arrange
    const subject = new FleetSecretReferences(async () => withProfile({ ANTHROPIC_API_KEY: '${secret:WORK_KEY}' }));

    // Act
    const actual = await subject.references();

    // Assert — the origin is somewhere a person can go and edit, not just a package name.
    should(actual).deepEqual([
      {
        name: 'WORK_KEY',
        origin: 'fleet account claude-kirin → ANTHROPIC_API_KEY, set by the profile "work"',
      },
    ]);
  });

  it('should contribute nothing on a host that has no fleet, which is not a failure', async () => {
    // Act
    const actual = await new FleetSecretReferences(async () => undefined).references();

    // Assert
    should(actual).deepEqual([]);
  });

  it('should contribute nothing for a fleet that uses no profile', async () => {
    // Act
    const actual = await new FleetSecretReferences(async () =>
      withProfile({ ANTHROPIC_BASE_URL: 'https://example.invalid' }),
    ).references();

    // Assert
    should(actual).deepEqual([]);
  });

  it('should let a configuration it cannot read take the read down, rather than report an empty list', async () => {
    // Arrange — a list quietly missing half its entries is how somebody deletes a secret still in use.
    const subject = new FleetSecretReferences(async () => {
      throw new Error('fleet config at /state/fleet/config.yaml is unreadable');
    });

    // Act
    const raised = await subject.references().catch((error: unknown) => error);

    // Assert
    should((raised as Error).message).match(/config\.yaml/u);
  });
});
