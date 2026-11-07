/**
 * The words and the small decisions behind "Move to Codex… / Move to Claude…": which harness a ferret
 * would move to, which accounts it could move onto, what a conversion preview says in plain sentences,
 * and how a refused move is read. Pure — the sheet and the Actions menu draw from it, so neither can
 * say something the other does not.
 */

import { type ConversionSummary, type MigrationRefusal, MigrationRefusedBodySchema } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { PickerAccount } from '../../lib/account-picker-catalog.ts';
import { HARNESS_SHORT, type HarnessKind, otherHarness } from '../fleet/credentials/credentials-model.ts';

/** The name the small print uses: the CLI's own. */
export const harnessProduct = (harness: HarnessKind): string => (harness === 'claude' ? 'Claude Code' : 'Codex');

/** The accounts a ferret on `harness` could be moved onto: agent runtimes of the OTHER harness that can serve. */
export const convertibleAccounts = (
  accounts: readonly PickerAccount[] | null,
  harness: HarnessKind,
): readonly PickerAccount[] =>
  (accounts ?? []).filter(account => account.kind === otherHarness(harness) && account.agent && account.available);

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
  const target = HARNESS_SHORT[summary.targetHarness];
  const source = HARNESS_SHORT[summary.sourceHarness];
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
    versions: `${harnessProduct(summary.targetHarness)} ${summary.targetVersion} · converted from ${harnessProduct(summary.sourceHarness)}${summary.sourceVersion === undefined ? '' : ` ${summary.sourceVersion}`}`,
  };
};

/** How a move the daemon refused is shown: in-flight work that can be forced past, or a sentence. */
export type ConversionFailure =
  | { readonly kind: 'inflight'; readonly refusal: MigrationRefusal }
  | { readonly kind: 'message'; readonly text: string };

export const conversionFailure = (reason: unknown): ConversionFailure => {
  if (reason instanceof FyHttpError && reason.code === 'migration_refused') {
    const body = MigrationRefusedBodySchema.safeParse(reason.body);
    const refusal = body.success ? body.data.inflight : undefined;
    if (refusal?.items.some(item => item.blocks) === true) return { kind: 'inflight', refusal };
  }
  return { kind: 'message', text: reason instanceof Error ? reason.message : String(reason) };
};
