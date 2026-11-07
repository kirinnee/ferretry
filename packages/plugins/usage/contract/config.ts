import { defineConfig, type Loosens } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { BUDGET_PERIODS, BudgetSchema, TimeZoneSchema } from './budget.ts';

/**
 * `config/usage.yaml` (§9.2): budgets per login, plus the two machine facts the feed and the days of a budget need.
 *
 * - `budgets`: a daily and/or weekly cap in US dollars per login id. Past a trigger nothing new starts on the login;
 *   past the hard limit its ferrets are stopped too (docs/budgets.md).
 * - `timeZone`: the zone a day and a week are counted in (absent: the host's own).
 * - `publicFeed`: whether `GET /usage` and `GET /metrics` answer a caller with no credential (off by default).
 */
export const UsageFileSchema = z.strictObject({
  budgets: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/u), BudgetSchema).optional(),
  timeZone: TimeZoneSchema.optional(),
  publicFeed: z.boolean().optional(),
});
export type UsageFile = z.infer<typeof UsageFileSchema>;

const raised = (before: number, after: number, what: string): readonly string[] =>
  after > before ? [`${what} goes up from ${String(before)} to ${String(after)}`] : [];

/**
 * A budget loosens when a limit goes up or goes away (a period dropped, a login's budget removed), and the public feed
 * loosens when it is switched on. Adding or lowering a limit tightens. Today's `loginLoosening`, word for word, over the
 * per-login map.
 */
export const usageLoosens: Loosens<UsageFile> = (before, after) => {
  // A first file is compared against the defaults a missing file means: no budgets and a private feed. Only the budgets
  // are empty then (nothing to remove); the feed is not, so a first file that turns it on is a loosening.
  const sentences: string[] = [];
  for (const [id, was] of Object.entries(before?.budgets ?? {})) {
    const now = after?.budgets?.[id];
    for (const period of BUDGET_PERIODS)
      for (const level of ['trigger', 'hard'] as const) {
        const had = was[period]?.[level];
        if (had === undefined) continue;
        const what = `login "${id}"'s ${period} ${level === 'hard' ? 'hard limit' : 'trigger'} in dollars`;
        const has = now?.[period]?.[level];
        if (has === undefined) sentences.push(`${what} is removed (was ${String(had)})`);
        else sentences.push(...raised(had, has, what));
      }
  }
  if (before?.publicFeed !== true && after?.publicFeed === true)
    sentences.push('the usage feed is served to callers with no credential');
  return sentences;
};

export const USAGE_CONFIG = defineConfig({
  file: 'usage.yaml',
  schema: UsageFileSchema,
  axis: 'configure',
  loosens: usageLoosens,
});
