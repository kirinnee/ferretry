/**
 * The rules of spending, apart from any network: how much was spent today, whether this call may go, must ask, or is
 * refused, and the ask itself. The ask is the EXISTING owner path (Asks: an ask on the agenda, answered Approve or
 * Reject by the owner); Create raises it as the `create-spend` source and reads the owner's answer back. Nothing here
 * can spend: it says go, ask or refuse, and the caller does the one thing it says.
 */
import { type AskDraft, type AsksApi, type EntryId, EntryIdSchema, type SourceKey } from '@ferretry/core-asks/contract';
import type { StatePort } from '@ferretry/kernel/contract';
import {
  CREATE_SPEND_SOURCE,
  type MicroUsd,
  type ResolvedCreateConfig,
  SPEND_LEDGER,
  type SpendRecord,
  type SpendTool,
  usdWords,
} from '../../contract/index.ts';

const MICRO = 1_000_000;
/** The ledger window read for a day's sum and a request's earlier spends: far more than any day holds. */
const LEDGER_WINDOW_BYTES = 4 * 1024 * 1024;

const SOURCE = CREATE_SPEND_SOURCE as SourceKey;

/** `YYYY-MM-DD` of an instant in an IANA zone. */
export function dayOf(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: string): string => parts.find(each => each.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Everything the ledger adds up for one decision. */
export interface SpendFacts {
  readonly spentToday: MicroUsd;
  /** How many times this very request has already been paid for (an approval is spent once, so each time needs its own). */
  readonly earlierSpends: number;
}

export class SpendLedger {
  constructor(private readonly state: StatePort) {}

  async facts(day: string, request: string): Promise<SpendFacts> {
    const { records } = await this.state.tail(SPEND_LEDGER, { maxBytes: LEDGER_WINDOW_BYTES });
    // A refund repeats the line it gives back and counts against it, so every sum below is net of refunds.
    const sign = (record: SpendRecord): 1 | -1 => (record.refund === true ? -1 : 1);
    return {
      spentToday: records
        .filter(record => record.day === day)
        .reduce((sum, record) => sum + sign(record) * record.microUsd, 0),
      earlierSpends: records
        .filter(record => record.request === request)
        .reduce((sum, record) => sum + sign(record), 0),
    };
  }

  /** Reserves a spend BEFORE the run: money that may be billed is counted from the moment it is risked. */
  async record(entry: SpendRecord): Promise<void> {
    await this.state.append(SPEND_LEDGER, entry);
  }

  /** Gives a reservation back, after a run fal definitely did not bill. Appends; never rewrites the ledger. */
  async refund(entry: SpendRecord): Promise<void> {
    await this.state.append(SPEND_LEDGER, { ...entry, refund: true });
  }
}

export type SpendVerdict =
  | { readonly kind: 'go' }
  | { readonly kind: 'ask'; readonly threshold: MicroUsd }
  | { readonly kind: 'refuse'; readonly sentence: string };

/** The two limits, in order: the day's cap is a wall (nothing is asked), the per-call threshold is a question. */
export function judgeSpend(cost: MicroUsd, facts: SpendFacts, config: ResolvedCreateConfig): SpendVerdict {
  const cap = Math.round(config.limits.dailyUsd * MICRO);
  if (facts.spentToday + cost > cap)
    return {
      kind: 'refuse',
      sentence: `this would pass the daily limit of ${usdWords(cap)} for creative tools (${usdWords(facts.spentToday)} spent so far today, this call ${usdWords(cost)}). It resets at midnight in ${config.timeZone}; only the owner can raise the limit.`,
    };
  const threshold = Math.round(config.limits.askAboveUsd * MICRO);
  return cost > threshold ? { kind: 'ask', threshold } : { kind: 'go' };
}

export type Approval =
  | { readonly kind: 'approved' }
  | { readonly kind: 'declined' }
  | { readonly kind: 'waiting'; readonly ask: string }
  | { readonly kind: 'unavailable'; readonly sentence: string };

/** What this plugin asks of Asks. */
export type SpendAsks = Pick<AsksApi, 'raise' | 'answers'>;

export interface AskDetails {
  readonly tool: SpendTool;
  readonly ferret: string;
  readonly request: string;
  readonly earlierSpends: number;
  readonly cost: MicroUsd;
  readonly model: string;
  /** What is being bought, in the owner's words: `one picture`, `a voiceover`. */
  readonly what: string;
  readonly threshold: MicroUsd;
  /** `Prompt` or `Text`: the heading over the ferret's own words. */
  readonly promptLabel: string;
  /** The ferret's own words for it, shown so the owner knows what they are paying for. */
  readonly prompt: string;
}

const PROMPT_SHOWN = 400;

/**
 * The owner's say on one dear call. The ask is raised once per (request, how many times it was paid for, the price
 * asked), so a ferret that asks again finds the same ask, an answered ask is spent by the one call it approved, the same
 * words asked for a second time ask a second time, and an approval holds only up to the price it was given for: a live
 * price above it asks again, one at or below it goes through.
 */
export async function approvalFor(asks: SpendAsks, details: AskDetails): Promise<Approval> {
  const prefix = `${details.request}-${details.earlierSpends}-`;
  const entry = EntryIdSchema.safeParse(`${prefix}${details.cost}`);
  if (!entry.success) return { kind: 'unavailable', sentence: 'the approval could not be named, so nothing was sent' };
  const shown = details.prompt.length > PROMPT_SHOWN ? `${details.prompt.slice(0, PROMPT_SHOWN - 1)}…` : details.prompt;
  const draft: AskDraft = {
    source: SOURCE,
    ref: { tool: details.tool, request: details.request },
    entry: entry.data as EntryId,
    kind: 'permission',
    subject: `Spend ${usdWords(details.cost)} on ${details.what} (${details.model})?`,
    why: `A ferret asked for ${details.what} that costs ${usdWords(details.cost)}, over your ${usdWords(details.threshold)} limit for one creative call. Nothing is spent until you approve.`,
    howToResolve:
      'Approve to let the ferret make it, or reject to refuse. Approving spends once; asking again asks again.',
    context: `${details.promptLabel}:\n${shown}`,
    raisedBy: { kind: 'daemon' },
    ferret: details.ferret,
    blocking: true,
  };
  try {
    const all = await asks.answers({ source: SOURCE });
    // An approval of this request, at this count, for AT LEAST the price now asked.
    const covered = all.some(
      answer =>
        answer.ferret === details.ferret &&
        answer.effect === 'approve' &&
        answer.entry.startsWith(prefix) &&
        Number(answer.entry.slice(prefix.length)) >= details.cost,
    );
    if (covered) return { kind: 'approved' };
    const raised = await asks.raise(draft);
    const last = all.filter(answer => answer.ferret === raised.ferret && answer.ask === raised.id).at(-1);
    if (last === undefined) return { kind: 'waiting', ask: raised.id };
    return last.effect === 'approve' ? { kind: 'approved' } : { kind: 'declined' };
  } catch (error) {
    return {
      kind: 'unavailable',
      sentence: `the owner could not be asked (${error instanceof Error ? error.message : 'the agenda refused'}), so nothing was sent`,
    };
  }
}
