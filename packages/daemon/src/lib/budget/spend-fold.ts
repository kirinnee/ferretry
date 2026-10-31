/**
 * The transcript records that cost money, one at a time, as the spend meter reads them (docs/budgets.md).
 *
 * The analytics fold (`../analytics/usage-fold.ts`) answers "what did this FINISHED session cost", once,
 * from the whole file. A budget asks something else: what did the requests made SINCE an instant cost, while
 * the session is still running — so each usage record is counted on its own, at its own timestamp, as the
 * transcript grows. The token arithmetic is the analytics fold's own helpers, so the two can never disagree
 * about what one request billed:
 *
 * - Claude writes one line per content block, each repeating its message's full usage. A record carries its
 *   `messageId`, and the meter keeps only the LAST record of a message (the one written when the response
 *   finished), replacing what it counted for an earlier line of the same message.
 * - Codex sometimes repeats the previous request's figures under the same running total; a record whose
 *   running total did not move is no new request (carried across reads in {@link SpendFoldCarry}).
 * - Codex states the model on a turn-context record before the usage; carried too.
 *
 * Pure: the caller prices.
 */
import {
  cacheWriteIsPlaceable,
  grossInput,
  isCountable,
  reasoningIsBilledApart,
  repeatsTheLastTotal,
} from '../analytics/usage-fold.ts';
import type { AnalyticsTokenUsage } from '../analytics/pricing.ts';
import type { TranscriptEvent, TranscriptHarness } from '../transcript/types.ts';

/** What one read leaves for the next: Codex's model and running total. */
export interface SpendFoldCarry {
  readonly turnModel?: string;
  readonly runningTotal?: number;
}

/** One request a transcript records, ready to price. */
export interface SpendRecord {
  /** The harness's timestamp, in milliseconds. */
  readonly atMs: number;
  /** Claude's message id: a later record with the same id replaces this one. */
  readonly messageId?: string;
  /** What to price, or `undefined` when the record's figures cannot be stated (it is counted unpriced). */
  readonly usage?: AnalyticsTokenUsage;
}

/** The spend records in `events`, in order, and the carry for the next read. Records with no timestamp are skipped. */
export function spendRecords(
  events: readonly TranscriptEvent[],
  harness: TranscriptHarness,
  carry: SpendFoldCarry,
): { readonly records: readonly SpendRecord[]; readonly carry: SpendFoldCarry } {
  let turnModel = carry.turnModel;
  let runningTotal = carry.runningTotal;
  const records: SpendRecord[] = [];
  for (const event of events) {
    if (event.kind === 'settings') {
      turnModel = event.settings.model ?? turnModel;
      continue;
    }
    if (event.kind !== 'usage') continue;
    const { usage } = event;
    if (repeatsTheLastTotal(usage.sessionTotalTokens, runningTotal)) continue;
    runningTotal = usage.sessionTotalTokens ?? runningTotal;
    const atMs = event.timestamp === undefined ? Number.NaN : Date.parse(event.timestamp);
    // A record the harness did not stamp cannot be placed in a day, so no period can claim it.
    if (Number.isNaN(atMs)) continue;
    const messageId = event.harness === 'claude' ? event.messageId : undefined;
    records.push({
      atMs,
      ...(messageId === undefined ? {} : { messageId }),
      ...priceable(harness, usage, usage.model ?? turnModel, event.timestamp as string),
    });
  }
  return {
    records,
    carry: {
      ...(turnModel === undefined ? {} : { turnModel }),
      ...(runningTotal === undefined ? {} : { runningTotal }),
    },
  };
}

type UsageFigures = Extract<TranscriptEvent, { kind: 'usage' }>['usage'];

/** One record's figures as pricing reads them, or nothing when they cannot be stated. */
function priceable(
  harness: TranscriptHarness,
  usage: UsageFigures,
  model: string | undefined,
  createdAt: string,
): { readonly usage?: AnalyticsTokenUsage } {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cachedRead = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  const cacheWrite5m = usage.cacheWrite5mInputTokens ?? 0;
  const cacheWrite1h = usage.cacheWrite1hInputTokens ?? 0;
  const reasoning = usage.reasoningTokens ?? 0;
  if (![input, output, cachedRead, cacheWrite, cacheWrite5m, cacheWrite1h, reasoning].every(isCountable)) return {};
  if (!cacheWriteIsPlaceable(harness, cacheWrite)) return {};
  const splitIsComplete = cacheWrite5m + cacheWrite1h === cacheWrite;
  return {
    usage: {
      // The spelling as written: pricing resolves it against the catalog's own aliases.
      pricingModel: model ?? null,
      createdAt,
      inputTokens: grossInput(harness, input, cachedRead, cacheWrite),
      outputTokens: output,
      cachedInputTokens: cachedRead,
      cacheWriteInputTokens: cacheWrite,
      cacheWrite5mInputTokens: splitIsComplete ? cacheWrite5m : null,
      cacheWrite1hInputTokens: splitIsComplete ? cacheWrite1h : null,
      reasoningTokens:
        reasoningIsBilledApart(harness) && usage.reasoningTokens !== undefined ? usage.reasoningTokens : null,
    },
  };
}
