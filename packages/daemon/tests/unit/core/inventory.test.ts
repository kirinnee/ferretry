import { describe, it } from 'bun:test';
import should from 'should';
import {
  canServeModel,
  defaultStartWaitPolicy,
  findAccountByAgent,
  findAccountById,
  resolveDisplayModel,
  selectableAutoAccounts,
  servableModels,
  startWaitMs,
  type CoreAccount,
} from '../../../src/lib/core/index.ts';
import { account, inventory } from './fixtures.ts';

describe('selectableAutoAccounts', () => {
  it('should offer only the auto lane, and only what is declared up', () => {
    // Arrange
    const accounts: readonly CoreAccount[] = [
      ...inventory,
      account({ id: 'interactive', mode: 'interactive' }),
      account({ id: 'down', available: false, unavailableReason: 'every credential is rejected' }),
    ];

    // Act
    const selectable = selectableAutoAccounts(accounts);

    // Assert
    should(selectable.map(entry => entry.id)).deepEqual(['account-primary', 'account-secondary', 'account-chore']);
  });
});

describe('findAccountById', () => {
  it('should find an account by its stable identity', () => {
    // Arrange / Act / Assert
    should(findAccountById(inventory, 'account-chore')?.agent).equal('agent-chore');
  });

  it('should find nothing for an unknown identity', () => {
    // Arrange / Act / Assert
    should(findAccountById(inventory, 'missing')).be.undefined();
  });
});

describe('findAccountByAgent', () => {
  it('should join a usage row to its account by executable name', () => {
    // Arrange / Act / Assert
    should(findAccountByAgent(inventory, 'agent-secondary')?.id).equal('account-secondary');
  });

  it('should refuse an ambiguous executable name rather than guess', () => {
    // Arrange — a manifest defect; picking the first attached one account's quota to another
    const accounts = [account({ id: 'one', agent: 'shared' }), account({ id: 'two', agent: 'shared' })];

    // Act / Assert
    should(findAccountByAgent(accounts, 'shared')).be.undefined();
  });

  it('should find nothing for an unknown executable name', () => {
    // Arrange / Act / Assert
    should(findAccountByAgent(inventory, 'agent-missing')).be.undefined();
  });
});

describe('servableModels', () => {
  it('should list only the models an available account declares available', () => {
    // Arrange
    const entry = account({
      id: 'mixed',
      models: [
        { id: 'up', available: true },
        { id: 'down', available: false, unavailableReason: 'declared down' },
      ],
    });

    // Act / Assert
    should(servableModels(entry).map(model => model.id)).deepEqual(['up']);
  });

  it('should list nothing for an account that is itself down', () => {
    // Arrange
    const entry = account({ id: 'down', available: false, models: [{ id: 'up', available: true }] });

    // Act / Assert
    should(servableModels(entry)).deepEqual([]);
  });
});

describe('canServeModel', () => {
  it.each([
    { label: 'a model it declares available', model: 'apex', expected: true },
    { label: 'a model it does not declare', model: 'forge', expected: false },
  ])('should answer $expected for $label', ({ model, expected }) => {
    // Arrange
    const entry = inventory[0] as CoreAccount;

    // Act / Assert
    should(canServeModel(entry, model)).equal(expected);
  });
});

describe('resolveDisplayModel', () => {
  const primary = inventory[0] as CoreAccount;

  it('should trust what the harness reported about itself above everything', () => {
    // Arrange / Act
    const resolved = resolveDisplayModel(primary, 'steady', '  observed-1  ');

    // Assert
    should(resolved).deepEqual({ model: 'observed-1', source: 'harness' });
  });

  it('should report the requested model when the account can serve it', () => {
    // Arrange / Act
    const resolved = resolveDisplayModel(primary, 'steady');

    // Assert
    should(resolved).deepEqual({ model: 'steady', source: 'requested' });
  });

  it('should report the default a request will really get when the model is not served here', () => {
    // Arrange — the source reported the requested alias and listed panes as models they never ran
    const resolved = resolveDisplayModel(primary, 'forge');

    // Assert
    should(resolved).deepEqual({ model: 'apex', source: 'account-default' });
  });

  it('should fall back to the account default when nothing was requested', () => {
    // Arrange / Act
    const resolved = resolveDisplayModel(primary, '   ');

    // Assert
    should(resolved).deepEqual({ model: 'apex', source: 'account-default' });
  });

  it('should claim nothing for an account that declares no default', () => {
    // Arrange / Act
    const resolved = resolveDisplayModel(account({ id: 'bare' }));

    // Assert
    should(resolved).deepEqual({ model: 'unknown', source: 'unknown' });
  });

  it('should claim nothing for an account that is down, whatever it declares', () => {
    // Arrange
    const down = account({
      id: 'down',
      available: false,
      defaultModel: 'apex',
      models: [{ id: 'apex', available: true }],
    });

    // Act
    const resolved = resolveDisplayModel(down, 'apex');

    // Assert
    should(resolved).deepEqual({ model: 'unknown', source: 'unknown' });
  });
});

describe('startWaitMs', () => {
  it('should hold an ordinary launch open for the base window', () => {
    // Arrange / Act / Assert
    should(startWaitMs(defaultStartWaitPolicy, 'account-primary')).equal(45_000);
  });

  it('should give a declared-slow account the longer window', () => {
    // Arrange
    const policy = { ...defaultStartWaitPolicy, slowAccountIds: ['account-chore'] };

    // Act / Assert
    should(startWaitMs(policy, 'account-chore')).equal(90_000);
  });

  it('should never exceed the ceiling, whatever the policy asks for', () => {
    // Arrange
    const policy = { baseMs: 200_000, slowMs: 300_000, ceilingMs: 90_000, slowAccountIds: ['account-chore'] };

    // Act / Assert
    should(startWaitMs(policy, 'account-chore')).equal(90_000);
  });

  it('should never return a negative window', () => {
    // Arrange
    const policy = { baseMs: -10, slowMs: 0, ceilingMs: -5, slowAccountIds: [] };

    // Act / Assert
    should(startWaitMs(policy, 'account-primary')).equal(0);
  });
});
