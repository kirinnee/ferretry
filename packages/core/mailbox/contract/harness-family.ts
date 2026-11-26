import {
  isRecordedHarness,
  isRecordedHarnessKey,
  recordedHarnessOf,
  type RecordedFamily,
} from '@ferretry/core-ferrets/contract';

/**
 * Ferrets' harness PLUGIN KEY as the send policy and the transcript readers name the family: `claude-code` is `claude`. The
 * key must be a row of the family table (Ferrets' `records.ts`) EXACTLY: a harness the table has no row for is NO family, and
 * so is the family word `claude` itself, which is not a key (a third harness may register under it). It gets no inline paste
 * and no transcript evidence, so nothing is pasted whole or typed again on a guess.
 */
export const harnessFamily = (key: string): RecordedFamily | undefined => {
  if (!isRecordedHarnessKey(key)) return undefined;
  const family = recordedHarnessOf(key);
  return isRecordedHarness(family) ? family : undefined;
};

/**
 * Whether a harness FAMILY is reached through the Claude channel (an MCP server the Claude CLI listens on). Only Claude's is:
 * Codex has no channel, and a harness this build has no family for is typed to, never pushed down a channel built for Claude.
 */
export const hasClaudeChannel = (family: string | undefined): boolean =>
  byHarnessFamily(family, { claude: () => true, codex: () => false, unknown: () => false });

/** What each family does, and what a harness the table has no row for does: a case a caller must write out. */
export interface FamilyCases<T> {
  readonly claude: () => T;
  readonly codex: () => T;
  readonly unknown: () => T;
}

/**
 * Total over a family TOKEN (`claude`, `codex`, what {@link harnessFamily} answers and what records and parsers carry): the
 * family's case, or `unknown` for anything else (a plugin key included, which {@link harnessFamily} turns into its family
 * first) and for no harness at all. Where a caller must refuse instead, it uses Ferrets' `byRecordedHarness`, which throws;
 * this one is for a policy whose honest answer for a harness it cannot read is "no" (no channel, no retraction proof),
 * written out where it is decided.
 */
export function byHarnessFamily<T>(family: string | undefined, cases: FamilyCases<T>): T {
  return family !== undefined && isRecordedHarness(family) ? cases[family]() : cases.unknown();
}
