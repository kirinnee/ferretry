import type { TranscriptEvent, TranscriptHarness, TranscriptIssueCode } from '../transcript/types.ts';
import { normalizeAnalyticsModelIdentity } from './model-identity.ts';
import type { AnalyticsTokenUsage } from './pricing.ts';

/** A session's token total, as this daemon can prove it from that session's own transcript. */
export type AnalyticsSessionUsage = Omit<AnalyticsTokenUsage, 'createdAt'>;

/**
 * Why a session has no reportable token total.
 *
 * Every member is a REFUSAL, not a zero. A session whose evidence could not be read has spent an
 * unknown amount, and reporting that as no tokens and no cost would put a free run on the board.
 */
export type AnalyticsUsageRefusal =
  /** No transcript is attributable to this session, so there is nothing to count. */
  | 'transcript_unresolved'
  /** The transcript is this session's, but the daemon could not read or parse it. */
  | 'transcript_unreadable'
  /** Bytes were lost, truncated or unparseable, so no total can be claimed complete. */
  | 'transcript_damaged'
  /** The read ended mid-record, so the last usage figure may be missing or partial. */
  | 'transcript_incomplete'
  /** The transcript parsed cleanly and records no usage at all. */
  | 'no_usage_evidence'
  /** A usage figure whose accounting this daemon cannot state, so no total is derivable. */
  | 'ambiguous_token_accounting';

export type AnalyticsSessionUsageFold =
  | { readonly kind: 'usage'; readonly usage: AnalyticsSessionUsage }
  | { readonly kind: 'refused'; readonly reason: AnalyticsUsageRefusal };

/**
 * The transcript read this fold is derived from, including how it ended.
 *
 * Resolution failures are carried as their own states rather than as an empty event list, because
 * "this session's transcript could not be found" and "this session used no tokens" are different
 * claims and only one of them is ever true here.
 */
export type AnalyticsTranscriptEvidence =
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'unreadable' }
  | {
      readonly kind: 'read';
      readonly harness: TranscriptHarness;
      readonly events: readonly TranscriptEvent[];
      readonly issues: readonly TranscriptIssueCode[];
      /** Bytes held back at the end of the read for want of a terminating newline. */
      readonly pendingBytes: number;
    };

/**
 * Where one finished session's own transcript evidence comes from.
 *
 * Keyed by session id and asked per session, so one daemon's analytics can only ever be assembled
 * from transcripts that same daemon resolved as belonging to its own sessions.
 */
export interface AnalyticsTranscriptEvidenceSource {
  evidenceFor(sessionId: string, harness: TranscriptHarness): Promise<AnalyticsTranscriptEvidence>;
}

/**
 * Issue codes that mean transcript bytes were never inspected.
 *
 * The distinction that matters is whether a record was SEEN. A record whose JSON parsed and which
 * the parser then modelled partially — an unsupported record type, a malformed tool input — was
 * inspected, and the parser can state that it carried no usage figure. A record whose bytes never
 * parsed, or which the read stopped short of, was never inspected at all, so a total computed
 * without it is a total nobody can call complete.
 */
const EVIDENCE_LOSING_ISSUES: readonly TranscriptIssueCode[] = [
  'invalid-json',
  'incomplete-line',
  'truncated-json',
  'oversized-record',
  'source-missing',
  'source-read-failed',
  'source-truncated',
];

interface UsageTotals {
  input: number;
  output: number;
  cachedRead: number;
  cacheWrite: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cachedRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

/**
 * The GROSS input a request billed, from a harness that does not report it that way.
 *
 * The two harnesses disagree about what `input_tokens` counts, and the disagreement is worth real
 * money. Anthropic reports uncached input only, with cache reads and cache writes as separate
 * figures beside it; OpenAI reports a prompt total with the cached portion named as a subset of it.
 * Both parsers already encode this in their own context-token derivation. Downstream pricing takes
 * a gross input and subtracts the cached parts back out, so each harness is converted to gross
 * exactly once, here.
 */
function grossInput(harness: TranscriptHarness, input: number, cachedRead: number, cacheWrite: number): number {
  return harness === 'claude' ? input + cachedRead + cacheWrite : input;
}

/**
 * Whether a harness's cache-write figure can be placed within its input accounting.
 *
 * Codex reports a prompt total that already contains its cached portion, but gives no basis for
 * saying whether a cache WRITE is inside that total or beside it. The two readings differ by the
 * write itself, so a figure this daemon cannot place is refused rather than assigned to whichever
 * side makes the arithmetic close.
 */
function cacheWriteIsPlaceable(harness: TranscriptHarness, cacheWrite: number): boolean {
  return harness === 'claude' || cacheWrite === 0;
}

function isCountable(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Fold every usage record in one finished session's transcript into a single billable total.
 *
 * Summing across records is the correct accounting rather than taking the last one: each request a
 * harness makes bills its own full input, so a conversation's cost is the sum of its turns and not
 * the size of its final turn.
 *
 * The MODEL is transcript evidence only. Where a session ran under more than one model the total is
 * still reported — a token count does not depend on which model produced it — but no single pricing
 * model is claimed, so the cost comes back unpriced instead of charging one model's whole run at
 * another model's rate.
 */
export function foldAnalyticsSessionUsage(evidence: AnalyticsTranscriptEvidence): AnalyticsSessionUsageFold {
  if (evidence.kind === 'unresolved') return { kind: 'refused', reason: 'transcript_unresolved' };
  if (evidence.kind === 'unreadable') return { kind: 'refused', reason: 'transcript_unreadable' };
  if (evidence.issues.some(code => EVIDENCE_LOSING_ISSUES.includes(code))) {
    return { kind: 'refused', reason: 'transcript_damaged' };
  }
  if (evidence.pendingBytes > 0) return { kind: 'refused', reason: 'transcript_incomplete' };

  const totals = emptyTotals();
  const models = new Set<string>();
  let turnModel: string | undefined;
  let sawUsage = false;

  for (const event of evidence.events) {
    if (event.kind === 'settings') {
      // A turn-context record states the model the turn that FOLLOWS it ran under. Codex records
      // the model only here, so without it every Codex session would be unattributable.
      turnModel = event.settings.model ?? turnModel;
      continue;
    }
    if (event.kind !== 'usage') continue;

    const { usage } = event;
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const cachedRead = usage.cachedInputTokens ?? 0;
    const cacheWrite = usage.cacheCreationInputTokens ?? 0;
    const cacheWrite5m = usage.cacheWrite5mInputTokens ?? 0;
    const cacheWrite1h = usage.cacheWrite1hInputTokens ?? 0;
    // A negative or fractional token count is not a small error, it is a record this daemon does
    // not understand; one of them makes the whole session's total unstateable.
    if (![input, output, cachedRead, cacheWrite, cacheWrite5m, cacheWrite1h].every(isCountable)) {
      return { kind: 'refused', reason: 'ambiguous_token_accounting' };
    }
    if (!cacheWriteIsPlaceable(evidence.harness, cacheWrite)) {
      return { kind: 'refused', reason: 'ambiguous_token_accounting' };
    }

    sawUsage = true;
    totals.input += grossInput(evidence.harness, input, cachedRead, cacheWrite);
    totals.output += output;
    totals.cachedRead += cachedRead;
    totals.cacheWrite += cacheWrite;
    totals.cacheWrite5m += cacheWrite5m;
    totals.cacheWrite1h += cacheWrite1h;

    const spelling = usage.model ?? turnModel;
    const identity = normalizeAnalyticsModelIdentity(spelling);
    if (identity !== null) models.add(identity.modelId);
  }

  if (!sawUsage) return { kind: 'refused', reason: 'no_usage_evidence' };
  if (!Object.values(totals).every(value => Number.isSafeInteger(value))) {
    return { kind: 'refused', reason: 'ambiguous_token_accounting' };
  }

  // The split is reported only when the harness recorded one that accounts for the whole write.
  // A partial split priced as if it were complete would silently charge the remainder at nothing.
  const splitIsComplete = totals.cacheWrite5m + totals.cacheWrite1h === totals.cacheWrite;
  const [onlyModel] = models;

  return {
    kind: 'usage',
    usage: {
      pricingModel: models.size === 1 && onlyModel !== undefined ? onlyModel : null,
      inputTokens: totals.input,
      outputTokens: totals.output,
      cachedInputTokens: totals.cachedRead,
      cacheWriteInputTokens: totals.cacheWrite,
      cacheWrite5mInputTokens: splitIsComplete ? totals.cacheWrite5m : null,
      cacheWrite1hInputTokens: splitIsComplete ? totals.cacheWrite1h : null,
    },
  };
}
