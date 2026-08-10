import {
  type BranchDeletionConfirmation,
  unclearedRemovalBlockers,
  type WorktreeRemovalBlocker,
  type WorktreeRemovalDecision,
  type WorktreeRemovalOverride,
} from '@ferretry/protocol';

/** The flags that authorize one class of destructive removal. */
export interface RemovalConsentFlags {
  /** Throw away uncommitted work in the worktree. */
  readonly discardChanges?: boolean;
  /** Remove a worktree whose commits exist nowhere else. */
  readonly acceptUnpushed?: boolean;
  /** Delete a branch that has not been merged anywhere. */
  readonly deleteUnmerged?: boolean;
  /** Delete the branch too, rather than leaving it behind. */
  readonly deleteBranch?: boolean;
  /** Delete a branch that existed before the worktree was created. */
  readonly deletePreexisting?: boolean;
}

/** Each consent flag, and the override it grants. Nothing else grants one. */
const CONSENT: ReadonlyArray<readonly [keyof RemovalConsentFlags, WorktreeRemovalOverride]> = [
  ['discardChanges', 'discard_worktree_changes'],
  ['acceptUnpushed', 'accept_unpushed_commits'],
];

/**
 * The overrides the caller consented to.
 *
 * There is deliberately no blanket `--force`. kteam had one, and it cleared blockers the caller had
 * never seen — including "another session is working here" — so a single flag could delete a
 * teammate's uncommitted work. Each override names exactly one class of loss.
 */
export function grantedOverrides(flags: RemovalConsentFlags): readonly WorktreeRemovalOverride[] {
  return CONSENT.filter(([flag]) => flags[flag] === true).map(([, override]) => override);
}

/** The branch-deletion confirmations the caller consented to. */
export function grantedConfirmations(flags: RemovalConsentFlags): readonly BranchDeletionConfirmation[] {
  if (flags.deleteBranch !== true) return [];
  const confirmations: BranchDeletionConfirmation[] = [];
  if (flags.deletePreexisting === true) confirmations.push('delete_preexisting_branch');
  if (flags.acceptUnpushed === true) confirmations.push('delete_unpushed_branch');
  if (flags.deleteUnmerged === true) confirmations.push('delete_unmerged_branch');
  return confirmations;
}

/** A blocker that the granted overrides do not clear. */
export interface UnclearedBlocker extends WorktreeRemovalBlocker {
  /** The flag that would clear it, or nothing when no flag can. */
  readonly flag: string | undefined;
}

/** The flag a caller would pass to grant each override. */
const FLAG_FOR: Readonly<Record<WorktreeRemovalOverride, string>> = {
  discard_worktree_changes: '--discard-changes',
  accept_unpushed_commits: '--accept-unpushed',
};

/**
 * Which blockers survive the consent given, each labelled with the flag that would clear it.
 *
 * THE DECISION IS THE PROTOCOL'S; ONLY THE LABEL IS THIS CLIENT'S. Which blockers survive is asked
 * by the daemon too, and a client answering it under its own rule would either promise a removal the
 * daemon then refuses or refuse one the daemon would have allowed. What the CLI adds is the part
 * nothing else can know: the name of its own flag, so a refusal says what to type next.
 */
export function unclearedBlockers(
  decision: WorktreeRemovalDecision,
  granted: readonly WorktreeRemovalOverride[],
): readonly UnclearedBlocker[] {
  return unclearedRemovalBlockers(decision.blockers, granted).map(blocker => ({
    ...blocker,
    flag: blocker.override === undefined ? undefined : FLAG_FOR[blocker.override],
  }));
}
