import type { ConversationEntry } from './conversation.ts';

/**
 * Keeping the newest history that fits the target model's context window.
 *
 * WHY THE NEWEST, WHOLE TURNS. A conversion exists so the agent can carry on, and what it needs to
 * carry on is the most recent work; the oldest turns are the ones a long session has usually moved
 * past. A turn — one thing the person said and everything the agent did about it — is kept or omitted
 * whole, so the history never opens on half an exchange. Only when the newest turn alone does not fit
 * is it cut inside: its opening message is kept, shortened if it must be, and then as much of its
 * newest work as fits.
 *
 * WHY AN ESTIMATE. The exact count depends on the target's tokenizer, which is not available here and
 * differs between providers. Three characters per token over-counts ordinary prose and is close for
 * code and logs, so the estimate errs towards keeping less, which is the recoverable direction.
 */

/** Characters per token, deliberately pessimistic. */
const CHARACTERS_PER_TOKEN = 3;

/**
 * The share of the target window a converted history may fill.
 *
 * The rest is headroom: the target harness's own system prompt and tool declarations (tens of
 * thousands of tokens on both), the context it injects every turn, and room for the agent to keep
 * working before its own compaction has to start.
 */
const HISTORY_SHARE = 0.6;

/** The token budget a converted history must fit for a target window of `contextWindow` tokens. */
export function historyBudget(contextWindow: number): number {
  return Math.max(0, Math.floor(contextWindow * HISTORY_SHARE));
}

/** The estimated token cost of one entry. Attachments cross as a reference line, not as bytes. */
export function entryTokens(entry: ConversationEntry): number {
  const characters =
    entry.kind === 'user'
      ? entry.text.length + entry.attachments.length * 120
      : entry.kind === 'assistant'
        ? entry.text.length
        : entry.kind === 'shell'
          ? entry.command.length + entry.output.length + 40
          : entry.name.length + entry.input.length + (entry.output?.length ?? 0) + 20;
  return Math.ceil(characters / CHARACTERS_PER_TOKEN);
}

export interface BoundedHistory {
  readonly entries: readonly ConversationEntry[];
  /** Turns in the source, after harness-internal records were dropped. */
  readonly turns: number;
  /** Turns kept whole or in part. */
  readonly keptTurns: number;
  /** Turns omitted entirely, which the target is told about. */
  readonly omittedTurns: number;
  /** Whether the newest turn itself had to be cut to fit. */
  readonly cutNewest: boolean;
  readonly estimatedTokens: number;
  readonly budgetTokens: number;
}

/** The entries grouped into turns, each opening at something the person said. */
export function turnsOf(entries: readonly ConversationEntry[]): readonly (readonly ConversationEntry[])[] {
  const turns: ConversationEntry[][] = [];
  for (const entry of entries) {
    const current = turns.at(-1);
    if (entry.kind === 'user' || current === undefined) turns.push([entry]);
    else current.push(entry);
  }
  return turns;
}

const sum = (entries: readonly ConversationEntry[]): number =>
  entries.reduce((total, entry) => total + entryTokens(entry), 0);

/** The newest turn cut to `budget`: its opening (shortened if need be), then its newest work. */
function cutTurn(turn: readonly ConversationEntry[], budget: number): readonly ConversationEntry[] {
  const [opening, ...rest] = turn as readonly [ConversationEntry, ...ConversationEntry[]];
  // The opening may take at most a quarter of the budget, so the newest work keeps the rest.
  const openingLimit = Math.floor(budget / 4);
  const head =
    entryTokens(opening) <= openingLimit || opening.kind !== 'user'
      ? opening
      : {
          ...opening,
          text: `${opening.text.slice(0, openingLimit * CHARACTERS_PER_TOKEN)}… [message truncated to fit]`,
        };
  // An agent opening too big to keep is left out, so the newest work still gets the whole budget.
  const headFits = entryTokens(head) <= budget;
  let room = headFits ? budget - entryTokens(head) : budget;
  const tail: ConversationEntry[] = [];
  for (const entry of rest.toReversed()) {
    const cost = entryTokens(entry);
    if (cost > room) break;
    room -= cost;
    tail.unshift(entry);
  }
  return headFits ? [head, ...tail] : tail;
}

export function boundHistory(entries: readonly ConversationEntry[], budgetTokens: number): BoundedHistory {
  const turns = turnsOf(entries);
  const kept: (readonly ConversationEntry[])[] = [];
  let used = 0;
  for (const turn of turns.toReversed()) {
    const cost = sum(turn);
    if (used + cost > budgetTokens) break;
    used += cost;
    kept.unshift(turn);
  }
  const newest = turns.at(-1);
  if (kept.length === 0 && newest !== undefined) {
    const cut = cutTurn(newest, budgetTokens);
    return {
      entries: cut,
      turns: turns.length,
      keptTurns: cut.length === 0 ? 0 : 1,
      omittedTurns: turns.length - (cut.length === 0 ? 0 : 1),
      cutNewest: true,
      estimatedTokens: sum(cut),
      budgetTokens,
    };
  }
  return {
    entries: kept.flat(),
    turns: turns.length,
    keptTurns: kept.length,
    omittedTurns: turns.length - kept.length,
    cutNewest: false,
    estimatedTokens: used,
    budgetTokens,
  };
}
