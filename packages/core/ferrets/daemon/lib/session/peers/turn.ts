/**
 * PEER: today's `daemon/src/lib/session/turn/policy.ts`, `turn/usage-limit.ts`, `turn/service.ts` and
 * `daemon/src/adapters/session/turn/pane-frames.ts` — owned by the conversation plugin.
 * Ferrets is core and cannot import a plugin's code (§2.1); this is the part the session code reads, injected by the host.
 *
 * The turn decision's small pure functions (each well under forty lines, values in and values out) are copied
 * verbatim, because the observer's pure fold calls them. The watcher loop (`SessionTurnWatcher`) and the pane frame
 * reader (`PaneFrames`) are interfaces with factories the host supplies.
 */

import type { HarnessDialog } from '../../protocol/session-dialog.ts';
import type { PermissionRequest } from '../../protocol/session-permission.ts';
import type { SessionState, SessionStatus, SessionTurnState } from '../../protocol/session.ts';
import type { ClockPort } from '../../ports.ts';
import type { SessionId } from '../../session-id.ts';
import type { TurnFacts, TurnStateChange } from '../observer/turn.ts';
import type { PaneState, TmuxCommandPort } from './tmux.ts';
import type { TranscriptEvent } from './transcript.ts';

// ── today's turn/policy.ts ───────────────────────────────────────────────────────────────────────

/** What one live frame of the agent's pane shows. */
export interface TurnPaneEvidence {
  /** The harness's own working line: spinner, elapsed clock, token counter or interrupt hint. */
  readonly working: boolean;
  /**
   * `working` rests on a spinner-shaped line alone — no interrupt hint, elapsed clock or token counter
   * anywhere on screen. A running turn draws that status line too, so this is the one pane reading a
   * transcript that says the turn ENDED may overrule.
   */
  readonly spinnerOnly?: boolean | undefined;
  /** An idle prompt the harness would accept a message at. */
  readonly atPrompt: boolean;
  /** A permission (or other choice) prompt nothing moves past until a person answers. */
  readonly permission: boolean;
  /**
   * A harness dialog the session is parked on — a one-shot nudge, a trust or theme screen — as the
   * words a person is shown for it. Like a permission prompt, nothing moves until somebody answers.
   */
  readonly prompt?: string | undefined;
  /** The tool-permission prompt on screen, read as data — what it asks and the choices it offers. */
  readonly request?: PermissionRequest | undefined;
  /** The harness's own dialog on screen — hooks to review, an update, a sign-in — read as data. */
  readonly dialog?: HarnessDialog | undefined;
}

/** What the transcript's tail says about the current turn. */
export type TranscriptTurnPhase = 'working' | 'ended' | 'unknown';

/** The statuses whose turn this module may describe. Every other status already says what it is. */
const TURN_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'running',
  'thinking',
  'tool_running',
  'awaiting_user',
  'awaiting_question',
  'interrupted',
  // A session parked on a usage-limit dialog (see ./usage-limit.ts) stays watched, so its release is seen.
  'rate_limited',
]);

/** Statuses that are, by their own account, waiting for the person. */
const IDLE_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['awaiting_user', 'interrupted']);

/**
 * The phase of the newest turn in a transcript tail.
 *
 * Read from the END: the first turn boundary met decides, and so does the first piece of turn work —
 * a person's message, the agent's reply, its reasoning, a tool call or a tool result — because any of
 * those after the last boundary is a turn that has not ended yet. Bookkeeping records (usage,
 * settings, attachments, errors, system and developer notes) say nothing about whose turn it is.
 */
export function transcriptTurnPhase(events: readonly TranscriptEvent[]): TranscriptTurnPhase {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as TranscriptEvent;
    if (event.kind === 'turn') return event.state === 'started' ? 'working' : 'ended';
    if (event.kind === 'usage' || event.kind === 'settings' || event.kind === 'attachment' || event.kind === 'error')
      continue;
    if (event.role === 'system' || event.role === 'developer') continue;
    return 'working';
  }
  return 'unknown';
}

/** Everything one decision reads. */
export interface TurnEvidence {
  readonly state: Pick<SessionState, 'status' | 'turn' | 'pendingQuestion'>;
  readonly transcript: TranscriptTurnPhase;
  /** `undefined` when no frame could be read this time. */
  readonly pane: TurnPaneEvidence | undefined;
}

/**
 * One observation's answer, and how strong it is.
 *
 * `confirmed` is false only for a `your-turn` that the evidence does not agree on — the pane alone,
 * or the transcript alone. Everything else (the agent visibly working, a person being asked
 * something, the pane AND the transcript both saying the turn ended) is confirmed on sight.
 */
export interface TurnObservation {
  readonly state: SessionTurnState;
  readonly confirmed: boolean;
  /** The harness dialog behind a `needs-input`, when that is what it is. */
  readonly prompt?: string | undefined;
  /** The tool-permission prompt behind a `needs-input`, when that is what it is. */
  readonly request?: PermissionRequest | undefined;
  /** The harness dialog behind a `needs-input`, read as data, when that is what it is. */
  readonly dialog?: HarnessDialog | undefined;
}

/**
 * The turn this evidence shows, or `undefined` for a session whose turn is not this module's to
 * describe (not live) or about which there is no evidence at all.
 */
export function observeTurn(evidence: TurnEvidence): TurnObservation | undefined {
  const { state, transcript, pane } = evidence;
  if (!TURN_STATUSES.has(state.status)) return undefined;
  if (state.status === 'awaiting_question' || (state.pendingQuestion ?? null) !== null)
    return { state: 'needs-input', confirmed: true };
  if (pane?.dialog !== undefined)
    return {
      state: 'needs-input',
      confirmed: true,
      dialog: pane.dialog,
      ...(pane.prompt === undefined ? {} : { prompt: pane.prompt }),
    };
  if (pane?.prompt !== undefined) return { state: 'needs-input', confirmed: true, prompt: pane.prompt };
  if (pane?.request !== undefined) return { state: 'needs-input', confirmed: true, request: pane.request };
  if (pane?.permission === true) return { state: 'needs-input', confirmed: true };
  // A spinner-shaped line with no live status line beside it is ambiguous, and the transcript's own turn
  // boundary decides it: a finished turn keeps no spinner, so an end the record proves outranks a shape
  // on an idle screen. Weak in both directions, it still needs two looks — see `settleTurnState`.
  if (pane?.working === true && pane.spinnerOnly === true && transcript === 'ended')
    return { state: 'your-turn', confirmed: false };
  if (pane?.working === true) return { state: 'working', confirmed: true };
  if (pane?.atPrompt === true) return { state: 'your-turn', confirmed: transcript !== 'working' };
  if (transcript === 'working') return { state: 'working', confirmed: true };
  if (transcript === 'ended') return { state: 'your-turn', confirmed: false };
  if (IDLE_STATUSES.has(state.status) || state.turn === 0) return { state: 'your-turn', confirmed: true };
  return undefined;
}

/**
 * The turn to RECORD, given what was recorded, this observation and the previous one.
 *
 * A confirmed observation is recorded at once. An unconfirmed `your-turn` is recorded only when the
 * observation before it said the same — two frames, a few seconds apart, both idle — so a single
 * frame between two spinner redraws cannot end a turn. A session whose turn is not this module's to
 * describe has its record cleared, so a finished session never carries a stale `working`.
 */
export function settleTurnState(
  recorded: SessionTurnState | undefined,
  observation: TurnObservation | undefined,
  previous: TurnObservation | undefined,
  live: boolean,
): SessionTurnState | undefined {
  if (!live) return undefined;
  if (observation === undefined) return recorded;
  if (observation.confirmed) return observation.state;
  return previous?.state === observation.state ? observation.state : recorded;
}

/**
 * The dialog to RECORD beside `next`: the one a `needs-input` observation saw (none for a permission
 * prompt), the one already recorded when this observation did not decide the turn, and none for any
 * turn but `needs-input`.
 */
export function settleTurnPrompt(
  recorded: string | undefined,
  next: SessionTurnState | undefined,
  observation: TurnObservation | undefined,
): string | undefined {
  if (next !== 'needs-input') return undefined;
  return observation?.state === 'needs-input' ? observation.prompt : recorded;
}

/** Whether a status is one this module describes; any other has no turn. */
export const isTurnStatus = (status: SessionStatus): boolean => TURN_STATUSES.has(status);

/**
 * The permission request to RECORD beside `next`, by the same rule as {@link settleTurnPrompt}: the one
 * a `needs-input` observation read, the one already recorded when this observation did not decide the
 * turn, and none for any turn but `needs-input`.
 */
export function settlePermissionRequest(
  recorded: PermissionRequest | undefined,
  next: SessionTurnState | undefined,
  observation: TurnObservation | undefined,
): PermissionRequest | undefined {
  if (next !== 'needs-input') return undefined;
  return observation?.state === 'needs-input' ? observation.request : recorded;
}

/** The harness dialog to RECORD beside `next`, by the same rule as {@link settlePermissionRequest}. */
export function settleHarnessDialog(
  recorded: HarnessDialog | undefined,
  next: SessionTurnState | undefined,
  observation: TurnObservation | undefined,
): HarnessDialog | undefined {
  if (next !== 'needs-input') return undefined;
  return observation?.state === 'needs-input' ? observation.dialog : recorded;
}

// ── today's turn/usage-limit.ts ─────────────────────────────────────────────────────────────────

/** What the dialog says about the login it came from. */
export interface UsageLimit {
  /** The harness's own sentence: "You've hit your org's monthly spend limit · run /usage-credits …". */
  readonly notice: string;
  /** Whether it is a spend limit (money), as opposed to a usage window. */
  readonly spend: boolean;
  /** When the harness says it continues by itself, epoch milliseconds in the host's local time. */
  readonly retryAt?: number;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const;

/** "continue automatically at Nov 1, 12am" / "at Nov 1, 3:30pm": month, day, hour, optional minutes, am or pm. */
const CONTINUE_AT =
  /continue automatically at\s+([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*([ap])m\b/iu;

/**
 * The instant "Nov 1, 12am" names, in the host's local time, or `undefined` when the label has none.
 *
 * The harness prints no year, so it is the nearest one that puts the instant at or after `nowMs`
 * (a reset is never in the past). An hour or day out of range reads as no time at all.
 */
export function parseContinueAt(label: string, nowMs: number): number | undefined {
  const match = CONTINUE_AT.exec(label);
  if (match === null) return undefined;
  const month = MONTHS.indexOf((match[1] as string).toLowerCase() as (typeof MONTHS)[number]);
  const day = Number(match[2]);
  const hour12 = Number(match[3]);
  const minute = match[4] === undefined ? 0 : Number(match[4]);
  if (month < 0 || day < 1 || day > 31 || hour12 < 1 || hour12 > 12 || minute > 59) return undefined;
  const hour = (hour12 % 12) + ((match[5] as string).toLowerCase() === 'p' ? 12 : 0);
  const year = new Date(nowMs).getFullYear();
  for (const candidate of [year, year + 1]) {
    const at = new Date(candidate, month, day, hour, minute);
    if (at.getMonth() === month && at.getDate() === day && at.getTime() >= nowMs) return at.getTime();
  }
  return undefined;
}

/** The limit a dialog reports, or `undefined` when it is not the usage-limit dialog. */
export function usageLimitOf(dialog: HarnessDialog | undefined, nowMs: number): UsageLimit | undefined {
  if (dialog?.kind !== 'usage-limit') return undefined;
  const notice = dialog.body?.split('\n')[0]?.trim() || dialog.title;
  const retryAt = dialog.options
    .map(option => parseContinueAt(option.label, nowMs))
    .find((at): at is number => at !== undefined);
  return { notice, spend: /\bspend\b/iu.test(notice), ...(retryAt === undefined ? {} : { retryAt }) };
}

type Quota = NonNullable<SessionState['quota']>;

/**
 * The error codes a harness writes on a turn its provider refused for quota. Codex's
 * `codex_error_info`; anything else — a stream error, a refusal, a crash — is not a quota fact.
 */
const USAGE_LIMIT_CODES: ReadonlySet<string> = new Set(['usage_limit_exceeded']);

/**
 * The limit the transcript's NEWEST turn ended on, or `undefined` when that turn ended any other way,
 * has not ended, or there is no turn at all.
 *
 * Read from the end: the boundary's own error is written right after it, so an error met before any
 * boundary is the newest turn's. Bookkeeping (usage, settings, attachments) is skipped; anything else —
 * a message, a tool call, a new `started` — means a later turn and so no limit.
 */
export function transcriptUsageLimit(events: readonly TranscriptEvent[]): UsageLimit | undefined {
  let limit: UsageLimit | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as TranscriptEvent;
    if (event.kind === 'usage' || event.kind === 'settings' || event.kind === 'attachment') continue;
    if (event.kind === 'error') {
      if (limit === undefined && event.error.code !== undefined && USAGE_LIMIT_CODES.has(event.error.code)) {
        const notice = event.error.message.split('\n')[0]?.trim() || 'The login hit its usage limit';
        limit = { notice, spend: /\bspend\b/iu.test(notice) };
      }
      continue;
    }
    return event.kind === 'turn' && event.state !== 'started' ? limit : undefined;
  }
  return undefined;
}

/** The quota fields this module owns: the ones it sets and the ones it removes again. */
const OWNED = ['atLimit', 'unavailable', 'unavailableReason', 'retryAt', 'resetAt', 'limitNotice'] as const;

/** The quota a limited session records: the login is at its limit, and until when when that is known. */
export function limitedQuota(current: Quota | undefined, limit: UsageLimit): Quota {
  return {
    ...clearedQuota(current),
    atLimit: true,
    limitNotice: limit.notice,
    ...(limit.spend ? { unavailable: true, unavailableReason: 'spend_limit' as const } : {}),
    ...(limit.retryAt === undefined ? {} : { retryAt: limit.retryAt, resetAt: limit.retryAt }),
  };
}

/** The quota once the limit is gone: this module's fields removed, everything else kept. */
export function clearedQuota(current: Quota | undefined): Quota | undefined {
  if (current === undefined) return undefined;
  const rest = { ...current };
  for (const field of OWNED) delete rest[field];
  return Object.keys(rest).length === 0 ? undefined : rest;
}

/**
 * The status and quota to record beside a turn change, or `undefined` when the change settles neither.
 *
 * Limited: a live session whose dialog is the usage-limit one, or whose newest turn the transcript says
 * ended on its limit (`proved`, from {@link transcriptUsageLimit}), becomes `rate_limited` with the limit
 * in its quota. A turn seen WORKING is a turn the provider accepted, so it proves no limit whatever an
 * older record says. Released: a `rate_limited` session this module limited — its recorded dialog was
 * the usage-limit one, or its quota carries the notice this module wrote — goes back to `running` once
 * neither shows a limit, and a `running` one loses a notice a send left behind; only on that signature,
 * so a `rate_limited` this module did not set is never undone by it.
 */
export function limitPatch(
  current: Pick<SessionState, 'status' | 'quota' | 'harnessDialog'>,
  dialog: HarnessDialog | undefined,
  nowMs: number,
  proved?: { readonly limit: UsageLimit | undefined; readonly to: SessionTurnState | undefined },
): { readonly status: 'rate_limited' | 'running'; readonly quota: Quota | undefined } | undefined {
  const limit = usageLimitOf(dialog, nowMs) ?? (proved?.to === 'working' ? undefined : proved?.limit);
  if (limit !== undefined) return { status: 'rate_limited', quota: limitedQuota(current.quota, limit) };
  const ours = current.harnessDialog?.kind === 'usage-limit' || current.quota?.limitNotice !== undefined;
  if (current.status === 'rate_limited' && ours) return { status: 'running', quota: clearedQuota(current.quota) };
  // A send moves a limited session to `running` without touching its quota; its next turn that proves no
  // limit takes the stale notice away, so no reader counts a login spent on a session that is working.
  if (current.status === 'running' && current.quota?.limitNotice !== undefined)
    return { status: 'running', quota: clearedQuota(current.quota) };
  return undefined;
}

// ── today's turn/service.ts ─────────────────────────────────────────────────────────────────────

/** How often the watcher looks: often enough that a finished turn reads as finished within seconds. */
export const TURN_WATCH_INTERVAL_MS = 2_000;

/** One session as the watcher needs it. */
export interface TurnWatchSession {
  readonly id: SessionId;
  readonly state: TurnFacts;
}

export interface SessionTurnPorts {
  /** Every session this daemon holds, with the fields a decision reads. */
  sessions(): Promise<readonly TurnWatchSession[]>;
  /** The transcript tail, or `undefined` when no transcript is proved to be this session's yet. */
  transcript(id: SessionId): Promise<readonly TranscriptEvent[] | undefined>;
  /** One live frame of the agent's pane, or `undefined` when there is no pane to read. */
  pane(id: SessionId): Promise<TurnPaneEvidence | undefined>;
  /**
   * Records the change under the session's own lock, re-reading the status there so a stop that
   * landed meanwhile is never overwritten, and journals it so the event stream carries it. Answers
   * whether anything was written.
   */
  record(id: SessionId, change: TurnStateChange, at: string): Promise<boolean>;
  readonly clock: ClockPort;
}

export interface TurnWatchReport {
  readonly changed: ReadonlyMap<SessionId, TurnStateChange>;
  readonly failures: ReadonlyMap<SessionId, string>;
}

/** The background loop as the composition root arms it. */
export interface TurnWatchLoop {
  readonly intervalMs: number;
  /** One tick. Never rejects: a background timer must not take the daemon down. */
  run(): Promise<TurnWatchReport | undefined>;
}

/**
 * THE ONE OWNER OF `turnState` — the loop that runs the session observer's turn part on a timer (today's
 * `SessionTurnWatcher` class). `tick` is one look at every session, answering what changed and what failed.
 */
export interface SessionTurnWatcher extends TurnWatchLoop {
  tick(): Promise<TurnWatchReport>;
}

/** Builds a watcher over `ports`: `new SessionTurnWatcher(ports)` today. */
export type SessionTurnWatcherFactory = (ports: SessionTurnPorts) => SessionTurnWatcher;

// ── today's adapters/session/turn/pane-frames.ts ────────────────────────────────────────────────

/**
 * The last frame captured of each running pane, read through one tmux client (today's `PaneFrames` class).
 */
export interface PaneFrames {
  /** The pane as captured now, or `undefined` when it is gone or dead. */
  state(tmuxSession: string): Promise<PaneState | undefined>;
  /** Forgets the frame kept for `tmuxSession`. */
  forget(tmuxSession: string): void;
}

/** Frames read through `port`: `new PaneFrames(new TmuxController(port), clock)` today. */
export type PaneFramesFactory = (port: TmuxCommandPort, clock: ClockPort) => PaneFrames;
