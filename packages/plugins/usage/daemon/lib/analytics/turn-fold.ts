import type { TurnUsage } from '@ferretry/core-ferrets/contract';
import { type AnalyticsModelAliasGroup, normalizeAnalyticsModelIdentity } from '../../../contract/index.ts';
import type { AnalyticsTokenUsage } from './pricing.ts';

/** A session's token total, as this daemon can prove it from that session's own turns. */
export type AnalyticsSessionUsage = Omit<AnalyticsTokenUsage, 'createdAt'>;

/**
 * Why a session has no reportable token total.
 *
 * Every member is a REFUSAL, not a zero. A session whose evidence could not be read has spent an unknown amount, and
 * reporting that as no tokens and no cost would put a free run on the board. The members are today's stored codes.
 */
export type AnalyticsUsageRefusal =
  /** No reader answers for this ferret, so there is nothing to count. */
  | 'transcript_unresolved'
  /** The ferret is its own, but its harness could not read its usage. */
  | 'transcript_unreadable'
  /** The harness read cleanly and records no usage at all. */
  | 'no_usage_evidence'
  /** A usage figure whose accounting this daemon cannot state, so no total is derivable. */
  | 'ambiguous_token_accounting';

export type AnalyticsSessionUsageFold =
  | { readonly kind: 'usage'; readonly usage: AnalyticsSessionUsage }
  | { readonly kind: 'refused'; readonly reason: AnalyticsUsageRefusal };

/** How long a session was ACTIVE and over how many turns; `null` is "not stated", never zero. */
export interface AnalyticsSessionActivity {
  readonly activeDurationMs: number | null;
  readonly turns: number | null;
}

/** Everything ingestion keeps from one ferret's usage: its token total (or refusal) and its activity. */
export interface AnalyticsTranscriptFold {
  readonly usage: AnalyticsSessionUsageFold;
  readonly activity: AnalyticsSessionActivity;
}

/**
 * What a ferret's turns say about it. `undefined` means the harness's usage reader could not be asked (no harness
 * provides it, or it failed): an unreadable ferret is a refusal, never a free one.
 */
export type TurnEvidence = readonly TurnUsage[] | undefined;

export function isCountable(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

/** One turn's usage as pricing wants it. `inputTokens` is the GROSS input: cache reads and writes are subsets of it. */
export function turnTokenUsage(turn: TurnUsage): AnalyticsTokenUsage {
  const cacheWrite = turn.cacheWriteTokens ?? 0;
  return {
    pricingModel: turn.model,
    createdAt: turn.at,
    inputTokens: turn.inputTokens,
    cachedInputTokens: turn.cacheReadTokens ?? 0,
    cacheWriteInputTokens: cacheWrite,
    cacheWrite5mInputTokens: null,
    cacheWrite1hInputTokens: null,
    outputTokens: turn.outputTokens,
    reasoningTokens: null,
  };
}

/**
 * Sum every turn a ferret made into a single billable total. Each turn bills its own full input, so a conversation's
 * cost is the sum of its turns and not the size of its last. The MODEL is the turns' own evidence only: where more than
 * one model ran, the total is still reported but no single pricing model is claimed, so the cost comes back unpriced
 * instead of charging one model's whole run at another model's rate. The catalog's aliases decide what is "one model".
 *
 * The turn reader states no cache-write lifetime split and no reasoning figure, so both stay `null`: pricing then
 * charges the write at the single write rate and the whole output at the output rate (and says so in the row).
 */
export function foldTurnUsage(
  evidence: TurnEvidence,
  aliasGroups: readonly AnalyticsModelAliasGroup[] = [],
): AnalyticsSessionUsageFold {
  if (evidence === undefined) return { kind: 'refused', reason: 'transcript_unresolved' };
  if (evidence.length === 0) return { kind: 'refused', reason: 'no_usage_evidence' };
  let input = 0;
  let output = 0;
  let cachedRead = 0;
  let cacheWrite = 0;
  const models = new Set<string>();
  for (const turn of evidence) {
    const figures = [turn.inputTokens, turn.outputTokens, turn.cacheReadTokens ?? 0, turn.cacheWriteTokens ?? 0];
    // A negative or fractional token count is not a small error, it is a record this daemon does not understand.
    if (!figures.every(isCountable)) return { kind: 'refused', reason: 'ambiguous_token_accounting' };
    if ((turn.cacheReadTokens ?? 0) + (turn.cacheWriteTokens ?? 0) > turn.inputTokens)
      return { kind: 'refused', reason: 'ambiguous_token_accounting' };
    input += turn.inputTokens;
    output += turn.outputTokens;
    cachedRead += turn.cacheReadTokens ?? 0;
    cacheWrite += turn.cacheWriteTokens ?? 0;
    const identity = normalizeAnalyticsModelIdentity(turn.model, aliasGroups);
    if (identity !== null) models.add(identity.modelId);
  }
  if (![input, output, cachedRead, cacheWrite].every(Number.isSafeInteger))
    return { kind: 'refused', reason: 'ambiguous_token_accounting' };
  const [onlyModel] = models;
  return {
    kind: 'usage',
    usage: {
      pricingModel: models.size === 1 && onlyModel !== undefined ? onlyModel : null,
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: cachedRead,
      cacheWriteInputTokens: cacheWrite,
      cacheWrite5mInputTokens: null,
      cacheWrite1hInputTokens: null,
      reasoningTokens: null,
    },
  };
}

/** What the turns say about activity: how many turns, and nothing about time (the reader carries tokens, not timing). */
export function turnActivity(evidence: TurnEvidence): AnalyticsSessionActivity {
  return { activeDurationMs: null, turns: evidence === undefined ? null : evidence.length };
}

/** The ONE fold ingestion uses. */
export function foldAnalyticsTurns(
  evidence: TurnEvidence,
  aliasGroups: readonly AnalyticsModelAliasGroup[] = [],
): AnalyticsTranscriptFold {
  return { usage: foldTurnUsage(evidence, aliasGroups), activity: turnActivity(evidence) };
}
