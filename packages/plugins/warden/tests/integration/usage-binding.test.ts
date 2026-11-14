import { describe, it } from 'bun:test';
import should from 'should';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import type { UsageApi, UsageFeedView } from '@ferretry/plugin-usage/contract';
import { fakeUsage } from '@ferretry/plugin-usage/contract/testing';
import { createWardenSubsystem } from '../../daemon/subsystem.ts';
import { fakeKernel, wardenConfig } from '../support/kernel.ts';

/**
 * The Warden over Usage's OWN provider shape (`UsageApi` from the Usage contract), not a type the Warden declared:
 * a stand-in port the provider does not match answers nothing at runtime and nothing says so.
 */
function warden(feed: UsageApi['feed']) {
  const config = wardenConfig({ accounts: [{ agent: 'claude-code' }, { agent: 'second' }] });
  const fake = fakeKernel({ config, start: '2026-11-07T12:00:00.000Z' });
  const usage: UsageApi = { ...fakeUsage(), feed };
  return createWardenSubsystem({
    kernel: fake.kernel,
    // Both logins are installed on this machine, so only the usage feed can say anything against one.
    ferrets: Object.assign(new FakeFerrets(), { harnesses: () => ['claude-code', 'second'] as never }),
    conversation: fakeConversation(),
    asks: new FakeAsks(),
    usage: () => usage,
    board: () => undefined,
  });
}

const feedOf =
  (accounts: UsageFeedView['accounts']): UsageApi['feed'] =>
  async () => ({ stale: false, accounts });

describe('the warden over the real Usage port', () => {
  it('should read a login at its limit from the usage feed and say it is not eligible', async () => {
    // Arrange
    const subject = warden(feedOf([{ agent: 'claude-code', atLimit: true, authOk: true }]));

    // Act
    const status = await subject.status();

    // Assert
    const [first, second] = status.failover?.accounts ?? [];
    should(first).have.properties({ agent: 'claude-code', eligible: false, reason: 'at its usage limit (usage feed)' });
    should(first?.quota).eql({ atLimit: true, authOk: true });
    should(second).have.properties({ agent: 'second', eligible: true });
  });

  it('should read rejected credentials and an unavailable provider from the usage feed', async () => {
    // Arrange
    const subject = warden(
      feedOf([
        { agent: 'claude-code', authOk: false },
        {
          agent: 'second',
          unavailable: true,
          unavailableReason: 'cooldown',
          retryAt: Date.parse('2026-11-07T13:00:00Z'),
        },
      ]),
    );

    // Act
    const status = await subject.status();

    // Assert
    const [first, second] = status.failover?.accounts ?? [];
    should(first?.reason).equal('credentials rejected (usage feed)');
    should(second?.reason).equal('provider unavailable: cooldown; retry after 2026-11-07T13:00:00.000Z (usage feed)');
  });

  it('should read every login as unknown, and not throw, when the usage feed fails', async () => {
    // Arrange
    const subject = warden(async () => {
      throw new Error('usage collector exploded');
    });

    // Act
    const status = await subject.status();

    // Assert
    should((status.failover?.accounts ?? []).map(account => account.eligible)).eql([true, true]);
    should((status.failover?.accounts ?? []).every(account => account.quota === undefined)).equal(true);
  });
});
