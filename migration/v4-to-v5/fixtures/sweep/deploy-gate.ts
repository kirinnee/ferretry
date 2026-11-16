/**
 * What counts as "the hosted 5.0 app is live for this commit" (slot.ts `upgrade-v5`). Pure: slot.ts reads the runs with
 * `gh` and asks these functions, so the rule is tested without GitHub.
 *
 * A run counts only when ALL of these hold:
 *   - it is a run of the preview Pages workflow for EXACTLY this commit,
 *   - it was built from `rebuild/5.0` or `rebuild/5.0-after` (the preview follows 5.0-after while that branch exists),
 *   - its conclusion is `success`, and
 *   - its `Deploy PWA` job itself concluded `success`.
 * The last line matters: on a `rebuild/5.0` push while `rebuild/5.0-after` exists the workflow skips build, sign and deploy
 * (never backwards) and the RUN still ends `success`. A skipped deploy job deployed nothing, so it must not count.
 */
export const PREVIEW_DEPLOY_WORKFLOW = 'Deploy 5.0 preview PWA to Pages';
export const PREVIEW_DEPLOY_JOB = 'Deploy PWA';
export const PREVIEW_BRANCHES: readonly string[] = ['rebuild/5.0', 'rebuild/5.0-after'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The ids of the runs (newest first, as `gh run list` gives them) that might be a live deploy of `commit`. */
export function candidateRunIds(runs: unknown, commit: string): number[] {
  if (!Array.isArray(runs)) return [];
  const ids: number[] = [];
  for (const entry of runs) {
    if (
      isRecord(entry) &&
      entry.headSha === commit &&
      entry.conclusion === 'success' &&
      typeof entry.headBranch === 'string' &&
      PREVIEW_BRANCHES.includes(entry.headBranch) &&
      typeof entry.databaseId === 'number'
    )
      ids.push(entry.databaseId);
  }
  return ids;
}

/** True when the run's own `Deploy PWA` job concluded `success` (a skipped or missing job is false). */
export function deployJobSucceeded(view: unknown): boolean {
  if (!isRecord(view) || !Array.isArray(view.jobs)) return false;
  return view.jobs.some(job => isRecord(job) && job.name === PREVIEW_DEPLOY_JOB && job.conclusion === 'success');
}
