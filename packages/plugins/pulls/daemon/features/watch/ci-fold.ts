import type { CiState } from '../../../contract/index.ts';

/** One check run or workflow run, as far as the fold needs it. */
export interface CiSignal {
  readonly status?: string | null | undefined;
  readonly conclusion?: string | null | undefined;
}

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
const PASSED = new Set(['success', 'neutral', 'skipped', 'stale']);
const WAITING = new Set(['queued', 'waiting', 'pending', 'requested']);

/**
 * One word for a commit's CI from every check run and workflow run it has. Worst first: a failure shows at once even
 * while other runs go on (that is the moment to tell), then running, queued, cancelled, passing. `action_required` (a
 * run waiting for somebody to approve it) counts as queued, not as a failure. No runs at all reads `none`.
 */
export function foldCi(signals: readonly CiSignal[]): CiState {
  if (signals.length === 0) return 'none';
  let failed = false;
  let running = false;
  let queued = false;
  let cancelled = false;
  for (const signal of signals) {
    const status = signal.status ?? '';
    const conclusion = signal.conclusion ?? '';
    if (status === 'in_progress') running = true;
    else if (WAITING.has(status)) queued = true;
    else if (FAILED.has(conclusion)) failed = true;
    else if (conclusion === 'cancelled') cancelled = true;
    else if (conclusion === 'action_required') queued = true;
    else if (!PASSED.has(conclusion)) queued = true;
  }
  if (failed) return 'failing';
  if (running) return 'running';
  if (queued) return 'queued';
  if (cancelled) return 'cancelled';
  return 'passing';
}
