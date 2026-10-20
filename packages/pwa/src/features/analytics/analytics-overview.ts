/**
 * THE ANALYTICS OVERVIEW, as pure data: what a period cost, how many tokens, turns and hours it took,
 * where they went and which sessions took them — across every machine that answered.
 *
 * Every figure is computed in the browser from per-session rows the daemons already serve, because a
 * daemon's aggregates answer a different question. A `sum` over a group whose sessions are not all
 * priced comes back as `null` — correct for a ledger, and exactly why an old headline read "Cost
 * unknown" while $600 of it was known. Summing the KNOWN values and counting the unknown ones beside
 * the total keeps a partial number a number, with its gap said out loud as a count.
 *
 * Three rules the whole module keeps:
 *
 * - A DAY WITH NO SESSIONS IS A KNOWN ZERO. The window is enumerated first and rows are poured into it,
 *   so an empty day exists as a bucket with zero sessions rather than as a gap a chart flags.
 * - UNKNOWN IS NEVER ZERO. A row whose cost (or tokens, or duration) is `null` adds nothing to that
 *   figure and one to its unknown count, so the reader always sees how much of the period it covers.
 * - A SESSION IS A MACHINE'S SESSION. Rows are keyed by the machine they came from as well as their id,
 *   so two machines can never merge two sessions, and every session links back to its own machine.
 */

import type { AnalyticsRawSession } from '@ferretry/protocol';

/** The windows a reader can pick, in days ending today (UTC). */
export const ANALYTICS_RANGES = [7, 14, 30] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];
export const DEFAULT_ANALYTICS_RANGE: AnalyticsRange = 14;

/** How the period is bucketed on the chart. */
export const ANALYTICS_BUCKETINGS = ['day', 'week'] as const;
export type AnalyticsBucketing = (typeof ANALYTICS_BUCKETINGS)[number];

/** What the chart and the splits measure. */
export const OVERVIEW_METRICS = ['cost', 'tokens', 'turns', 'active'] as const;
export type OverviewMetric = (typeof OVERVIEW_METRICS)[number];

/** What the top-sessions list ranks by. */
export const TOP_SESSION_ORDERS = ['tokens', 'duration', 'cost'] as const;
export type TopSessionOrder = (typeof TOP_SESSION_ORDERS)[number];

/** The groupings the overview splits a period by. */
export const OVERVIEW_SPLITS = ['model', 'runtime', 'machine', 'project'] as const;
export type OverviewSplit = (typeof OVERVIEW_SPLITS)[number];

const DAY_MS = 86_400_000;

/** The UTC calendar day of an instant, in the daemon's `day` label spelling. */
export const utcDay = (instant: Date): string => instant.toISOString().slice(0, 10);

/** Every UTC day in the window, oldest first, ending with the day `now` falls on. */
export const analyticsRangeDays = (range: number, now: Date): readonly string[] => {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: range }, (_, index) => utcDay(new Date(today - (range - 1 - index) * DAY_MS)));
};

/** The Monday that starts the ISO week a UTC day falls in, as a day. */
export const weekStart = (day: string): string => {
  const instant = new Date(`${day}T00:00:00Z`);
  const offset = (instant.getUTCDay() + 6) % 7;
  return utcDay(new Date(instant.getTime() - offset * DAY_MS));
};

/**
 * One glob per calendar month the window touches. A glob on the `day` label narrows a read to one
 * month, which is what keeps a long history out of every request.
 */
export const analyticsMonthGlobs = (days: readonly string[]): readonly string[] => [
  ...new Set(days.map(day => `${day.slice(0, 7)}-*`)),
];

/** A day that was read only in part because it held too many rows for one read. */
export interface AnalyticsPartialDay {
  readonly day: string;
  /** Which machine's read was partial. */
  readonly daemonId?: string;
  /** How many sessions the daemon counted that day, listed or not. */
  readonly sessions: number;
  /** How many of them it could not price. */
  readonly unpriced: number;
}

/** The machine a row came from: its pairing id, and the name the app shows for it. */
export interface OverviewMachine {
  readonly daemonId: string;
  readonly name: string;
}

/** Token counts by kind. The four kinds add up to the session's total. */
export interface TokenKinds {
  /** Input that was neither read from nor written to the cache. */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export const TOKEN_KINDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];
export const TOKEN_KIND_LABELS: Readonly<Record<TokenKind, string>> = {
  input: 'Input',
  output: 'Output',
  cacheRead: 'Cache read',
  cacheWrite: 'Cache write',
};

/** One session, as the overview reads it. */
export interface OverviewRow {
  readonly id: string;
  readonly daemonId: string;
  readonly machine: string;
  readonly label: string | null;
  readonly runtime: string | null;
  readonly model: string | null;
  readonly project: string | null;
  readonly parent: string | null;
  readonly tree: string;
  readonly day: string | null;
  readonly costMicros: number | null;
  readonly tokens: TokenKinds | null;
  readonly turns: number | null;
  readonly activeMs: number | null;
  readonly wallMs: number | null;
}

/** The last path segment of a working directory: the project a person would name. */
export const projectName = (cwd: string | null): string | null => {
  if (cwd === null) return null;
  const segments = cwd.split(/[\\/]/u).filter(segment => segment !== '');
  return segments.at(-1) ?? null;
};

const tokenKinds = (row: AnalyticsRawSession): TokenKinds | null => {
  const { inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens } = row;
  if (inputTokens === null || outputTokens === null || cachedInputTokens === null || cacheWriteInputTokens === null)
    return null;
  return {
    input: Math.max(0, inputTokens - cachedInputTokens - cacheWriteInputTokens),
    output: outputTokens,
    cacheRead: cachedInputTokens,
    cacheWrite: cacheWriteInputTokens,
  };
};

/**
 * Reads one daemon row as the overview's row, tagged with the machine it came from.
 *
 * The machine is named as the app names it everywhere else — the sessions bar's distinct name — rather
 * than by the daemon's own `machine` stamp: two machines with one hostname would otherwise merge into
 * one row of "By machine", and an older daemon stamps nothing at all.
 */
export const overviewRow = (row: AnalyticsRawSession, machine: OverviewMachine): OverviewRow => ({
  id: row.id,
  daemonId: machine.daemonId,
  machine: machine.name,
  label: row.label,
  runtime: row.agent,
  model: row.model,
  project: projectName(row.cwd),
  parent: row.parent,
  tree: row.tree ?? row.id,
  day: row.day,
  costMicros: row.equivalentApiCostUsdMicros,
  tokens: tokenKinds(row),
  turns: row.turns,
  activeMs: row.activeDurationMs,
  wallMs: row.durationMs,
});

/** Every figure for a set of sessions, each with the count of sessions it could not include. */
export interface OverviewTotals {
  readonly sessions: number;
  readonly costMicros: number;
  readonly unpriced: number;
  readonly tokens: TokenKinds;
  readonly tokensUnknown: number;
  readonly turns: number;
  readonly turnsUnknown: number;
  readonly activeMs: number;
  readonly activeUnknown: number;
  /** Turns of the sessions whose active time is known: the denominator of time per turn. */
  readonly activeTurns: number;
  readonly wallMs: number;
  readonly wallUnknown: number;
}

/** Groups in first-seen order. (`Map.groupBy` is missing from Safari before 17.4.) */
const groupBy = <T, K>(items: Iterable<T>, key: (item: T) => K): Map<K, T[]> => {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group === undefined) groups.set(key(item), [item]);
    else group.push(item);
  }
  return groups;
};

const ZERO_TOKENS: TokenKinds = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const tokenTotal = (tokens: TokenKinds): number =>
  tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;

export const overviewTotals = (rows: readonly OverviewRow[]): OverviewTotals => {
  let costMicros = 0;
  let unpriced = 0;
  let tokens = ZERO_TOKENS;
  let tokensUnknown = 0;
  let turns = 0;
  let turnsUnknown = 0;
  let activeMs = 0;
  let activeUnknown = 0;
  let activeTurns = 0;
  let wallMs = 0;
  let wallUnknown = 0;
  for (const row of rows) {
    if (row.costMicros === null) unpriced += 1;
    else costMicros += row.costMicros;
    if (row.tokens === null) tokensUnknown += 1;
    else
      tokens = {
        input: tokens.input + row.tokens.input,
        output: tokens.output + row.tokens.output,
        cacheRead: tokens.cacheRead + row.tokens.cacheRead,
        cacheWrite: tokens.cacheWrite + row.tokens.cacheWrite,
      };
    if (row.turns === null) turnsUnknown += 1;
    else turns += row.turns;
    if (row.activeMs === null) activeUnknown += 1;
    else {
      activeMs += row.activeMs;
      activeTurns += row.turns ?? 0;
    }
    if (row.wallMs === null) wallUnknown += 1;
    else wallMs += row.wallMs;
  }
  return {
    sessions: rows.length,
    costMicros,
    unpriced,
    tokens,
    tokensUnknown,
    turns,
    turnsUnknown,
    activeMs,
    activeUnknown,
    activeTurns,
    wallMs,
    wallUnknown,
  };
};

/** One figure of a set of sessions, in display units, and how many sessions it leaves out. */
export interface MetricReading {
  readonly value: number;
  readonly unknown: number;
}

/** The chosen metric of a set of totals: dollars, tokens, turns or seconds. */
export const metricReading = (totals: OverviewTotals, metric: OverviewMetric): MetricReading => {
  switch (metric) {
    case 'cost':
      return { value: totals.costMicros / 1_000_000, unknown: totals.unpriced };
    case 'tokens':
      return { value: tokenTotal(totals.tokens), unknown: totals.tokensUnknown };
    case 'turns':
      return { value: totals.turns, unknown: totals.turnsUnknown };
    case 'active':
      return { value: totals.activeMs / 1000, unknown: totals.activeUnknown };
  }
};

export interface OverviewBucket {
  /** The day, or the Monday that starts the week. */
  readonly key: string;
  readonly totals: OverviewTotals;
  /** Some machine could list this bucket only in part, so its figures are a lower bound. */
  readonly partial: boolean;
  /** The daemon's own session count where a read was partial, which the listed rows fall short of. */
  readonly countedSessions: number;
}

/** A group of a split: one model, runtime, machine or project. */
export interface OverviewGroup {
  readonly key: string;
  readonly totals: OverviewTotals;
}

/** One session tree on one machine: the session somebody started, and every child it spawned. */
export interface OverviewTopSession {
  readonly id: string;
  readonly daemonId: string;
  readonly machine: string;
  readonly label: string | null;
  readonly runtime: string | null;
  readonly project: string | null;
  readonly model: string | null;
  readonly children: number;
  readonly totals: OverviewTotals;
}

export interface AnalyticsOverview {
  readonly days: readonly OverviewBucket[];
  readonly totals: OverviewTotals;
  /** Days some machine listed in part. */
  readonly partialDays: number;
  readonly rows: readonly OverviewRow[];
  readonly topSessions: readonly OverviewTopSession[];
}

/**
 * Folds the window's rows into the overview. Rows outside `days` are ignored, so a month-wide read can
 * be passed as it came back; a `partial` day's session count is the daemon's, because its count for
 * that day is the authority the list is not.
 */
export const analyticsOverview = (
  days: readonly string[],
  rows: readonly OverviewRow[],
  partial: readonly AnalyticsPartialDay[] = [],
): AnalyticsOverview => {
  const window = new Set(days);
  const unique = new Map<string, OverviewRow>();
  for (const row of rows) if (row.day !== null && window.has(row.day)) unique.set(`${row.daemonId}\n${row.id}`, row);
  const inWindow = [...unique.values()];
  const byDay = groupBy(inWindow, row => row.day!);

  const buckets = days.map((day): OverviewBucket => {
    const listed = byDay.get(day) ?? [];
    const counted = partial.filter(entry => entry.day === day);
    // Each partial machine's own count stands in for the rows it could not list.
    const short = counted.reduce(
      (sum, entry) =>
        sum +
        Math.max(
          0,
          entry.sessions -
            listed.filter(row => entry.daemonId === undefined || row.daemonId === entry.daemonId).length,
        ),
      0,
    );
    return {
      key: day,
      totals: overviewTotals(listed),
      partial: counted.length > 0,
      countedSessions: listed.length + short,
    };
  });

  return {
    days: buckets,
    totals: overviewTotals(inWindow),
    partialDays: buckets.filter(bucket => bucket.partial).length,
    rows: inWindow,
    topSessions: overviewTopSessions(inWindow),
  };
};

/** Days folded into ISO weeks (Monday first), oldest first; a week the window cuts keeps only its days. */
export const overviewWeeks = (days: readonly OverviewBucket[], rows: readonly OverviewRow[]): readonly OverviewBucket[] => {
  const weeks = groupBy(days, bucket => weekStart(bucket.key));
  const rowsByWeek = groupBy(rows, row => weekStart(row.day!));
  return [...weeks.entries()].map(([key, members]) => ({
    key,
    totals: overviewTotals(rowsByWeek.get(key) ?? []),
    partial: members.some(member => member.partial),
    countedSessions: members.reduce((sum, member) => sum + member.countedSessions, 0),
  }));
};

const SPLIT_KEY: Readonly<Record<OverviewSplit, (row: OverviewRow) => string | null>> = {
  model: row => row.model,
  runtime: row => row.runtime,
  machine: row => row.machine,
  project: row => row.project,
};

const UNKNOWN_GROUP: Readonly<Record<OverviewSplit, string>> = {
  model: 'unknown model',
  runtime: 'unknown runtime',
  machine: 'unknown machine',
  project: 'no project',
};

/** The rows grouped by one label, largest first by `metric`; a fully unknown group sorts last. */
export const overviewGroups = (
  rows: readonly OverviewRow[],
  split: OverviewSplit,
  metric: OverviewMetric,
): readonly OverviewGroup[] =>
  [...groupBy(rows, row => SPLIT_KEY[split](row) ?? UNKNOWN_GROUP[split]).entries()]
    .map(([key, members]) => ({ key, totals: overviewTotals(members) }))
    .sort((left, right) => {
      const a = metricReading(left.totals, metric);
      const b = metricReading(right.totals, metric);
      return b.value - a.value || a.unknown - b.unknown || left.key.localeCompare(right.key);
    });

/** Rows grouped into session trees per machine. */
export const overviewTopSessions = (rows: readonly OverviewRow[]): readonly OverviewTopSession[] =>
  [...groupBy(rows, row => `${row.daemonId}\n${row.tree}`).values()].map(members => {
    const first = members[0]!;
    const root = members.find(member => member.id === first.tree) ?? first;
    return {
      id: first.tree,
      daemonId: root.daemonId,
      machine: root.machine,
      label: root.label,
      runtime: root.runtime,
      project: root.project,
      model: root.model,
      children: members.filter(member => member.id !== first.tree).length,
      totals: overviewTotals(members),
    };
  });

/**
 * The value a top session is ranked and shown by, or `null` when none of its sessions has one — such a
 * session is listed after every known one, never as a zero.
 */
export const topSessionValue = (session: OverviewTopSession, order: TopSessionOrder): number | null => {
  const { totals } = session;
  switch (order) {
    case 'tokens':
      return totals.tokensUnknown === totals.sessions ? null : tokenTotal(totals.tokens);
    case 'duration':
      return totals.activeUnknown === totals.sessions ? null : totals.activeMs / 1000;
    case 'cost':
      return totals.unpriced === totals.sessions ? null : totals.costMicros / 1_000_000;
  }
};

/** Session trees by `order`, largest first, unknown last. */
export const rankTopSessions = (
  sessions: readonly OverviewTopSession[],
  order: TopSessionOrder,
): readonly OverviewTopSession[] =>
  [...sessions].sort((left, right) => {
    const a = topSessionValue(left, order);
    const b = topSessionValue(right, order);
    if (a === null || b === null) return a === b ? left.id.localeCompare(right.id) : a === null ? 1 : -1;
    return b - a || left.id.localeCompare(right.id);
  });

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
const COUNT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Dollars to the cent; a positive amount below a cent says so instead of rounding to $0.00. */
export const formatUsd = (micros: number): string =>
  micros > 0 && micros < 5_000 ? '<$0.01' : USD.format(micros / 1_000_000);

/** Dollars (not micros) to the cent, for a chart value. */
export const formatDollars = (dollars: number): string => formatUsd(Math.round(dollars * 1_000_000));

/** An axis label: whole dollars when the step allows it. */
export const formatAxisUsd = (dollars: number): string =>
  Number.isInteger(dollars) ? USD_WHOLE.format(dollars) : USD.format(dollars);

/** 144M, 10.8M, 950K — the size of a token count rather than its digits. */
export const formatTokens = (tokens: number): string => COMPACT.format(tokens);

/** 1,284 — a count, grouped. */
export const formatCount = (count: number): string => COUNT.format(count);

/**
 * A duration in seconds the way a person says it: `42s`, `7m 05s`, `3h 12m`, `2d 4h`. Two units at
 * most, the second padded so a column of durations lines up.
 */
export const formatDuration = (seconds: number): string => {
  const whole = Math.round(Math.max(0, seconds));
  if (whole < 60) return `${whole}s`;
  const pad = (value: number): string => String(value).padStart(2, '0');
  if (whole < 3600) return `${Math.floor(whole / 60)}m ${pad(whole % 60)}s`;
  if (whole < 86_400) return `${Math.floor(whole / 3600)}h ${pad(Math.floor((whole % 3600) / 60))}m`;
  return `${Math.floor(whole / 86_400)}d ${Math.floor((whole % 86_400) / 3600)}h`;
};

/** An axis label for seconds: whole hours, minutes or seconds, whichever the tick is a whole number of. */
export const formatAxisDuration = (seconds: number): string =>
  seconds === 0
    ? '0'
    : seconds % 3600 === 0
      ? `${seconds / 3600}h`
      : seconds % 60 === 0
        ? `${seconds / 60}m`
        : `${seconds}s`;

/** Round axis ticks for seconds: steps of whole minutes or hours, so `formatAxisDuration` stays whole. */
export const durationAxisTicks = (maxSeconds: number): readonly number[] => {
  const unit = maxSeconds >= 3 * 3600 ? 3600 : maxSeconds >= 180 ? 60 : 1;
  return analyticsAxisTicks(maxSeconds / unit).map(tick => Math.round(tick * unit));
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** `2026-10-13` as "13 Oct", the way the axis and the readout name a day. */
export const formatDay = (day: string): string => {
  const [, month, date] = day.split('-');
  return `${Number(date)} ${MONTHS[Number(month) - 1] ?? month}`;
};

/** A week by the Monday it starts on: "wk 12 Oct". */
export const formatWeek = (monday: string): string => `wk ${formatDay(monday)}`;

/** A metric value in its own units. */
export const formatMetric = (metric: OverviewMetric, value: number): string => {
  switch (metric) {
    case 'cost':
      return formatDollars(value);
    case 'tokens':
      return formatTokens(value);
    case 'turns':
      return formatCount(value);
    case 'active':
      return formatDuration(value);
  }
};

/** Kept for the session pane: priced cost per model, most expensive first. */
export interface AnalyticsModelShare {
  readonly model: string;
  readonly costMicros: number;
  readonly sessions: number;
}

/** Priced cost per model, most expensive first. Unpriced rows are counted by the caller, not here. */
export const analyticsModelShares = (rows: readonly AnalyticsRawSession[]): readonly AnalyticsModelShare[] => {
  const shares = new Map<string, { costMicros: number; sessions: number }>();
  for (const row of rows) {
    const cost = row.equivalentApiCostUsdMicros;
    if (cost === null) continue;
    const model = row.model ?? 'unknown model';
    const share = shares.get(model) ?? { costMicros: 0, sessions: 0 };
    shares.set(model, { costMicros: share.costMicros + cost, sessions: share.sessions + 1 });
  }
  return [...shares.entries()]
    .map(([model, share]) => ({ model, ...share }))
    .sort((left, right) => right.costMicros - left.costMicros || left.model.localeCompare(right.model));
};
