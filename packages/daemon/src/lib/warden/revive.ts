/**
 * Auto-revive: which dead sessions the Warden starts again, and in what order.
 *
 * THE RULE. The Warden revives a session that died ABNORMALLY — nobody chose its end — and never one that
 * ended on purpose. "Chose" is read from the session's own journal, from its LAST terminal event only:
 *
 * - `session.exited` with status `failed` is the one revivable end: the terminal vanished (tmux crashed or
 *   was restarted), a signal killed the agent, or the agent exited non-zero.
 * - `session.stopped` (anyone stopped it), `session.completed` (the done marker), `session.failed` (it never
 *   started, or a revive already failed) and a clean exit are all decisions or repeats; a restart would undo
 *   the decision or repeat the failure.
 *
 * THE LIMITS, so a crash can never become a loop. A death older than the window is last week's fleet, not
 * this crash; a session is revived once per cooldown; a session that crashed by itself (non-zero exit) is
 * revived once ever; a fleet-wide death (three sessions inside ten seconds — the tmux server went) is revived
 * in waves, leads first, children after their lead; and a revived session that dies again within two minutes
 * (or more than half of a wave doing so) opens a circuit breaker that stops every revive for a while.
 *
 * GAP (declared): no out-of-memory evidence is recorded anywhere today — a kill by the kernel's OOM killer
 * looks like SIGKILL (or exit 137) and is worded as exactly that. Nothing here claims "out of memory"; the
 * day an exit carries that fact, it is one more {@link ReviveCause}.
 *
 * GAP (declared): sessions carry no archived flag in this tree, so there is nothing to filter on for
 * "archived". An archived session would be `stopped` or `completed` first, which this rule already refuses.
 *
 * Pure: no IO, no clock (`nowMs` is a parameter), no globals.
 */

import type { WardenReviveConfig } from '@ferretry/protocol';
import { focusCardBrief, type WardenFocusCard } from './focus-card.ts';
import { instantMs } from './time.ts';

/** One journal event, as the revive reads it. */
export interface ReviveEvent {
  readonly type: string;
  readonly time: string;
  readonly data: unknown;
}

/** Why a session's terminal ended, in the words the revive message and the Warden page use. */
export type ReviveCause =
  | { readonly kind: 'tmux_crashed' }
  | { readonly kind: 'terminal_gone' }
  | { readonly kind: 'signal'; readonly signal: number }
  | { readonly kind: 'agent_crashed'; readonly exitCode: number };

/** Why a failed session is left as it is. */
export type ReviveLeaveReason =
  | 'not_failed'
  | 'stopped'
  | 'completed'
  | 'start_failed'
  | 'clean_exit'
  | 'unrecorded_exit'
  | 'no_terminal_event';

export type EndVerdict =
  | { readonly kind: 'revive'; readonly cause: ReviveCause; readonly diedAt: string }
  | { readonly kind: 'leave'; readonly why: ReviveLeaveReason };

/** Why a session that would have been revived was not, as journalled. */
export type ReviveRefusal =
  | 'stopped'
  | 'cooldown'
  | 'breaker_open'
  | 'too_old'
  | 'parent_stopped'
  | 'crash_repeat'
  | `refused:${string}`;

const TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  'session.exited',
  'session.stopped',
  'session.completed',
  'session.failed',
]);

const SIGNAL_NAMES: Readonly<Record<number, string>> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  4: 'SIGILL',
  6: 'SIGABRT',
  7: 'SIGBUS',
  8: 'SIGFPE',
  9: 'SIGKILL',
  11: 'SIGSEGV',
  13: 'SIGPIPE',
  14: 'SIGALRM',
  15: 'SIGTERM',
};

/** The conventional name of a signal number, or the number itself when it has none here. */
export function signalName(signal: number): string {
  return SIGNAL_NAMES[signal] ?? `signal ${signal}`;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

/**
 * What a shell reports for a process a signal killed: 128 plus the signal. Read as the signal, because
 * "the agent crashed (exit 137)" would hide that something killed it from outside.
 */
const SHELL_SIGNAL_BASE = 128;
const SHELL_SIGNAL_LAST = 159;

/**
 * Whether the session's last terminal event is an abnormal death, and which.
 *
 * `status` is the session's status NOW: only a `failed` session is a candidate, so a session someone has
 * already revived, stopped or finished since is never touched. `events` run oldest first.
 */
export function classifyEnd(status: string, events: readonly ReviveEvent[]): EndVerdict {
  if (status !== 'failed') return { kind: 'leave', why: 'not_failed' };
  const last = events.findLast(event => TERMINAL_EVENTS.has(event.type));
  if (last === undefined) return { kind: 'leave', why: 'no_terminal_event' };
  if (last.type === 'session.stopped') return { kind: 'leave', why: 'stopped' };
  if (last.type === 'session.completed') return { kind: 'leave', why: 'completed' };
  if (last.type === 'session.failed') return { kind: 'leave', why: 'start_failed' };
  const data = isRecord(last.data) ? last.data : {};
  if (data.status !== 'failed') return { kind: 'leave', why: 'clean_exit' };
  const exitCode = typeof data.exitCode === 'number' && Number.isInteger(data.exitCode) ? data.exitCode : undefined;
  if (exitCode === 0) return { kind: 'leave', why: 'clean_exit' };
  const signal = positiveInteger(data.signal);
  if (signal !== undefined) return { kind: 'revive', cause: { kind: 'signal', signal }, diedAt: last.time };
  if (exitCode !== undefined) {
    const shellSignal = exitCode - SHELL_SIGNAL_BASE;
    return exitCode > SHELL_SIGNAL_BASE && exitCode <= SHELL_SIGNAL_LAST
      ? { kind: 'revive', cause: { kind: 'signal', signal: shellSignal }, diedAt: last.time }
      : { kind: 'revive', cause: { kind: 'agent_crashed', exitCode }, diedAt: last.time };
  }
  if (data.pane === 'gone') return { kind: 'revive', cause: { kind: 'terminal_gone' }, diedAt: last.time };
  return { kind: 'leave', why: 'unrecorded_exit' };
}

/** The cause in plain words, finishing the sentence "Your terminal ended because …". */
export function causeText(cause: ReviveCause): string {
  switch (cause.kind) {
    case 'tmux_crashed':
      return 'the tmux server crashed';
    case 'terminal_gone':
      return 'its terminal disappeared';
    case 'signal':
      return `it was killed by a signal (${signalName(cause.signal)})`;
    case 'agent_crashed':
      return `the agent crashed (exit ${cause.exitCode})`;
  }
}

/** The cause as a short key, for the journal. */
export function causeKey(cause: ReviveCause): string {
  switch (cause.kind) {
    case 'tmux_crashed':
    case 'terminal_gone':
      return cause.kind;
    case 'signal':
      return `signal:${signalName(cause.signal)}`;
    case 'agent_crashed':
      return `exit:${cause.exitCode}`;
  }
}

const clock = (at: string): string => `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;

/**
 * What a revived session is told.
 *
 * An AUTO session is told why and to carry on, on its focus card when it has one (`focus-card.ts`). An
 * INTERACTIVE one gets the notice only: somebody is typing into that terminal, and an instruction to "continue"
 * would be Ferretry putting words in the owner's turn.
 */
export function reviveMessage(
  cause: ReviveCause,
  diedAt: string,
  mode: 'auto' | 'interactive',
  card?: WardenFocusCard,
): string {
  const notice = `Ferretry started your terminal again: it ended because ${causeText(cause)} at ${clock(diedAt)}.`;
  if (mode === 'interactive') return notice;
  return (
    `${notice} Your conversation was resumed as it was. Re-read your last turn file and continue where you left off` +
    (card === undefined ? '.' : `, on the card below.\n\n${focusCardBrief(card)}`)
  );
}

/** One session that died abnormally and is a candidate. */
export interface ReviveSubject {
  readonly id: string;
  readonly mode: 'auto' | 'interactive';
  readonly parent?: string;
  readonly cause: ReviveCause;
  readonly diedAt: string;
}

/** A session as the planner sees the fleet: enough to walk ancestry. */
export interface ReviveFleetEntry {
  readonly id: string;
  readonly status: string;
  readonly parent?: string;
}

/** What the Warden remembers of its own revives, durably. */
export interface ReviveSessionRecord {
  readonly revivedAt: string;
  /** How many times it was revived, ever. */
  readonly attempts: number;
  /** How many of those were for a non-zero exit — only one is ever allowed. */
  readonly crashRevives: number;
}

export interface ReviveBatchRecord {
  readonly at: string;
  readonly ids: readonly string[];
}

export interface ReviveBreaker {
  readonly openedAt: string;
  readonly until: string;
  readonly why: string;
}

export interface ReviveState {
  readonly sessions: Readonly<Record<string, ReviveSessionRecord>>;
  /** The waves revived, newest last, bounded: the breaker asks how many of one died again. */
  readonly batches: readonly ReviveBatchRecord[];
  readonly breaker?: ReviveBreaker;
  /** Deaths already explained once (`<id>@<diedAt>` → when), so a refusal is journalled once and not every sweep. */
  readonly refused: Readonly<Record<string, string>>;
}

export const EMPTY_REVIVE_STATE: ReviveState = { sessions: {}, batches: [], refused: {} };

/** How many wave records the state keeps. */
export const REVIVE_BATCH_LIMIT = 10;

/** A death this soon after a revive is the revive not taking. */
export const REVIVE_QUICK_DEATH_MS = 2 * 60_000;

/** This many deaths this close together is one event, not several. */
export const CASCADE_COUNT = 3;
export const CASCADE_SPAN_MS = 10_000;

const MINUTE_MS = 60_000;

/** The key a death is remembered under once it has been explained. */
export const deathKey = (subject: Pick<ReviveSubject, 'id' | 'diedAt'>): string => `${subject.id}@${subject.diedAt}`;

/**
 * Whether the fleet-wide-death signature is present: {@link CASCADE_COUNT} deaths within
 * {@link CASCADE_SPAN_MS} of each other. Answers the ids that are part of such a cluster.
 */
export function cascadeMembers(subjects: readonly ReviveSubject[]): ReadonlySet<string> {
  const deaths = subjects.map(subject => ({ id: subject.id, at: instantMs(subject.diedAt) ?? 0 }));
  const members = new Set<string>();
  for (const death of deaths) {
    const near = deaths.filter(other => Math.abs(other.at - death.at) <= CASCADE_SPAN_MS);
    if (near.length >= CASCADE_COUNT) for (const other of near) members.add(other.id);
  }
  return members;
}

/**
 * Whether the circuit breaker must open, and why.
 *
 * Two signs the revives are not taking: a revived session died again within {@link REVIVE_QUICK_DEATH_MS}, or
 * more than half of one wave died again. Either is read from `subjects` — the deaths seen now — against what
 * was recorded when each was revived, so it needs no event of its own.
 */
export function breakerVerdict(
  state: ReviveState,
  subjects: readonly ReviveSubject[],
  nowMs: number,
  config: WardenReviveConfig,
): ReviveBreaker | undefined {
  const open = (why: string): ReviveBreaker => ({
    openedAt: new Date(nowMs).toISOString(),
    until: new Date(nowMs + config.breakerMinutes * MINUTE_MS).toISOString(),
    why,
  });
  const diedAgain = (subject: ReviveSubject): number | undefined => {
    const record = state.sessions[subject.id];
    const revivedMs = record === undefined ? undefined : instantMs(record.revivedAt);
    const diedMs = instantMs(subject.diedAt);
    return revivedMs === undefined || diedMs === undefined || diedMs <= revivedMs ? undefined : diedMs - revivedMs;
  };
  const quick = subjects.find(subject => (diedAgain(subject) ?? Infinity) <= REVIVE_QUICK_DEATH_MS);
  if (quick !== undefined) return open(`${quick.id} died again within 2 minutes of being revived`);
  for (const batch of state.batches) {
    const again = batch.ids.filter(id => {
      const subject = subjects.find(candidate => candidate.id === id);
      const batchMs = instantMs(batch.at);
      const diedMs = subject === undefined ? undefined : instantMs(subject.diedAt);
      return batchMs !== undefined && diedMs !== undefined && diedMs > batchMs;
    });
    if (again.length * 2 > batch.ids.length)
      return open(`${again.length} of the ${batch.ids.length} sessions revived together died again`);
  }
  return undefined;
}

/** One session placed in a wave. */
export interface PlannedRevive extends ReviveSubject {
  /** One-based. */
  readonly wave: number;
}

export interface RevivePlan {
  readonly waves: readonly (readonly PlannedRevive[])[];
  readonly refused: readonly { readonly subject: ReviveSubject; readonly why: ReviveRefusal }[];
  /** Whether this is a fleet-wide death: the caller waits for the tmux server first. */
  readonly cascade: boolean;
}

/** Whether `id` or anything above it is a session someone stopped. */
function ancestorStopped(id: string, fleet: ReadonlyMap<string, ReviveFleetEntry>): boolean {
  const seen = new Set<string>([id]);
  for (let parent = fleet.get(id)?.parent; parent !== undefined; parent = fleet.get(parent)?.parent) {
    if (seen.has(parent)) return false;
    seen.add(parent);
    if (fleet.get(parent)?.status === 'stopped') return true;
  }
  return false;
}

/**
 * Who is revived now, in which wave, and who is refused and why.
 *
 * Refusals are checked in a fixed order — too old, breaker open, a stopped ancestor, cooldown, a repeat
 * crash — so a session reports the first reason that applies. What survives is ordered into waves of at most
 * `waveSize`: interactive sessions first (a person may be waiting), then leads, then the earliest to die; a
 * child never shares a wave with, or precedes, a lead that is itself being revived.
 *
 * In a cascade a "terminal gone" death is promoted to "the tmux server crashed": three terminals vanishing
 * together is one cause, and saying so is what the session's own notice should read.
 */
export function planRevives(
  subjects: readonly ReviveSubject[],
  fleet: readonly ReviveFleetEntry[],
  state: ReviveState,
  nowMs: number,
  config: WardenReviveConfig,
): RevivePlan {
  const byId = new Map(fleet.map(entry => [entry.id, entry]));
  const members = cascadeMembers(subjects);
  const breakerOpen = state.breaker !== undefined && (instantMs(state.breaker.until) ?? 0) > nowMs;
  const accepted: ReviveSubject[] = [];
  const refused: { subject: ReviveSubject; why: ReviveRefusal }[] = [];
  for (const raw of subjects) {
    const subject: ReviveSubject =
      raw.cause.kind === 'terminal_gone' && members.has(raw.id) ? { ...raw, cause: { kind: 'tmux_crashed' } } : raw;
    const record = state.sessions[subject.id];
    const diedMs = instantMs(subject.diedAt) ?? 0;
    const revivedMs = record === undefined ? undefined : instantMs(record.revivedAt);
    const why: ReviveRefusal | undefined =
      nowMs - diedMs > config.windowMinutes * MINUTE_MS
        ? 'too_old'
        : breakerOpen
          ? 'breaker_open'
          : ancestorStopped(subject.id, byId)
            ? 'parent_stopped'
            : revivedMs !== undefined && nowMs - revivedMs < config.cooldownMinutes * MINUTE_MS
              ? 'cooldown'
              : subject.cause.kind === 'agent_crashed' && (record?.crashRevives ?? 0) > 0
                ? 'crash_repeat'
                : undefined;
    if (why === undefined) accepted.push(subject);
    else refused.push({ subject, why });
  }

  const leads = new Set(accepted.flatMap(subject => (subject.parent === undefined ? [] : [subject.parent])));
  const rank = (subject: ReviveSubject): readonly [number, number, number, string] => [
    subject.mode === 'interactive' ? 0 : 1,
    leads.has(subject.id) ? 0 : 1,
    instantMs(subject.diedAt) ?? 0,
    subject.id,
  ];
  const compare = (left: ReviveSubject, right: ReviveSubject): number => {
    const a = rank(left);
    const b = rank(right);
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3].localeCompare(b[3]);
  };

  const waves: PlannedRevive[][] = [];
  const waiting = [...accepted];
  while (waiting.length > 0) {
    const ready = waiting
      .filter(subject => subject.parent === undefined || !waiting.some(other => other.id === subject.parent))
      .toSorted(compare)
      .slice(0, config.waveSize);
    // A parent cycle leaves nobody ready; the earliest is released rather than wedging the rest.
    const wave = ready.length > 0 ? ready : [waiting.toSorted(compare)[0] as ReviveSubject];
    waves.push(wave.map(subject => ({ ...subject, wave: waves.length + 1 })));
    for (const placed of wave) waiting.splice(waiting.indexOf(placed), 1);
  }
  return { waves, refused, cascade: accepted.some(subject => members.has(subject.id)) };
}
