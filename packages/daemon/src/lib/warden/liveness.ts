/**
 * The liveness layer: what the Warden actually SEES of each ferret between sweeps, ported from kteam's
 * reflex monitor (`liveness.ts`, `tmux-controller.ts`).
 *
 * Every tick the sampler looks at each live ferret — a hash of its screen, a hash of its transcript
 * tail, the work counters its harness paints ("✢ Fixing… (5m 45s · ↓ 17.2k tokens)") and whether its
 * pane has a live child process — and {@link foldLivenessSample} turns the differences into the ledger
 * the sus classifiers have always reasoned over and nothing ever filled: when the transcript last grew,
 * when the counters last advanced, when the tokens last climbed, when a subprocess was last alive and
 * since when, and when the screen last changed.
 *
 * TWO LAYERS, AS IN KTEAM. The REFLEX here is dumb and only catches a totally frozen agent: no life-sign
 * of any kind for `nudgeAfterSeconds` earns one nudge per episode, and no STRONG life-sign (the screen
 * excluded — the nudge itself repaints it) for `frozenAfterSeconds` after that makes it FROZEN. The
 * smart layer is the sweep: the sus classifiers read the same ledger for alive-but-weird ferrets.
 *
 * NOTHING HERE KILLS. kteam's reflex killed a frozen agent; the Warden never stops a ferret on its own,
 * so a frozen one becomes a flag — a restart candidate for an investigation, or the owner's to read.
 *
 * Pure: no IO, no clock, no globals.
 */

import { paneShowsActiveWork } from '../tmux/pane.ts';
import { ledgerAges } from './sus.ts';
import { isoFromMs } from './time.ts';
import type { WardenLivenessLedger, WardenSessionState } from './types.ts';

/** The counters a harness paints while it works. Undefined fields were not on screen. */
export interface PaneWorkCounters {
  readonly elapsedSeconds?: number;
  readonly tokens?: number;
}

/**
 * Elapsed-time and token counters from a frame that shows ACTIVE work. Undefined when no active-work
 * indicator is on screen at all — a bare number elsewhere must never read as progress.
 */
export function paneWorkCounters(pane: string): PaneWorkCounters | undefined {
  if (!paneShowsActiveWork(pane)) return undefined;
  const elapsed = /\(\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(\d+)\s*s\b/u.exec(pane);
  const tokens = /([\d.,]+)\s*(k?)\s*tokens/u.exec(pane.toLowerCase());
  const counters: PaneWorkCounters = {
    ...(elapsed === null
      ? {}
      : { elapsedSeconds: Number(elapsed[1] ?? 0) * 3600 + Number(elapsed[2] ?? 0) * 60 + Number(elapsed[3]) }),
    ...(tokens === null
      ? {}
      : {
          tokens: Math.round(
            Number.parseFloat((tokens[1] ?? '0').replaceAll(',', '')) * (tokens[2] === 'k' ? 1000 : 1),
          ),
        }),
  };
  return counters.elapsedSeconds === undefined && counters.tokens === undefined ? undefined : counters;
}

/** One look at a ferret. An `undefined` field could not be read this tick and changes nothing. */
export interface LivenessSample {
  /** A digest of the screen as it is now. */
  readonly paneHash?: string;
  /** The screen itself, for its work counters. */
  readonly pane?: string;
  /** A digest of the transcript's tail: it changes when the conversation grows. */
  readonly transcriptHash?: string;
  /** A live process under the pane, or a background terminal the harness reports. */
  readonly subprocessAlive?: boolean;
}

/** What the liveness layer remembers of one ferret between ticks. */
export interface LivenessTrack {
  readonly ledger: WardenLivenessLedger;
  /** The turn this track measures; a new turn starts every clock again. */
  readonly turn: number;
  /** When this track started watching the turn — no silence is measured from before it. */
  readonly anchorAt: string;
  readonly paneHash?: string;
  readonly transcriptHash?: string;
  readonly counters?: PaneWorkCounters;
  /** When the reflex nudged it, this episode. Cleared when a strong life-sign returns. */
  readonly nudgedAt?: string;
  /** When it was judged frozen. Cleared when any strong life-sign returns. */
  readonly frozenAt?: string;
  /** Consecutive ticks whose verdict was frozen: two are needed before it is believed. */
  readonly frozenTicks: number;
}

/** A track for a ferret seen for the first time, or on a new turn. */
export function startTrack(turn: number, nowMs: number): LivenessTrack {
  return { ledger: {}, turn, anchorAt: isoFromMs(nowMs), frozenTicks: 0 };
}

/**
 * Fold one sample into a track. A hash that differs from the last one is a life-sign; the first hash of
 * a track is only a baseline. Counters that strictly advanced are a counter life-sign, and a token count
 * that climbed is the token one. A live subprocess stamps `lastSubprocessAt` and opens an episode that
 * closes the first tick it is gone.
 */
export function foldLivenessSample(
  previous: LivenessTrack | undefined,
  sample: LivenessSample,
  turn: number,
  nowMs: number,
): LivenessTrack {
  const base = previous === undefined || previous.turn !== turn ? startTrack(turn, nowMs) : previous;
  const at = isoFromMs(nowMs);
  const changed = (before: string | undefined, now: string | undefined): boolean =>
    before !== undefined && now !== undefined && before !== now;
  const counters = sample.pane === undefined ? undefined : paneWorkCounters(sample.pane);
  const before = base.counters;
  const elapsedAdvanced =
    before?.elapsedSeconds !== undefined &&
    counters?.elapsedSeconds !== undefined &&
    counters.elapsedSeconds > before.elapsedSeconds;
  const tokensAdvanced =
    before?.tokens !== undefined && counters?.tokens !== undefined && counters.tokens > before.tokens;
  const { subprocessSince: _episode, ...closed } = base.ledger;
  const ledger: WardenLivenessLedger = {
    ...(sample.subprocessAlive === false ? closed : base.ledger),
    ...(changed(base.transcriptHash, sample.transcriptHash) ? { lastTranscriptAt: at } : {}),
    ...(changed(base.paneHash, sample.paneHash) ? { lastPaneChangeAt: at } : {}),
    ...(elapsedAdvanced || tokensAdvanced ? { lastCounterAdvanceAt: at } : {}),
    ...(tokensAdvanced ? { lastTokenAdvanceAt: at } : {}),
    ...(sample.subprocessAlive === true
      ? { lastSubprocessAt: at, subprocessSince: base.ledger.subprocessSince ?? at }
      : {}),
  };
  return {
    ...base,
    ledger,
    ...(sample.paneHash === undefined ? {} : { paneHash: sample.paneHash }),
    ...(sample.transcriptHash === undefined ? {} : { transcriptHash: sample.transcriptHash }),
    ...(counters === undefined ? {} : { counters }),
  };
}

export interface ReflexSettings {
  /** No life-sign of any kind for this long earns one nudge. */
  readonly nudgeAfterSeconds: number;
  /** No strong life-sign for this long — after the nudge, when nudging is allowed — is frozen. */
  readonly frozenAfterSeconds: number;
  /** The tick, seconds: a subprocess seen within two ticks counts as running now. */
  readonly tickSeconds: number;
}

export type ReflexVerdict = 'alive' | 'nudge' | 'frozen';

export interface ReflexAssessment {
  readonly verdict: ReflexVerdict;
  /** Seconds since the freshest life-sign of any kind, the screen included. */
  readonly quietSeconds: number;
  /** The same without the screen: the strong life-signs only. */
  readonly strongQuietSeconds: number;
}

/**
 * The reflex rule. `quiet` is the youngest of every life-sign; `strong` leaves the screen out, because
 * the nudge's own typed message repaints it and a repaint must never end an episode (kteam watched a
 * frozen agent loop through endless nudges that way). Silence is floored at the track's anchor, so a
 * fresh turn, a restarted daemon or a lagged tick is never instantly quiet.
 *
 * `nudgeAllowed` is the owner's `mayActAlone.nudge`: when the Warden may not nudge, a frozen verdict
 * does not wait for a nudge that will never come.
 */
export function reflexAssess(
  track: LivenessTrack,
  nowMs: number,
  settings: ReflexSettings,
  nudgeAllowed: boolean,
): ReflexAssessment {
  const anchorMs = Date.parse(track.anchorAt);
  const ages = ledgerAges(track.ledger, nowMs, Number.isFinite(anchorMs) ? anchorMs : nowMs);
  const subprocessRunning = ages.subprocess <= 2 * settings.tickSeconds;
  const strongQuietSeconds = Math.min(
    ages.transcript,
    ages.tokenAdvance,
    ages.counterAdvance,
    subprocessRunning ? 0 : Number.POSITIVE_INFINITY,
  );
  const quietSeconds = Math.min(strongQuietSeconds, ages.paneChange);
  const nudged = track.nudgedAt !== undefined || !nudgeAllowed;
  if (nudged && strongQuietSeconds >= settings.frozenAfterSeconds)
    return { verdict: 'frozen', quietSeconds, strongQuietSeconds };
  if (nudgeAllowed && track.nudgedAt === undefined && quietSeconds >= settings.nudgeAfterSeconds)
    return { verdict: 'nudge', quietSeconds, strongQuietSeconds };
  return { verdict: 'alive', quietSeconds, strongQuietSeconds };
}

/** What the reflex does this tick, and the track it leaves. */
export interface ReflexStep {
  readonly track: LivenessTrack;
  /** Nudge it now: the first quiet tick of an episode, and the owner lets the Warden nudge. */
  readonly nudge: boolean;
  /** It has just been confirmed frozen. Reported once per episode. */
  readonly frozen: boolean;
  readonly assessment: ReflexAssessment;
}

/**
 * One reflex step. A frozen verdict must hold on TWO consecutive ticks before it is believed: one late
 * observation must never mark a ferret frozen. A returning strong life-sign ends the episode — the nudge
 * and the frozen mark both clear — and a `suspended` ferret (waiting by declaration, or interactive) is
 * never nudged or frozen at all.
 */
export function reflexStep(
  track: LivenessTrack,
  nowMs: number,
  settings: ReflexSettings,
  options: { readonly nudgeAllowed: boolean; readonly suspended: boolean },
): ReflexStep {
  const assessment = reflexAssess(track, nowMs, settings, options.nudgeAllowed);
  const verdict = options.suspended ? 'alive' : assessment.verdict;
  if (verdict === 'alive') {
    const revived = assessment.strongQuietSeconds < settings.nudgeAfterSeconds;
    const { nudgedAt: _nudged, frozenAt: _frozen, ...rest } = track;
    return {
      track: revived ? { ...rest, frozenTicks: 0 } : { ...track, frozenTicks: 0 },
      nudge: false,
      frozen: false,
      assessment,
    };
  }
  if (verdict === 'nudge')
    return { track: { ...track, nudgedAt: isoFromMs(nowMs), frozenTicks: 0 }, nudge: true, frozen: false, assessment };
  const frozenTicks = track.frozenTicks + 1;
  const confirmed = frozenTicks >= 2 && track.frozenAt === undefined;
  return {
    track: { ...track, frozenTicks, ...(confirmed ? { frozenAt: isoFromMs(nowMs) } : {}) },
    nudge: false,
    frozen: confirmed,
    assessment,
  };
}

/** The message a reflex nudge types, in kteam's words. */
export const REFLEX_NUDGE_MESSAGE =
  'Liveness check: no output, screen change or subprocess activity has been seen for several minutes. If you are alive, continue the task now and post a short status.';

/** How long a ferret may be quiet before the reflex nudges it, when its own settings name no time. */
export const DEFAULT_REFLEX_NUDGE_SECONDS = 300;
/** How long a ferret may show no strong life-sign before it is frozen, when its settings name none. */
export const DEFAULT_REFLEX_FROZEN_SECONDS = 900;

/**
 * The reflex times for one ferret: its own `nudgeAfterSeconds` / `killAfterSeconds` when it names them
 * (the kill time is read as the frozen time — nothing here kills), the defaults otherwise, and the
 * frozen time never closer than a tick after the nudge.
 */
export function reflexSettingsFor(
  config: { readonly nudgeAfterSeconds?: number; readonly killAfterSeconds?: number },
  tickSeconds: number,
): ReflexSettings {
  const nudgeAfterSeconds =
    config.nudgeAfterSeconds !== undefined && config.nudgeAfterSeconds > 0
      ? config.nudgeAfterSeconds
      : DEFAULT_REFLEX_NUDGE_SECONDS;
  const frozen =
    config.killAfterSeconds !== undefined && config.killAfterSeconds > 0
      ? config.killAfterSeconds
      : DEFAULT_REFLEX_FROZEN_SECONDS;
  return { nudgeAfterSeconds, frozenAfterSeconds: Math.max(frozen, nudgeAfterSeconds + tickSeconds), tickSeconds };
}

/** The later of two instants, either of which may be missing. */
function later(left: string | undefined, right: string | undefined): string | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

/**
 * A ferret's state with the liveness monitor's ledger laid over it: each signal is the later of what
 * the session's own documents say and what the monitor saw, so neither can make the other look older.
 * The subprocess episode is the monitor's alone — it is the only thing that watches the pane's children.
 */
export function withLivenessLedger(
  state: WardenSessionState,
  ledger: WardenLivenessLedger | undefined,
): WardenSessionState {
  if (ledger === undefined) return state;
  const merged = {
    lastTranscriptAt: later(state.lastTranscriptAt, ledger.lastTranscriptAt),
    lastCounterAdvanceAt: later(state.lastCounterAdvanceAt, ledger.lastCounterAdvanceAt),
    lastTokenAdvanceAt: later(state.lastTokenAdvanceAt, ledger.lastTokenAdvanceAt),
    lastSubprocessAt: later(state.lastSubprocessAt, ledger.lastSubprocessAt),
    lastPaneAt: later(state.lastPaneAt, ledger.lastPaneChangeAt),
    subprocessSince: ledger.subprocessSince,
  };
  const { subprocessSince: _stale, ...rest } = state;
  return {
    ...rest,
    ...Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)),
  };
}
