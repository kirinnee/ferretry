/**
 * Usage: v4's budget memory and rate catalog → `state/usage/` (`packages/plugins/usage/contract/state.ts`).
 *
 * - `state/budget-holds.json` → `pauses.json` `{pauses}`: the same five fields per login (v5's `PauseSchema` is v4's
 *   hold, made strict and `resetsAtMs ≥ 0`). A garbled v4 file is carried as no pauses, exactly as v4 read it; a
 *   single hold v5 refuses is dropped and counted (v5's minute tick measures every login again, so a pause that is
 *   still due comes back on its own).
 * - `state/budget-told.json` → `pause-told.json` `{told}`: the keys are the same `<login>|<period>|<ISO start>`
 *   spelling in both (`toldKey`, v4 `lib/budget/service.ts:110`, v5 `daemon/lib/budget/service.ts:115`).
 * - `config/daemon.json` `analyticsPricing` + `analyticsPricingSources` → `pricing.json` `{catalog, sources}`. Rows
 *   in v4's older rate spelling are converted with v4's own transform (`src/v4/usage.ts`); the result must pass v5's
 *   `PricingFileSchema` or the step fails naming the row, because a booted v4 held only a catalog it accepted.
 *
 * Every v5 schema here describes the body without `format`; `V5Writer.stamped` writes `"format": 1` first, as the
 * kernel does. Nothing here holds a runtime uuid, so M7 has nothing to re-key (the analytics index is a cache).
 */
import {
  PAUSE_TOLD_STATE,
  PAUSES_STATE,
  PauseSchema,
  PausesFileSchema,
  PauseToldFileSchema,
  PRICING_STATE,
  PricingFileSchema,
} from '@ferretry/plugin-usage/contract';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { KeptItem, StepReport } from '../report.ts';
import { failureNote, readV4Json, V4InputError } from '../v4/documents.ts';
import { V4_CREDENTIALS, V4_PASSIVE_USAGE } from '../v4/logins.ts';
import {
  canonicalRateRow,
  V4_ANALYTICS_INDEX,
  V4_BUDGET_HOLDS,
  V4_BUDGET_TOLD,
  V4_DAEMON_CONFIG,
  V4BudgetHolds,
  V4BudgetTold,
  V4PricingKeys,
} from '../v4/usage.ts';
import type { Step } from './index.ts';

const V5_DIR = 'state/usage';
export const V5_USAGE_PAUSES = join(V5_DIR, PAUSES_STATE.path);
export const V5_USAGE_PAUSE_TOLD = join(V5_DIR, PAUSE_TOLD_STATE.path);
export const V5_USAGE_PRICING = join(V5_DIR, PRICING_STATE.path);

/** A v4 document v4 itself read as empty when garbled: `undefined` for absent, `'damaged'` for anything unreadable. */
async function lenient(home: string, path: string): Promise<unknown> {
  try {
    return await readV4Json(home, join(home, path));
  } catch {
    return 'damaged' as const;
  }
}

/** How many logins hold a passive reading. `lstat` only: the file sits in a sign-in folder and is never opened. */
async function passiveReadings(home: string): Promise<number> {
  const root = join(home, V4_CREDENTIALS);
  const facts = await lstat(root).catch(() => undefined);
  if (facts === undefined || !facts.isDirectory()) return 0;
  let count = 0;
  for (const login of await readdir(root)) {
    const reading = await lstat(join(root, login, V4_PASSIVE_USAGE)).catch(() => undefined);
    if (reading?.isFile() === true) count++;
  }
  return count;
}

export const usageStep: Step = {
  id: 'usage',
  title: 'Usage history and budgets (pauses, told notices, rate catalog)',
  owner: ['plugin-usage'],
  reads: [
    V4_BUDGET_HOLDS,
    V4_BUDGET_TOLD,
    `${V4_DAEMON_CONFIG} (analyticsPricing, analyticsPricingSources)`,
    `${V4_CREDENTIALS}/<login>/${V4_PASSIVE_USAGE} (lstat only, never opened)`,
  ],
  sealed: [],
  notCarried: [
    {
      what: `${V4_ANALYTICS_INDEX} (the insights index, rows keyed by runtime uuid)`,
      why: 'a cache: v5 declares analytics.sqlite as sqlite-cache and rebuilds it from the ferrets’ own records (runtime names, M7)',
    },
    {
      what: `${V4_CREDENTIALS}/<login>/${V4_PASSIVE_USAGE} (the last passive 5h/weekly reading per login)`,
      why: 'v5 declares no file for a passive reading: quotas/<login>.json holds a provider endpoint or transcript reading (ProviderQuotaReadingSchema has no claude-statusline or codex-rollout source). The next Claude turn or Codex rollout scan reads it again',
    },
    {
      what: 'a budget hold v5’s PauseSchema refuses (e.g. a negative resetsAtMs)',
      why: 'dropped and counted; v5 measures every login again on its first tick, so a pause still due returns by itself',
    },
    {
      what: 'a garbled budget-holds.json or budget-told.json',
      why: 'v4 read it as none (readBudgetHoldsSync, FileBudgetTold.read), so none is carried; counted, never quoted',
    },
    {
      what: `${V4_DAEMON_CONFIG} usage (feed URL) and the budget blocks of config/machine.yaml and config/logins/<id>.yaml`,
      why: 'configuration, not state: the Layouts and settings step splits them into config/usage.yaml',
    },
  ],
  async run(ctx): Promise<StepReport> {
    const base = { id: this.id, title: this.title, notCarried: this.notCarried, sealed: [] };
    const home = ctx.v4.home;
    try {
      const notes: string[] = ctx.dryRun ? ['dry run: nothing written'] : [];
      const kept: KeptItem[] = [];

      const holds = await lenient(home, V4_BUDGET_HOLDS);
      if (holds !== undefined) {
        const v4 = V4BudgetHolds.safeParse(holds);
        const pauses: Record<string, unknown> = {};
        let refused = 0;
        if (v4.success)
          for (const [login, hold] of Object.entries(v4.data).sort(([a], [b]) => a.localeCompare(b))) {
            const pause = PauseSchema.safeParse(hold);
            if (pause.success) pauses[login] = pause.data;
            else refused++;
          }
        else notes.push(`${V4_BUDGET_HOLDS} is garbled: v4 read it as no holds, so none is carried`);
        if (refused > 0) notes.push(`${String(refused)} budget hold(s) v5 refuses dropped (v5 measures again)`);
        await ctx.v5.stamped(
          { path: V5_USAGE_PAUSES, format: PAUSES_STATE.format, schema: PausesFileSchema },
          { pauses },
        );
        kept.push({ what: 'budget pauses', count: Object.keys(pauses).length });
      }

      const told = await lenient(home, V4_BUDGET_TOLD);
      if (told !== undefined) {
        const v4 = V4BudgetTold.safeParse(told);
        if (!v4.success) notes.push(`${V4_BUDGET_TOLD} is garbled: v4 read it as nothing told, so none is carried`);
        const keys = v4.success ? v4.data : [];
        await ctx.v5.stamped(
          { path: V5_USAGE_PAUSE_TOLD, format: PAUSE_TOLD_STATE.format, schema: PauseToldFileSchema },
          { told: keys },
        );
        kept.push({ what: 'budget notices already told', count: keys.length });
      }

      // daemon.json is the daemon's own document: a booted v4 refused a damaged one, so damage here is a failure.
      const config = await readV4Json(home, join(home, V4_DAEMON_CONFIG));
      if (config !== undefined) {
        const keys = V4PricingKeys.safeParse(config);
        if (!keys.success)
          throw new V4InputError(`${V4_DAEMON_CONFIG}: is not a JSON object with list-valued pricing keys`);
        const catalog = keys.data.analyticsPricing.map(canonicalRateRow);
        const unreadable = catalog.findIndex(row => row === undefined);
        if (unreadable !== -1)
          throw new V4InputError(
            `${V4_DAEMON_CONFIG}: analyticsPricing entry ${String(unreadable)} is not a v4 pricing row`,
          );
        const document = PricingFileSchema.safeParse({ catalog, sources: keys.data.analyticsPricingSources });
        if (!document.success) {
          const where = document.error.issues[0]?.path.slice(0, 2).join(' entry ') ?? '';
          throw new V4InputError(`${V4_DAEMON_CONFIG}: pricing ${where} does not fit the v5 rate catalog`);
        }
        if (keys.data.analyticsPricing.length > 0 || keys.data.analyticsPricingSources.length > 0) {
          await ctx.v5.stamped(
            { path: V5_USAGE_PRICING, format: PRICING_STATE.format, schema: PricingFileSchema },
            document.data,
          );
        }
        kept.push(
          { what: 'priced model rates', count: document.data.catalog.length },
          { what: 'pricing feeds', count: document.data.sources.length },
        );
      }

      const passive = await passiveReadings(home);
      if (passive > 0)
        notes.push(`${String(passive)} passive usage reading(s) not carried (read again on the next turn)`);
      return { ...base, status: 'converted', ...(notes.length > 0 ? { note: notes.join('; ') } : {}), kept };
    } catch (error) {
      return { ...base, status: 'failed', note: failureNote(error, 'cannot convert the usage files'), kept: [] };
    }
  },
};
