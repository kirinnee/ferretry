/**
 * "What agents may control" (T): the policy over the account model's `machine.agentControl`.
 *
 * The claims: each kind reads its own field; a document with no `machine.agentControl` yet (an old
 * document, or no document at all) reads as the schema's own defaults — every kind allowed but
 * Ferretry settings, which is off until the owner turns it on — never a
 * second guess written here; the read is fresh on every call, never cached.
 */
import { describe, it } from 'bun:test';
import { type AccountModel, parseAccountModel } from '@ferretry/fleet';
import should from 'should';
import { AccountModelAgentControlPolicy } from '../../../src/lib/fleet/agent-control.ts';

const modelWith = (agentControl: Partial<AccountModel['machine']['agentControl']>): AccountModel =>
  parseAccountModel({ version: 2, machine: { agentControl } });

describe('AccountModelAgentControlPolicy', () => {
  it('should answer each kind from its own field', async () => {
    // Arrange
    const policy = new AccountModelAgentControlPolicy(async () =>
      modelWith({ terminals: true, browsers: false, files: true, ferretrySettings: true }),
    );

    // Act + Assert
    should(await policy.allows('terminal')).be.true();
    should(await policy.allows('browser')).be.false();
    should(await policy.allows('files')).be.true();
    should(await policy.allows('settings')).be.true();
  });

  it('should read fresh on every call, never caching an earlier answer', async () => {
    // Arrange
    let allowed = false;
    const policy = new AccountModelAgentControlPolicy(async () => modelWith({ terminals: allowed }));

    // Act + Assert
    should(await policy.allows('terminal')).be.false();
    allowed = true;
    should(await policy.allows('terminal')).be.true();
  });

  it('should read every switch but Ferretry settings on for a document the schema has defaulted every field of', async () => {
    // Arrange
    const policy = new AccountModelAgentControlPolicy(async () => parseAccountModel({ version: 2 }));

    // Act + Assert
    should(await policy.allows('terminal')).be.true();
    should(await policy.allows('browser')).be.true();
    should(await policy.allows('files')).be.true();
    should(await policy.allows('settings')).be.false();
  });

  it('should read every switch but Ferretry settings on for a machine with no configuration at all', async () => {
    // Arrange
    const policy = new AccountModelAgentControlPolicy(async () => undefined);

    // Act + Assert
    should(await policy.allows('terminal')).be.true();
    should(await policy.allows('browser')).be.true();
    should(await policy.allows('files')).be.true();
    should(await policy.allows('settings')).be.false();
  });
});
