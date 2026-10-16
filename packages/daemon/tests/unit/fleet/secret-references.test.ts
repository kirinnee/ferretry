/**
 * The account model as a place that names secrets, so a login whose secret is missing is a line on a
 * screen before it is a session that dies at start.
 */
import { describe, it } from 'bun:test';
import { type AccountModel, parseAccountModel } from '@ferretry/fleet';
import should from 'should';
import { FleetSecretReferences } from '../../../src/lib/fleet/secret-references.ts';

const declared = (env: Record<string, string>): AccountModel =>
  parseAccountModel({
    version: 2,
    machine: {},
    credentials: { 'claude-work': { harness: 'claude', store: 'environment', env } },
  });

describe('FleetSecretReferences', () => {
  it('should name each login that reaches for a secret, and the variable that does', async () => {
    // Arrange
    const subject = new FleetSecretReferences(async () => declared({ ANTHROPIC_API_KEY: '${secret:WORK_KEY}' }));

    // Act
    const actual = await subject.references();

    // Assert — the origin is somewhere a person can go and edit, not just a package name.
    should(actual).deepEqual([{ name: 'WORK_KEY', origin: 'credential claude-work env ANTHROPIC_API_KEY' }]);
  });

  it('should contribute nothing on a machine that has no account model, which is not a failure', async () => {
    // Act
    const actual = await new FleetSecretReferences(async () => undefined).references();

    // Assert
    should(actual).deepEqual([]);
  });

  it('should contribute nothing for a login whose environment names no secret', async () => {
    // Act
    const actual = await new FleetSecretReferences(async () =>
      declared({ ANTHROPIC_API_KEY: 'sk-literal-value-for-a-test' }),
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
