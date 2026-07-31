import type { AccountUsage } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import should from 'should';
import {
  TeamAdvisor,
  type AccountInventoryPort,
  type CoreAccount,
  type RoutingCatalogPort,
} from '../../../src/lib/core/index.ts';
import type { UsageFeedPort } from '../../../src/lib/usage/index.ts';
import { account, catalog, inventory } from './fixtures.ts';

const inventoryPort = (accounts: readonly CoreAccount[]): AccountInventoryPort => ({
  accounts: () => Promise.resolve(accounts),
});

const routingPort: RoutingCatalogPort = { catalog: () => Promise.resolve(catalog) };

const feed = (accounts: readonly AccountUsage[], record?: { signal?: AbortSignal }): UsageFeedPort => ({
  accounts: signal => {
    if (record !== undefined && signal !== undefined) record.signal = signal;
    return Promise.resolve(accounts);
  },
  snapshotAt: () => undefined,
  hasSnapshot: () => accounts.length > 0,
});

describe('TeamAdvisor', () => {
  it('should recommend over the fleet manifest, the catalog and the feed together', async () => {
    // Arrange
    const advisor = new TeamAdvisor(inventoryPort(inventory), routingPort, feed([]));

    // Act
    const recommendation = await advisor.recommend({ task: 'add a new endpoint to the API' });

    // Assert
    should(recommendation.roles.length).be.above(0);
    should(recommendation.roles[0]?.primary.accountId).be.a.String();
  });

  it('should offer only the auto lane, because unattended work may not take a human terminal', async () => {
    // Arrange — the only account that can serve anything is interactive
    const interactive = [account({ ...inventory[1], mode: 'interactive' } as CoreAccount)];
    const advisor = new TeamAdvisor(inventoryPort(interactive), routingPort, feed([]));

    // Act
    const recommendation = await advisor.recommend({ task: 'refactor the parser' });

    // Assert
    should(recommendation.warnings.join(' ')).match(/no usable account/);
  });

  it('should include interactive accounts when the caller asks for them', async () => {
    // Arrange
    const interactive = [account({ ...inventory[1], mode: 'interactive' } as CoreAccount)];
    const advisor = new TeamAdvisor(inventoryPort(interactive), routingPort, feed([]));

    // Act
    const recommendation = await advisor.recommend({ task: 'refactor the parser', includeInteractive: true });

    // Assert
    should(recommendation.roles.some(role => role.primary.accountId === 'account-secondary')).be.true();
  });

  it('should pass the caller budget, shape and auth modes through to the engine', async () => {
    // Arrange
    const advisor = new TeamAdvisor(inventoryPort(inventory), routingPort, feed([]));

    // Act
    const recommendation = await advisor.recommend({
      task: 'rename a field everywhere',
      budget: 'cheap',
      roles: ['reviewer'],
      authModes: { 'account-primary': 'oauth' },
    });

    // Assert
    should(recommendation.budget).equal('cheap');
    should(recommendation.roles.map(role => role.role)).eql(['reviewer']);
  });

  it('should rank against live account headroom rather than assuming the fleet is empty', async () => {
    // Arrange — the primary account is nearly spent, so its twin-tier rival should lead
    const spent = feed([{ agent: 'agent-primary', fiveHourPercent: 99 }]);
    const advisor = new TeamAdvisor(inventoryPort(inventory), routingPort, spent);

    // Act
    const withUsage = await advisor.recommend({ task: 'plan the migration', roles: ['planner'] });
    const withoutUsage = await new TeamAdvisor(inventoryPort(inventory), routingPort, feed([])).recommend({
      task: 'plan the migration',
      roles: ['planner'],
    });

    // Assert — the feed changed the score, so it was genuinely read
    should(withUsage.roles[0]?.primary.score).be.below(withoutUsage.roles[0]?.primary.score ?? 0);
  });

  it("should hand the caller's cancellation down to the feed", async () => {
    // Arrange
    const record: { signal?: AbortSignal } = {};
    const advisor = new TeamAdvisor(inventoryPort(inventory), routingPort, feed([], record));
    const controller = new AbortController();

    // Act
    await advisor.recommend({ task: 'review the diff' }, controller.signal);

    // Assert
    should(record.signal).equal(controller.signal);
  });
});
