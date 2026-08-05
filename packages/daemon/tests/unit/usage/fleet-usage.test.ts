import { describe, it } from 'bun:test';
import type { FleetUsage, FleetUsageSnapshot } from '@ferretry/fleet';
import should from 'should';
import type { CoreAccount } from '../../../src/lib/core/inventory.ts';
import { accountUsageFromFleet, quotaFromUsage, usageForAgent } from '../../../src/lib/usage/index.ts';

const ACCOUNT_ID = '4c0f3b6e-7a91-4a2f-9a7f-2b1d0f5c8e31';
const OTHER_ID = '9d2e1a44-3c57-4b18-8f60-7c9a5e2d1b03';

const account = (overrides: Partial<CoreAccount> = {}): CoreAccount => ({
  id: ACCOUNT_ID,
  agent: 'claude-writer',
  kind: 'claude',
  mode: 'auto',
  displayName: 'Writer',
  defaultModel: 'sonnet',
  models: [{ id: 'sonnet', available: true }],
  available: true,
  ...overrides,
});

const row = (overrides: Partial<FleetUsage> = {}): FleetUsage => ({
  accountId: ACCOUNT_ID,
  kind: 'claude',
  usageBased: true,
  ok: true,
  unavailable: false,
  atLimit: false,
  ...overrides,
});

const snapshot = (...accounts: readonly FleetUsage[]): FleetUsageSnapshot => ({
  at: 1_700_000_000_000,
  accounts: [...accounts],
});

describe('accountUsageFromFleet', () => {
  /**
   * THE JOIN IS THE FEATURE. `agent` is the executable name a session launches with — the value
   * quota-failover hands to `migrate(...)` and the advisor matches on — and a collector row carries
   * only the manifest's opaque account id. Simplifying this to `accountId` would type-check, satisfy
   * every schema and render a plausible `/usage` document that matches nothing, so failover would
   * quietly stop moving sessions off exhausted accounts. This test fails if anyone ever does.
   */
  it('should key each row by the executable name, never by the account id', () => {
    // Arrange
    const rows = accountUsageFromFleet(snapshot(row()), [account()]);

    // Act
    const found = usageForAgent(rows ?? [], 'claude-writer');

    // Assert
    should(rows?.map(entry => entry.agent)).deepEqual(['claude-writer']);
    should(rows?.some(entry => entry.agent === ACCOUNT_ID)).be.false();
    should(found).not.be.undefined();
  });

  it('should carry the short and long windows into the five-hour and weekly fields', () => {
    // Arrange
    const reading = row({
      provider: 'anthropic',
      authOk: true,
      shortWindow: { usedPercent: 42, resetAt: 1_700_000_060_000 },
      longWindow: { usedPercent: 71, resetAt: 1_700_000_900_000 },
    });

    // Act
    const [mapped] = accountUsageFromFleet(snapshot(reading), [account()]) ?? [];

    // Assert
    should(mapped).deepEqual({
      agent: 'claude-writer',
      ok: true,
      usageBased: true,
      provider: 'anthropic',
      authOk: true,
      availability: 'available',
      unavailable: false,
      atLimit: false,
      fiveHourPercent: 42,
      weeklyPercent: 71,
      fiveHourResetAt: 1_700_000_060_000,
      weeklyResetAt: 1_700_000_900_000,
    });
  });

  it('should leave an absent window absent rather than reporting zero percent', () => {
    // Arrange
    const reading = row({ shortWindow: { usedPercent: 12 } });

    // Act
    const [mapped] = accountUsageFromFleet(snapshot(reading), [account()]) ?? [];

    // Assert — unknown is not exhausted, and it is not empty either.
    should(mapped?.fiveHourPercent).equal(12);
    should(mapped).not.have.property('weeklyPercent');
    should(mapped).not.have.property('fiveHourResetAt');
    should(mapped).not.have.property('weeklyResetAt');
  });

  it('should state nothing about a failed probe beyond the failure', () => {
    // Arrange — the collector writes usageBased:false, unavailable:false and atLimit:false on a row
    // it could not read. None of those are findings.
    const reading = row({ usageBased: false, ok: false, error: 'probe failed' });

    // Act
    const [mapped] = accountUsageFromFleet(snapshot(reading), [account()]) ?? [];

    // Assert
    should(mapped).deepEqual({ agent: 'claude-writer', ok: false });
    should(quotaFromUsage(mapped as NonNullable<typeof mapped>)).deepEqual({});
  });

  it('should carry a proven unavailability, and its reason when the wire has a word for it', () => {
    // Arrange
    const reading = row({
      usageBased: false,
      ok: false,
      unavailable: true,
      unavailableReason: 'cooldown',
      atLimit: true,
    });

    // Act
    const [mapped] = accountUsageFromFleet(snapshot(reading), [account()]) ?? [];

    // Assert
    should(mapped).deepEqual({
      agent: 'claude-writer',
      ok: false,
      availability: 'unavailable',
      unavailable: true,
      unavailableReason: 'cooldown',
      atLimit: true,
    });
  });

  it('should keep an unavailability whose reason the wire cannot spell', () => {
    // Arrange — the manifest's reasons are free text; the wire's are a closed set.
    const reading = row({ ok: false, unavailable: true, unavailableReason: 'no available models' });

    // Act
    const [mapped] = accountUsageFromFleet(snapshot(reading), [account()]) ?? [];

    // Assert
    should(mapped?.unavailable).be.true();
    should(mapped).not.have.property('unavailableReason');
  });

  it('should carry an exhausted quota from a successful reading', () => {
    // Arrange
    const reading = row({ atLimit: true, shortWindow: { usedPercent: 100 } });

    // Act
    const [mapped] = accountUsageFromFleet(snapshot(reading), [account()]) ?? [];

    // Assert
    should(mapped?.atLimit).be.true();
  });

  it('should drop a row no account in the manifest answers to', () => {
    // Act
    const rows = accountUsageFromFleet(snapshot(row(), row({ accountId: OTHER_ID })), [account()]);

    // Assert — the unnamed row cannot be routed, and the named one still can.
    should(rows?.map(entry => entry.agent)).deepEqual(['claude-writer']);
  });

  it('should refuse an executable name two accounts claim rather than pick one', () => {
    // Arrange — a manifest defect. Attaching this quota to a name another account also answers to is
    // how one account's exhaustion gets charged to another's session.
    const manifest = [account(), account({ id: OTHER_ID, displayName: 'Second' })];

    // Act
    const rows = accountUsageFromFleet(snapshot(row(), row({ accountId: OTHER_ID })), manifest);

    // Assert — nothing survived the join, so this reads as unreadable rather than as no accounts.
    should(rows).be.undefined();
  });

  it('should keep the rows it can name when only one executable name is contested', () => {
    // Arrange
    const contested = '1f7c8d92-58a1-4f3e-9c26-0a4b7e6d5f88';
    const manifest = [
      account(),
      account({ id: OTHER_ID, agent: 'claude-shared', displayName: 'Second' }),
      account({ id: contested, agent: 'claude-shared', displayName: 'Third' }),
    ];

    // Act
    const rows = accountUsageFromFleet(
      snapshot(row(), row({ accountId: OTHER_ID }), row({ accountId: contested })),
      manifest,
    );

    // Assert
    should(rows?.map(entry => entry.agent)).deepEqual(['claude-writer']);
  });

  it('should report a snapshot whose every row is unjoinable as unreadable, not as an empty fleet', () => {
    // Act — a stale or foreign manifest. Damaged evidence is not evidence of no accounts.
    const rows = accountUsageFromFleet(snapshot(row({ accountId: OTHER_ID })), [account()]);

    // Assert
    should(rows).be.undefined();
  });

  it('should report a genuinely empty fleet as empty', () => {
    // Act
    const rows = accountUsageFromFleet(snapshot(), [account()]);

    // Assert
    should(rows).deepEqual([]);
  });
});
