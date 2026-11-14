/**
 * What the app says of a daemon that is behind, and the request each button sends. Pure: the views draw it.
 * The daemon decides what is behind (`available`); the app never compares versions itself.
 */
import {
  type DaemonUpdateStartRequest,
  type DaemonUpdateView,
  DAEMON_UPDATE_CODES,
  knownLatestRelease,
} from '../../contract/index.ts';

/** The one line the notice shows, or `undefined` when there is nothing to say. */
export function behindSentence(view: DaemonUpdateView): string | undefined {
  const latest = knownLatestRelease(view.check);
  if (!view.available || latest === undefined) return undefined;
  return `This daemon is behind: ${view.current} runs, ${latest.version} is out.`;
}

/** What the update buttons offer for this view. */
export type UpdateOffer =
  | { readonly kind: 'none' }
  | { readonly kind: 'busy'; readonly sentence: string }
  | {
      readonly kind: 'steps';
      readonly explanation: string;
      readonly steps: readonly { command: string; note?: string }[];
    }
  | { readonly kind: 'update'; readonly target: string; readonly midTurn: number };

export function updateOffer(view: DaemonUpdateView): UpdateOffer {
  const latest = knownLatestRelease(view.check);
  if (view.job?.state === 'running') return { kind: 'busy', sentence: `Updating to ${view.job.target}.` };
  if (view.job?.state === 'waiting-for-idle')
    return { kind: 'busy', sentence: `Waiting for no ferret to be mid-turn, then updating to ${view.job.target}.` };
  if (!view.available || latest === undefined) return { kind: 'none' };
  if (view.plan.kind !== 'self') return { kind: 'steps', explanation: view.plan.explanation, steps: view.plan.steps };
  return { kind: 'update', target: latest.version, midTurn: view.midTurn };
}

export const updateRequest = (target: string, when: DaemonUpdateStartRequest['when']): DaemonUpdateStartRequest => ({
  target,
  when,
});

/** The sentence for a refusal code the update routes answer with. */
export function refusalSentence(code: string | undefined, fallback: string): string {
  switch (code) {
    case DAEMON_UPDATE_CODES.inProgress:
      return 'An update is already on its way.';
    case DAEMON_UPDATE_CODES.notAvailable:
      return 'There is no newer release to update to.';
    case DAEMON_UPDATE_CODES.notSelfUpdatable:
      return 'This daemon cannot update itself; follow the steps shown.';
    case DAEMON_UPDATE_CODES.staleTarget:
      return 'A newer release came out while you were looking; refresh and try again.';
    default:
      return fallback;
  }
}

/**
 * The sentence under "Running …": behind, up to date, or — honestly — that nobody could say. "Up to date" is a claim
 * about the newest release, so it is made only when a check (this one or the last good one) actually knew the latest;
 * a daemon that has never checked, or whose only check failed, says that instead.
 */
export function headlineSentence(view: DaemonUpdateView): string {
  const behind = behindSentence(view);
  if (behind !== undefined) return behind;
  const { check } = view;
  if (check.state === 'never') return 'This daemon has not checked for a newer release yet.';
  if (check.state === 'failed') {
    return check.lastKnown === undefined
      ? `The last check for a newer release failed (${check.reason}), so this daemon may not be up to date.`
      : `This daemon is up to date as of the last good check; the newest check failed (${check.reason}).`;
  }
  return 'This daemon is up to date.';
}
