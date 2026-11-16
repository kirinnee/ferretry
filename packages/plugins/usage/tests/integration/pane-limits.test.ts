/**
 * The limits live panes prove, through the REAL Usage daemon half over a Ferrets that reports them (triage row 10): the
 * feed row of a limited login says so, `UsageApi.paneLimits()` carries presence, notice, spend and the optional reset
 * time by login, an unaffected login is untouched, and a limit ends when its ferret is released or its reset passes.
 */
import { describe, expect, test } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { FerretPaneLimit } from '@ferretry/core-ferrets/contract';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { UsagePort, type UsageFeedView } from '../../contract/index.ts';
import usage from '../../daemon/index.ts';

const limit = (over: Partial<FerretPaneLimit> & { readonly ferret: string }): FerretPaneLimit =>
  ({ notice: "You've hit your usage limit", spend: false, login: 'limited', ...over }) as FerretPaneLimit;

async function host(ferrets = new FakeFerrets()) {
  const h = await testHost({
    plugins: [usage],
    fakes: {
      ferrets,
      conversation: fakeConversation(),
      // Both logins are signed in with room in their windows: only a pane can say the first one is spent.
      logins: fakeLogins(
        ['limited', 'free'].map(id =>
          sampleLogin(id, { usage: { fiveHour: { usedPercent: 10 }, weekly: { usedPercent: 20 } } }),
        ),
      ),
      vault: new FakeVault(),
    },
  });
  return { h, ferrets };
}

const rowOf = (view: UsageFeedView, login: string) => view.accounts.find(row => row.agent === login);

describe('the pane limits the usage daemon half owns', () => {
  test('a login a live pane proves spent reads as at its limit in the feed, an unaffected one does not', async () => {
    const { h, ferrets } = await host();
    ferrets.setPaneLimits([limit({ ferret: ferretId('a') })]);

    const feed = (await h.request('GET', '/v1/usage')).json<UsageFeedView>();

    expect(rowOf(feed, 'limited')?.atLimit).toBe(true);
    expect(rowOf(feed, 'free')?.atLimit).toBe(false);
    await h.stop();
  });

  test('a spend limit makes the login unavailable for spend_limit until the time the harness gave', async () => {
    const { h, ferrets } = await host();
    const retryAt = Date.parse('2999-01-01T00:00:00Z');
    ferrets.setPaneLimits([limit({ ferret: ferretId('a'), spend: true, retryAt })]);

    const row = rowOf((await h.request('GET', '/v1/usage')).json<UsageFeedView>(), 'limited');

    expect([row?.unavailable, row?.unavailableReason, row?.retryAt]).toEqual([true, 'spend_limit', retryAt]);
    await h.stop();
  });

  test('paneLimits() carries presence, notice, spend and the optional reset by login — a non-spend limit with no reset time too', async () => {
    const { h, ferrets } = await host();
    ferrets.setPaneLimits([
      limit({ ferret: ferretId('a') }),
      limit({ ferret: ferretId('b'), login: 'timed', retryAt: 4_000_000_000_000 }),
    ]);

    const limits = await h.provided(UsagePort).paneLimits();

    expect(limits).toEqual([
      { login: 'limited', notice: "You've hit your usage limit", spend: false },
      { login: 'timed', notice: "You've hit your usage limit", spend: false, retryAt: 4_000_000_000_000 },
    ]);
    await h.stop();
  });

  test('where several ferrets prove one login, the one with no reset time outranks a timed one, then the latest reset wins', async () => {
    const { h, ferrets } = await host();
    ferrets.setPaneLimits([
      limit({ ferret: ferretId('a'), retryAt: 4_000_000_000_000, notice: 'early' }),
      limit({ ferret: ferretId('b'), retryAt: 4_100_000_000_000, notice: 'late' }),
      limit({ ferret: ferretId('c'), login: 'open', notice: 'timed first', retryAt: 4_000_000_000_000 }),
      limit({ ferret: ferretId('d'), login: 'open', notice: 'no time' }),
    ]);

    const limits = await h.provided(UsagePort).paneLimits();

    expect(limits.map(row => [row.login, row.notice, row.retryAt])).toEqual([
      ['limited', 'late', 4_100_000_000_000],
      ['open', 'no time', undefined],
    ]);
    await h.stop();
  });

  test('a limit ends when its ferret is released, and when its reset time has passed', async () => {
    const { h, ferrets } = await host();
    ferrets.setPaneLimits([
      limit({ ferret: ferretId('a') }),
      limit({ ferret: ferretId('b'), login: 'over', retryAt: 1 }),
    ]);

    const held = await h.provided(UsagePort).paneLimits();
    ferrets.setPaneLimits([]);
    const released = await h.provided(UsagePort).paneLimits();

    expect(held.map(row => row.login)).toEqual(['limited']);
    expect(released).toEqual([]);
    await h.stop();
  });

  test('a ferret that records no login is known by its runtime, and an unreadable Ferrets proves no limit', async () => {
    const { h, ferrets } = await host();
    ferrets.setPaneLimits([{ ferret: ferretId('a'), runtime: 'codex-main', notice: 'limit', spend: false }]);
    const byRuntime = await h.provided(UsagePort).paneLimits();
    ferrets.paneLimits = async () => {
      throw new Error('ferrets are down');
    };

    expect(byRuntime).toEqual([{ runtime: 'codex-main', notice: 'limit', spend: false }]);
    expect(await h.provided(UsagePort).paneLimits()).toEqual([]);
    expect((await h.request('GET', '/v1/usage')).status).toBe(200);
    await h.stop();
  });
});
