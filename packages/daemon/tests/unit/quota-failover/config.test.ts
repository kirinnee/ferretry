import { describe, it } from 'bun:test';
import should from 'should';
import {
  defaultQuotaFailoverConfig,
  MINIMUM_QUOTA_FAILOVER_INTERVAL_MS,
  parseStoredQuotaFailoverConfig,
  QuotaFailoverConfigSchema,
  quotaFailoverIntervalMs,
  quotaFailoverPool,
  retryCooldownMs,
  revisitCooldownMs,
  snapshotAgeCeilingMs,
} from '../../../src/lib/quota-failover/index.ts';

describe('the quota-failover defaults', () => {
  it('should be off twice over, so a fresh daemon can never move a session on its own', () => {
    // Arrange / Act / Assert — either the switch OR the empty pool alone stops every move
    should(defaultQuotaFailoverConfig.enabled).be.false();
    should(defaultQuotaFailoverConfig.accounts).deepEqual([]);
  });
});

describe('parseStoredQuotaFailoverConfig', () => {
  it.each([
    { label: 'no document has been written yet', stored: undefined },
    { label: 'the document is null', stored: null },
  ])('should take the defaults with no warning when $label', ({ stored }) => {
    // Act
    const result = parseStoredQuotaFailoverConfig(stored);

    // Assert
    should(result.config).deepEqual(defaultQuotaFailoverConfig);
    should(result.warnings).deepEqual([]);
  });

  it('should keep a document an operator wrote correctly', () => {
    // Act
    const result = parseStoredQuotaFailoverConfig({ enabled: true, accounts: ['agent-a'], headroomPercent: 50 });

    // Assert
    should(result.config.enabled).be.true();
    should(result.config.accounts).deepEqual(['agent-a']);
    should(result.config.headroomPercent).equal(50);
    should(result.warnings).deepEqual([]);
  });

  it('should fall back to the defaults and say so when a field does not validate', () => {
    // Act — a hand-edited document can only ever DISABLE this feature, never misdirect it
    const result = parseStoredQuotaFailoverConfig({ enabled: true, headroomPercent: 400 });

    // Assert
    should(result.config).deepEqual(defaultQuotaFailoverConfig);
    should(result.warnings).have.length(1);
    should(result.warnings[0]).match(/headroomPercent/);
    should(result.warnings[0]).match(/no session will be moved/);
  });

  it('should name the document itself when the stored value is not an object at all', () => {
    // Act
    const result = parseStoredQuotaFailoverConfig('a pool, honest');

    // Assert
    should(result.config).deepEqual(defaultQuotaFailoverConfig);
    should(result.warnings[0]).match(/\(document: /);
  });

  it('should refuse a field it does not recognise rather than silently dropping it', () => {
    // Arrange — an operator naming a knob that does not exist has made a mistake worth reporting
    const result = parseStoredQuotaFailoverConfig({ enabled: true, accounts: ['agent-a'], force: true });

    // Assert
    should(result.config).deepEqual(defaultQuotaFailoverConfig);
    should(result.warnings).have.length(1);
  });
});

describe('the derived durations', () => {
  it('should floor the tick cadence so a mis-set minute is cheap rather than ruinous', () => {
    // Arrange
    const tiny = QuotaFailoverConfigSchema.parse({ intervalMinutes: 0.05 });

    // Act / Assert
    should(quotaFailoverIntervalMs(tiny)).equal(MINIMUM_QUOTA_FAILOVER_INTERVAL_MS);
  });

  it('should honour a configured cadence above the floor', () => {
    // Arrange / Act / Assert
    should(quotaFailoverIntervalMs(QuotaFailoverConfigSchema.parse({ intervalMinutes: 7 }))).equal(420_000);
  });

  it.each([
    { label: 'the snapshot freshness ceiling', derive: snapshotAgeCeilingMs, field: 'maxSnapshotAgeMinutes' },
    { label: 'the revisit cooldown', derive: revisitCooldownMs, field: 'revisitCooldownMinutes' },
    { label: 'the retry cooldown', derive: retryCooldownMs, field: 'retryCooldownMinutes' },
  ])('should derive $label in milliseconds', ({ derive, field }) => {
    // Arrange / Act / Assert
    should(derive(QuotaFailoverConfigSchema.parse({ [field]: 3 }))).equal(180_000);
  });

  it.each([
    { label: 'the revisit cooldown', derive: revisitCooldownMs, field: 'revisitCooldownMinutes' },
    { label: 'the retry cooldown', derive: retryCooldownMs, field: 'retryCooldownMinutes' },
  ])('should let an operator set $label to zero', ({ derive, field }) => {
    // Arrange — zero is a legal configuration and means "no cooldown", unlike the tick cadence
    should(derive(QuotaFailoverConfigSchema.parse({ [field]: 0 }))).equal(0);
  });
});

describe('quotaFailoverPool', () => {
  it('should keep the operator preference order, which is the tiebreak between equal candidates', () => {
    // Arrange / Act / Assert
    should(quotaFailoverPool(QuotaFailoverConfigSchema.parse({ accounts: ['b', 'a', 'c'] }))).deepEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('should drop a repeated account, keeping its first position', () => {
    // Arrange / Act / Assert
    should(quotaFailoverPool(QuotaFailoverConfigSchema.parse({ accounts: ['a', 'b', 'a'] }))).deepEqual(['a', 'b']);
  });

  it('should refuse a blank account outright at the schema, which is stricter than dropping it', () => {
    // Arrange / Act / Assert
    should(QuotaFailoverConfigSchema.safeParse({ accounts: ['a', '   '] }).success).be.false();
  });

  it('should still drop a blank that reached it another way', () => {
    // Arrange — the schema refuses one, but this function's own contract is a config value, and a
    // pool entry that is not an account name must never become a candidate agent
    const handBuilt = { ...defaultQuotaFailoverConfig, accounts: ['a', '  ', 'b'] };

    // Act / Assert
    should(quotaFailoverPool(handBuilt)).deepEqual(['a', 'b']);
  });

  it('should produce an empty pool from an empty list', () => {
    // Arrange / Act / Assert
    should(quotaFailoverPool(defaultQuotaFailoverConfig)).deepEqual([]);
  });
});
