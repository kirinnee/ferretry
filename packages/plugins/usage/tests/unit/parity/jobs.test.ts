/**
 * Parity rows J-0010, J-0020, J-0028, J-0041, J-0081, J-0082, J-0086, J-0090, J-0108, J-0115, J-0124, J-0138, J-0163,
 * J-0181, J-0263, J-0264, J-0268 (docs/design/rebuild-parity.md, usage).
 */
import { describe, expect, test } from 'bun:test';
import { milliseconds } from '@ferretry/std';
import { InsightsChanged } from '../../../contract/index.ts';
import { HttpAnalyticsPricingFeed } from '../../../daemon/adapters/analytics/pricing-feed-source.ts';
import { WatchedUsageFeed } from '../../../daemon/lib/usage/provider-quota/watched-feed.ts';
import type { UsageFeedPort } from '../../../daemon/lib/usage/types.ts';
import { usageHost } from './host.ts';

describe('the jobs the kernel arms', () => {
  test('J-0020 J-0081 J-0090 J-0124 the budgets are measured once a minute, after the last published pauses are restored', async () => {
    const { host, scheduled } = await usageHost();

    const restore = scheduled.find(job => job.id === 'usage-restore');
    const tick = scheduled.find(job => job.id === 'usage-budget');
    expect(restore?.schedule).toEqual({ onceAfterStart: true });
    expect(tick?.schedule).toEqual({ every: milliseconds(60_000) });
    expect(tick?.after).toEqual(['usage-restore']);
    expect(host.jobIds()).toEqual(expect.arrayContaining(['usage-restore', 'usage-budget']));
    await host.stop();
  });

  test('J-0082 a change to usage.yaml measures the budgets now, not at the next minute', async () => {
    const { host } = await usageHost();
    expect((await host.request('GET', '/v1/usage/budgets')).json()).toEqual({ budgets: [] });

    host.setConfig('usage.yaml', { budgets: { work: { daily: { trigger: 5, hard: 9 } } } });
    await host.settle();

    const view = (await host.request('GET', '/v1/usage/budgets')).json<{ budgets: { login: string }[] }>();
    expect(view.budgets.map(entry => entry.login)).toEqual(['work']);
    await host.stop();
  });

  test('J-0010 J-0041 J-0086 insights ingestion is armed with a fifteen-minute backstop; a pass reads the fleet and says the index changed', async () => {
    const { host, scheduled } = await usageHost();

    expect(scheduled.find(job => job.id === 'usage-ingest')?.schedule).toEqual({ every: milliseconds(15 * 60_000) });
    await host.runJob('usage-ingest');

    expect(host.published.filter(entry => entry.event === InsightsChanged.name)).toHaveLength(1);
    await host.stop();
  });

  test('J-0108 J-0138 J-0263 J-0264 a performance profile samples the daemon on the kernel timers and closes at its window', async () => {
    const { host } = await usageHost();

    const started = (await host.request('POST', '/v1/diagnostics/profile', { body: { seconds: 5 } })).json<{
      state: string;
      id: string;
    }>();
    expect(started.state).toBe('running');
    // The first gauge read lands before the window's end is scheduled.
    for (let round = 0; round < 20; round += 1) await Promise.resolve();
    expect(host.clock.pending()).toBeGreaterThan(0);
    await host.clock.advance(5_000);
    type Done = { state: string; report?: { windowMs: number } };
    const read = async () => (await host.request('GET', `/v1/diagnostics/profile/${started.id}`)).json<Done>();
    let done = await read();
    for (let turn = 0; turn < 50 && done.state !== 'finished'; turn += 1) {
      await new Promise(resolve => setTimeout(resolve, 1));
      done = await read();
    }
    expect(done.state).toBe('finished');
    expect(done.report?.windowMs).toBe(5_000);
    await host.stop();
  });

  test('J-0181 a pricing feed read that outlives its deadline is aborted and answered as a timeout', async () => {
    let fire: (() => void) | undefined;
    let deadlineMs: number | undefined;
    let cleared = false;
    const feed = new HttpAnalyticsPricingFeed({
      fetcher: () => new Promise<Response>(() => {}),
      scheduleTimeout: (onTimeout, timeoutMs) => {
        fire = onTimeout;
        deadlineMs = timeoutMs;
        return () => {
          cleared = true;
        };
      },
    });

    const pending = feed.read({ url: 'https://prices.example.test/rates.json' } as never);
    fire?.();

    expect(await pending).toEqual({ kind: 'timeout' });
    expect(deadlineMs).toBeGreaterThan(0);
    expect(cleared).toBe(true);
  });

  test('J-0268 reading the feed asks the provider-quota reader to watch, once per read', async () => {
    let watches = 0;
    const inner: UsageFeedPort = {
      accounts: async () => [],
      snapshotAt: () => 1,
      hasSnapshot: () => true,
    };
    const feed = new WatchedUsageFeed(inner, () => ({
      watch: async () => {
        watches += 1;
      },
      peekAgent: () => undefined,
    }));

    await feed.accounts();
    await feed.accounts();

    expect(watches).toBe(2);
  });

  test.skip('J-0028 the usage feed re-reads when the published manifest file changes — pending port: a Logins change event the feed can invalidate on (the published manifest file is Logins’, and the feed reads its list through the port per refresh)', () => {});
  test.skip('J-0115 the event-loop lag meter beats every interval and feeds the performance report — pending port: the kernel hands Usage no event-loop reading yet (the profile report says so in its limitations)', () => {});
  test.skip('J-0163 timers started outside a live activity are wrapped so they do not hold the daemon busy — not Usage’s: the host’s live-activity timers (Ferrets/kernel), listed under usage in the parity table', () => {});
});
