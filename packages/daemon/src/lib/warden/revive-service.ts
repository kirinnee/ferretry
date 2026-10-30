/**
 * The Warden's auto-revive: the loop that turns `revive.ts`'s rules into resumed sessions.
 *
 * WHY THIS IS NOT A VERDICT. A revive carries out no judgement of an LLM or of Jev: it is a rule about a
 * recorded fact (the session's last terminal event is an abnormal exit), exactly like closing a leftover
 * browser. It therefore does not go through `carryOut`, which declines terminal statuses, and it spends
 * nothing. It follows the same shape as `closeLeftovers`: only while the Warden is on, every outcome listed
 * under Recent actions and journalled, nothing thrown at the sweep.
 *
 * WHAT IT PROMISES.
 * - It never revives faster than the rules in `revive.ts` allow: waves of at most `waveSize`, `waveGapSeconds`
 *   apart, leads before their children.
 * - After a fleet-wide death it waits for the tmux server to answer before the first wave. If it never does
 *   the revive is DEFERRED — nothing is recorded, no cooldown is spent — and the next sweep tries again while
 *   the window lasts.
 * - A revive that is refused (by a rule here, or by the resume service) is journalled ONCE per death, so a
 *   standing refusal never refills the journal every sweep.
 * - When the breaker opens it is journalled and the owner is told once; when it lapses that is journalled too.
 *
 * Every durable fact is written through `persist` after each wave, so a daemon that dies mid-cascade has
 * already spent the cooldown of those it revived and will not revive them twice.
 */

import type { WardenAction, WardenConfig } from '@ferretry/protocol';
import {
  breakerVerdict,
  causeKey,
  causeText,
  classifyEnd,
  deathKey,
  EMPTY_REVIVE_STATE,
  type PlannedRevive,
  planRevives,
  REVIVE_BATCH_LIMIT,
  type ReviveEvent,
  type ReviveRefusal,
  type ReviveState,
  type ReviveSubject,
  reviveMessage,
} from './revive.ts';
import type { WardenFocusCard } from './focus-card.ts';
import { instantMs, isoFromMs } from './time.ts';
import { WARDEN_LABEL, type WardenSessionView } from './types.ts';

/** What the revive needs of the session journal, per session. */
export interface WardenReviveEvents {
  /** A session's events, oldest first. Total: an unreadable journal is no events. */
  read(sessionId: string): Promise<readonly ReviveEvent[]>;
  /** Append one Warden event to a session's own journal. */
  emit(sessionId: string, type: string, data: Readonly<Record<string, unknown>>): Promise<void>;
}

export type WardenResumeOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface WardenReviveNotice {
  readonly sessionId: string;
  readonly title: string;
  readonly subject: string;
  readonly why: string;
}

export interface WardenRevivePorts {
  readonly events: WardenReviveEvents;
  /** Start the session again with `message` as its turn. Total: a refusal is `{ok:false}`, never a throw. */
  resume(sessionId: string, message: string): Promise<WardenResumeOutcome>;
  /** Whether the daemon's tmux server answers. */
  tmuxReady(): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  /** One notice to the owner. Total. */
  notifyOwner(notice: WardenReviveNotice): Promise<void>;
  /**
   * The card a session's work is attributed to, so a revived auto ferret is told to carry on with it
   * (`focus-card.ts`). Total: no card, or one that cannot be read, is `undefined`. Absent: no board.
   */
  focusCard?(sessionId: string): Promise<WardenFocusCard | undefined>;
  journal: { record(type: string, data: Readonly<Record<string, unknown>>): void };
}

export interface WardenReviveInput {
  readonly fleet: readonly WardenSessionView[];
  readonly config: WardenConfig;
  readonly revive: ReviveState | undefined;
  readonly nowMs: number;
}

export interface WardenReviveResult {
  readonly revive: ReviveState;
  readonly actions: readonly WardenAction[];
  /** The sessions revived this run, so the sweep does not flag them as dead on the same pass. */
  readonly revived: ReadonlySet<string>;
}

/** How long, and how often, a fleet-wide death waits for the tmux server. */
export const REVIVE_TMUX_WAIT_TRIES = 12;
export const REVIVE_TMUX_WAIT_MS = 5_000;

/** Candidates are read from sessions that failed within this many windows: older ones are not read at all. */
const CANDIDATE_WINDOWS = 2;
const DAY_MS = 24 * 60 * 60_000;

/** Persist after each wave: the sweep applies the actions and writes the document. */
export type WardenRevivePersist = (revive: ReviveState, actions: readonly WardenAction[]) => Promise<void>;

export class WardenReviveService {
  constructor(private readonly ports: WardenRevivePorts) {}

  async run(input: WardenReviveInput, persist: WardenRevivePersist): Promise<WardenReviveResult> {
    const { config, nowMs } = input;
    const at = isoFromMs(nowMs);
    const none: WardenReviveResult = {
      revive: input.revive ?? EMPTY_REVIVE_STATE,
      actions: [],
      revived: new Set(),
    };
    // A revive IS a resume of a dead agent: an owner who has not let the Warden resume alone has not let it
    // revive alone either, whatever `revive.enabled` says.
    if (!config.enabled || !config.revive.enabled || !config.mayActAlone.resume) return none;

    let state = this.housekeeping(input.revive ?? EMPTY_REVIVE_STATE, input.fleet, nowMs);
    const found = await this.candidates(input, state);
    state = found.state;
    const fresh = found.subjects.filter(subject => state.refused[deathKey(subject)] === undefined);

    const tripped = state.breaker === undefined ? breakerVerdict(state, fresh, nowMs, config.revive) : undefined;
    if (tripped !== undefined) {
      state = { ...state, breaker: tripped };
      this.ports.journal.record('fleet.warden_revive_breaker_opened', { why: tripped.why, until: tripped.until });
      const subject = fresh[0];
      if (subject !== undefined)
        await this.ports.notifyOwner({
          sessionId: subject.id,
          title: 'Auto-revive paused',
          subject: `Auto-revive is paused until ${tripped.until}: ${tripped.why}.`,
          why: `Ferretry started sessions again after they died, and they died again (${tripped.why}). It will not revive anything else until ${tripped.until}. Turn auto-revive off in config/warden.yaml (revive.enabled: false) to stop it altogether.`,
        });
    }

    const plan = planRevives(
      fresh,
      input.fleet.map(entry => ({
        id: entry.config.id,
        status: entry.state.status,
        ...(entry.config.parent === undefined ? {} : { parent: entry.config.parent }),
      })),
      state,
      nowMs,
      config.revive,
    );

    for (const { subject, why } of plan.refused) {
      state = { ...state, refused: { ...state.refused, [deathKey(subject)]: at } };
      await this.refuse(subject.id, why);
    }

    const actions: WardenAction[] = [];
    const revived = new Set<string>();
    if (plan.waves.length > 0 && plan.cascade && !(await this.waitForTmux())) {
      this.ports.journal.record('fleet.warden_revive_deferred', {
        why: 'tmux_unavailable',
        sessions: plan.waves.flat().map(planned => planned.id),
      });
      await persist(state, actions);
      return { revive: state, actions, revived };
    }

    for (const [index, wave] of plan.waves.entries()) {
      if (index > 0) await this.ports.sleep(config.revive.waveGapSeconds * 1000);
      const done: string[] = [];
      const waveActions: WardenAction[] = [];
      for (const planned of wave) {
        const outcome = await this.reviveOne(planned, state, nowMs);
        state = outcome.state;
        waveActions.push(outcome.action);
        actions.push(outcome.action);
        if (outcome.revived) {
          done.push(planned.id);
          revived.add(planned.id);
        }
      }
      if (done.length > 0)
        state = {
          ...state,
          batches: [...state.batches, { at: isoFromMs(nowMs), ids: done }].slice(-REVIVE_BATCH_LIMIT),
        };
      await persist(state, waveActions);
    }
    if (plan.waves.length === 0) await persist(state, actions);
    return { revive: state, actions, revived };
  }

  /** Close a lapsed breaker, and forget what is too old to matter. */
  private housekeeping(state: ReviveState, fleet: readonly WardenSessionView[], nowMs: number): ReviveState {
    let next = state;
    if (next.breaker !== undefined && (instantMs(next.breaker.until) ?? 0) <= nowMs) {
      this.ports.journal.record('fleet.warden_revive_breaker_closed', { openedAt: next.breaker.openedAt });
      const { breaker: _closed, ...rest } = next;
      next = rest;
    }
    const known = new Set(fleet.map(entry => entry.config.id));
    return {
      ...next,
      sessions: Object.fromEntries(Object.entries(next.sessions).filter(([id]) => known.has(id))),
      refused: Object.fromEntries(
        Object.entries(next.refused).filter(([, at]) => nowMs - (instantMs(at) ?? 0) < DAY_MS),
      ),
    };
  }

  /** The failed, non-investigator sessions whose journal ends in an abnormal exit. */
  private async candidates(
    input: WardenReviveInput,
    state: ReviveState,
  ): Promise<{ readonly subjects: readonly ReviveSubject[]; readonly state: ReviveState }> {
    const horizon = input.config.revive.windowMinutes * 60_000 * CANDIDATE_WINDOWS;
    const at = isoFromMs(input.nowMs);
    const subjects: ReviveSubject[] = [];
    let next = state;
    for (const view of input.fleet) {
      if (view.state.status !== 'failed') continue;
      if (view.config.label?.trim() === WARDEN_LABEL || view.config.wardenLineage === true) continue;
      const finished = instantMs(view.state.finishedAt);
      if (finished === undefined || input.nowMs - finished > horizon) continue;
      const verdict = classifyEnd(view.state.status, await this.ports.events.read(view.config.id));
      if (verdict.kind === 'leave') {
        if (verdict.why === 'stopped') {
          const key = `${view.config.id}@stopped@${view.state.finishedAt}`;
          if (next.refused[key] === undefined) {
            next = { ...next, refused: { ...next.refused, [key]: at } };
            await this.refuse(view.config.id, 'stopped');
          }
        }
        continue;
      }
      subjects.push({
        id: view.config.id,
        mode: view.config.mode,
        ...(view.config.parent === undefined ? {} : { parent: view.config.parent }),
        cause: verdict.cause,
        diedAt: verdict.diedAt,
      });
    }
    return { subjects, state: next };
  }

  private async waitForTmux(): Promise<boolean> {
    for (let attempt = 0; attempt < REVIVE_TMUX_WAIT_TRIES; attempt++) {
      if (await this.ports.tmuxReady()) return true;
      await this.ports.sleep(REVIVE_TMUX_WAIT_MS);
    }
    return false;
  }

  private async refuse(sessionId: string, why: ReviveRefusal): Promise<void> {
    await this.ports.events.emit(sessionId, 'warden.revive_refused', { why });
    this.ports.journal.record('fleet.warden_revive_refused', { sessionId, why });
  }

  private async reviveOne(
    planned: PlannedRevive,
    state: ReviveState,
    nowMs: number,
  ): Promise<{ readonly state: ReviveState; readonly action: WardenAction; readonly revived: boolean }> {
    const at = isoFromMs(nowMs);
    const cause = causeKey(planned.cause);
    const base = {
      at,
      sessionId: planned.id,
      action: 'revive' as const,
      by: 'warden' as const,
      actor: 'auto' as const,
    };
    await this.ports.events.emit(planned.id, 'warden.revive_planned', { cause, wave: planned.wave });
    // Only an auto ferret is told what to carry on with: an interactive one gets the notice alone.
    const card = planned.mode === 'auto' ? await this.ports.focusCard?.(planned.id).catch(() => undefined) : undefined;
    const outcome = await this.ports.resume(
      planned.id,
      reviveMessage(planned.cause, planned.diedAt, planned.mode, card),
    );
    const key = deathKey(planned);
    if (!outcome.ok) {
      const why: ReviveRefusal = `refused:${outcome.reason}`;
      await this.refuse(planned.id, why);
      return {
        state: { ...state, refused: { ...state.refused, [key]: at } },
        action: {
          ...base,
          outcome: 'failed',
          detail: `Could not start it again after ${causeText(planned.cause)}: ${outcome.reason}.`,
        },
        revived: false,
      };
    }
    const previous = state.sessions[planned.id];
    const attempts = (previous?.attempts ?? 0) + 1;
    await this.ports.events.emit(planned.id, 'warden.revived', { cause, attempt: attempts });
    this.ports.journal.record('fleet.warden_revived', {
      sessionId: planned.id,
      cause,
      attempt: attempts,
      wave: planned.wave,
    });
    return {
      state: {
        ...state,
        sessions: {
          ...state.sessions,
          [planned.id]: {
            revivedAt: at,
            attempts,
            crashRevives: (previous?.crashRevives ?? 0) + (planned.cause.kind === 'agent_crashed' ? 1 : 0),
          },
        },
        refused: { ...state.refused, [key]: at },
      },
      action: {
        ...base,
        outcome: 'done',
        detail: `Started it again: ${causeText(planned.cause)}. ${planned.mode === 'interactive' ? 'Told it so, nothing more.' : 'Told it why, and to re-read its last turn and continue.'}`,
      },
      revived: true,
    };
  }
}
