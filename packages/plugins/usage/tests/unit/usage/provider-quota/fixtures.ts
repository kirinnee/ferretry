/**
 * Recorded provider replies, one per quota endpoint, as each provider (or the community tools that
 * found an undocumented one) shows them. The tests read these; nothing here touches the network.
 *
 * Instants are fixed: 2026-10-16T09:00:00Z is `NOW_MS`.
 */

export const NOW_MS = Date.parse('2026-10-16T09:00:00.000Z');
const IN_2H = NOW_MS + 2 * 3_600_000;
const IN_3D = NOW_MS + 3 * 86_400_000;
const IN_20D = NOW_MS + 20 * 86_400_000;

/** `GET https://api.z.ai/api/monitor/usage/quota/limit` — two prompt windows and the tool allowance. */
export const ZAI_QUOTA = {
  code: 200,
  msg: 'Operation successful',
  success: true,
  data: {
    limits: [
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 31, nextResetTime: IN_3D },
      {
        type: 'TIME_LIMIT',
        unit: 5,
        number: 1,
        usage: 1000,
        currentValue: 120,
        remaining: 880,
        percentage: 12,
        nextResetTime: IN_20D,
      },
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 64, nextResetTime: IN_2H },
    ],
  },
};

/** `GET https://www.minimax.io/v1/token_plan/remains` — `usage_count` is what REMAINS. */
export const MINIMAX_REMAINS = {
  model_remains: [
    { model_name: 'speech-hd', current_interval_total_count: 10, current_interval_usage_count: 10 },
    {
      model_name: 'general',
      start_time: NOW_MS - 3 * 3_600_000,
      end_time: IN_2H,
      remains_time: 2 * 3_600_000,
      current_interval_total_count: 1500,
      current_interval_usage_count: 1200,
      weekly_start_time: NOW_MS - 4 * 86_400_000,
      weekly_end_time: IN_3D,
      weekly_remains_time: 3 * 86_400_000,
      current_weekly_total_count: 15000,
      current_weekly_usage_count: 3000,
    },
  ],
  base_resp: { status_code: 0, status_msg: 'success' },
};

/** The same endpoint's newer shape, with remaining percentages instead of counts. */
export const MINIMAX_REMAINS_PERCENT = {
  model_remains: [
    {
      model_name: 'general',
      current_interval_remaining_percent: 80,
      current_weekly_remaining_percent: 40,
      remains_time: 3_600_000,
    },
  ],
  base_resp: { status_code: 0, status_msg: 'success' },
};

/** MiniMax answers a bad key with HTTP 200. */
export const MINIMAX_LOGIN_FAIL = { base_resp: { status_code: 1004, status_msg: 'login fail' } };

/** `GET https://api.deepseek.com/user/balance`. */
export const DEEPSEEK_BALANCE = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
    { currency: 'USD', total_balance: '12.50', granted_balance: '0.00', topped_up_balance: '12.50' },
  ],
};

/** `GET https://api.moonshot.ai/v1/users/me/balance`. */
export const MOONSHOT_BALANCE = {
  code: 0,
  data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 },
  scode: '0x0',
  status: true,
};

/** `GET https://openrouter.ai/api/v1/key` — a key with a $10 limit. */
export const OPENROUTER_KEY = {
  data: {
    label: 'sk-or-v1-abc...xyz',
    limit: 10,
    usage: 4.2,
    limit_remaining: 5.8,
    limit_reset: 'monthly',
    usage_daily: 0.4,
    usage_weekly: 1.9,
    usage_monthly: 4.2,
    is_free_tier: false,
  },
};

/** The same endpoint for a key with no limit. */
export const OPENROUTER_KEY_UNLIMITED = {
  data: { label: 'sk-or-v1-def...uvw', limit: null, usage: 31.7, limit_remaining: null, usage_monthly: 8.25 },
};

/** `GET <proxy>/key/info`. */
export const LITELLM_KEY_INFO = {
  key: 'hashed',
  info: { spend: 12.5, max_budget: 50, budget_reset_at: '2026-11-01T00:00:00Z' },
};

/** `GET https://ai-gateway.vercel.sh/v1/credits`. */
export const VERCEL_CREDITS = { balance: '95.50', total_used: '4.50' };
