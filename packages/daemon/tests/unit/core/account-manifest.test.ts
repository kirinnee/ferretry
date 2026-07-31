import { describe, it } from 'bun:test';
import should from 'should';
import { parseAccountManifest } from '../../../src/lib/core/index.ts';

const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'account-primary',
  agent: 'agent-primary',
  kind: 'claude',
  mode: 'auto',
  displayName: 'Primary',
  defaultModel: 'apex',
  models: [{ id: 'apex', available: true }],
  available: true,
  ...overrides,
});

describe('parseAccountManifest', () => {
  it('should read a bare array of accounts', () => {
    // Arrange / Act
    const accounts = parseAccountManifest([row()]);

    // Assert
    should(accounts.map(item => item.id)).eql(['account-primary']);
  });

  it("should read the provisioner's envelope", () => {
    // Arrange / Act
    const accounts = parseAccountManifest({ version: 1, accounts: [row()] });

    // Assert
    should(accounts).have.length(1);
  });

  it('should keep provisioning attributes the daemon does not read', () => {
    // Arrange / Act — refusing these would couple every fleet change to a daemon release
    const accounts = parseAccountManifest([row({ wrapper: '/usr/bin/agent-primary', home: '/home/agent' })]);

    // Assert
    should(accounts).have.length(1);
  });

  it('should drop one malformed row rather than blind the daemon to the whole fleet', () => {
    // Arrange / Act
    const accounts = parseAccountManifest([row(), row({ id: 'account-broken', kind: 'telepathy' })]);

    // Assert
    should(accounts.map(item => item.id)).eql(['account-primary']);
  });

  it('should carry the declared reason a model is down', () => {
    // Arrange / Act
    const accounts = parseAccountManifest([
      row({ models: [{ id: 'apex', available: false, unavailableReason: 'retired by the provider' }] }),
    ]);

    // Assert — availability is declared, so an unavailable model cannot be recommended
    should(accounts[0]?.models[0]).eql({ id: 'apex', available: false, unavailableReason: 'retired by the provider' });
  });

  it('should read an account that names no default model', () => {
    // Arrange / Act
    const accounts = parseAccountManifest([row({ defaultModel: null })]);

    // Assert
    should(accounts[0]?.defaultModel).be.null();
  });

  it('should report an empty fleet for a payload that is not a manifest at all', () => {
    // Arrange / Act / Assert
    should(parseAccountManifest({ error: 'not provisioned' })).eql([]);
    should(parseAccountManifest('nonsense')).eql([]);
  });
});
