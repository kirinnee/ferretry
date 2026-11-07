/** How safely an in-flight operation can be interrupted for account migration. */
export type InflightVerdict = 'safe_to_kill' | 're_armable' | 'destructive_to_interrupt' | 'unknown';

const rank: Readonly<Record<InflightVerdict, number>> = {
  safe_to_kill: 0,
  re_armable: 1,
  unknown: 2,
  destructive_to_interrupt: 3,
};

/** Returns the most dangerous verdict, deliberately treating unknown work as unsafe. */
export function worstVerdict(verdicts: readonly InflightVerdict[]): InflightVerdict {
  let worst: InflightVerdict = 'safe_to_kill';
  for (const verdict of verdicts) if (rank[verdict] > rank[worst]) worst = verdict;
  return worst;
}

/** Migration must refuse destructive and unclassified work unless explicitly forced. */
export function verdictBlocksMigration(verdict: InflightVerdict): boolean {
  return verdict === 'destructive_to_interrupt' || verdict === 'unknown';
}
