import { describe, it } from 'bun:test';
import should from 'should';
import {
  baseRoleScore,
  indexCatalog,
  kindBonus,
  parseRoutingCatalog,
  type RoutingCatalogInput,
} from '../../../src/lib/core/index.ts';
import { catalog, catalogInput } from './fixtures.ts';

const withAccounts = (accounts: RoutingCatalogInput['accounts']): RoutingCatalogInput => ({
  ...catalogInput,
  accounts,
});

describe('parseRoutingCatalog', () => {
  it('should fill in the weights a catalog leaves unstated', () => {
    // Arrange
    const { weights: _weights, ...rest } = { ...catalogInput, weights: undefined };

    // Act
    const parsed = parseRoutingCatalog(rest);

    // Assert
    should(parsed.weights.alternativesShown).equal(3);
    should(parsed.weights.preferredSpendBonus).equal(6);
  });

  it('should default a model with no role scores to being nobody a role can lead', () => {
    // Arrange / Act
    const parsed = parseRoutingCatalog(catalogInput);
    const chore = parsed.models.find(model => model.id === 'chore');

    // Assert
    should(chore?.roleScore.planner).be.undefined();
    should(chore?.needsPlan).be.false();
  });

  it('should reject a catalog with no models at all', () => {
    // Arrange / Act / Assert
    should(() => parseRoutingCatalog({ ...catalogInput, models: [] })).throw();
  });

  it('should reject two models sharing an id', () => {
    // Arrange
    const duplicated = { ...catalogInput, models: [...catalogInput.models, catalogInput.models[0]] };

    // Act / Assert
    should(() => parseRoutingCatalog(duplicated)).throw(/duplicate model id/);
  });

  it('should reject two routing entries for one account', () => {
    // Arrange
    const duplicated = withAccounts([
      { accountId: 'account-primary', options: [{ model: 'apex' }] },
      { accountId: 'account-primary', options: [{ model: 'steady' }] },
    ]);

    // Act / Assert
    should(() => parseRoutingCatalog(duplicated)).throw(/duplicate routing entry for account/);
  });

  it('should reject an account offering a model the catalog does not describe', () => {
    // Arrange
    const dangling = withAccounts([{ accountId: 'account-primary', options: [{ model: 'ghost' }] }]);

    // Act / Assert
    should(() => parseRoutingCatalog(dangling)).throw(/offers unknown model/);
  });

  it('should reject a power outside the doctrine scale', () => {
    // Arrange
    const model = { ...catalogInput.models[0], power: 140 };
    const broken = { ...catalogInput, models: [model] };

    // Act / Assert
    should(() => parseRoutingCatalog(broken)).throw();
  });
});

describe('indexCatalog', () => {
  it('should look models and accounts up by id', () => {
    // Arrange / Act
    const index = indexCatalog(catalog);

    // Assert
    should(index.model('forge')?.label).equal('Forge');
    should(index.account('account-chore')?.options).have.length(1);
  });

  it('should find nothing for ids the catalog does not carry', () => {
    // Arrange / Act
    const index = indexCatalog(catalog);

    // Assert
    should(index.model('ghost')).be.undefined();
    should(index.account('ghost')).be.undefined();
  });
});

describe('baseRoleScore', () => {
  it('should score an implementer by the complexity in front of it, not in the abstract', () => {
    // Arrange
    const apex = catalog.models.find(model => model.id === 'apex');
    if (apex === undefined) throw new Error('fixture model missing');

    // Act / Assert
    should(baseRoleScore(apex, 'implementer', 'mechanical')).equal(5);
    should(baseRoleScore(apex, 'implementer', 'hard')).equal(78);
  });

  it('should score every other role from the role table', () => {
    // Arrange
    const apex = catalog.models.find(model => model.id === 'apex');
    if (apex === undefined) throw new Error('fixture model missing');

    // Act / Assert
    should(baseRoleScore(apex, 'planner', 'mid')).equal(100);
  });

  it('should score a role the model was never given as zero', () => {
    // Arrange
    const chore = catalog.models.find(model => model.id === 'chore');
    if (chore === undefined) throw new Error('fixture model missing');

    // Act / Assert
    should(baseRoleScore(chore, 'planner', 'mid')).equal(0);
  });
});

describe('kindBonus', () => {
  it('should carry a specialist bonus declared in the catalog', () => {
    // Arrange
    const chore = catalog.models.find(model => model.id === 'chore');
    if (chore === undefined) throw new Error('fixture model missing');

    // Act / Assert
    should(kindBonus(chore, 'debugging')).equal(12);
    should(kindBonus(chore, 'frontend')).equal(0);
  });
});
