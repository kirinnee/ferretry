import { describe, it } from 'bun:test';
import { ProviderQuotaWindowSchema } from '@ferretry/protocol';
import should from 'should';
import {
  amountOf,
  parseDeepseekBalance,
  parseLitellmKeyInfo,
  parseMinimaxRemains,
  parseMoonshotBalance,
  parseOpenRouterKey,
  parseVercelCredits,
  parseZaiQuota,
} from '../../../../src/lib/usage/provider-quota/parse.ts';
import {
  DEEPSEEK_BALANCE,
  LITELLM_KEY_INFO,
  MINIMAX_LOGIN_FAIL,
  MINIMAX_REMAINS,
  MINIMAX_REMAINS_PERCENT,
  MOONSHOT_BALANCE,
  NOW_MS,
  OPENROUTER_KEY,
  OPENROUTER_KEY_UNLIMITED,
  VERCEL_CREDITS,
  ZAI_QUOTA,
} from './fixtures.ts';

const iso = (ms: number): string => new Date(ms).toISOString();
const MALFORMED = { kind: 'malformed' };

describe('parseZaiQuota', () => {
  it('should tell the 5-hour window from the weekly one by when each resets, and keep the tool allowance apart', () => {
    // Act
    const actual = parseZaiQuota(ZAI_QUOTA);

    // Assert
    should(actual).deepEqual({
      kind: 'quota',
      quota: {
        windows: [
          { label: '5h', usedPercent: 64, resetsAt: iso(NOW_MS + 2 * 3_600_000) },
          { label: 'week', usedPercent: 31, resetsAt: iso(NOW_MS + 3 * 86_400_000) },
          {
            label: 'tools',
            unit: 'requests',
            used: 120,
            limit: 1000,
            usedPercent: 12,
            resetsAt: iso(NOW_MS + 20 * 86_400_000),
          },
        ],
        exhausted: false,
      },
    });
    for (const window of actual.kind === 'quota' ? actual.quota.windows : []) ProviderQuotaWindowSchema.parse(window);
  });

  it('should say a full prompt window is exhausted, and a full tool allowance is not', () => {
    // Arrange
    const full = { data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 100 }] } };
    const tools = { data: { limits: [{ type: 'TIME_LIMIT', currentValue: 10, usage: 10 }] } };

    // Act
    const fullPrompts = parseZaiQuota(full);
    const fullTools = parseZaiQuota(tools);

    // Assert
    should(fullPrompts).deepEqual({
      kind: 'quota',
      quota: { windows: [{ label: '5h', usedPercent: 100 }], exhausted: true },
    });
    should(fullTools).deepEqual({
      kind: 'quota',
      quota: {
        windows: [{ label: 'tools', unit: 'requests', used: 10, limit: 10, usedPercent: 100 }],
        exhausted: false,
      },
    });
  });

  it('should leave a window it was told nothing about unknown, never 0', () => {
    // Act
    const actual = parseZaiQuota({
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', percentage: 'lots', nextResetTime: -4 },
          { type: 'TOKENS_LIMIT' },
          { type: 'TIME_LIMIT' },
        ],
      },
    });

    // Assert
    should(actual).deepEqual({
      kind: 'quota',
      quota: {
        windows: [{ label: '5h' }, { label: 'week' }, { label: 'tools', unit: 'requests' }],
        exhausted: false,
      },
    });
  });

  it('should refuse a reply with no limits it recognises', () => {
    // Act & Assert
    should(parseZaiQuota({ data: {} })).deepEqual(MALFORMED);
    should(parseZaiQuota({ data: { limits: [{ type: 'OTHER' }, null] } })).deepEqual(MALFORMED);
    should(parseZaiQuota('nope')).deepEqual(MALFORMED);
    should(parseZaiQuota([])).deepEqual(MALFORMED);
  });
});

describe('parseMinimaxRemains', () => {
  it('should read usage_count as what REMAINS, so used is the total less it', () => {
    // Act
    const actual = parseMinimaxRemains(MINIMAX_REMAINS, NOW_MS);

    // Assert
    should(actual).deepEqual({
      kind: 'quota',
      quota: {
        windows: [
          {
            label: '5h',
            unit: 'prompts',
            used: 300,
            limit: 1500,
            usedPercent: 20,
            resetsAt: iso(NOW_MS + 2 * 3_600_000),
          },
          {
            label: 'week',
            unit: 'prompts',
            used: 12000,
            limit: 15000,
            usedPercent: 80,
            resetsAt: iso(NOW_MS + 3 * 86_400_000),
          },
        ],
        exhausted: false,
      },
    });
  });

  it('should prefer the remaining percentages when the reply has them, and time a reset from what is left', () => {
    // Act
    const actual = parseMinimaxRemains(MINIMAX_REMAINS_PERCENT, NOW_MS);

    // Assert
    should(actual).deepEqual({
      kind: 'quota',
      quota: {
        windows: [
          { label: '5h', usedPercent: 20, resetsAt: iso(NOW_MS + 3_600_000) },
          { label: 'week', usedPercent: 60 },
        ],
        exhausted: false,
      },
    });
  });

  it('should leave a plan with nothing provisioned unknown, and say an empty window is exhausted', () => {
    // Arrange
    const reply = (entry: Record<string, unknown>) => ({
      model_remains: [entry],
      base_resp: { status_code: 0 },
    });

    // Act
    const unprovisioned = parseMinimaxRemains(
      reply({ current_interval_total_count: 0, current_interval_usage_count: 0 }),
      NOW_MS,
    );
    const spent = parseMinimaxRemains(
      reply({ current_interval_total_count: 100, current_interval_usage_count: 0 }),
      NOW_MS,
    );

    // Assert
    should(unprovisioned).deepEqual({
      kind: 'quota',
      quota: { windows: [{ label: '5h' }, { label: 'week' }], exhausted: false },
    });
    should(spent).containDeep({ quota: { exhausted: true } });
  });

  it('should read its login-fail code as a refused key, and any other code or shape as unreadable', () => {
    // Act & Assert
    should(parseMinimaxRemains(MINIMAX_LOGIN_FAIL, NOW_MS)).deepEqual({ kind: 'rejected' });
    should(parseMinimaxRemains({ base_resp: { status_code: 2049 } }, NOW_MS)).deepEqual({ kind: 'rejected' });
    should(parseMinimaxRemains({ base_resp: { status_code: 1002 } }, NOW_MS)).deepEqual(MALFORMED);
    should(parseMinimaxRemains({ base_resp: { status_code: 0 } }, NOW_MS)).deepEqual(MALFORMED);
    should(parseMinimaxRemains({ base_resp: { status_code: 0 }, model_remains: [] }, NOW_MS)).deepEqual(MALFORMED);
    should(parseMinimaxRemains(null, NOW_MS)).deepEqual(MALFORMED);
  });
});

describe('parseDeepseekBalance', () => {
  it('should show the US-dollar balance when there is one', () => {
    // Act & Assert
    should(parseDeepseekBalance(DEEPSEEK_BALANCE)).deepEqual({
      kind: 'quota',
      quota: { windows: [], balance: { amount: 12.5, currency: 'USD' }, exhausted: false },
    });
  });

  it('should show the first balance otherwise, and an account that cannot pay as exhausted', () => {
    // Act
    const yuan = parseDeepseekBalance({
      is_available: false,
      balance_infos: [{ currency: 'cny', total_balance: '0.00' }],
    });
    const unknownCurrency = parseDeepseekBalance({ is_available: true, balance_infos: [{ currency: '¥' }] });

    // Assert
    should(yuan).deepEqual({
      kind: 'quota',
      quota: { windows: [], balance: { amount: 0, currency: 'CNY' }, exhausted: true },
    });
    should(unknownCurrency).deepEqual({ kind: 'quota', quota: { windows: [], exhausted: false } });
  });

  it('should refuse a reply with no balances and no availability', () => {
    // Act & Assert
    should(parseDeepseekBalance({})).deepEqual(MALFORMED);
    should(parseDeepseekBalance({ balance_infos: [{ total_balance: '' }] })).deepEqual(MALFORMED);
  });
});

describe('parseMoonshotBalance', () => {
  it('should read the available balance in the currency the platform bills in', () => {
    // Act & Assert
    should(parseMoonshotBalance(MOONSHOT_BALANCE, 'USD')).deepEqual({
      kind: 'quota',
      quota: { windows: [], balance: { amount: 49.58894, currency: 'USD' }, exhausted: false },
    });
    should(parseMoonshotBalance({ data: { available_balance: -1 } }, 'CNY')).deepEqual({
      kind: 'quota',
      quota: { windows: [], balance: { amount: -1, currency: 'CNY' }, exhausted: true },
    });
  });

  it('should refuse an error code or a reply with no balance', () => {
    // Act & Assert
    should(parseMoonshotBalance({ code: 5, data: { available_balance: 1 } }, 'USD')).deepEqual(MALFORMED);
    should(parseMoonshotBalance({ code: 0, data: {} }, 'USD')).deepEqual(MALFORMED);
  });
});

describe('parseOpenRouterKey', () => {
  it('should read a key with a limit as a key window, its remainder as the balance, and this month', () => {
    // Act & Assert
    should(parseOpenRouterKey(OPENROUTER_KEY)).deepEqual({
      kind: 'quota',
      quota: {
        windows: [
          { label: 'key', unit: 'usd', used: 4.2, limit: 10, usedPercent: 42 },
          { label: 'month', unit: 'usd', used: 4.2 },
        ],
        balance: { amount: 5.8, currency: 'USD' },
        exhausted: false,
      },
    });
  });

  it('should show only this month for a key with no limit, and a spent limit as exhausted', () => {
    // Act
    const unlimited = parseOpenRouterKey(OPENROUTER_KEY_UNLIMITED);
    const spent = parseOpenRouterKey({ data: { limit: 0, limit_remaining: 0 } });
    const onlyUsage = parseOpenRouterKey({ data: { usage: 3 } });

    // Assert
    should(unlimited).deepEqual({
      kind: 'quota',
      quota: { windows: [{ label: 'month', unit: 'usd', used: 8.25 }], exhausted: false },
    });
    should(spent).deepEqual({
      kind: 'quota',
      quota: {
        windows: [{ label: 'key', unit: 'usd', limit: 0 }],
        balance: { amount: 0, currency: 'USD' },
        exhausted: true,
      },
    });
    should(onlyUsage).deepEqual({ kind: 'quota', quota: { windows: [], exhausted: false } });
  });

  it('should refuse a reply with no data or nothing in it', () => {
    // Act & Assert
    should(parseOpenRouterKey({ error: 'nope' })).deepEqual(MALFORMED);
    should(parseOpenRouterKey({ data: {} })).deepEqual(MALFORMED);
  });
});

describe('parseLitellmKeyInfo', () => {
  it('should read the key spend against its budget, and the budget left as its balance', () => {
    // Act & Assert
    should(parseLitellmKeyInfo(LITELLM_KEY_INFO)).deepEqual({
      kind: 'quota',
      quota: {
        windows: [
          { label: 'key', unit: 'usd', used: 12.5, limit: 50, usedPercent: 25, resetsAt: '2026-11-01T00:00:00.000Z' },
        ],
        balance: { amount: 37.5, currency: 'USD' },
        exhausted: false,
      },
    });
  });

  it('should show only the spend of a key with no budget, and refuse a reply without one', () => {
    // Act & Assert
    should(parseLitellmKeyInfo({ info: { spend: '2', budget_reset_at: 'soon' } })).deepEqual({
      kind: 'quota',
      quota: { windows: [{ label: 'key', unit: 'usd', used: 2 }], exhausted: false },
    });
    should(parseLitellmKeyInfo({ info: {} })).deepEqual(MALFORMED);
  });
});

describe('parseVercelCredits', () => {
  it('should read the credit balance, and none left as exhausted', () => {
    // Act & Assert
    should(parseVercelCredits(VERCEL_CREDITS)).deepEqual({
      kind: 'quota',
      quota: { windows: [], balance: { amount: 95.5, currency: 'USD' }, exhausted: false },
    });
    should(parseVercelCredits({ balance: 0 })).containDeep({ quota: { exhausted: true } });
    should(parseVercelCredits({})).deepEqual(MALFORMED);
  });
});

describe('amountOf', () => {
  it('should read finite numbers and numeric strings, and nothing else', () => {
    // Act & Assert
    should(amountOf(3)).equal(3);
    should(amountOf('4.5')).equal(4.5);
    should(amountOf(Number.NaN)).be.undefined();
    should(amountOf('  ')).be.undefined();
    should(amountOf('abc')).be.undefined();
    should(amountOf(true)).be.undefined();
  });
});
