/**
 * THE ANALYTICS OVERVIEW, as pure data: what a period cost, where it went, and which sessions spent it.
 *
 * Every figure is computed in the browser from per-session rows the daemon already serves, because the
 * daemon's aggregates answer a different question. A `sum` over a group whose sessions are not all
 * priced comes back as `null` — correct for a ledger, and exactly why the old page's headline read "Cost
 * unknown" while $600 of it was known. Summing the KNOWN rows and counting the unpriced ones beside the
 * total keeps a partial number a number, with its gap said out loud as a count.
 *
 * Two rules the whole module keeps:
 *
 * - A DAY WITH NO SESSIONS IS A KNOWN ZERO. The window is enumerated first and rows are poured into it,
 *   so an empty day exists as a bucket with zero sessions rather than as a gap a chart flags.
 * - UNPRICED IS NEVER ZERO. A row whose cost is `null` adds nothing to a dollar figure and one to the
 *   unpriced count, so the reader always sees how much of the period the dollar figure covers.
 */

import type { AnalyticsRawSession } from '@ferretry/protocol';

/** The windows a reader can pick, in days ending today (UTC). */
export const ANALYTICS_RANGES = [7, 14, 30] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];
export const DEFAULT_ANALYTICS_RANGE: AnalyticsRange = 14;

const DAY_MS = 86_400_000;

/** The UTC calendar day of an instant, in the daemon's `day` label spelling. */
export const utcDay = (instant: Date): string => instant.toISOString().slice(0, 10);

/** Every UTC day in the window, oldest first, ending with the day `now` falls on. */
export const analyticsRangeDays = (range: number, now: Date): readonly string[] => {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: range }, (_, index) => utcDay(new Date(today - (range - 1 - index) * DAY_MS)));
};

/**
 * One glob per calendar month the window touches. The query language has no date range, but a glob on
 * the `day` label narrows a read to one month, which is what keeps a long history out of every request.
 */
export const analyticsMonthGlobs = (days: readonly string[]): readonly string[] => [
  ...new Set(days.map(day => `${day.slice(0, 7)}-*`)),
];

/** Days that were read in full from the daemon, or only partly because one day held too many rows. */
export interface AnalyticsPartialDay {
  readonly day: string;
  /** How many sessions the daemon counted that day, listed or not. */
  readonly sessions: number;
  /** How many of them it could not price. */
  readonly unpriced: number;
}

export interface AnalyticsDayBucket {
  readonly day: string;
  readonly sessions: number;
  /** Known equivalent cost in micro-dollars: priced rows only. */
  readonly costMicros: number;
  readonly unpriced: number;
  /** The day held more sessions than one read returns; its cost covers the listed ones only. */
  readonly partial: boolean;
}

export interface AnalyticsModelShare {
  readonly model: string;
  readonly costMicros: number;
  readonly sessions: number;
}

/** One session tree: the session somebody started, plus every child it spawned in the window. */
export interface AnalyticsTopSession {
  readonly id: string;
  readonly agent: string | null;
  readonly label: string | null;
  readonly project: string | null;
  readonly model: string | null;
  readonly costMicros: number;
  readonly unpriced: number;
  readonly children: number;
}

export interface AnalyticsOverview {
  readonly days: readonly AnalyticsDayBucket[];
  readonly sessions: number;
  readonly costMicros: number;
  readonly unpriced: number;
  readonly pricedSessions: number;
  readonly tokens: number;
  /** Sessions whose token evidence could not be read. */
  readonly tokensUnknown: number;
  /** Cache reads as a share of input tokens, 0-100, or null when no input was counted. */
  readonly cacheReadPercent: number | null;
  /** Average equivalent cost per PRICED session, or null when none was priced. */
  readonly averageMicros: number | null;
  readonly busiest: AnalyticsDayBucket | null;
  readonly models: readonly AnalyticsModelShare[];
  readonly topSessions: readonly AnalyticsTopSession[];
  readonly partialDays: number;
}

const knownCost = (row: AnalyticsRawSession): number | null => row.equivalentApiCostUsdMicros;

/** The last path segment of a working directory: the project a person would name. */
export const projectName = (cwd: string | null): string | null => {
  if (cwd === null) return null;
  const segments = cwd.split(/[\\/]/u).filter(segment => segment !== '');
  return segments.at(-1) ?? null;
};

/** Priced cost per model, most expensive first. Unpriced rows are counted by the caller, not here. */
export const analyticsModelShares = (rows: readonly AnalyticsRawSession[]): readonly AnalyticsModelShare[] => {
  const shares = new Map<string, { costMicros: number; sessions: number }>();
  for (const row of rows) {
    const cost = knownCost(row);
    if (cost === null) continue;
    const model = row.model ?? 'unknown model';
    const share = shares.get(model) ?? { costMicros: 0, sessions: 0 };
    shares.set(model, { costMicros: share.costMicros + cost, sessions: share.sessions + 1 });
  }
  return [...shares.entries()]
    .map(([model, share]) => ({ model, ...share }))
    .sort((left, right) => right.costMicros - left.costMicros || left.model.localeCompare(right.model));
};

/** Rows grouped into session trees, most expensive tree first. */
export const analyticsTopSessions = (rows: readonly AnalyticsRawSession[]): readonly AnalyticsTopSession[] => {
  const trees = new Map<string, AnalyticsRawSession[]>();
  for (const row of rows) {
    const key = row.tree ?? row.id;
    trees.set(key, [...(trees.get(key) ?? []), row]);
  }
  return [...trees.entries()]
    .map(([id, members]): AnalyticsTopSession => {
      const root = members.find(member => member.id === id) ?? members[0]!;
      return {
        id,
        agent: root.agent,
        label: root.label,
        project: projectName(root.cwd),
        model: root.model,
        costMicros: members.reduce((sum, member) => sum + (knownCost(member) ?? 0), 0),
        unpriced: members.filter(member => knownCost(member) === null).length,
        children: members.filter(member => member.id !== id).length,
      };
    })
    .sort((left, right) => right.costMicros - left.costMicros || left.id.localeCompare(right.id));
};

const sumKnown = (rows: readonly AnalyticsRawSession[], pick: (row: AnalyticsRawSession) => number | null): number =>
  rows.reduce((sum, row) => sum + (pick(row) ?? 0), 0);

/**
 * Folds the window's rows into the overview. `rows` outside `days` are ignored, so a month-wide read can
 * be passed as it came back; `partial` overrides the session and unpriced counts of a day that could not
 * be listed in full, because the daemon's count for that day is the authority the list is not.
 */
export const analyticsOverview = (
  days: readonly string[],
  rows: readonly AnalyticsRawSession[],
  partial: readonly AnalyticsPartialDay[] = [],
): AnalyticsOverview => {
  const window = new Set(days);
  const unique = new Map<string, AnalyticsRawSession>();
  for (const row of rows) if (row.day !== null && window.has(row.day)) unique.set(row.id, row);
  const inWindow = [...unique.values()];
  const partialByDay = new Map(partial.map(day => [day.day, day]));

  const buckets = days.map((day): AnalyticsDayBucket => {
    const listed = inWindow.filter(row => row.day === day);
    const counted = partialByDay.get(day);
    return {
      day,
      sessions: counted?.sessions ?? listed.length,
      costMicros: sumKnown(listed, knownCost),
      unpriced: counted?.unpriced ?? listed.filter(row => knownCost(row) === null).length,
      partial: counted !== undefined,
    };
  });

  const priced = inWindow.filter(row => knownCost(row) !== null);
  const costMicros = buckets.reduce((sum, bucket) => sum + bucket.costMicros, 0);
  const withInput = inWindow.filter(row => row.inputTokens !== null && row.cachedInputTokens !== null);
  const inputTokens = sumKnown(withInput, row => row.inputTokens);
  const busiest = buckets.reduce<AnalyticsDayBucket | null>(
    (best, bucket) => (bucket.sessions > 0 && (best === null || bucket.sessions > best.sessions) ? bucket : best),
    null,
  );

  return {
    days: buckets,
    sessions: buckets.reduce((sum, bucket) => sum + bucket.sessions, 0),
    costMicros,
    unpriced: buckets.reduce((sum, bucket) => sum + bucket.unpriced, 0),
    pricedSessions: priced.length,
    tokens: sumKnown(inWindow, row => row.tokens),
    tokensUnknown: inWindow.filter(row => row.tokens === null).length,
    cacheReadPercent: inputTokens > 0 ? (100 * sumKnown(withInput, row => row.cachedInputTokens)) / inputTokens : null,
    averageMicros: priced.length > 0 ? sumKnown(priced, knownCost) / priced.length : null,
    busiest,
    models: analyticsModelShares(inWindow),
    topSessions: analyticsTopSessions(inWindow),
    partialDays: buckets.filter(bucket => bucket.partial).length,
  };
};

/**
 * Round y-axis ticks from zero up to at least `max`: a 1, 2, 2.5 or 5 step so every label is a number a
 * person would write, and never fewer than two ticks so an all-zero window still draws an axis.
 */
export const analyticsAxisTicks = (max: number, count = 4): readonly number[] => {
  if (!(max > 0)) return [0, 1];
  const rough = max / (count - 1);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map(factor => factor * magnitude).find(candidate => candidate >= rough)!;
  const top = Math.ceil(max / step);
  return Array.from({ length: top + 1 }, (_, index) => Number((index * step).toPrecision(12)));
};

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const USD_WHOLE = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** Dollars to the cent; a positive amount below a cent says so instead of rounding to $0.00. */
export const formatUsd = (micros: number): string =>
  micros > 0 && micros < 5_000 ? '<$0.01' : USD.format(micros / 1_000_000);

/** An axis label: whole dollars when the step allows it. */
export const formatAxisUsd = (dollars: number): string =>
  Number.isInteger(dollars) ? USD_WHOLE.format(dollars) : USD.format(dollars);

/** 144M, 10.8M, 950K — the size of a token count rather than its digits. */
export const formatTokens = (tokens: number): string => COMPACT.format(tokens);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** `2026-10-13` as "13 Oct", the way the axis and the readout name a day. */
export const formatDay = (day: string): string => {
  const [, month, date] = day.split('-');
  return `${Number(date)} ${MONTHS[Number(month) - 1] ?? month}`;
};
