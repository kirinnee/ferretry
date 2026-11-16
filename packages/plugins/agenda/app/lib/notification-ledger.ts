/**
 * Pure notification planning for one or more runtime-paired daemons.
 *
 * The browser delivery layer supplies visibility and `showNotification`; this
 * module owns only the deterministic transition, de-duplication, and payload
 * decisions. Every session identity flows through `DaemonSessionScope` so two
 * daemons can safely own the same session id.
 */

import { daemonHomeHref } from '../shell.ts';
import { sessionNotificationPath } from '@ferretry/core-asks/contract';
import type { SessionConfig, SessionStatus } from '../shell.ts';
import { parseTaskName } from '../shell.ts';
import { displayCallsign } from '../shell.ts';
import type { DaemonId } from '../shell.ts';
import { type DaemonSessionScope, daemonSessionKey, daemonSessionScope } from '../shell.ts';
import type { DeviceNotificationFilterPreferences, PushNotificationKind } from './notification-filter.ts';
import { shouldShowNotification } from './notification-filter.ts';
import type { NotificationPreferences } from './notification-preferences.ts';

export type NotifyKind = PushNotificationKind;

/**
 * Every status a ferret's view may carry here: Ferrets' four (and the machine's own `running`), and the ones a
 * session list says about a ferret that is waiting, finished or dead. A ferret that DIED says one of the failed three;
 * Ferrets' own list (`starting | working | idle | stopped`) never does: it says `stopped` with an end cause nobody
 * chose (`failedStatusOf`), which the watch reads as `failed`.
 */
export type NotifiedStatus =
  | SessionStatus
  | 'awaiting_user'
  | 'awaiting_question'
  | 'completed'
  | 'failed'
  | 'stalled'
  | 'kill_failed';

/** The ferret, as far as a notification reads it. A Ferrets row (`FerretView`) is one. */
export interface NotifiedView {
  readonly config: SessionConfig;
  readonly state: {
    readonly status: NotifiedStatus;
    readonly reason?: string;
    readonly turn?: number;
    /** Why a stopped ferret ended (Ferrets' end cause); the only place a Ferrets death is told. */
    readonly cause?: { readonly kind: string };
    /** Whose turn the ferret's last turn left it on. */
    readonly turnState?: 'working' | 'your-turn' | 'needs-input';
    /** When that turn ended: each turn end is its own event. */
    readonly turnStateAt?: string;
  };
}

/** Every machine's ferrets as the watch reads them; `sessions: null` is a list not read yet. */
export interface NotifiedFleet {
  readonly daemons: ReadonlyMap<DaemonId, { readonly sessions: readonly NotifiedView[] | null }>;
}

/** A ferret's chat under its machine, as a daemon names it (`/ferrets/<id>/chat`, relative to the machine's pages). */
const ferretPagePath = (daemonId: DaemonId, sessionId: string): string =>
  `${daemonHomeHref(daemonId)}${sessionNotificationPath(sessionId)}`;

/**
 * The kinds a SESSION transition can produce. `device-paired` is never one of them — no session
 * transition ever means "a new browser was paired" — and neither is `question`: a ferret parked on a
 * blocking prompt raises an Agenda item, and THAT pushes, so a page notification would say it twice.
 * Both are excluded here rather than given dead switch cases below.
 */
export type SessionNotifyKind = Exclude<NotifyKind, 'device-paired' | 'question'>;

const FAILED_STATUSES: ReadonlySet<NotifiedStatus> = new Set(['failed', 'stalled', 'kill_failed']);

/**
 * The end causes Ferrets reads as a death (its `FAILED_ENDS`): an end NOBODY CHOSE, or a launch that never ran. A stop
 * somebody chose (`stopped`), completion (`completed`) and a clean exit are not deaths.
 */
const FAILED_END_CAUSES: ReadonlySet<string> = new Set([
  'tmux_crashed',
  'terminal_gone',
  'signal',
  'agent_crashed',
  'start_failed',
]);

/**
 * The view as the watch reads it: a Ferrets `stopped` that carries a failure cause is `failed`, so the one transition
 * into it notifies once (the ledger holds the status, so a repeat tick is no transition) and a ferret that is resumed
 * and dies again notifies again. Every other view is returned as it is.
 */
const failedStatusOf = (view: NotifiedView): NotifiedView =>
  view.state.status === 'stopped' && view.state.cause !== undefined && FAILED_END_CAUSES.has(view.state.cause.kind)
    ? { ...view, state: { ...view.state, status: 'failed' } }
    : view;

/**
 * NOTIFICATIONS ARE ATTENTION (docs/agenda.md): a ferret that wants the owner raises an Agenda
 * item, and THAT is what pushes — its card title is the heading and its ask the body. So a ferret that
 * is merely waiting (`awaiting_user`, `your-turn`), that finished (`completed`), or that is parked on
 * a blocking prompt (`awaiting_question`, `needs-input` — the daemon raises an item for every one)
 * notifies nothing here.
 *
 * One transition still notifies, because a dead ferret CANNOT raise an item for itself: it died
 * (`failed`, `stalled`, `kill_failed`). First sight and every other transition stay silent.
 */
export const classifyTransition = (
  prev: NotifiedStatus | undefined,
  next: NotifiedStatus,
): SessionNotifyKind | null => {
  if (prev === undefined || prev === next) return null;
  return FAILED_STATUSES.has(next) ? 'failed' : null;
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
  readonly #statuses = new Map<string, NotifiedStatus>();
  readonly #fired = new Map<string, Fired>();
  readonly #groups = new Map<string, Group>();

  status(scope: DaemonSessionScope): NotifiedStatus | undefined {
    return this.#statuses.get(daemonSessionKey(scope));
  }

  setStatus(scope: DaemonSessionScope, status: NotifiedStatus): void {
    this.#statuses.set(daemonSessionKey(scope), status);
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
    for (const key of this.#fired.keys()) {
      const [entryDaemon, sessionId] = JSON.parse(key) as [DaemonId, string, NotifyKind];
      if (entryDaemon === daemonId && !live.has(daemonSessionKey(daemonSessionScope({ daemonId }, sessionId))))
        this.#fired.delete(key);
    }
    for (const key of this.#groups.keys()) if (isDaemonKey(key, daemonId) && !live.has(key)) this.#groups.delete(key);
  }

  clearDaemon(daemonId: DaemonId): void {
    for (const key of this.#statuses.keys()) if (isDaemonKey(key, daemonId)) this.#statuses.delete(key);
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

const bodyFor = (view: NotifiedView, kind: SessionNotifyKind): string => {
  switch (kind) {
    case 'agenda':
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

export const notificationEventKey = (scope: DaemonSessionScope, view: NotifiedView, kind: SessionNotifyKind): string =>
  JSON.stringify(notificationEventParts(scope, view, kind));

const notificationEventParts = (
  scope: DaemonSessionScope,
  view: NotifiedView,
  kind: SessionNotifyKind,
): readonly [DaemonId, string, SessionNotifyKind, NotifiedStatus, number, string] => {
  if (scope.sessionId !== view.config.id) throw new Error('notification scope must match the session view');
  return [
    scope.daemonId,
    scope.sessionId,
    kind,
    view.state.status,
    view.state.turn ?? 0,
    // The boundary itself, so each turn end is its own event and never collapsed into the last one.
    kind === 'attention' || kind === 'agenda' ? (view.state.turnStateAt ?? '') : '',
  ];
};

export const notificationTitle = (view: NotifiedView): string => {
  const { prefix, task } = parseTaskName(view.config.name);
  const title = task || view.config.id;
  const callsign = displayCallsign(view.config.teammate) || prefix || '';
  return callsign ? `${title} · ${callsign}` : title;
};

/** Builds a daemon-qualified OS payload for one session transition. */
export const buildNotification = (
  scope: DaemonSessionScope,
  view: NotifiedView,
  kind: SessionNotifyKind,
  count = 1,
): NotificationSpec => ({
  title: notificationTitle(view),
  body: bodyFor(view, kind),
  tag: `fy-session:${encodeURIComponent(scope.daemonId)}:${encodeURIComponent(scope.sessionId)}`,
  url: ferretPagePath(scope.daemonId, scope.sessionId),
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
  body: `${count} sessions need you.`,
  tag: `fy-summary:${encodeURIComponent(daemonId)}`,
  url: daemonHomeHref(daemonId),
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
  views: readonly NotifiedView[],
  ledger: DaemonNotificationLedger,
  prefs: NotificationPreferences,
  filter: DeviceNotificationFilterPreferences,
  at: number,
): readonly NotificationSpec[] => {
  const liveSessionIds = new Set<string>();
  const specs: NotificationSpec[] = [];
  const now = new Date(at);
  for (const listed of views) {
    const view = failedStatusOf(listed);
    const scope = daemonSessionScope({ daemonId }, view.config.id);
    liveSessionIds.add(scope.sessionId);
    const kind = classifyTransition(ledger.status(scope), view.state.status);
    ledger.setStatus(scope, view.state.status);
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
  snapshot(): NotifiedFleet | null;
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
    const daemonIds = new Set<DaemonId>(snapshot.daemons.keys());
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
