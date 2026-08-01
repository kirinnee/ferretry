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
import type { NotificationPreferences } from './notification-preferences.ts';
import { daemonSessionPath, daemonSessionsPath } from './pages/routes.ts';

export type NotifyKind = PushNotificationKind;

const FAILED_STATUSES: ReadonlySet<SessionStatus> = new Set(['failed', 'stalled', 'kill_failed']);

/** First sight and non-notifying transitions deliberately remain silent. */
export const classifyTransition = (prev: SessionStatus | undefined, next: SessionStatus): NotifyKind | null => {
  if (prev === undefined || prev === next) return null;
  if (next === 'awaiting_question') return 'question';
  if (next === 'awaiting_user') return 'attention';
  if (FAILED_STATUSES.has(next)) return 'failed';
  return next === 'completed' ? 'completed' : null;
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
  readonly #fired = new Map<string, Fired>();
  readonly #groups = new Map<string, Group>();

  status(scope: DaemonSessionScope): SessionStatus | undefined {
    return this.#statuses.get(daemonSessionKey(scope));
  }

  setStatus(scope: DaemonSessionScope, status: SessionStatus): void {
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
  readonly kind?: NotifyKind;
  readonly eventKey: string;
  readonly count: number;
}

const QUESTION_PREVIEW_LEN = 120;

const bodyFor = (view: SessionView, kind: NotifyKind): string => {
  switch (kind) {
    case 'question': {
      const question = view.state.pendingQuestion?.questions[0]?.question;
      if (question)
        return question.length > QUESTION_PREVIEW_LEN ? `${question.slice(0, QUESTION_PREVIEW_LEN - 1)}…` : question;
      return 'Asked you a question.';
    }
    case 'attention':
      return 'Waiting for you at the prompt.';
    case 'failed': {
      const label =
        view.state.status === 'stalled' ? 'Stalled' : view.state.status === 'kill_failed' ? 'Kill failed' : 'Failed';
      return view.state.reason ? `${label} — ${view.state.reason}` : `${label}.`;
    }
    case 'completed':
      return 'Finished its task.';
  }
};

export const notificationEventKey = (scope: DaemonSessionScope, view: SessionView, kind: NotifyKind): string =>
  JSON.stringify(notificationEventParts(scope, view, kind));

const notificationEventParts = (
  scope: DaemonSessionScope,
  view: SessionView,
  kind: NotifyKind,
): readonly [DaemonId, string, NotifyKind, SessionStatus, number, string] => {
  if (scope.sessionId !== view.config.id) throw new Error('notification scope must match the session view');
  return [
    scope.daemonId,
    scope.sessionId,
    kind,
    view.state.status,
    view.state.turn,
    kind === 'question' ? (view.state.pendingQuestion?.toolUseId ?? '') : '',
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
  kind: NotifyKind,
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

/** Diffs one daemon's fleet while always consuming the transition baseline. */
export const planNotifications = (
  daemonId: DaemonId,
  views: readonly SessionView[],
  ledger: DaemonNotificationLedger,
  prefs: NotificationPreferences,
  at: number,
): readonly NotificationSpec[] => {
  const liveSessionIds = new Set<string>();
  const specs: NotificationSpec[] = [];
  for (const view of views) {
    const scope = daemonSessionScope({ daemonId }, view.config.id);
    liveSessionIds.add(scope.sessionId);
    const kind = classifyTransition(ledger.status(scope), view.state.status);
    ledger.setStatus(scope, view.state.status);
    if (
      kind === null ||
      !prefs.enabled ||
      !prefs.events[kind] ||
      (prefs.interactiveOnly && view.config.mode !== 'interactive')
    )
      continue;
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
    for (const [daemonId, fleet] of snapshot.daemons) {
      if (fleet.sessions === null) continue;
      const prefs = env.prefs(daemonId);
      const specs = planNotifications(daemonId, fleet.sessions, ledger, prefs, env.now());
      if (visible && prefs.onlyWhenHidden) continue;
      for (const spec of specs)
        if (spec.scope === undefined || daemonSessionKey(spec.scope) !== foregroundKey) env.show(spec);
    }
  };
  tick();
  return source.subscribe(tick);
};
