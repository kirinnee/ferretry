/**
 * What a Warden decision DOES — the one place one turns into an act on a ferret.
 *
 * THE RULES, ALL ENFORCED HERE:
 *
 * - Two deciders act, through the same remedies and the same permissions: an assigned warden's verdict,
 *   and Jev as first responder when it is sure enough (`triage.ts` decides that; it reaches this module
 *   only as a {@link WardenVerdictAct} it already judged). Both are listed under Recent actions as who
 *   they are.
 * - Only the explicit `Verdict:` marker acts. The prose heuristics that index a report for reading
 *   carry no authority: a report that drifted off the template is shown, never executed.
 * - Each act is filtered by what the owner let the Warden do alone. An act that is not allowed is not
 *   dropped: it is HELD, which puts it in front of the owner as "the Warden recommends this".
 * - Stop is held unless the owner explicitly allowed it. It is never a default.
 *
 * Pure: the act itself is the caller's, through {@link WardenRemedyPort}.
 */

import type { WardenActionKind, WardenMayActAlone } from '@ferretry/protocol';
import type { WardenRecommendation, WardenVerdictKind } from './verdicts.ts';

/** Carrying out a verdict. Each method throws when the act did not take. */
export interface WardenRemedyPort {
  nudge(sessionId: string, message: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  /** Relaunch a dead or frozen process with its conversation intact, even over a pane that looks alive. */
  restart(sessionId: string): Promise<void>;
  stop(sessionId: string, reason: string): Promise<void>;
  failover(sessionId: string, agent: string): Promise<void>;
  /**
   * Close the browsers a ferret launched that still run under its pane — the ferret itself untouched.
   * The process tree is read again at the moment of closing; answers how many were closed.
   */
  closeLeftoverBrowsers(sessionId: string): Promise<number>;
}

/** The act a verdict asks for, before the owner's permissions are applied. */
export type WardenVerdictAct =
  | { readonly action: Exclude<WardenActionKind, 'bless' | 'failover' | 'close_leftover'>; readonly reason: string }
  | { readonly action: 'failover'; readonly reason: string; readonly agent: string };

const DEFAULT_REASONS: Readonly<Record<Exclude<WardenActionKind, 'bless' | 'close_leftover'>, string>> = {
  nudge: 'it looks wedged but recoverable',
  resume: 'its turn died but the work should continue',
  restart: 'its process is dead or frozen',
  stop: 'it is burning time with no progress',
  failover: 'its login is out of quota',
};

/**
 * The act an explicit verdict asks for, or `undefined` for a verdict that asks for none.
 *
 * `structured` is the marker's verdict and nothing else. `MIGRATE (agent)` and `RESTART` are the acts no
 * verdict word names, so they are read from the recommendation line — but only alongside a marker that
 * is not a clear, and a migration only when it names the account to move to.
 */
export function verdictAct(
  structured: WardenVerdictKind | undefined,
  recommendation: WardenRecommendation | undefined,
): WardenVerdictAct | undefined {
  if (structured === undefined) return undefined;
  const reason = (fallback: string): string =>
    recommendation?.reason !== undefined && recommendation.reason.trim() !== '' ? recommendation.reason : fallback;
  if (recommendation?.action === 'migrate' && recommendation.agent !== undefined && structured !== 'cleared')
    return { action: 'failover', agent: recommendation.agent, reason: reason(DEFAULT_REASONS.failover) };
  if (recommendation?.action === 'restart' && structured !== 'cleared')
    return { action: 'restart', reason: reason(DEFAULT_REASONS.restart) };
  switch (structured) {
    case 'nudged':
      return { action: 'nudge', reason: reason(DEFAULT_REASONS.nudge) };
    case 'revived':
      return { action: 'resume', reason: reason(DEFAULT_REASONS.resume) };
    case 'killed':
      return { action: 'stop', reason: reason(DEFAULT_REASONS.stop) };
    default:
      return undefined;
  }
}

/** Whether the owner let the Warden carry this act out alone. */
export function mayActAlone(act: WardenVerdictAct, permissions: WardenMayActAlone): boolean {
  return permissions[act.action];
}

/** The message a nudge types into the ferret, in the Warden's voice and the investigation's words. */
export function wardenNudgeMessage(reason: string): string {
  return `The Warden checked on you: ${reason.trim().replace(/\.$/u, '')}. If you are blocked, say exactly what you need; otherwise carry on and post a short status.`;
}

const PAST: Readonly<Record<WardenVerdictAct['action'], string>> = {
  nudge: 'Nudged',
  resume: 'Resumed',
  restart: 'Restarted with its conversation intact',
  stop: 'Stopped',
  failover: 'Moved to another login',
};

const ASKS: Readonly<Record<WardenVerdictAct['action'], string>> = {
  nudge: 'The Warden recommends a nudge',
  resume: 'The Warden recommends resuming it',
  restart: 'The Warden recommends restarting it with its conversation intact',
  stop: 'The Warden recommends stopping it',
  failover: 'The Warden recommends moving it to another login',
};

/** The message a Jev nudge types into the ferret: the specific message Jev chose, in the Warden's voice. */
export function jevNudgeMessage(message: string): string {
  return `The Warden checked on you: ${message.trim()}`;
}

const JEV_DID: Readonly<Record<Exclude<WardenVerdictAct['action'], 'failover'>, string>> = {
  nudge: 'Jev nudged it',
  resume: 'Jev resumed it',
  restart: 'Jev restarted it with its conversation intact',
  stop: 'Jev stopped it',
};

const JEV_ASKS: Readonly<Record<WardenVerdictAct['action'], string>> = {
  nudge: 'Jev recommends a nudge',
  resume: 'Jev recommends resuming it',
  restart: 'Jev recommends restarting it with its conversation intact',
  stop: 'Jev recommends stopping it',
  failover: 'Jev recommends moving it to another login',
};

const sure = (confidence: number): string => `${Math.round(confidence * 100)}% sure`;

/** One plain sentence for the actions list about Jev's own act: what, how sure, and why. */
export function jevActDetail(
  action: WardenVerdictAct['action'],
  reason: string,
  confidence: number,
  outcome: 'done' | 'held' | 'failed',
  error?: string,
): string {
  const why = reason.trim().replace(/\.$/u, '');
  if (outcome === 'held') return `${JEV_ASKS[action]} (${sure(confidence)}): ${why}. It waits for you.`;
  const did = action === 'failover' ? 'Jev moved it to another login' : JEV_DID[action];
  if (outcome === 'done') return `${did} (${sure(confidence)}): ${why}.`;
  return `${did} — it did not take: ${error ?? 'the daemon refused it'}. The flag goes on to be looked at.`;
}

/** One plain sentence for the actions list: what happened, and why. */
export function wardenActDetail(act: WardenVerdictAct, outcome: 'done' | 'held' | 'failed', error?: string): string {
  const why = act.reason.trim().replace(/\.$/u, '');
  const target = act.action === 'failover' ? ` (${act.agent})` : '';
  if (outcome === 'done') return `${PAST[act.action]}${target}: ${why}.`;
  if (outcome === 'held') return `${ASKS[act.action]}${target}: ${why}. It waits for you.`;
  return `${PAST[act.action]}${target} did not take: ${error ?? 'the daemon refused it'}.`;
}
