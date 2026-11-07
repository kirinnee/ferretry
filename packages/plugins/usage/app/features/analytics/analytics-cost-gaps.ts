/**
 * Why a session has no cost, in words a person can act on. The daemon names the evidence gap; this
 * names it for the screen. An unknown reason is shown as itself, never hidden: a new daemon reason must
 * stay readable on an old page.
 */

export type AnalyticsCostGaps = Readonly<Record<string, number>>;

const REASON_WORDS: Readonly<Record<string, string>> = {
  transcript_unresolved: 'transcript not found',
  transcript_unreadable: 'transcript could not be read',
  transcript_damaged: 'transcript damaged',
  transcript_incomplete: 'transcript still being written',
  no_usage_evidence: 'transcript records no usage',
  ambiguous_token_accounting: 'token accounting unclear',
  missing_pricing_model: 'no model name recorded',
  unknown_pricing_model: 'model has no known price',
  pricing_outside_validity_window: 'no price in force that day',
  invalid_created_at: 'start time unreadable',
  incomplete_token_counts: 'token counts incomplete',
  invalid_token_counts: 'token counts invalid',
  negative_uncached_input: 'token counts inconsistent',
  missing_anthropic_cache_write_split: 'cache-write split missing',
  inconsistent_anthropic_cache_write_split: 'cache-write split inconsistent',
  invalid_rate_table: 'price table invalid',
  cost_out_of_range: 'cost too large to count',
  unknown: 'reason not recorded',
};

export const costGapReason = (reason: string): string => REASON_WORDS[reason] ?? reason.replaceAll('_', ' ');

/** "10 unpriced", or nothing when every session stated a cost. */
export const unpricedLabel = (gaps: AnalyticsCostGaps | undefined): string | undefined => {
  const count = Object.values(gaps ?? {}).reduce((sum, n) => sum + n, 0);
  return count === 0 ? undefined : `${count} unpriced`;
};

/** Reasons biggest first, so the one that matters most is read first. */
export const costGapEntries = (gaps: AnalyticsCostGaps): readonly (readonly [string, number])[] =>
  Object.entries(gaps).sort(([a, x], [b, y]) => y - x || a.localeCompare(b));

export const sumCostGaps = (all: readonly (AnalyticsCostGaps | undefined)[]): AnalyticsCostGaps | undefined => {
  const merged: Record<string, number> = {};
  for (const gaps of all)
    for (const [reason, n] of Object.entries(gaps ?? {})) merged[reason] = (merged[reason] ?? 0) + n;
  return Object.keys(merged).length === 0 ? undefined : merged;
};
