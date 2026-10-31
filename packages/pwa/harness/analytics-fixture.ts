/**
 * A realistic two-machine analytics fleet for review captures: 30 days of sessions ending 16 Oct 2026
 * on `AMER-D22HXVF42W` and `kirin-box`, across four runtimes, five models and four projects, with
 * cache reads and writes, active and wall time, a few empty days, some session trees with children, and
 * a model no catalog prices — so the unpriced gap is on screen.
 *
 * The request functions answer the queries the PWA sends — raw `{day=…}`, `{id=…}`, `{tree==…}` reads
 * and aggregate queries alike — from these rows, through the protocol's own parser, one machine at a
 * time, so the Overview, the Query page and the session cost pane all run their real loading and
 * fan-out paths against it.
 */

import type {
  AnalyticsAggregateResult,
  AnalyticsLabel,
  AnalyticsMeasure,
  AnalyticsRawSession,
  AnalyticsResponse,
} from '@ferretry/protocol';
import { analyticsRawMetricValue, parseAnalyticsQuery } from '@ferretry/protocol';

/** The instant the captured window ends on. */
export const ANALYTICS_FIXTURE_NOW = new Date('2026-10-16T15:00:00Z');

/** The two machines, by the harness daemon ids. */
export const ANALYTICS_FIXTURE_MACHINES = [
  { daemonId: 'harness-daemon', name: 'AMER-D22HXVF42W' },
  { daemonId: 'harness-other-daemon', name: 'kirin-box' },
] as const;

const DAY_MS = 86_400_000;
const DAYS = 30;

/** Sessions started per day, oldest first, per machine. */
const PER_DAY = [
  [3, 1],
  [4, 0],
  [0, 0],
  [5, 2],
  [6, 2],
  [4, 1],
  [7, 3],
  [2, 0],
  [0, 0],
  [6, 2],
  [8, 3],
  [5, 2],
  [9, 4],
  [6, 1],
  [3, 0],
  [7, 2],
  [5, 2],
  [0, 1],
  [8, 3],
  [9, 4],
  [6, 2],
  [10, 4],
  [7, 2],
  [3, 1],
  [0, 0],
  [8, 3],
  [12, 5],
  [9, 3],
  [8, 4],
  [5, 2],
] as const;

const RUNTIMES = ['claude-auto-loge', 'claude-auto-liftoff', 'claude-auto-atomi', 'codex-sol'] as const;
const PROJECTS = [
  '/home/kirin/Workspace/personal/ferretry',
  '/home/kirin/.config/home-manager',
  '/home/kirin/Workspace/atomi/diene',
  '/home/kirin/Workspace/atomi/nitroso',
] as const;
const LABELS = [
  'Fix transcript scrolling',
  'Relay retry budget',
  'Pricing catalog sync',
  'Docs pass on grants',
  'Flaky int test',
  'Session tree view',
  'Theme token audit',
  'Insights redesign',
  'Nix flake bump',
  'Warden layer review',
] as const;

/** USD per million tokens: input, output, cache read, cache write. `null` is a model nobody priced. */
const MODELS = [
  { model: 'claude-opus-5-5', harness: 'claude', rates: [5, 25, 0.5, 6.25] },
  { model: 'claude-sonnet-5-5', harness: 'claude', rates: [3, 15, 0.3, 3.75] },
  { model: 'claude-haiku-5-5', harness: 'claude', rates: [1, 5, 0.1, 1.25] },
  { model: 'gpt-5.6-sol', harness: 'codex', rates: [1.25, 10, 0.125, 0] },
  { model: 'gpt-6-astra', harness: 'codex', rates: null },
] as const;

/** A small deterministic generator, so every capture draws the same fleet. */
const random = (() => {
  let seed = 0x5eed;
  return (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
})();
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const between = (low: number, high: number): number => Math.round(low + random() * (high - low));

const isoWeek = (day: string): string => {
  const date = new Date(`${day}T00:00:00Z`);
  const thursday = new Date(date.getTime() + (3 - ((date.getUTCDay() + 6) % 7)) * DAY_MS);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};

interface Draw {
  readonly id: string;
  readonly day: string;
  readonly machine: (typeof ANALYTICS_FIXTURE_MACHINES)[number];
  readonly parent?: string;
  readonly tree?: string;
  readonly model?: (typeof MODELS)[number];
  readonly label?: string;
  readonly scale?: number;
}

const session = ({ id, day, machine, parent, tree, model: forced, label, scale = 1 }: Draw): AnalyticsRawSession => {
  const runtime = machine.daemonId === 'harness-daemon' ? pick(RUNTIMES) : pick(['claude-auto-loge', 'codex-sol']);
  const model =
    forced ??
    (runtime === 'codex-sol'
      ? random() < 0.35
        ? MODELS[4]
        : MODELS[3]
      : random() < 0.45
        ? MODELS[0]
        : random() < 0.7
          ? MODELS[1]
          : MODELS[2]);
  const output = Math.round(between(20_000, 160_000) * scale);
  const cacheRead = Math.round(between(400_000, 4_200_000) * scale);
  const cacheWrite = model.harness === 'claude' ? Math.round(between(30_000, 260_000) * scale) : 0;
  const uncached = Math.round(between(8_000, 90_000) * scale);
  const input = uncached + cacheRead + cacheWrite;
  const turns = Math.max(2, Math.round(between(4, 48) * scale));
  const activeMs = turns * between(25_000, 140_000);
  const timed = random() > 0.05;
  const cost =
    model.rates === null
      ? null
      : Math.round(
          uncached * model.rates[0] +
            output * model.rates[1] +
            cacheRead * model.rates[2] +
            cacheWrite * model.rates[3],
        );
  const hour = between(1, 13);
  return {
    id,
    agent: runtime,
    model: model.model,
    contextWindow: 200_000,
    harness: model.harness,
    mode: 'auto',
    status: 'completed',
    label: label ?? pick(LABELS),
    cwd: pick(PROJECTS),
    parent: parent ?? null,
    tree: tree ?? id,
    day,
    week: isoWeek(day),
    createdAt: `${day}T${String(hour).padStart(2, '0')}:${String(between(0, 59)).padStart(2, '0')}:00.000Z`,
    pricingModel: model.rates === null ? null : model.model,
    equivalentApiCostUsdMicros: cost,
    tokens: input + output,
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    cacheWrite5mInputTokens: cacheWrite,
    cacheWrite1hInputTokens: 0,
    reasoningTokens: model.harness === 'codex' ? Math.round(output * 0.4) : null,
    turns,
    durationMs: Math.round(activeMs * (1.3 + random() * 2)),
    activeDurationMs: timed ? activeMs : null,
    machine: machine.name,
    timeToFirstOutputMs: between(800, 4_000),
    contextEndPercent: between(18, 92),
    stalled: false,
    failed: false,
    migrated: false,
    completed: true,
  };
};

/** The root of the largest tree: the session the cost pane is captured on. */
const ANALYTICS_FIXTURE_ROOT = 'harness-session';

/** Every session on both machines. */
export const ANALYTICS_FIXTURE_ROWS: readonly AnalyticsRawSession[] = (() => {
  const rows: AnalyticsRawSession[] = [];
  const start = ANALYTICS_FIXTURE_NOW.getTime() - (DAYS - 1) * DAY_MS;
  PER_DAY.forEach((counts, offset) => {
    const day = new Date(start + offset * DAY_MS).toISOString().slice(0, 10);
    ANALYTICS_FIXTURE_MACHINES.forEach((machine, which) => {
      for (let n = 0; n < counts[which]!; n += 1) {
        const id = `${machine.name === 'kirin-box' ? 'kb' : 'am'}-${day.slice(5)}-${n}`;
        rows.push(session({ id, day, machine }));
        // Every fourth session spawned a child or two.
        if (n % 4 === 1)
          for (let child = 0; child < 1 + (n % 3); child += 1)
            rows.push(session({ id: `${id}-c${child}`, day, machine, parent: id, tree: id, scale: 0.4 }));
      }
    });
  });
  const day = '2026-10-13';
  const here = ANALYTICS_FIXTURE_MACHINES[0];
  rows.push(
    session({
      id: ANALYTICS_FIXTURE_ROOT,
      day,
      machine: here,
      model: MODELS[0],
      label: 'Insights redesign',
      scale: 3.2,
    }),
    session({
      id: `${ANALYTICS_FIXTURE_ROOT}-child-0`,
      day,
      machine: here,
      parent: ANALYTICS_FIXTURE_ROOT,
      tree: ANALYTICS_FIXTURE_ROOT,
      model: MODELS[0],
      scale: 1.4,
    }),
    session({
      id: `${ANALYTICS_FIXTURE_ROOT}-child-1`,
      day,
      machine: here,
      parent: ANALYTICS_FIXTURE_ROOT,
      tree: ANALYTICS_FIXTURE_ROOT,
      model: MODELS[1],
    }),
    session({
      id: `${ANALYTICS_FIXTURE_ROOT}-child-2`,
      day,
      machine: here,
      parent: ANALYTICS_FIXTURE_ROOT,
      tree: ANALYTICS_FIXTURE_ROOT,
      model: MODELS[4],
      scale: 0.6,
    }),
  );
  return rows.map((row, at) => {
    const gap =
      row.model === 'claude-opus-5-5' && at % 11 === 0
        ? 'transcript_unresolved'
        : row.model === 'claude-sonnet-5-5' && at % 17 === 0
          ? 'transcript_unreadable'
          : row.model === 'gpt-6-astra'
            ? 'unknown_pricing_model'
            : null;
    const cost = gap === null ? row.equivalentApiCostUsdMicros : null;
    return {
      ...row,
      equivalentApiCostUsdMicros: cost,
      equivalentApiCostCurrentUsdMicros: cost === null ? null : Math.round(cost * 1.0),
      costGap: gap,
    };
  });
})();

const index = (rows: readonly AnalyticsRawSession[]) => ({
  schemaVersion: 6,
  sessions: rows.length,
  tokenSessions: rows.length,
  transcriptSources: rows.length,
  indexedTranscriptSources: rows.length,
  pendingTranscriptSources: 0,
  sourceErrors: 0,
  refreshing: false,
});

const glob = (value: string, pattern: string): boolean =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
      .replace(/\*/gu, '.*')
      .replace(/\?/gu, '.')}$`,
  ).test(value);

const projectOf = (row: AnalyticsRawSession): string | null =>
  row.cwd === null ? null : (row.cwd.split('/').filter(Boolean).at(-1) ?? null);

/** A row's value for a label, as the daemon would read it. */
const labelValue = (row: AnalyticsRawSession, label: AnalyticsLabel): string | null => {
  switch (label) {
    case 'id':
    case 'session':
      return row.id;
    case 'agent':
    case 'runtime':
      return row.agent;
    case 'repo':
    case 'project':
      return projectOf(row);
    case 'pricing_model':
      return row.pricingModel;
    case 'context_window':
      return row.contextWindow === null ? null : String(row.contextWindow);
    case 'token_data':
      return row.tokens === null ? 'missing' : 'present';
    default: {
      const value = (row as unknown as Record<string, unknown>)[label];
      return typeof value === 'string' ? value : null;
    }
  }
};

const MEASURES = {
  tokens: row => row.tokens,
  inputTokens: row => row.inputTokens,
  outputTokens: row => row.outputTokens,
  cachedInputTokens: row => row.cachedInputTokens,
  cacheWriteInputTokens: row => row.cacheWriteInputTokens,
  cacheWrite5mInputTokens: row => row.cacheWrite5mInputTokens,
  cacheWrite1hInputTokens: row => row.cacheWrite1hInputTokens,
  reasoningTokens: row => row.reasoningTokens,
  equivalentApiCostUsdMicros: row => row.equivalentApiCostUsdMicros,
  equivalentApiCostCurrentUsdMicros: row => row.equivalentApiCostCurrentUsdMicros ?? null,
  turns: row => row.turns,
  durationMs: row => row.durationMs,
  activeDurationMs: row => row.activeDurationMs,
  timeToFirstOutputMs: row => row.timeToFirstOutputMs,
  contextEndPercent: row => row.contextEndPercent,
} as const satisfies Record<string, (row: AnalyticsRawSession) => number | null>;

const measure = (
  rows: readonly AnalyticsRawSession[],
  read: (row: AnalyticsRawSession) => number | null,
  aggregation: string,
): AnalyticsMeasure => {
  const known = rows.map(read).filter((value): value is number => value !== null);
  const total = rows.length;
  if (aggregation === 'count') return { value: known.length, known: known.length, total };
  if (known.length === 0) return { value: null, known: 0, total };
  const partialSum = known.length < total && aggregation === 'sum';
  const value =
    aggregation === 'min'
      ? Math.min(...known)
      : aggregation === 'max'
        ? Math.max(...known)
        : aggregation === 'avg'
          ? known.reduce((sum, item) => sum + item, 0) / known.length
          : known.length < total
            ? null
            : known.reduce((sum, item) => sum + item, 0);
  return partialSum
    ? { value, known: known.length, total, knownSum: known.reduce((sum, item) => sum + item, 0) }
    : { value, known: known.length, total };
};

const gapsOf = (rows: readonly AnalyticsRawSession[]): Record<string, number> => {
  const gaps: Record<string, number> = {};
  for (const row of rows) if (row.costGap) gaps[row.costGap] = (gaps[row.costGap] ?? 0) + 1;
  return gaps;
};

const aggregateRow = (
  labels: Record<string, string | null>,
  rows: readonly AnalyticsRawSession[],
  aggregation: string,
): AnalyticsAggregateResult => {
  const percent = (flag: (row: AnalyticsRawSession) => boolean): number =>
    rows.length === 0 ? 0 : (100 * rows.filter(flag).length) / rows.length;
  return {
    labels,
    sessions: rows.length,
    ...(Object.keys(gapsOf(rows)).length > 0 ? { costGaps: gapsOf(rows) } : {}),
    rates: {
      stall: percent(row => row.stalled),
      failure: percent(row => row.failed),
      completion: percent(row => row.completed),
    },
    ...(Object.fromEntries(
      Object.entries(MEASURES).map(([key, read]) => [key, measure(rows, read, aggregation)]),
    ) as Record<keyof typeof MEASURES, AnalyticsMeasure>),
  };
};

const LIMIT = 100;

/** Answers one query from ONE machine's share of the fixture fleet, as that daemon's route would. */
export const answerAnalyticsFixture = (query: string, daemonId = 'harness-daemon'): AnalyticsResponse => {
  const parsed = parseAnalyticsQuery(query);
  const own = ANALYTICS_FIXTURE_ROWS.filter(
    row => row.machine === ANALYTICS_FIXTURE_MACHINES.find(machine => machine.daemonId === daemonId)?.name,
  );
  const range = parsed.range;
  const from =
    range === undefined
      ? Number.NEGATIVE_INFINITY
      : range.kind === 'relative'
        ? ANALYTICS_FIXTURE_NOW.getTime() - range.seconds * 1000
        : Date.parse(range.from);
  const to = range === undefined || range.kind === 'relative' ? Number.POSITIVE_INFINITY : Date.parse(range.to);
  const matched = own
    .filter(row => {
      const created = Date.parse(row.createdAt ?? '');
      return created >= from && created < to;
    })
    .filter(row =>
      parsed.matchers.every(matcher => {
        const value = labelValue(row, matcher.label);
        if (value === null) return false;
        if (matcher.op === '=~') return new RegExp(`^(?:${matcher.value})$`, 'u').test(value);
        return matcher.wildcard ? glob(value, matcher.value) : value === matcher.value;
      }),
    );
  const scope = {
    allSessions: true as const,
    indexed: own.length,
    matched: matched.length,
    ...(range === undefined
      ? {}
      : {
          window: {
            from: new Date(Number.isFinite(from) ? from : 0).toISOString(),
            to: new Date(Number.isFinite(to) ? to : ANALYTICS_FIXTURE_NOW.getTime()).toISOString(),
          },
        }),
  };
  const parsedEcho = {
    groupBy: parsed.groupBy,
    matchers: parsed.matchers,
    ...(parsed.metric === undefined ? {} : { metric: parsed.metric }),
    ...(range === undefined ? {} : { range }),
  };
  if (parsed.aggregation === undefined) {
    const metric = parsed.metric;
    const sorted = [...matched].sort((left, right) => {
      if (metric !== undefined) {
        const a = analyticsRawMetricValue(left, metric);
        const b = analyticsRawMetricValue(right, metric);
        if (a !== b) return a === null ? 1 : b === null ? -1 : b - a;
      }
      return (right.createdAt ?? '').localeCompare(left.createdAt ?? '');
    });
    return {
      kind: 'raw',
      query: parsed.canonical,
      parsed: parsedEcho,
      scope,
      index: index(own),
      limit: LIMIT,
      truncated: sorted.length > LIMIT,
      results: sorted.slice(0, LIMIT),
    };
  }
  const groups = new Map<string, { labels: Record<string, string | null>; rows: AnalyticsRawSession[] }>();
  for (const row of matched) {
    const labels = Object.fromEntries(parsed.groupBy.map(label => [label, labelValue(row, label)]));
    const key = JSON.stringify(labels);
    const group = groups.get(key) ?? { labels, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return {
    kind: 'aggregate',
    aggregation: parsed.aggregation,
    query: parsed.canonical,
    parsed: { ...parsedEcho, aggregation: parsed.aggregation },
    scope,
    index: index(own),
    results: [...groups.values()]
      .sort((left, right) => JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels)))
      .map(group => aggregateRow(group.labels, group.rows, parsed.aggregation!)),
  };
};
