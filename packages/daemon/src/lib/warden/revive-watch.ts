/**
 * Did a revive take? The Warden brings a dead ferret back (a rule's `revive`, a verdict's `resume`) and
 * then watches it: within {@link WARDEN_REVIVE_PROGRESS_MINUTES} it either does real work again — counted
 * as `progressed` — or it does not, or it ends again — counted as `stalled`, under who decided the revive.
 *
 * WHAT COUNTS AS PROGRESS. A signal only the agent's own work makes: tokens advancing, a counter
 * advancing, a tool or subprocess running. The transcript growing counts only once it has grown past the
 * resume's own message. A ferret that finished (`completed`) after the revive progressed; one that ended
 * any other way did not.
 *
 * NEVER INVENT A NUMBER. A revive nobody looked at until long after its window (the daemon was off) is
 * dropped uncounted: it is not known whether it took, and a guess would be a made-up rate.
 *
 * Pure: no IO, no clock, no globals.
 */

import {
  WARDEN_REVIVE_PROGRESS_MINUTES,
  type WardenAction,
  type WardenActor,
  wardenActionActor,
} from '@ferretry/protocol';
import { settleRevive } from './action-tally.ts';
import { dayOf, withDay } from './daily.ts';
import type { WardenRuntimeState } from './state.ts';
import { instantMs } from './time.ts';
import { utcDay } from './triage.ts';
import { isTerminalStatus, type WardenSessionView } from './types.ts';

/** One ferret the Warden brought back and is still watching. */
export interface ReviveWatch {
  readonly sessionId: string;
  /** When it was brought back. */
  readonly at: string;
  readonly actor: WardenActor;
  readonly action: 'revive' | 'resume';
}

/** How many revives are watched at once; the oldest is dropped past it. */
export const REVIVE_WATCH_LIMIT = 50;

/** How long a revived ferret has to show progress. */
export const REVIVE_PROGRESS_MS = WARDEN_REVIVE_PROGRESS_MINUTES * 60_000;

/** A revive nobody evaluated within this many windows is dropped uncounted. */
const STALE_WINDOWS = 3;

/** The resume's own message lands in the transcript this soon after the revive: not progress. */
const RESUME_ECHO_MS = 30_000;

/** Start watching a ferret the Warden just brought back. Any other action leaves the state alone. */
export function watchRevive(state: WardenRuntimeState, action: WardenAction): WardenRuntimeState {
  if (action.outcome !== 'done' || (action.action !== 'revive' && action.action !== 'resume')) return state;
  const watch: ReviveWatch = {
    sessionId: action.sessionId,
    at: action.at,
    actor: wardenActionActor(action),
    action: action.action,
  };
  const others = (state.reviveWatch ?? []).filter(entry => entry.sessionId !== watch.sessionId);
  return { ...state, reviveWatch: [...others, watch].slice(-REVIVE_WATCH_LIMIT) };
}

const after = (instant: string | undefined, floorMs: number): boolean => (instantMs(instant) ?? -Infinity) > floorMs;

type Verdict = 'progressed' | 'stalled' | 'waiting';

function judge(view: WardenSessionView | undefined, atMs: number, nowMs: number): Verdict {
  const expired = nowMs - atMs >= REVIVE_PROGRESS_MS;
  if (view === undefined) return expired ? 'stalled' : 'waiting';
  const { state } = view;
  const worked =
    after(state.lastTokenAdvanceAt, atMs) ||
    after(state.lastCounterAdvanceAt, atMs) ||
    after(state.lastSubprocessAt, atMs) ||
    after(state.lastTranscriptAt, atMs + RESUME_ECHO_MS);
  if (isTerminalStatus(state.status) && after(state.finishedAt, atMs)) {
    return state.status === 'completed' || worked ? 'progressed' : 'stalled';
  }
  if (worked) return 'progressed';
  return expired ? 'stalled' : 'waiting';
}

/**
 * Settle every watched revive that has shown progress or run out of its window, counting it on the day
 * it was made; leave the rest watched.
 */
export function resolveReviveWatch(
  state: WardenRuntimeState,
  fleet: readonly WardenSessionView[],
  nowMs: number,
): WardenRuntimeState {
  const watched = state.reviveWatch ?? [];
  if (watched.length === 0) return state;
  const byId = new Map(fleet.map(view => [view.config.id, view]));
  let daily = state.daily ?? [];
  const waiting: ReviveWatch[] = [];
  for (const watch of watched) {
    const atMs = instantMs(watch.at);
    if (atMs === undefined || nowMs - atMs >= REVIVE_PROGRESS_MS * STALE_WINDOWS) continue;
    const verdict = judge(byId.get(watch.sessionId), atMs, nowMs);
    if (verdict === 'waiting') {
      waiting.push(watch);
      continue;
    }
    const day = dayOf(daily, utcDay(atMs));
    daily = withDay(daily, { ...day, reviveResults: settleRevive(day.reviveResults, verdict, watch.actor) });
  }
  return { ...state, daily, reviveWatch: waiting };
}
