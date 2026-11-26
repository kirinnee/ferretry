import { isRecordedHarness, recordedHarnessOf, type RecordedFamily } from '@ferretry/core-ferrets/contract';

/**
 * Ferrets' harness key as the send policy and the transcript readers name the family: `claude-code` is `claude`. A
 * harness the family table (Ferrets' `records.ts`) has no row for is NO family: it gets no inline paste and no transcript
 * evidence, so nothing is pasted whole or typed again on a guess.
 */
export const harnessFamily = (key: string): RecordedFamily | undefined => {
  const family = recordedHarnessOf(key);
  return isRecordedHarness(family) ? family : undefined;
};

/** What each family does, and what a harness the table has no row for does: a case a caller must write out. */
export interface FamilyCases<T> {
  readonly claude: () => T;
  readonly codex: () => T;
  readonly unknown: () => T;
}

/**
 * Total over a harness: the family's case, or `unknown` for a harness with no family (and for no harness at all). Where a
 * caller must refuse instead, it uses Ferrets' `byRecordedHarness`, which throws; this one is for a policy whose honest
 * answer for a harness it cannot read is "no" (no channel, no retraction proof), written out where it is decided.
 */
export function byHarnessFamily<T>(harness: string | undefined, cases: FamilyCases<T>): T {
  const family = harness === undefined ? undefined : harnessFamily(harness);
  return family === undefined ? cases.unknown() : cases[family]();
}
