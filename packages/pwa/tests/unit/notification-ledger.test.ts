import { describe, it } from 'bun:test';
import type { SessionStatus, SessionView } from '@ferretry/protocol';
import should from 'should';

import { daemonId } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import type { FleetSnapshot } from '../../src/lib/fleet-store.ts';
import { DEFAULT_NOTIFICATION_FILTER_PREFERENCES } from '../../src/lib/notification-filter.ts';
import {
  buildNotification,
  classifyTransition,
  DaemonNotificationLedger,
  fleetNotificationEventKey,
  NOTIFY_BURST_LIMIT,
  NOTIFY_COOLDOWN_MS,
  NOTIFY_GROUP_WINDOW_MS,
  type NotificationSpec,
  notificationEventKey,
  notificationTitle,
  planNotifications,
  startNotificationWatch,
  summaryNotification,
} from '../../src/lib/notification-ledger.ts';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
} from '../../src/lib/notification-preferences.ts';
import { sessionView } from '../support/sessions.ts';

const daemonA = daemonId('daemon-a');
const daemonB = daemonId('daemon-b');
const enabledPrefs: NotificationPreferences = { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: true };
const allowAll = DEFAULT_NOTIFICATION_FILTER_PREFERENCES;

const view = (
  id: string,
  status: SessionStatus,
  overrides: Partial<SessionView['config']> = {},
  turn = 4,
): SessionView => sessionView(id, { config: { ...overrides }, state: { status, turn } });

const fleetSnapshot = (
  slices: readonly [typeof daemonA | typeof daemonB, readonly SessionView[] | null][],
): FleetSnapshot => ({
  daemons: new Map(
    slices.map(([daemonId, sessions]) => [
      daemonId,
      { sessions, byId: new Map(), status: sessions === null ? 'idle' : 'ready', error: null },
    ]),
  ),
});

describe('notification classification and ledger', () => {
  it('should keep first sight, waiting, and finished quiet while classifying exact transitions', () => {
    should(classifyTransition(undefined, 'awaiting_user')).be.null();
    should(classifyTransition('awaiting_user', 'awaiting_user')).be.null();
    should(classifyTransition('running', 'awaiting_question')).be.null();
    should(classifyTransition('running', 'awaiting_user')).be.null();
    should(classifyTransition('running', 'failed')).equal('failed');
    should(classifyTransition('running', 'stalled')).equal('failed');
    should(classifyTransition('running', 'kill_failed')).equal('failed');
    should(classifyTransition('running', 'completed')).be.null();
    should(classifyTransition('running', 'stopped')).be.null();
  });

  it('should isolate equal session ids, cooldowns, groups, pruning, and clearing by daemon', () => {
    const ledger = new DaemonNotificationLedger();
    const a = daemonSessionScope({ daemonId: daemonA }, 'same');
    const b = daemonSessionScope({ daemonId: daemonB }, 'same');
    ledger.setStatus(a, 'running');
    ledger.setStatus(b, 'failed');
    should(ledger.shouldFire(a, 'attention', 1_000, 'turn-1')).be.true();
    should(ledger.shouldFire(a, 'attention', 2_000, 'turn-1')).be.false();
    should(ledger.shouldFire(a, 'attention', 2_000, 'turn-2')).be.true();
    should(ledger.shouldFire(b, 'attention', 2_000, 'turn-1')).be.true();
    should(ledger.nextGroupCount(a, 1_000)).equal(1);
    should(ledger.nextGroupCount(a, 2_000)).equal(2);
    should(ledger.nextGroupCount(a, 2_000 + NOTIFY_GROUP_WINDOW_MS + 1)).equal(1);
    ledger.prune(daemonA, new Set());
    should(ledger.status(a)).be.undefined();
    should(ledger.status(b)).equal('failed');
    should(ledger.shouldFire(a, 'attention', 2_001, 'turn-1')).be.true();
    ledger.clearDaemon(daemonA);
    should(ledger.shouldFire(b, 'attention', 2_001 + NOTIFY_COOLDOWN_MS, 'turn-2')).be.true();
  });

  it('should cap one daemon group at one hundred', () => {
    const ledger = new DaemonNotificationLedger();
    const scope = daemonSessionScope({ daemonId: daemonA }, 'busy');
    for (let index = 0; index < 101; index += 1) ledger.nextGroupCount(scope, index);
    should(ledger.nextGroupCount(scope, 102)).equal(100);
  });
});

describe('notification payloads', () => {
  it('should daemon-qualify event keys, tags, session links, summaries, and stable fleet keys', () => {
    const a = daemonSessionScope({ daemonId: daemonA }, 'same/id');
    const b = daemonSessionScope({ daemonId: daemonB }, 'same/id');
    const waiting = view('same/id', 'awaiting_user', { teammate: 'zelda' });
    const aSpec = buildNotification(a, waiting, 'attention');
    const bSpec = buildNotification(b, waiting, 'attention');
    should(aSpec.title).equal('[Zelda] Session same/id');
    should(aSpec.body).equal('Waiting for you at the prompt.');
    const yours = buildNotification(
      a,
      sessionView('same/id', { state: { status: 'running', turn: 4, turnState: 'your-turn' } }),
      'attention',
    );
    should(yours.body).equal('Your turn — finished and waiting for you.');
    should(aSpec.sessionId).equal('same/id');
    should(aSpec.tag).not.equal(bSpec.tag);
    should(aSpec.url).equal('/d/daemon-a/session/same%2Fid');
    should(aSpec.eventKey).equal(notificationEventKey(a, waiting, 'attention'));
    should(aSpec.eventKey).not.equal(bSpec.eventKey);
    should(summaryNotification(daemonA, 7).tag).equal('fy-summary:daemon-a');
    should(summaryNotification(daemonA, 7).url).equal('/d/daemon-a');
    should(summaryNotification(daemonA, 7).sessionId).be.undefined();
    const keys = [aSpec.eventKey, bSpec.eventKey];
    should(fleetNotificationEventKey(daemonA, keys)).equal(fleetNotificationEventKey(daemonA, [...keys].reverse()));
    should(fleetNotificationEventKey(daemonA, keys)).not.equal(fleetNotificationEventKey(daemonB, keys));
  });

  it('should preserve composed titles, clamp counts, and use kind-specific bodies', () => {
    const scope = daemonSessionScope({ daemonId: daemonA }, 's1');
    const composed = view('s1', 'failed', { name: '[Zelda] already composed' });
    should(buildNotification(scope, composed, 'failed', 999).title).equal('[Zelda] already composed');
    should(notificationTitle(composed)).equal('[Zelda] already composed');
    should(buildNotification(scope, composed, 'failed', 999).count).equal(100);
    const failed = view('s1', 'stalled');
    failed.state.reason = 'pane died';
    should(buildNotification(scope, failed, 'failed', -1).body).equal('Stalled — pane died');
    should(buildNotification(scope, view('s1', 'completed'), 'completed').body).equal('Finished its task.');
  });

  it('should treat an agenda push exactly like an attention one: same body, and each turn end is its own event', () => {
    const scope = daemonSessionScope({ daemonId: daemonA }, 's1');
    const yours = sessionView('s1', {
      state: { status: 'running', turn: 4, turnState: 'your-turn', turnStateAt: 't1' },
    });
    const later = sessionView('s1', {
      state: { status: 'running', turn: 4, turnState: 'your-turn', turnStateAt: 't2' },
    });
    should(buildNotification(scope, yours, 'agenda').body).equal(buildNotification(scope, yours, 'attention').body);
    should(notificationEventKey(scope, yours, 'agenda')).not.equal(notificationEventKey(scope, later, 'agenda'));
    should(notificationEventKey(scope, yours, 'attention')).not.equal(notificationEventKey(scope, later, 'attention'));
    should(notificationEventKey(scope, yours, 'completed')).equal(notificationEventKey(scope, later, 'completed'));
  });

  it('should reject a scope that names another session', () => {
    const scope = daemonSessionScope({ daemonId: daemonA }, 'expected');
    const actual = view('actual', 'awaiting_user');
    should(() => notificationEventKey(scope, actual, 'attention')).throw(
      'notification scope must match the session view',
    );
    should(() => buildNotification(scope, actual, 'attention')).throw('notification scope must match the session view');
  });
});

describe('notification planning', () => {
  it('should advance a silent baseline through the per-daemon master switch', () => {
    const ledger = new DaemonNotificationLedger();
    planNotifications(daemonA, [view('s1', 'running'), view('s2', 'running')], ledger, enabledPrefs, allowAll, 1_000);
    const disabled: NotificationPreferences = { ...enabledPrefs, enabled: false };
    should(
      planNotifications(daemonA, [view('s1', 'failed'), view('s2', 'failed')], ledger, disabled, allowAll, 2_000),
    ).have.length(0);
  });

  it('should defer to the device-wide filter for a category switched off', () => {
    const ledger = new DaemonNotificationLedger();
    planNotifications(daemonA, [view('s1', 'running'), view('s2', 'running')], ledger, enabledPrefs, allowAll, 1_000);
    const noFailed = { ...allowAll, categories: { ...allowAll.categories, failed: false } };
    should(
      planNotifications(daemonA, [view('s1', 'failed'), view('s2', 'failed')], ledger, enabledPrefs, noFailed, 2_000),
    ).have.length(0);
  });

  it('should defer to the device-wide filter for a muted machine', () => {
    const ledger = new DaemonNotificationLedger();
    planNotifications(daemonA, [view('s1', 'running')], ledger, enabledPrefs, allowAll, 1_000);
    const muted = { ...allowAll, machines: { [daemonA]: false } };
    should(planNotifications(daemonA, [view('s1', 'failed')], ledger, enabledPrefs, muted, 2_000)).have.length(0);
  });

  it('should defer to the device-wide filter during quiet hours', () => {
    const ledger = new DaemonNotificationLedger();
    planNotifications(daemonA, [view('s1', 'running')], ledger, enabledPrefs, allowAll, 1_000);
    const quiet = { ...allowAll, quietHours: { enabled: true, startMinute: 0, endMinute: 0 } };
    should(planNotifications(daemonA, [view('s1', 'failed')], ledger, enabledPrefs, quiet, 2_000)).have.length(0);
  });

  it('should fire a later real transition and collapse a burst into a daemon dashboard summary', () => {
    const ledger = new DaemonNotificationLedger();
    const many = Array.from({ length: NOTIFY_BURST_LIMIT + 2 }, (_, index) => view(`s${index}`, 'running'));
    should(planNotifications(daemonA, many, ledger, enabledPrefs, allowAll, 1_000)).have.length(0);
    const changed = many.map(item => ({ ...item, state: { ...item.state, status: 'failed' as const } }));
    const summary = planNotifications(daemonA, changed, ledger, enabledPrefs, allowAll, 2_000);
    should(summary).have.length(1);
    should(summary[0]?.tag).equal('fy-summary:daemon-a');
    should(summary[0]?.body).equal(`${NOTIFY_BURST_LIMIT + 2} sessions need you.`);
  });

  it('should plan same session ids independently for paired daemons', () => {
    const ledger = new DaemonNotificationLedger();
    planNotifications(daemonA, [view('shared', 'running')], ledger, enabledPrefs, allowAll, 1_000);
    planNotifications(daemonB, [view('shared', 'running')], ledger, enabledPrefs, allowAll, 1_000);
    const a = planNotifications(daemonA, [view('shared', 'failed')], ledger, enabledPrefs, allowAll, 2_000);
    const b = planNotifications(daemonB, [view('shared', 'failed')], ledger, enabledPrefs, allowAll, 2_000);
    should(a[0]?.tag).not.equal(b[0]?.tag);
    should(a[0]?.scope?.daemonId).equal(daemonA);
    should(b[0]?.scope?.daemonId).equal(daemonB);
  });
});

describe('notification watch', () => {
  it('should skip null hydration, suppress only an equal foreground scope, and unsubscribe', () => {
    let snapshot: FleetSnapshot | null = null;
    const listeners = new Set<() => void>();
    const shown: NotificationSpec[] = [];
    let hidden = false;
    let foreground = daemonSessionScope({ daemonId: daemonA }, 'shared');
    const source = {
      subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      snapshot: () => snapshot,
    };
    const stop = startNotificationWatch(source, {
      prefs: () => ({ ...enabledPrefs, onlyWhenHidden: false }),
      filter: () => allowAll,
      hidden: () => hidden,
      foregroundSession: () => foreground,
      show: spec => shown.push(spec),
      now: () => 2_000,
    });
    for (const listener of listeners) listener();
    snapshot = fleetSnapshot([[daemonA, [view('shared', 'running'), view('other', 'running')]]]);
    for (const listener of listeners) listener();
    snapshot = fleetSnapshot([[daemonA, [view('shared', 'failed', {}, 5), view('other', 'failed', {}, 5)]]]);
    for (const listener of listeners) listener();
    should(shown.map(spec => spec.scope?.sessionId)).deepEqual(['other']);
    foreground = daemonSessionScope({ daemonId: daemonB }, 'other');
    hidden = true;
    snapshot = fleetSnapshot([[daemonA, [view('shared', 'running'), view('other', 'running')]]]);
    for (const listener of listeners) listener();
    snapshot = fleetSnapshot([[daemonA, [view('shared', 'failed'), view('other', 'failed')]]]);
    for (const listener of listeners) listener();
    should(shown.length).equal(3);
    stop();
    snapshot = fleetSnapshot([[daemonA, [view('shared', 'failed'), view('other', 'failed')]]]);
    for (const listener of listeners) listener();
    should(shown.length).equal(3);
  });

  it('should consume a visible hidden-only transition without replaying it later', () => {
    let snapshot: FleetSnapshot | null = fleetSnapshot([[daemonA, [view('s1', 'running')]]]);
    let listener: (() => void) | undefined;
    const shown: NotificationSpec[] = [];
    let hidden = false;
    const source = {
      subscribe: (next: () => void): (() => void) => {
        listener = next;
        return () => undefined;
      },
      snapshot: () => snapshot,
    };
    startNotificationWatch(source, {
      prefs: () => enabledPrefs,
      filter: () => allowAll,
      hidden: () => hidden,
      foregroundSession: () => null,
      show: spec => shown.push(spec),
      now: () => 2_000,
    });
    snapshot = fleetSnapshot([[daemonA, [view('s1', 'failed')]]]);
    listener?.();
    hidden = true;
    listener?.();
    should(shown).have.length(0);
  });

  it('should plan every hydrated daemon slice and preserve equal ids outside the foreground daemon', () => {
    let snapshot: FleetSnapshot | null = fleetSnapshot([
      [daemonA, [view('shared', 'running')]],
      [daemonB, [view('shared', 'running')]],
    ]);
    let listener: (() => void) | undefined;
    const shown: NotificationSpec[] = [];
    const source = {
      subscribe: (next: () => void): (() => void) => {
        listener = next;
        return () => undefined;
      },
      snapshot: () => snapshot,
    };
    startNotificationWatch(source, {
      prefs: () => ({ ...enabledPrefs, onlyWhenHidden: false }),
      filter: () => allowAll,
      hidden: () => false,
      foregroundSession: () => daemonSessionScope({ daemonId: daemonA }, 'shared'),
      show: spec => shown.push(spec),
      now: () => 2_000,
    });
    snapshot = fleetSnapshot([
      [daemonA, [view('shared', 'failed')]],
      [daemonB, [view('shared', 'failed')]],
    ]);
    listener?.();
    should(shown).have.length(1);
    should(shown[0]?.scope?.daemonId).equal(daemonB);
  });

  it('should clear a departed daemon before a same-id re-pair while retaining another daemon ledger', () => {
    let snapshot: FleetSnapshot | null = fleetSnapshot([
      [daemonA, [view('shared', 'running')]],
      [daemonB, [view('shared', 'running')]],
    ]);
    let listener: (() => void) | undefined;
    const shown: NotificationSpec[] = [];
    const ledger = new DaemonNotificationLedger();
    const source = {
      subscribe: (next: () => void): (() => void) => {
        listener = next;
        return () => undefined;
      },
      snapshot: () => snapshot,
    };
    startNotificationWatch(
      source,
      {
        prefs: () => ({ ...enabledPrefs, onlyWhenHidden: false }),
        filter: () => allowAll,
        hidden: () => true,
        foregroundSession: () => null,
        show: spec => shown.push(spec),
        now: () => 2_000,
      },
      ledger,
    );
    snapshot = fleetSnapshot([
      [daemonA, [view('shared', 'failed')]],
      [daemonB, [view('shared', 'failed')]],
    ]);
    listener?.();
    should(shown).have.length(2);
    snapshot = fleetSnapshot([[daemonB, [view('shared', 'failed')]]]);
    listener?.();
    should(ledger.status(daemonSessionScope({ daemonId: daemonA }, 'shared'))).be.undefined();
    should(ledger.status(daemonSessionScope({ daemonId: daemonB }, 'shared'))).equal('failed');
    snapshot = fleetSnapshot([
      [daemonA, [view('shared', 'running')]],
      [daemonB, [view('shared', 'failed')]],
    ]);
    listener?.();
    snapshot = fleetSnapshot([
      [daemonA, [view('shared', 'failed')]],
      [daemonB, [view('shared', 'failed')]],
    ]);
    listener?.();
    should(shown).have.length(3);
  });
});

/**
 * AN ASK REACHES THE OWNER AS AN ATTENTION CARD, not as a session notification: a ferret parked on a
 * question, a permission prompt or a dialog raises an item whose own title and ask are the push. The
 * session watch keeps only a session's failure.
 */
describe('session notifications that remain', () => {
  const turnView = (
    turnState: 'working' | 'your-turn' | 'needs-input',
    turnStateAt: string,
    status: SessionStatus = 'running',
  ): SessionView => sessionView('s1', { state: { status, turn: 4, turnState, turnStateAt } });
  const kinds = (specs: readonly NotificationSpec[]) => specs.map(spec => spec.kind);
  const poll = (ledger: DaemonNotificationLedger, views: readonly SessionView[], at = 1_000) =>
    planNotifications(daemonA, views, ledger, enabledPrefs, allowAll, at);

  it('never notifies a ferret parked on a question, a permission prompt or a dialog', () => {
    const ledger = new DaemonNotificationLedger();
    should(poll(ledger, [turnView('working', 't1')])).have.length(0);
    should(poll(ledger, [turnView('needs-input', 't2')], 2_000)).have.length(0);
    should(poll(ledger, [turnView('needs-input', 't3')], 3_000)).have.length(0);
    should(poll(ledger, [turnView('needs-input', 't4', 'awaiting_question')], 4_000)).have.length(0);
    should(poll(ledger, [view('s1', 'awaiting_question')], 5_000)).have.length(0);
  });

  it('never notifies a ferret that is only waiting for its next turn, nor on first sight or while working', () => {
    const ledger = new DaemonNotificationLedger();
    should(poll(ledger, [turnView('your-turn', 't0')])).have.length(0);
    should(poll(ledger, [turnView('working', 't1')])).have.length(0);
    should(poll(ledger, [turnView('your-turn', 't2')], 2_000)).have.length(0);
    should(poll(ledger, [turnView('working', 't3')], 3_000)).have.length(0);
    should(poll(ledger, [turnView('your-turn', 't4')], 4_000)).have.length(0);
  });

  it("keeps a session's failure, whatever its turn fact says", () => {
    const ledger = new DaemonNotificationLedger();
    poll(ledger, [turnView('working', 't1')]);
    should(kinds(poll(ledger, [turnView('your-turn', 't2', 'failed')], 2_000))).deepEqual(['failed']);
  });
});
