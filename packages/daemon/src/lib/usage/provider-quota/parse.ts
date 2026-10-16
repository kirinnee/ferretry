/**
 * Each provider's quota or balance reply, mapped onto Ferretry's one shape (docs/provider-quotas.md):
 * windows, each with what was used, the limit, the share used and when it resets, plus the money left
 * where that is how the provider bills.
 *
 * EVERY FIELD IS OPTIONAL, AND A MISSING ONE STAYS MISSING. A reply that does not say how much of a
 * window is used produces a window with no `usedPercent` — "unknown" on screen — never a 0 that reads
 * as "nothing used". A reply that is not the shape a provider documents is `malformed`, and the reader
 * falls back rather than guessing.
 *
 * Pure: a recorded reply in, a parsed quota out.
 */
import type { ProviderQuotaBalance, ProviderQuotaWindow } from '@ferretry/protocol';

/** What one reply said, before it is stamped with its source and the instant it was read. */
export interface ParsedProviderQuota {
  readonly windows: readonly ProviderQuotaWindow[];
  readonly balance?: ProviderQuotaBalance;
  readonly exhausted: boolean;
}

/** A reply the reader can use, one that says the key was refused, or one it cannot read. */
export type ProviderQuotaParse =
  | { readonly kind: 'quota'; readonly quota: ParsedProviderQuota }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'malformed' };

const MALFORMED: ProviderQuotaParse = { kind: 'malformed' };

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/** A finite number, or a numeric string as several providers send money. */
export function amountOf(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const nonNegative = (value: unknown): number | undefined => {
  const amount = amountOf(value);
  return amount === undefined || amount < 0 ? undefined : amount;
};

/** A share in percentage points, 0 to 100. Anything else is not a share this reader trusts. */
const share = (value: unknown): number | undefined => {
  const amount = nonNegative(value);
  return amount === undefined || amount > 100 ? undefined : amount;
};

/** Epoch milliseconds as an instant, or `undefined` for anything that is not a plausible one. */
const instantFromMs = (value: unknown): string | undefined => {
  const ms = amountOf(value);
  return ms === undefined || ms <= 0 || ms > 8.64e15 ? undefined : new Date(ms).toISOString();
};

/** An ISO date-time string as an instant. */
const instantFromText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
};

/** A window with only the fields that were said. */
function windowOf(
  label: ProviderQuotaWindow['label'],
  fields: Partial<Omit<ProviderQuotaWindow, 'label'>>,
): ProviderQuotaWindow {
  return {
    label,
    ...(fields.unit === undefined ? {} : { unit: fields.unit }),
    ...(fields.used === undefined ? {} : { used: fields.used }),
    ...(fields.limit === undefined ? {} : { limit: fields.limit }),
    ...(fields.usedPercent === undefined ? {} : { usedPercent: fields.usedPercent }),
    ...(fields.resetsAt === undefined ? {} : { resetsAt: fields.resetsAt }),
  };
}

/** `used / limit` as a share to two decimals, when both are known and the limit is not zero. */
const ratio = (used: number | undefined, limit: number | undefined): number | undefined =>
  used === undefined || limit === undefined || limit <= 0 ? undefined : Math.round((used / limit) * 10_000) / 100;

/** A window is full when its share used reached 100. */
const full = (windows: readonly ProviderQuotaWindow[]): boolean =>
  windows.some(window => window.usedPercent !== undefined && window.usedPercent >= 100);

const quota = (windows: readonly ProviderQuotaWindow[], balance?: ProviderQuotaBalance, exhausted = false) => ({
  kind: 'quota' as const,
  quota: { windows, ...(balance === undefined ? {} : { balance }), exhausted: exhausted || full(windows) },
});

// ── Z.ai GLM Coding Plan ─────────────────────────────────────────────────────────────────────────

/**
 * `GET https://api.z.ai/api/monitor/usage/quota/limit` → `{ data: { limits: [...] } }`. UNVERIFIED: the
 * endpoint is described by community tools, not by Z.ai's documentation, and so is this mapping.
 *
 * The prompt windows are `TOKENS_LIMIT` entries that do not name their length, so they are told apart
 * by when they reset: the sooner is the 5-hour window, the later the weekly one. A `TIME_LIMIT` entry
 * is the plan's separate allowance of tool calls (web search, readers), shown as `tools`.
 */
export function parseZaiQuota(payload: unknown): ProviderQuotaParse {
  const body = record(payload);
  const limits = record(body?.data)?.limits;
  if (!Array.isArray(limits)) return MALFORMED;
  const entries = limits.map(record).filter(entry => entry !== undefined);
  const resetOf = (entry: Readonly<Record<string, unknown>>): number => amountOf(entry.nextResetTime) ?? Infinity;
  const prompts = entries
    .filter(entry => entry.type === 'TOKENS_LIMIT')
    .toSorted((left, right) => (resetOf(left) === resetOf(right) ? 0 : resetOf(left) < resetOf(right) ? -1 : 1));
  const tools = entries.find(entry => entry.type === 'TIME_LIMIT');
  if (prompts.length === 0 && tools === undefined) return MALFORMED;
  const promptWindow = (label: '5h' | 'week', entry: Readonly<Record<string, unknown>> | undefined) => {
    if (entry === undefined) return [];
    const usedPercent = share(entry.percentage);
    const resetsAt = instantFromMs(entry.nextResetTime);
    return [
      windowOf(label, {
        ...(usedPercent === undefined ? {} : { usedPercent }),
        ...(resetsAt === undefined ? {} : { resetsAt }),
      }),
    ];
  };
  const windows = [
    ...promptWindow('5h', prompts[0]),
    ...promptWindow('week', prompts.length > 1 ? prompts.at(-1) : undefined),
  ];
  if (tools !== undefined) {
    const used = nonNegative(tools.currentValue);
    const limit = nonNegative(tools.usage);
    const usedPercent = share(tools.percentage) ?? ratio(used, limit);
    const resetsAt = instantFromMs(tools.nextResetTime);
    windows.push(
      windowOf('tools', {
        unit: 'requests',
        ...(used === undefined ? {} : { used }),
        ...(limit === undefined ? {} : { limit }),
        ...(usedPercent === undefined ? {} : { usedPercent }),
        ...(resetsAt === undefined ? {} : { resetsAt }),
      }),
    );
  }
  // A full tool allowance does not stop a ferret from working, so only the prompt windows count.
  return { kind: 'quota', quota: { windows, exhausted: full(windows.filter(window => window.label !== 'tools')) } };
}

// ── MiniMax Token Plan ───────────────────────────────────────────────────────────────────────────

/** MiniMax's "login fail" and "invalid key" codes, which it answers with HTTP 200. */
const MINIMAX_AUTH_CODES = new Set([1004, 2049]);

/**
 * `GET https://www.minimax.io/v1/token_plan/remains` → `{ model_remains: [...], base_resp }`.
 *
 * TWO FIELDS SAY THE OPPOSITE OF THEIR NAME. `current_interval_usage_count` and
 * `current_weekly_usage_count` are what REMAINS, not what was used (MiniMax-AI/MiniMax-M2#99), so
 * used = total − usage_count. A reply that carries the `*_remaining_percent` fields is read from those
 * instead, and they are remaining too. A total of 0 is a plan with nothing provisioned, which says
 * nothing about use, so that window stays unknown.
 *
 * MiniMax answers a bad key with HTTP 200 and a `base_resp.status_code`, so that code is the refusal.
 */
export function parseMinimaxRemains(payload: unknown, nowMs: number): ProviderQuotaParse {
  const body = record(payload);
  const status = amountOf(record(body?.base_resp)?.status_code);
  if (status !== undefined && MINIMAX_AUTH_CODES.has(status)) return { kind: 'rejected' };
  if (status !== 0 || !Array.isArray(body?.model_remains)) return MALFORMED;
  const remains = body.model_remains.map(record).filter(entry => entry !== undefined);
  const entry = remains.find(candidate => candidate.model_name === 'general') ?? remains[0];
  if (entry === undefined) return MALFORMED;
  const window = (
    label: '5h' | 'week',
    names: { percent: string; total: string; remaining: string; end: string; left: string },
  ) => {
    const remainingPercent = share(entry[names.percent]);
    const total = nonNegative(entry[names.total]);
    const remaining = nonNegative(entry[names.remaining]);
    const counted = total !== undefined && total > 0 && remaining !== undefined;
    const used = counted ? Math.max(0, total - remaining) : undefined;
    const usedPercent = remainingPercent === undefined ? ratio(used, total) : 100 - remainingPercent;
    const left = nonNegative(entry[names.left]);
    const resetsAt = instantFromMs(entry[names.end]) ?? (left === undefined ? undefined : instantFromMs(nowMs + left));
    return windowOf(label, {
      ...(counted ? { unit: 'prompts' as const, used, limit: total } : {}),
      ...(usedPercent === undefined ? {} : { usedPercent: Math.min(100, usedPercent) }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    });
  };
  return quota([
    window('5h', {
      percent: 'current_interval_remaining_percent',
      total: 'current_interval_total_count',
      remaining: 'current_interval_usage_count',
      end: 'end_time',
      left: 'remains_time',
    }),
    window('week', {
      percent: 'current_weekly_remaining_percent',
      total: 'current_weekly_total_count',
      remaining: 'current_weekly_usage_count',
      end: 'weekly_end_time',
      left: 'weekly_remains_time',
    }),
  ]);
}

// ── DeepSeek ─────────────────────────────────────────────────────────────────────────────────────

/**
 * `GET https://api.deepseek.com/user/balance` → `{ is_available, balance_infos: [{ currency,
 * total_balance, … }] }`. The balance is in each currency the account was topped up in; US dollars are
 * shown when there are any, otherwise the first. `is_available: false` is an account that cannot pay.
 */
export function parseDeepseekBalance(payload: unknown): ProviderQuotaParse {
  const body = record(payload);
  if (!Array.isArray(body?.balance_infos)) return MALFORMED;
  const infos = body.balance_infos.map(record).filter(entry => entry !== undefined);
  const chosen = infos.find(info => info.currency === 'USD') ?? infos[0];
  const amount = amountOf(chosen?.total_balance);
  const currency = typeof chosen?.currency === 'string' ? chosen.currency.toUpperCase() : undefined;
  const balance =
    amount === undefined || currency === undefined || !/^[A-Z]{3}$/u.test(currency) ? undefined : { amount, currency };
  if (balance === undefined && typeof body.is_available !== 'boolean') return MALFORMED;
  return quota([], balance, body.is_available === false || (balance !== undefined && balance.amount <= 0));
}

// ── Kimi / Moonshot ──────────────────────────────────────────────────────────────────────────────

/**
 * `GET https://api.moonshot.ai/v1/users/me/balance` → `{ code: 0, data: { available_balance,
 * voucher_balance, cash_balance } }`. The international platform bills in US dollars and the
 * mainland one (`api.moonshot.cn`) in yuan, so the currency is the reader's to say.
 */
export function parseMoonshotBalance(payload: unknown, currency: 'USD' | 'CNY'): ProviderQuotaParse {
  const body = record(payload);
  const amount = amountOf(record(body?.data)?.available_balance);
  if (amount === undefined || (body?.code !== undefined && body.code !== 0)) return MALFORMED;
  return quota([], { amount, currency }, amount <= 0);
}

// ── OpenRouter ───────────────────────────────────────────────────────────────────────────────────

/**
 * `GET https://openrouter.ai/api/v1/key` → `{ data: { usage, limit, limit_remaining, usage_monthly, … } }`,
 * all in US dollars. A key with a spending limit is a `key` window and its remainder is the balance; a
 * key without one has no limit to be a share of, so only this month's spend is shown.
 */
export function parseOpenRouterKey(payload: unknown): ProviderQuotaParse {
  const data = record(record(payload)?.data);
  if (data === undefined) return MALFORMED;
  const used = nonNegative(data.usage);
  const limit = nonNegative(data.limit);
  const remaining = amountOf(data.limit_remaining);
  const monthly = nonNegative(data.usage_monthly);
  const windows: ProviderQuotaWindow[] = [];
  if (limit !== undefined) {
    const usedPercent = ratio(used, limit);
    windows.push(
      windowOf('key', {
        unit: 'usd',
        ...(used === undefined ? {} : { used }),
        limit,
        ...(usedPercent === undefined ? {} : { usedPercent: Math.min(100, usedPercent) }),
      }),
    );
  }
  if (monthly !== undefined) windows.push(windowOf('month', { unit: 'usd', used: monthly }));
  if (windows.length === 0 && remaining === undefined && used === undefined) return MALFORMED;
  const balance = remaining === undefined ? undefined : { amount: remaining, currency: 'USD' };
  return quota(windows, balance, remaining !== undefined && remaining <= 0);
}

// ── LiteLLM ──────────────────────────────────────────────────────────────────────────────────────

/**
 * `GET <proxy>/key/info` → `{ info: { spend, max_budget, budget_reset_at } }`: the key's own spend
 * against the budget its proxy admin set, in US dollars. No budget is no limit, so only the spend.
 */
export function parseLitellmKeyInfo(payload: unknown): ProviderQuotaParse {
  const info = record(record(payload)?.info);
  const used = nonNegative(info?.spend);
  if (info === undefined || used === undefined) return MALFORMED;
  const limit = nonNegative(info.max_budget);
  const usedPercent = ratio(used, limit);
  const resetsAt = instantFromText(info.budget_reset_at);
  const window = windowOf('key', {
    unit: 'usd',
    used,
    ...(limit === undefined ? {} : { limit }),
    ...(usedPercent === undefined ? {} : { usedPercent: Math.min(100, usedPercent) }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  });
  const balance = limit === undefined ? undefined : { amount: limit - used, currency: 'USD' };
  return quota([window], balance);
}

// ── Vercel AI Gateway ────────────────────────────────────────────────────────────────────────────

/** `GET https://ai-gateway.vercel.sh/v1/credits` → `{ balance, total_used }`, US dollars as strings. */
export function parseVercelCredits(payload: unknown): ProviderQuotaParse {
  const amount = amountOf(record(payload)?.balance);
  if (amount === undefined) return MALFORMED;
  return quota([], { amount, currency: 'USD' }, amount <= 0);
}
