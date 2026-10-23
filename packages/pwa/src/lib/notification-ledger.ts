/**
 * Pure notification planning for one or more runtime-paired daemons.
 *
 * The browser delivery layer supplies visibility and `showNotification`; this
 * module owns only the deterministic transition, de-duplication, and payload
 * decisions. Every session identity flows through `DaemonSessionScope` so two
 * daemons can safely own the same session id.
 */

import type { PushNotificationKind, SessionStatus, SessionView } from '@ferretry/protocol';
import { displayCallsign } from './callsign.ts';
import type { DaemonId } from './daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey, daemonSessionScope } from './daemon-scope.ts';
import type { FleetSnapshot } from './fleet-store.ts';
import { harnessDialogNotice } from './harness-dialogs.ts';
import type { DeviceNotificationFilterPreferences } from './notification-filter.ts';
import { shouldShowNotification } from './notification-filter.ts';
import type { NotificationPreferences } from './notification-preferences.ts';
import { daemonSessionPath, daemonSessionsPath } from './pages/routes.ts';
import { permissionSentence, shortPermissionWhat } from './permission-requests.ts';

export type NotifyKind = PushNotificationKind;

/**
 * The kinds a SESSION transition can produce. `device-paired` is never one of them — no session
 * transition ever means "a new browser was paired" — so it is excluded here rather than given a
 * dead switch case below.
 */
export type SessionNotifyKind = Exclude<NotifyKind, 'device-paired'>;

const FAILED_STATUSES: ReadonlySet<SessionStatus> = new Set(['failed', 'stalled', 'kill_failed']);

/**
 * NOTIFICATIONS ARE ATTENTION (docs/attention.md): a ferret that wants the owner raises an Attention
 * item, and THAT is what pushes. So a ferret that is merely waiting — its turn ended, it is idle at its
 * prompt (`awaiting_user`, `your-turn`) — or that finished (`completed`) notifies nothing here.
 *
 * Two transitions still notify, because the ferret CANNOT raise an item for them itself: its harness
 * is parked on a blocking ask it owns (`awaiting_question`, `needs-input` — a permission prompt, a
 * harness dialog, a structured question), or it died (`failed`, `stalled`, `kill_failed`).
 * First sight and every other transition stay silent.
 */
export const classifyTransition = (prev: SessionStatus | undefined, next: SessionStatus): SessionNotifyKind | null => {
  if (prev === undefined || prev === next) return null;
  if (next === 'awaiting_question') return 'question';
  return FAILED_STATUSES.has(next) ? 'failed' : null;
};

/** One recorded turn boundary: the daemon's `turnState` and the instant it last changed. */
export interface TurnBoundary {
  readonly state: NonNullable<SessionView['state']['turnState']>;
  readonly at: string;
  /** The permission prompt a `needs-input` boundary is parked on, by its request id. */
  readonly permission?: string;
  /** The harness dialog a `needs-input` boundary is parked on, by its dialog id. */
  readonly dialog?: string;
}

/** The boundary a view carries, or `undefined` from a daemon that predates the turn watcher. */
export const turnBoundary = (view: SessionView): TurnBoundary | undefined => {
  const { turnState, turnStateAt, permissionRequest, harnessDialog } = view.state;
  if (turnState === undefined) return undefined;
  return {
    state: turnState,
    at: turnStateAt ?? '',
    ...(permissionRequest === undefined ? {} : { permission: permissionRequest.id }),
    ...(harnessDialog === undefined ? {} : { dialog: harnessDialog.id }),
  };
};

/**
 * A notification for a NEW turn boundary, or none.
 *
 * The daemon's turn watcher is the one owner of whose turn it is, and `turnStateAt` moves exactly
 * when the value changes — so a boundary is notified once, however many times it is read, and a
 * needs-input that fell between two polls still shows as a new boundary rather than being missed. Never
 * while working, never on first sight, and never for `your-turn`: a ferret waiting for its next message
 * is not asking for anything.
 *
 * A NEW PERMISSION PROMPT OR HARNESS DIALOG is a new ask even on an unchanged boundary: a session that is
 * allowed one command and stops at the next one may never leave `needs-input` between two reads, so a
 * changed request or dialog id is notified as a question of its own. One that merely went away is not an ask.
 */
export const classifyTurnTransition = (
  prev: TurnBoundary | undefined,
  next: TurnBoundary | undefined,
): SessionNotifyKind | null => {
  if (prev === undefined || next === undefined) return null;
  const sameBoundary = prev.state === next.state && prev.at === next.at;
  const ask = next.permission ?? next.dialog;
  if (sameBoundary && (ask === undefined || ask === (prev.permission ?? prev.dialog))) return null;
  // A your-turn boundary is the ferret waiting, which never notifies (see `classifyTransition`).
  return next.state === 'needs-input' ? 'question' : null;
};

/**
 * What one view notifies, given what this ledger last saw of it.
 *
 * With a daemon turn fact, "your turn" and "needs input" come from it ALONE — the status words that
 * used to stand in for them (`awaiting_user`, `awaiting_question`) would otherwise notify the same
 * moment a second time. A failure, which is not a turn, still comes from the status.
 */
export const classifySessionNotification = (
  prevStatus: SessionStatus | undefined,
  prevTurn: TurnBoundary | undefined,
  view: SessionView,
): SessionNotifyKind | null => {
  const next = turnBoundary(view);
  const byStatus = classifyTransition(prevStatus, view.state.status);
  if (next === undefined) return byStatus;
  if (byStatus === 'failed') return byStatus;
  return classifyTurnTransition(prevTurn, next);
};

export const NOTIFY_COOLDOWN_MS = 60_000;
export const NOTIFY_GROUP_WINDOW_MS = 15 * 60_000;

type Fired = Readonly<{ at: number; eventKey: string }>;
type Group = Readonly<{ at: number; count: number }>;

const kindKey = (scope: DaemonSessionScope, kind: NotifyKind): string =>
  JSON.stringify([scope.daemonId, scope.sessionId, kind]);

const isDaemonKey = (key: string, daemonId: DaemonId): boolean => {
  const parsed = JSON.parse(key) as readonly unknown[];
  return parsed[0] === daemonId;
};

/**
 * In-memory transition baseline, cooldowns, and notification grouping.
 * `clearDaemon` structurally satisfies `DaemonScopedCache` for pairing
 * lifecycle invalidation.
 */
export class DaemonNotificationLedger {
  readonly #statuses = new Map<string, SessionStatus>();
  readonly #turns = new Map<string, TurnBoundary | undefined>();
  readonly #fired = new Map<string, Fired>();
  readonly #groups = new Map<string, Group>();

  status(scope: DaemonSessionScope): SessionStatus | undefined {
    return this.#statuses.get(daemonSessionKey(scope));
  }

  setStatus(scope: DaemonSessionScope, status: SessionStatus): void {
    this.#statuses.set(daemonSessionKey(scope), status);
  }

  turn(scope: DaemonSessionScope): TurnBoundary | undefined {
    return this.#turns.get(daemonSessionKey(scope));
  }

  setTurn(scope: DaemonSessionScope, turn: TurnBoundary | undefined): void {
    this.#turns.set(daemonSessionKey(scope), turn);
  }

  /** A new logical event may update the same grouped notification immediately. */
  shouldFire(
    scope: DaemonSessionScope,
    kind: NotifyKind,
    at: number,
    eventKey: string,
    cooldownMs = NOTIFY_COOLDOWN_MS,
  ): boolean {
    const key = kindKey(scope, kind);
    const last = this.#fired.get(key);
    if (last !== undefined && last.eventKey === eventKey && at - last.at < cooldownMs) return false;
    this.#fired.set(key, { at, eventKey });
    return true;
  }

  nextGroupCount(scope: DaemonSessionScope, at: number, windowMs = NOTIFY_GROUP_WINDOW_MS): number {
    const key = daemonSessionKey(scope);
    const previous = this.#groups.get(key);
    const count = previous === undefined || at - previous.at > windowMs ? 1 : Math.min(100, previous.count + 1);
    this.#groups.set(key, { at, count });
    return count;
  }

  /** Removes only the given daemon's departed sessions. */
  prune(daemonId: DaemonId, liveSessionIds: ReadonlySet<string>): void {
    const live = new Set(
      [...liveSessionIds].map(sessionId => daemonSessionKey(daemonSessionScope({ daemonId }, sessionId))),
    );
    for (const key of this.#statuses.keys())
      if (isDaemonKey(key, daemonId) && !live.has(key)) this.#statuses.delete(key);
    for (const key of this.#turns.keys()) if (isDaemonKey(key, daemonId) && !live.has(key)) this.#turns.delete(key);
    for (const key of this.#fired.keys()) {
      const [entryDaemon, sessionId] = JSON.parse(key) as [DaemonId, string, NotifyKind];
      if (entryDaemon === daemonId && !live.has(daemonSessionKey(daemonSessionScope({ daemonId }, sessionId))))
        this.#fired.delete(key);
    }
    for (const key of this.#groups.keys()) if (isDaemonKey(key, daemonId) && !live.has(key)) this.#groups.delete(key);
  }

  clearDaemon(daemonId: DaemonId): void {
    for (const key of this.#statuses.keys()) if (isDaemonKey(key, daemonId)) this.#statuses.delete(key);
    for (const key of this.#turns.keys()) if (isDaemonKey(key, daemonId)) this.#turns.delete(key);
    for (const key of this.#fired.keys()) if (isDaemonKey(key, daemonId)) this.#fired.delete(key);
    for (const key of this.#groups.keys()) if (isDaemonKey(key, daemonId)) this.#groups.delete(key);
  }
}

export interface NotificationSpec {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  readonly url: string;
  /** Present for session notifications; fleet summaries intentionally omit it. */
  readonly sessionId?: string;
  readonly scope?: DaemonSessionScope;
  readonly kind?: SessionNotifyKind;
  readonly eventKey: string;
  readonly count: number;
}

const QUESTION_PREVIEW_LEN = 120;

const bodyFor = (view: SessionView, kind: SessionNotifyKind): string => {
  switch (kind) {
    case 'question': {
      const permission = view.state.permissionRequest;
      if (permission !== undefined) {
        const agent = displayCallsign(view.config.teammate) || 'The agent';
        return `${permissionSentence(agent, permission, shortPermissionWhat(permission))} — Allow?`;
      }
      const dialog = view.state.harnessDialog;
      if (dialog !== undefined)
        return harnessDialogNotice(displayCallsign(view.config.teammate) || 'The agent', dialog);
      const question = view.state.pendingQuestion?.questions[0]?.question;
      if (question)
        return question.length > QUESTION_PREVIEW_LEN ? `${question.slice(0, QUESTION_PREVIEW_LEN - 1)}…` : question;
      if (view.state.turnState !== 'needs-input') return 'Asked you a question.';
      // A harness dialog: say what the screen is asking, because nothing in the chat will.
      return view.state.turnPrompt === undefined
        ? 'Needs your input to continue.'
        : `Blocked by a prompt on screen: ${view.state.turnPrompt}`;
    }
    case 'attention':
      return view.state.turnState === 'your-turn'
        ? 'Your turn — finished and waiting for you.'
        : 'Waiting for you at the prompt.';
    case 'failed': {
      const label =
        view.state.status === 'stalled' ? 'Stalled' : view.state.status === 'kill_failed' ? 'Kill failed' : 'Failed';
      return view.state.reason ? `${label} — ${view.state.reason}` : `${label}.`;
    }
    case 'completed':
      return 'Finished its task.';
  }
};

export const notificationEventKey = (scope: DaemonSessionScope, view: SessionView, kind: SessionNotifyKind): string =>
  JSON.stringify(notificationEventParts(scope, view, kind));

const notificationEventParts = (
  scope: DaemonSessionScope,
  view: SessionView,
  kind: SessionNotifyKind,
): readonly [DaemonId, string, SessionNotifyKind, SessionStatus, number, string] => {
  if (scope.sessionId !== view.config.id) throw new Error('notification scope must match the session view');
  return [
    scope.daemonId,
    scope.sessionId,
    kind,
    view.state.status,
    view.state.turn,
    // The boundary itself, so each turn end is its own event and never collapsed into the last one.
    kind === 'question'
      ? (view.state.permissionRequest?.id ??
        view.state.harnessDialog?.id ??
        view.state.pendingQuestion?.toolUseId ??
        view.state.turnStateAt ??
        '')
      : kind === 'attention'
        ? (view.state.turnStateAt ?? '')
        : '',
  ];
};

export const notificationTitle = (view: SessionView): string => {
  const task = view.config.name?.trim() || view.config.id;
  if (task.startsWith('[')) return task;
  const callsign = displayCallsign(view.config.teammate);
  return callsign ? `[${callsign}] ${task}` : task;
};

/** Builds a daemon-qualified OS payload for one session transition. */
export const buildNotification = (
  scope: DaemonSessionScope,
  view: SessionView,
  kind: SessionNotifyKind,
  count = 1,
): NotificationSpec => ({
  title: notificationTitle(view),
  body: bodyFor(view, kind),
  tag: `fy-session:${encodeURIComponent(scope.daemonId)}:${encodeURIComponent(scope.sessionId)}`,
  url: daemonSessionPath(scope.daemonId, scope.sessionId),
  sessionId: scope.sessionId,
  scope,
  kind,
  eventKey: notificationEventKey(scope, view, kind),
  count: Math.max(1, Math.min(100, Math.floor(count))),
});

export const NOTIFY_BURST_LIMIT = 3;

/** Stable FNV-1a fleet identity, distinct even for equal transition sets. */
export const fleetNotificationEventKey = (daemonId: DaemonId, eventKeys: readonly string[]): string => {
  let hash = 0x811c9dc5;
  const joined = [...eventKeys].sort().join('\n');
  for (let index = 0; index < joined.length; index += 1) {
    hash ^= joined.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fleet:${encodeURIComponent(daemonId)}:${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

export const summaryNotification = (
  daemonId: DaemonId,
  count: number,
  eventKey = fleetNotificationEventKey(daemonId, [String(count)]),
): NotificationSpec => ({
  title: 'ferretry',
  body: `${count} sessions need your attention.`,
  tag: `fy-summary:${encodeURIComponent(daemonId)}`,
  url: daemonSessionsPath(daemonId),
  eventKey,
  count: 1,
});

/**
 * Diffs one daemon's fleet while always consuming the transition baseline.
 *
 * `prefs.enabled` is this daemon's own master switch — "per machine on/off" — and is checked first,
 * so a muted machine never even reaches the device-wide filter. `filter` is the single pure decision
 * (`notification-filter.ts`): the four category switches and quiet hours, which are the same for
 * every daemon because they describe this browser, not this machine.
 */
export const planNotifications = (
  daemonId: DaemonId,
  views: readonly SessionView[],
  ledger: DaemonNotificationLedger,
  prefs: NotificationPreferences,
  filter: DeviceNotificationFilterPreferences,
  at: number,
): readonly NotificationSpec[] => {
  const liveSessionIds = new Set<string>();
  const specs: NotificationSpec[] = [];
  const now = new Date(at);
  for (const view of views) {
    const scope = daemonSessionScope({ daemonId }, view.config.id);
    liveSessionIds.add(scope.sessionId);
    const kind = classifySessionNotification(ledger.status(scope), ledger.turn(scope), view);
    ledger.setStatus(scope, view.state.status);
    ledger.setTurn(scope, turnBoundary(view));
    if (kind === null || !prefs.enabled || !shouldShowNotification({ kind, daemonId }, filter, now)) continue;
    const eventKey = notificationEventKey(scope, view, kind);
    if (!ledger.shouldFire(scope, kind, at, eventKey)) continue;
    specs.push(buildNotification(scope, view, kind, ledger.nextGroupCount(scope, at)));
  }
  ledger.prune(daemonId, liveSessionIds);
  return specs.length > NOTIFY_BURST_LIMIT
    ? [
        summaryNotification(
          daemonId,
          specs.length,
          fleetNotificationEventKey(
            daemonId,
            specs.map(spec => spec.eventKey),
          ),
        ),
      ]
    : specs;
};

export interface SessionsSource {
  subscribe(listener: () => void): () => void;
  /** `null` is an unhydrated fleet, which must not reset any baseline. */
  snapshot(): FleetSnapshot | null;
}

export interface NotificationWatchEnvironment {
  prefs(daemonId: DaemonId): NotificationPreferences;
  /** This browser's device-wide filter — the same for every daemon (`notification-filter.ts`). */
  filter(): DeviceNotificationFilterPreferences;
  hidden(): boolean;
  foregroundSession(): DaemonSessionScope | null;
  show(spec: NotificationSpec): void;
  now(): number;
}

/** Starts an injected, multi-daemon watcher with no browser-global dependency. */
export const startNotificationWatch = (
  source: SessionsSource,
  env: NotificationWatchEnvironment,
  ledger: DaemonNotificationLedger = new DaemonNotificationLedger(),
): (() => void) => {
  let priorDaemonIds = new Set<DaemonId>();
  const tick = (): void => {
    const snapshot = source.snapshot();
    if (snapshot === null) return;
    const daemonIds = new Set(snapshot.daemons.keys());
    for (const daemonId of priorDaemonIds) if (!daemonIds.has(daemonId)) ledger.clearDaemon(daemonId);
    priorDaemonIds = daemonIds;
    const visible = !env.hidden();
    const foreground = visible ? env.foregroundSession() : null;
    const foregroundKey = foreground === null ? undefined : daemonSessionKey(foreground);
    const filter = env.filter();
    for (const [daemonId, fleet] of snapshot.daemons) {
      if (fleet.sessions === null) continue;
      const prefs = env.prefs(daemonId);
      const specs = planNotifications(daemonId, fleet.sessions, ledger, prefs, filter, env.now());
      if (visible && prefs.onlyWhenHidden) continue;
      for (const spec of specs)
        if (spec.scope === undefined || daemonSessionKey(spec.scope) !== foregroundKey) env.show(spec);
    }
  };
  tick();
  return source.subscribe(tick);
};
