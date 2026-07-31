import type { SessionHealthSettings } from './settings.ts';
import { instantMs } from '../../warden/time.ts';
import type { SelfRestartHandler, SelfRestartStamp, SelfRestartStampStore, SessionHealthEvent } from './types.ts';

/** Why a restart was withheld, so the operator-facing line can say which of them applied. */
export type SelfRestartBlock = 'recent-restart' | 'unreadable-stamp' | 'future-stamp';

export type SelfRestartDecision =
  | { readonly kind: 'not-needed' }
  | { readonly kind: 'already-requested' }
  | { readonly kind: 'cooling'; readonly block: SelfRestartBlock }
  | { readonly kind: 'restart' };

export interface SelfRestartInput {
  /** Whether the consistency pass concluded the index cannot be healed in place. */
  readonly escalate: boolean;
  /** Whether this process has already handed a restart over; a second is not a second chance. */
  readonly requested: boolean;
  readonly stamp: SelfRestartStamp | undefined;
  /** True when a stamp exists on disk but could not be read or parsed. */
  readonly stampUnreadable: boolean;
  readonly nowMs: number;
}

/**
 * Decides whether a clean self-restart may be requested.
 *
 * The cooldown exists because a condition boot cannot fix — an unreadable journal, a directory the
 * index refuses — would otherwise restart the daemon every few minutes forever, dropping fleet
 * supervision for every boot window. That makes suppression the safe direction: a restart withheld
 * leaves a degraded daemon that still supervises and still complains, while a restart granted in
 * error costs every session its supervision.
 *
 * So the two unprovable cases both suppress. A stamp that cannot be parsed is exactly the state a
 * restart LOOP produces — the ancestor read it as "no stamp" and restarted anyway, disabling the
 * guard precisely when it was needed. A stamp dated in the future cannot be aged at all.
 */
export function decideSelfRestart(input: SelfRestartInput, settings: SessionHealthSettings): SelfRestartDecision {
  if (!input.escalate) return { kind: 'not-needed' };
  if (input.requested) return { kind: 'already-requested' };
  if (input.stampUnreadable) return { kind: 'cooling', block: 'unreadable-stamp' };
  const lastAtMs = instantMs(input.stamp?.at);
  if (lastAtMs === undefined) return { kind: 'restart' };
  if (!Number.isFinite(input.nowMs)) return { kind: 'cooling', block: 'unreadable-stamp' };
  if (lastAtMs > input.nowMs) return { kind: 'cooling', block: 'future-stamp' };
  return input.nowMs - lastAtMs < settings.selfRestartCooldownMs
    ? { kind: 'cooling', block: 'recent-restart' }
    : { kind: 'restart' };
}

/** How the unhealable set is named in an announcement without pasting a thousand ids into a log. */
export function unhealablePreview(unhealable: readonly string[], settings: SessionHealthSettings): string {
  const preview = unhealable.slice(0, settings.unhealablePreviewLimit);
  const remainder = unhealable.length - preview.length;
  return `${preview.join(', ')}${remainder > 0 ? `, +${remainder} more` : ''}`;
}

/** What actually happened, once the decision met the entrypoint's answer. */
export type SelfRestartOutcome = 'restarting' | 'cooling' | 'unsupervised' | 'declined' | 'none';

export function selfRestartMessage(
  outcome: SelfRestartOutcome,
  context: { readonly consecutive: number; readonly unhealable: readonly string[] },
  settings: SessionHealthSettings,
): string {
  const headline =
    `session index is unhealable after ${context.consecutive} passes ` +
    `(${context.unhealable.length} session(s) invisible to listings; ` +
    `ids: ${unhealablePreview(context.unhealable, settings)})`;
  const cooldownMinutes = Math.round(settings.selfRestartCooldownMs / 60_000);
  const detail: Record<SelfRestartOutcome, string> = {
    restarting: 'restarting cleanly',
    cooling: `NOT restarting: a self-restart already happened within ${cooldownMinutes}m — this needs a human`,
    unsupervised: 'NOT restarting: this daemon is not under a service manager — restart it yourself',
    declined: 'NOT restarting: the restart handler failed — this needs a human',
    none: 'no restart was required',
  };
  return `${headline} — ${detail[outcome]}`;
}

/** Everything the coordinator reports back, so the caller owns all logging and journalling. */
export interface SelfRestartReport {
  readonly outcome: SelfRestartOutcome;
  readonly decision: SelfRestartDecision;
  /** Present only when this outcome differs from the last one announced. */
  readonly event: SessionHealthEvent | undefined;
}

export interface SelfRestartContext {
  readonly consecutive: number;
  readonly unhealable: readonly string[];
  readonly nowMs: number;
  readonly at: string;
}

/**
 * Requests a clean restart of a daemon whose index cannot be repaired in place.
 *
 * Two orderings here are load-bearing. The cooldown stamp is written BEFORE the handler is called,
 * because a handler that drains and exits may never come back to write it — and an unstamped
 * restart is a restart loop with no brake. And a handler that throws or answers false is a DECLINE,
 * not a restart: the latch and the stamp are both taken back, or the repair would stay disabled for
 * a restart that never happened.
 */
export class SelfRestartCoordinator {
  /** Not module state: one coordinator instance owns exactly one daemon process's restart latch. */
  private requested = false;
  private announced: SelfRestartOutcome | undefined;

  constructor(
    private readonly stamps: SelfRestartStampStore,
    private readonly handler: SelfRestartHandler,
    private readonly settings: SessionHealthSettings,
  ) {}

  /** True once a restart has been handed over and not taken back. */
  get restartRequested(): boolean {
    return this.requested;
  }

  async request(escalate: boolean, context: SelfRestartContext): Promise<SelfRestartReport> {
    const read = await this.readStamp();
    const decision = decideSelfRestart(
      {
        escalate,
        requested: this.requested,
        stamp: read.stamp,
        stampUnreadable: read.unreadable,
        nowMs: context.nowMs,
      },
      this.settings,
    );
    if (decision.kind === 'not-needed' || decision.kind === 'already-requested')
      return { outcome: 'none', decision, event: undefined };
    if (decision.kind === 'cooling') return this.report('cooling', decision, context);
    this.requested = true;
    await this.stamps
      .write({ at: context.at, sessions: context.unhealable.slice(0, this.settings.selfRestartStampSessionLimit) })
      .catch(() => undefined);
    const restarting = await this.handler.restart().catch(() => undefined);
    if (restarting === true) return this.report('restarting', decision, context);
    // Nothing would re-spawn this daemon, or the handler refused. Un-latch and un-stamp so a later
    // pass reconsiders instead of living with a cooldown no restart ever earned.
    this.requested = false;
    await this.stamps.clear().catch(() => undefined);
    return this.report(restarting === false ? 'unsupervised' : 'declined', decision, context);
  }

  private async readStamp(): Promise<{ readonly stamp: SelfRestartStamp | undefined; readonly unreadable: boolean }> {
    try {
      return { stamp: await this.stamps.read(), unreadable: false };
    } catch {
      // A stamp that exists but will not parse is the signature of a restart loop, so it counts as
      // evidence of one rather than as no evidence at all.
      return { stamp: undefined, unreadable: true };
    }
  }

  /**
   * Announces each outcome once, and again whenever the outcome CHANGES. Whether a restart is
   * possible is the entrypoint's answer and can change between passes, so a single "not supervised"
   * must not silence the daemon about a broken index for the rest of its life — which is what a
   * one-shot latch did.
   */
  private report(
    outcome: SelfRestartOutcome,
    decision: SelfRestartDecision,
    context: SelfRestartContext,
  ): SelfRestartReport {
    if (this.announced === outcome) return { outcome, decision, event: undefined };
    this.announced = outcome;
    return {
      outcome,
      decision,
      event: {
        type: 'fleet.daemon_self_restart',
        data: {
          outcome,
          reason: 'session index unhealable in place',
          message: selfRestartMessage(outcome, context, this.settings),
          sessions: [...context.unhealable],
          consecutive: context.consecutive,
          ...(decision.kind === 'cooling' ? { block: decision.block } : {}),
        },
      },
    };
  }
}
