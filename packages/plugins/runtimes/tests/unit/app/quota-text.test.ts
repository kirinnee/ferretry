import { describe, expect, it } from 'bun:test';
import type { UsageAccountView } from '@ferretry/plugin-usage/contract';
import { formatQuotaMoney, quotaParts, quotaResetsIn } from '../../../app/lib/quota-text.ts';
import { NO_USAGE, readUsageRows } from '../../../app/lib/usage-feed.ts';
import { scripted } from './support/client.ts';

const NOW = Date.parse('2026-10-13T08:00:00.000Z');
const row = (overrides: Partial<UsageAccountView> = {}): UsageAccountView => ({ agent: 'claude-a', ...overrides });
const texts = (view: UsageAccountView | null) => quotaParts(view, NOW).map(part => part.text);

describe('how a runtime’s quota reads', () => {
  it('says nothing for a runtime the feed has no row for, or a row that states nothing: unknown is not zero', () => {
    expect(quotaParts(null, NOW)).toEqual([]);
    expect(quotaParts(row(), NOW)).toEqual([]);
  });

  it('reads the two windows as percent used, and tones them as they run out', () => {
    expect(texts(row({ fiveHourPercent: 30, weeklyPercent: 62 }))).toEqual(['5h 30%', 'wk 62%']);
    const tone = (percent: number) => quotaParts(row({ fiveHourPercent: percent }), NOW)[0]?.tone;
    expect([tone(30), tone(75), tone(90)]).toEqual(['muted', 'warn', 'err']);
    expect(texts(row({ weeklyPercent: 62 }))).toEqual(['wk 62%']);
  });

  it('says when a window resets, on hover', () => {
    const [part] = quotaParts(row({ fiveHourPercent: 30, fiveHourResetAt: NOW + 3 * 3_600_000 + 10 * 60_000 }), NOW);
    expect(part?.title).toBe('resets in 3h 10m');
  });

  it('leads with at limit, the state that stops work', () => {
    expect(quotaParts(row({ atLimit: true, fiveHourPercent: 100 }), NOW).map(part => [part.text, part.tone])).toEqual([
      ['at limit', 'err'],
      ['5h 100%', 'err'],
    ]);
  });

  it('an auth failure is not a quota: it says the login needs signing in and no percentage', () => {
    expect(quotaParts(row({ authOk: false, fiveHourPercent: 12 }), NOW)).toEqual([
      { text: 'sign-in needed', tone: 'err' },
    ]);
  });

  it('shows a credit-billed login’s balance, or this month’s spend when nothing else is known', () => {
    expect(texts(row({ balance: { amount: 12.345, currency: 'USD' } }))).toEqual(['$12.35 left']);
    expect(texts(row({ spendUsd: 3.2 }))).toEqual(['$3.20 this month']);
    expect(texts(row({ spendUsd: 3.2, fiveHourPercent: 10 }))).toEqual(['5h 10%']);
  });

  it('writes an unknown currency code out, and humanises the time to a reset', () => {
    expect(formatQuotaMoney(5, 'USD')).toBe('$5.00');
    expect(formatQuotaMoney(5, 'not-a-code')).toBe('5.00 not-a-code');
    expect(quotaResetsIn(undefined, NOW)).toBeNull();
    expect(quotaResetsIn(NOW - 1, NOW)).toBe('now');
    expect(quotaResetsIn(NOW + 47 * 60_000, NOW)).toBe('47m');
    expect(quotaResetsIn(NOW + 3 * 3_600_000, NOW)).toBe('3h');
    expect(quotaResetsIn(NOW + 2 * 86_400_000, NOW)).toBe('2d');
  });
});

describe('the quota rows, read through Usage’s contract', () => {
  it('parses the feed Usage serves into its account rows', async () => {
    const read = await readUsageRows(
      scripted({ 'GET /v1/usage': { stale: false, accounts: [{ agent: 'claude-a', fiveHourPercent: 42 }] } }),
    );
    expect(read).toEqual({ rows: [{ agent: 'claude-a', fiveHourPercent: 42 }], error: null });
  });

  it('Usage off is no rows and no complaint', async () => {
    const off = Object.assign(new Error('paused'), { status: 0, code: 'plugin_paused' });
    expect(await readUsageRows(scripted({ 'GET /v1/usage': off }))).toBe(NO_USAGE);
  });

  it('a failed read says so, with the daemon’s reason; an answer that is no feed is a failed read', async () => {
    expect((await readUsageRows(scripted({ 'GET /v1/usage': new Error('boom') }))).error).toBe(
      'Quota could not be read (boom).',
    );
    expect((await readUsageRows(scripted({ 'GET /v1/usage': { accounts: 3 } }))).rows).toEqual([]);
  });
});
