/**
 * A realistic analytics fleet for review captures: 15 days of sessions ending 16 Oct 2026, two of them
 * empty, a busy day, a handful of unpriced sessions and a few session trees with children.
 *
 * The request functions answer the same queries the PWA sends — raw `{day=…}`, `{id=…}` and
 * `{tree==…}` reads — by filtering these rows through the protocol's own parser, so the Analytics page
 * and the session cost pane run their real loading paths against it. Aggregate queries (Custom query)
 * answer with the caller's fixed aggregate fixture.
 */

import type { AnalyticsRawSession, AnalyticsResponse } from '@ferretry/protocol';
import { parseAnalyticsQuery } from '@ferretry/protocol';

/** The instant the captured window ends on. */
export const ANALYTICS_FIXTURE_NOW = new Date('2026-10-16T15:00:00Z');

const SESSIONS_PER_DAY = [12, 8, 0, 10, 13, 9, 16, 11, 7, 0, 12, 21, 14, 13, 9] as const;
const AGENTS = ['Marin', 'Hadi', 'Jaylynn', 'Oskar', 'Priya', 'Tomas', 'Wren', 'Ines'] as const;
const PROJECTS = ['/home/kirin/Workspace/ferretry', '/home/kirin/.config/home-manager', '/home/kirin/Workspace/atomi'];
const LABELS = ['Flaky test fix', 'Session workspace', 'Main agent', 'Relay retry', 'Docs pass', 'Pricing sync'];
const MODELS = [
  { model: 'claude-opus-5-5', perMillion: 9 },
  { model: 'claude-sonnet-5-5', perMillion: 2.6 },
  { model: 'gpt-5.6-sol', perMillion: 2 },
  { model: 'claude-haiku-5-5', perMillion: 0.7 },
] as const;

const row = (index: number, day: string, overrides: Partial<AnalyticsRawSession> = {}): AnalyticsRawSession => {
  const choice = MODELS[index % 7 === 0 ? 3 : index % 5 === 0 ? 2 : index % 3 === 0 ? 1 : 0]!;
  const tokens = 200_000 + ((index * 7919) % 1_400_000);
  const unpriced = index % 23 === 4;
  return {
    id: `session-${String(index).padStart(3, '0')}`,
    agent: AGENTS[index % AGENTS.length]!,
    model: choice.model,
    contextWindow: 200_000,
    harness: choice.model.startsWith('gpt') ? 'codex' : 'claude',
    mode: 'auto',
    status: 'completed',
    label: LABELS[index % LABELS.length]!,
    cwd: PROJECTS[index % PROJECTS.length]!,
    parent: null,
    tree: null,
    day,
    week: '2026-W42',
    createdAt: `${day}T${String(8 + (index % 12)).padStart(2, '0')}:00:00.000Z`,
    pricingModel: unpriced ? null : choice.model,
    equivalentApiCostUsdMicros: unpriced ? null : Math.round((tokens / 1_000_000) * choice.perMillion * 1_000_000),
    tokens,
    inputTokens: Math.round(tokens * 0.8),
    outputTokens: Math.round(tokens * 0.2),
    cachedInputTokens: Math.round(tokens * 0.13),
    cacheWriteInputTokens: 0,
    cacheWrite5mInputTokens: 0,
    cacheWrite1hInputTokens: 0,
    reasoningTokens: null,
    turns: 10 + (index % 40),
    durationMs: 600_000,
    timeToFirstOutputMs: 1_200,
    contextEndPercent: 30 + (index % 60),
    stalled: false,
    failed: false,
    migrated: false,
    completed: true,
    ...overrides,
  };
};

const buildRows = (): readonly AnalyticsRawSession[] => {
  const rows: AnalyticsRawSession[] = [];
  let index = 0;
  SESSIONS_PER_DAY.forEach((count, offset) => {
    const day = `2026-10-${String(2 + offset).padStart(2, '0')}`;
    for (let n = 0; n < count; n += 1) rows.push(row(index++, day));
  });
  return rows;
};

/** The root of the largest tree: the session the cost pane is captured on. */
const ANALYTICS_FIXTURE_ROOT = 'harness-session';

/** Every session, with one three-child tree rooted at {@link ANALYTICS_FIXTURE_ROOT}. */
export const ANALYTICS_FIXTURE_ROWS: readonly AnalyticsRawSession[] = (() => {
  const day = '2026-10-13';
  const root = row(900, day, {
    id: ANALYTICS_FIXTURE_ROOT,
    agent: 'Marin',
    label: 'Flaky test fix',
    cwd: PROJECTS[0]!,
    model: 'claude-opus-5-5',
    pricingModel: 'claude-opus-5-5',
    tree: ANALYTICS_FIXTURE_ROOT,
    tokens: 4_830_000,
    equivalentApiCostUsdMicros: 43_510_000,
    contextEndPercent: 62,
    turns: 41,
  });
  const child = (n: number, model: string, cost: number | null): AnalyticsRawSession =>
    row(901 + n, day, {
      id: `${ANALYTICS_FIXTURE_ROOT}-child-${n}`,
      agent: 'Marin',
      parent: ANALYTICS_FIXTURE_ROOT,
      tree: ANALYTICS_FIXTURE_ROOT,
      model,
      pricingModel: cost === null ? null : model,
      equivalentApiCostUsdMicros: cost,
    });
  return [
    ...buildRows(),
    root,
    child(0, 'claude-opus-5-5', 31_890_000),
    child(1, 'claude-sonnet-5-5', 5_400_000),
    child(2, 'claude-haiku-5-5', 210_000),
  ];
})();

const INDEX = {
  schemaVersion: 6,
  sessions: ANALYTICS_FIXTURE_ROWS.length,
  tokenSessions: ANALYTICS_FIXTURE_ROWS.length,
  transcriptSources: ANALYTICS_FIXTURE_ROWS.length,
  indexedTranscriptSources: ANALYTICS_FIXTURE_ROWS.length,
  pendingTranscriptSources: 0,
  sourceErrors: 0,
  refreshing: false,
};

const glob = (value: string, pattern: string): boolean =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
      .replace(/\*/gu, '.*')
      .replace(/\?/gu, '.')}$`,
  ).test(value);

const LIMIT = 100;

/** Answers one query from the fixture fleet, as the daemon's route would. */
export const answerAnalyticsFixture = (query: string, aggregate: AnalyticsResponse): AnalyticsResponse => {
  const parsed = parseAnalyticsQuery(query);
  if (parsed.aggregation !== undefined) return { ...aggregate, query: parsed.canonical };
  const matched = ANALYTICS_FIXTURE_ROWS.filter(candidate =>
    parsed.matchers.every(matcher => {
      const value = (candidate as unknown as Record<string, unknown>)[matcher.label];
      if (typeof value !== 'string') return false;
      return matcher.wildcard ? glob(value, matcher.value) : value === matcher.value;
    }),
  ).sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''));
  return {
    kind: 'raw',
    query: parsed.canonical,
    parsed: { groupBy: [], matchers: parsed.matchers },
    scope: { allSessions: true, indexed: ANALYTICS_FIXTURE_ROWS.length, matched: matched.length },
    index: INDEX,
    limit: LIMIT,
    truncated: matched.length > LIMIT,
    results: matched.slice(0, LIMIT),
  };
};
