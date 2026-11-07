/**
 * The words and the small decisions behind "Move to Codex… / Move to Claude…": which CLI a ferret would move to, what
 * a conversion preview says in plain sentences, and how a refused move is read. Pure — the page draws from it.
 *
 * Which accounts a ferret could move onto is not decided here: the move page offers Runtimes' account slot with the
 * OTHER harness, and the runtimes it draws are the ones that can serve.
 */

import {
  type ConversionSummary,
  type HarnessKey,
  type MoveRefusal,
  MoveRefusedBodySchema,
} from '../../../contract/index.ts';
import type { MoveCallFailure } from './call-failure.ts';

/** The short name the sentences use: the CLI's own. */
export const HARNESS_SHORT: Readonly<Record<HarnessKey, string>> = { 'claude-code': 'Claude', codex: 'Codex' };

/** The product name the small print uses. */
export const harnessProduct = (harness: HarnessKey): string => (harness === 'claude-code' ? 'Claude Code' : 'Codex');

export const otherHarness = (harness: HarnessKey): HarnessKey => (harness === 'claude-code' ? 'codex' : 'claude-code');

/** The word a recorded conversation harness (`claude`, `codex`) is said with. */
const recordedShort = (harness: ConversionSummary['sourceHarness']): string =>
  harness === 'claude' ? 'Claude' : 'Codex';
const recordedProduct = (harness: ConversionSummary['sourceHarness']): string =>
  harness === 'claude' ? 'Claude Code' : 'Codex';

const count = (value: number, one: string, many = `${one}s`): string => `${value} ${value === 1 ? one : many}`;

export interface ConversionSentences {
  /** What moves, and what was left out to fit. */
  readonly headline: string;
  /** Each part of the conversation that is carried in a different shape. */
  readonly carried: readonly string[];
  /** What is not carried at all; null when everything is. */
  readonly notCarried: string | null;
  readonly cutNewest: string | null;
  /** The honest limit, said once. */
  readonly note: string;
  /** Versions, in small print. */
  readonly versions: string;
}

/** A ready preview, in the words a person reads before pressing the button. */
export const conversionSentences = (summary: ConversionSummary, targetModel: string): ConversionSentences => {
  const target = recordedShort(summary.targetHarness);
  const source = recordedShort(summary.sourceHarness);
  const headline =
    summary.omittedTurns > 0
      ? `${summary.keptTurns} of ${summary.turns} turns will move to ${target} (${count(summary.omittedTurns, 'older turn')} left out to fit ${targetModel}’s window).`
      : `All ${count(summary.turns, 'turn')} will move.`;
  const carried: string[] = [];
  if (summary.nativeToolCalls > 0)
    carried.push(
      summary.nativeToolCalls === 1
        ? `1 shell command carries over as a ${target} command.`
        : `${summary.nativeToolCalls} shell commands carry over as ${target} commands.`,
    );
  if (summary.toolCallsAsText > 0)
    carried.push(
      summary.toolCallsAsText === 1
        ? '1 other tool call becomes a short text note.'
        : `${summary.toolCallsAsText} other tool calls become short text notes.`,
    );
  if (summary.attachments > 0)
    carried.push(
      summary.attachments === 1
        ? '1 attachment carries over as a file reference.'
        : `${summary.attachments} attachments carry over as file references.`,
    );
  const dropped = [
    ['thinking', summary.dropped.reasoning],
    ['subagent work', summary.dropped.sidechains],
    ['harness notes', summary.dropped.internal],
    ['earlier summaries', summary.dropped.compactions],
  ] as const;
  const left = dropped.filter(([, amount]) => amount > 0).map(([name, amount]) => `${name} (${amount})`);
  return {
    headline,
    carried,
    notCarried: left.length === 0 ? null : `Not carried: ${left.join(', ')}.`,
    cutNewest: summary.cutNewest ? 'The newest turn is too long and will be shortened.' : null,
    note: `Tool calls other than shell commands become text, so ${target} can read what happened but can’t re-run them. The ${source} conversation stays on disk.`,
    versions: `${recordedProduct(summary.targetHarness)} ${summary.targetVersion} · converted from ${recordedProduct(summary.sourceHarness)}${summary.sourceVersion === undefined ? '' : ` ${summary.sourceVersion}`}`,
  };
};

/** How a move the daemon refused is shown: in-flight work that can be forced past, or a sentence. */
export type ConversionFailure =
  | { readonly kind: 'inflight'; readonly refusal: MoveRefusal }
  | { readonly kind: 'message'; readonly text: string };

export const conversionFailure = (reason: MoveCallFailure): ConversionFailure => {
  if (reason.code === 'move_refused') {
    const body = MoveRefusedBodySchema.safeParse(reason.body);
    const refusal = body.success ? body.data.inflight : undefined;
    if (refusal?.items.some(item => item.blocks) === true) return { kind: 'inflight', refusal };
  }
  return { kind: 'message', text: reason.message };
};

const REFUSED_CAUSE: Readonly<Record<MoveRefusal['blockedBy'], string>> = {
  unknown: 'Ferretry can’t tell if what the agent is running is safe to stop',
  destructive: 'the agent is running something that could be left half-done if it is stopped',
  unreadable: 'Ferretry couldn’t check what the agent is running',
};

/** Why the daemon would not stop what the agent is running, as a clause. */
export const refusedCause = (refusal: MoveRefusal): string => REFUSED_CAUSE[refusal.blockedBy];
