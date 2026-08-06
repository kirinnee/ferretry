import {
  normalizeAnalyticsModelIdentity,
  type AnalyticsModelIdentity,
  type AnalyticsRawSession,
} from '@ferretry/protocol';
import {
  snapshotAnalyticsUsagePricing,
  type AnalyticsPricingRate,
  type AnalyticsTokenUsage,
  type AnalyticsUsagePricingSnapshot,
} from './pricing.ts';

export interface FinishedAnalyticsSession {
  readonly id: string;
  readonly agent?: string | null;
  /** Display/selector evidence. It is never replaced by transcript evidence. */
  readonly selectedModel?: string | null;
  readonly contextWindow?: number | null;
  readonly harness?: string | null;
  readonly mode?: string | null;
  readonly status?: string | null;
  readonly label?: string | null;
  readonly cwd?: string | null;
  readonly parent?: string | null;
  readonly createdAt: string;
  readonly startedAt?: string | null;
  readonly finishedAt: string;
  readonly firstOutputAt?: string | null;
  readonly turns?: number | null;
  readonly contextEndPercent?: number | null;
  readonly stalled: boolean;
  readonly failed: boolean;
  readonly migrated: boolean;
  readonly completed: boolean;
  readonly usage?: Omit<AnalyticsTokenUsage, 'createdAt'> | null;
}

/** Durable session records are authoritative; an analytics index is never a source of truth. */
export interface FinishedAnalyticsSessionSource {
  listFinishedAnalyticsSessions(): readonly FinishedAnalyticsSession[];
}

/** Adapter-facing stored form. Extra evidence never leaks into the wire row. */
export interface AnalyticsSessionIndexRecord {
  readonly raw: AnalyticsRawSession;
  readonly finishedAt: string | null;
  readonly displayModelIdentity: AnalyticsModelIdentity | null;
  readonly pricing: AnalyticsUsagePricingSnapshot | null;
}

function instant(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalInstant(value: string | null | undefined): string | null {
  const parsed = instant(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

function nonNegativeInteger(value: number | null | undefined): number | null {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : null;
}

function percentage(value: number | null | undefined): number | null {
  return Number.isFinite(value) && (value ?? -1) >= 0 && (value ?? 101) <= 100 ? value! : null;
}

function elapsed(from: string | null | undefined, through: string | null | undefined): number | null {
  const start = instant(from);
  const end = instant(through);
  return start === null || end === null ? null : Math.max(0, end - start);
}

function utcDay(value: string): string | null {
  return canonicalInstant(value)?.slice(0, 10) ?? null;
}

function utcWeek(value: string): string | null {
  const parsed = instant(value);
  if (parsed === null) return null;
  const date = new Date(parsed);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

function tokenFields(
  usage: FinishedAnalyticsSession['usage'],
): Pick<
  AnalyticsRawSession,
  | 'tokens'
  | 'inputTokens'
  | 'outputTokens'
  | 'cachedInputTokens'
  | 'cacheWriteInputTokens'
  | 'cacheWrite5mInputTokens'
  | 'cacheWrite1hInputTokens'
> {
  if (usage === null || usage === undefined) {
    return {
      tokens: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      cacheWrite5mInputTokens: null,
      cacheWrite1hInputTokens: null,
    };
  }

  const inputTokens = nonNegativeInteger(usage.inputTokens);
  const outputTokens = nonNegativeInteger(usage.outputTokens);
  const cachedInputTokens = nonNegativeInteger(usage.cachedInputTokens);
  const cacheWriteInputTokens = nonNegativeInteger(usage.cacheWriteInputTokens);
  const requiredKnown = [inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens].every(
    value => value !== null,
  );
  if (!requiredKnown) {
    return {
      tokens: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      cacheWrite5mInputTokens: null,
      cacheWrite1hInputTokens: null,
    };
  }

  const tokens = inputTokens! + outputTokens!;
  if (!Number.isSafeInteger(tokens)) {
    return {
      tokens: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      cacheWrite5mInputTokens: null,
      cacheWrite1hInputTokens: null,
    };
  }

  return {
    tokens,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    cacheWrite5mInputTokens: nonNegativeInteger(usage.cacheWrite5mInputTokens),
    cacheWrite1hInputTokens: nonNegativeInteger(usage.cacheWrite1hInputTokens),
  };
}

/** Convert one authoritative finished-session record into disposable index data. */
export function deriveAnalyticsSessionRecord(
  session: FinishedAnalyticsSession,
  pricingCatalog: readonly AnalyticsPricingRate[],
): AnalyticsSessionIndexRecord {
  const displayModelIdentity = normalizeAnalyticsModelIdentity(
    session.selectedModel,
    pricingCatalog.map(entry => ({ modelId: entry.modelId, aliases: entry.aliases })),
  );
  const pricing =
    session.usage === null || session.usage === undefined
      ? null
      : snapshotAnalyticsUsagePricing({ ...session.usage, createdAt: session.createdAt }, pricingCatalog);
  const tokens = tokenFields(session.usage);
  const createdAt = canonicalInstant(session.createdAt);
  const finishedAt = canonicalInstant(session.finishedAt);
  const durationStart = canonicalInstant(session.startedAt) ?? createdAt;
  const equivalentApiCostUsdMicros = pricing?.kind === 'priced' ? pricing.equivalentApiCostUsdMicros : null;

  return {
    raw: {
      id: session.id,
      agent: session.agent ?? null,
      model: displayModelIdentity?.modelId ?? null,
      contextWindow: nonNegativeInteger(session.contextWindow) ?? displayModelIdentity?.contextWindow ?? null,
      harness: session.harness ?? null,
      mode: session.mode ?? null,
      status: session.status ?? null,
      label: session.label ?? null,
      cwd: session.cwd ?? null,
      parent: session.parent ?? null,
      day: utcDay(session.createdAt),
      week: utcWeek(session.createdAt),
      createdAt,
      pricingModel: pricing?.identity?.modelId ?? null,
      equivalentApiCostUsdMicros,
      ...tokens,
      turns: nonNegativeInteger(session.turns),
      durationMs: elapsed(durationStart, finishedAt),
      timeToFirstOutputMs: elapsed(durationStart, session.firstOutputAt),
      contextEndPercent: percentage(session.contextEndPercent),
      stalled: session.stalled,
      failed: session.failed,
      migrated: session.migrated,
      completed: session.completed,
    },
    finishedAt,
    displayModelIdentity,
    pricing,
  };
}

/** Recreate the disposable analytics materialization from durable finished-session records. */
export function rebuildAnalyticsSessionIndex(
  source: FinishedAnalyticsSessionSource,
  pricingCatalog: readonly AnalyticsPricingRate[],
): AnalyticsSessionIndexRecord[] {
  const records = new Map<string, AnalyticsSessionIndexRecord>();
  for (const session of source.listFinishedAnalyticsSessions()) {
    const record = deriveAnalyticsSessionRecord(session, pricingCatalog);
    records.set(record.raw.id, record);
  }
  return [...records.values()];
}
