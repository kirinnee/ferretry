/**
 * What counts as "the hosted 5.0 app is live for this commit" and how the kit moves the preview ref to a commit
 * (preview-ref.ts runs these, slot.ts hands it the real `git` and `gh`). Pure: the rules are tested without GitHub.
 *
 * THE PREVIEW APP FOLLOWS THE OWNER'S SLOT. The preview Pages workflow (`pwa-pages-v5.yaml`) triggers only on a push to ONE
 * ref, `refs/heads/rebuild/preview`; a merge to rebuild/5.0 or rebuild/5.0-after deploys nothing. So `upgrade-v5` /
 * `reset-v5`, given a build of commit X, first make that ref point at X, then wait for that push's run.
 *
 * Moving the ref (`decidePush`): create it, or fast-forward it, or leave it when it already is X. NEVER backwards: X must be a
 * descendant of the commit the ref holds (the installed app refuses a release whose sequence is lower than the one it holds).
 *
 * A run counts as live only when ALL of these hold (`waitVerdict`):
 *   - it is a run of the preview Pages workflow for EXACTLY this commit,
 *   - it was built from `rebuild/preview`,
 *   - its conclusion is `success`, and
 *   - its `Deploy PWA` job itself concluded `success`.
 * The last line matters: when the workflow's gate refuses a push (not a fast-forward) it skips build, sign and deploy and the RUN
 * still ends `success`. A skipped deploy job deployed nothing, so it must not count.
 */
export const PREVIEW_DEPLOY_WORKFLOW = 'Deploy 5.0 preview PWA to Pages';
export const PREVIEW_DEPLOY_JOB = 'Deploy PWA';
export const PREVIEW_REF = 'rebuild/preview';
export const PREVIEW_REMOTE = 'origin';

/** How long the kit waits: for a run to show up after the push, and for the run to finish (build, sign and deploy queue). */
export const PREVIEW_APPEAR_MS = 4 * 60_000;
export const PREVIEW_TOTAL_MS = 40 * 60_000;
export const PREVIEW_POLL_MS = 20_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export type RunState = 'pending' | 'success' | { readonly ended: string };

/** The runs (newest first, as `gh run list` gives them) of the preview workflow for EXACTLY `commit` on the preview ref. */
export function previewRunsFor(runs: unknown, commit: string): { readonly id: number; readonly state: RunState }[] {
  if (!Array.isArray(runs)) return [];
  const found: { id: number; state: RunState }[] = [];
  for (const entry of runs) {
    if (
      !isRecord(entry) ||
      entry.headSha !== commit ||
      entry.headBranch !== PREVIEW_REF ||
      typeof entry.databaseId !== 'number'
    )
      continue;
    if (entry.status !== undefined && entry.status !== 'completed')
      found.push({ id: entry.databaseId, state: 'pending' });
    else if (entry.conclusion === 'success') found.push({ id: entry.databaseId, state: 'success' });
    else
      found.push({
        id: entry.databaseId,
        state: { ended: typeof entry.conclusion === 'string' ? entry.conclusion : 'unknown' },
      });
  }
  return found;
}

/** True when the run's own `Deploy PWA` job concluded `success` (a skipped or missing job is false). */
export function deployJobSucceeded(view: unknown): boolean {
  if (!isRecord(view) || !Array.isArray(view.jobs)) return false;
  return view.jobs.some(job => isRecord(job) && job.name === PREVIEW_DEPLOY_JOB && job.conclusion === 'success');
}

export type PushDecision = 'create' | 'already' | 'fast-forward' | 'refuse';

/**
 * What to do to point the preview ref at `commit`. `current` is what the ref holds now (undefined: it does not exist yet);
 * `currentIsAncestor` is whether that commit is an ancestor of `commit` (undefined: it could not be determined, which refuses).
 */
export function decidePush(
  current: string | undefined,
  commit: string,
  currentIsAncestor: boolean | undefined,
): PushDecision {
  if (current === undefined) return 'create';
  if (current === commit) return 'already';
  return currentIsAncestor === true ? 'fast-forward' : 'refuse';
}

export interface Observed {
  readonly id: number;
  /** pending: still running; deployed: green and its deploy job succeeded; skipped: green but nothing was deployed; ended: any other end. */
  readonly state: 'pending' | 'deployed' | 'skipped' | { readonly ended: string };
}

export type Verdict =
  | { readonly kind: 'live' }
  | { readonly kind: 'wait' }
  | { readonly kind: 'refuse'; readonly why: string };

/** What the observed runs for the commit say, `elapsedMs` after the push (or after the kit started waiting). */
export function waitVerdict(observed: readonly Observed[], elapsedMs: number): Verdict {
  if (observed.some(run => run.state === 'deployed')) return { kind: 'live' };
  if (elapsedMs > PREVIEW_TOTAL_MS)
    return {
      kind: 'refuse',
      why: `the deploy had not finished ${String(Math.round(PREVIEW_TOTAL_MS / 60_000))} minutes after the push`,
    };
  if (observed.some(run => run.state === 'pending')) return { kind: 'wait' };
  if (observed.length === 0) {
    return elapsedMs > PREVIEW_APPEAR_MS
      ? {
          kind: 'refuse',
          why: `no "${PREVIEW_DEPLOY_WORKFLOW}" run for this commit appeared on ${PREVIEW_REF} within ${String(Math.round(PREVIEW_APPEAR_MS / 60_000))} minutes`,
        }
      : { kind: 'wait' };
  }
  const reasons = observed.map(run =>
    run.state === 'skipped'
      ? `run ${String(run.id)} was green but its "${PREVIEW_DEPLOY_JOB}" job did not succeed (the workflow's gate skips a push that is not a fast-forward, and the deploy job refuses a commit that is no longer the head of ${PREVIEW_REF})`
      : `run ${String(run.id)} ended ${typeof run.state === 'object' ? run.state.ended : 'unknown'}`,
  );
  return { kind: 'refuse', why: reasons.join('; ') };
}
