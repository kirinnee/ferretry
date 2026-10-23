import { describe, it } from 'bun:test';
import type { SessionStatus, SessionView } from '@ferretry/protocol';
import should from 'should';

import { daemonId } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import type { FleetSnapshot } from '../../src/lib/fleet-store.ts';
import { DEFAULT_NOTIFICATION_FILTER_PREFERENCES } from '../../src/lib/notification-filter.ts';
import {
  buildNotification,
  classifySessionNotification,
  classifyTransition,
  classifyTurnTransition,
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
  turnBoundary,
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
    should(classifyTransition('running', 'awaiting_question')).equal('question');
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
    const question = view('s1', 'awaiting_question', { name: '[Zelda] already composed' });
    question.state.pendingQuestion = { toolUseId: 't1', questions: [{ question: 'x'.repeat(300) }] };
    should(buildNotification(scope, question, 'question', 999).title).equal('[Zelda] already composed');
    should(notificationTitle(question)).equal('[Zelda] already composed');
    should(buildNotification(scope, question, 'question').body.endsWith('…')).be.true();
    should(buildNotification(scope, question, 'question', 999).count).equal(100);
    const failed = view('s1', 'stalled');
    failed.state.reason = 'pane died';
    should(buildNotification(scope, failed, 'failed', -1).body).equal('Stalled — pane died');
    should(buildNotification(scope, view('s1', 'completed'), 'completed').body).equal('Finished its task.');
    should(buildNotification(scope, view('s1', 'awaiting_question'), 'question').body).equal('Asked you a question.');
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
      planNotifications(
        daemonA,
        [view('s1', 'failed'), view('s2', 'awaiting_question')],
        ledger,
        disabled,
        allowAll,
        2_000,
      ),
    ).have.length(0);
  });

  it('should defer to the device-wide filter for a category switched off', () => {
    const ledger = new DaemonNotificationLedger();
    planNotifications(daemonA, [view('s1', 'running'), view('s2', 'running')], ledger, enabledPrefs, allowAll, 1_000);
    const noFailed = { ...allowAll, categories: { ...allowAll.categories, failed: false } };
    should(
      planNotifications(
        daemonA,
        [view('s1', 'failed'), view('s2', 'awaiting_question')],
        ledger,
        enabledPrefs,
        noFailed,
        2_000,
      ),
    ).have.length(1);
  });

  it('should defer to the device-wide filter for a muted machine', () => {
    const ledger = new DaemonNotificationLedger();
    planNotifications(daemonA, [view('s1', 'running')], ledger, enabledPrefs, allowAll, 1_000);
    const muted = { ...allowAll, machines: { [daemonA]: false } };
    should(
      planNotifications(daemonA, [view('s1', 'awaiting_question')], ledger, enabledPrefs, muted, 2_000),
    ).have.length(0);
  });

  it('should defer to the device-wide filter during quiet hours', () => {
    const ledger = new DaemonNotificationLedger();
    planNotifications(daemonA, [view('s1', 'running')], ledger, enabledPrefs, allowAll, 1_000);
    const quiet = { ...allowAll, quietHours: { enabled: true, startMinute: 0, endMinute: 0 } };
    should(
      planNotifications(daemonA, [view('s1', 'awaiting_question')], ledger, enabledPrefs, quiet, 2_000),
    ).have.length(0);
  });

  it('should fire a later real transition and collapse a burst into a daemon dashboard summary', () => {
    const ledger = new DaemonNotificationLedger();
    const many = Array.from({ length: NOTIFY_BURST_LIMIT + 2 }, (_, index) => view(`s${index}`, 'running'));
    should(planNotifications(daemonA, many, ledger, enabledPrefs, allowAll, 1_000)).have.length(0);
    const changed = many.map(item => ({ ...item, state: { ...item.state, status: 'awaiting_question' as const } }));
    const summary = planNotifications(daemonA, changed, ledger, enabledPrefs, allowAll, 2_000);
    should(summary).have.length(1);
    should(summary[0]?.tag).equal('fy-summary:daemon-a');
    should(summary[0]?.body).equal(`${NOTIFY_BURST_LIMIT + 2} sessions need your attention.`);
  });

  it('should plan same session ids independently for paired daemons', () => {
    const ledger = new DaemonNotificationLedger();
    planNotifications(daemonA, [view('shared', 'running')], ledger, enabledPrefs, allowAll, 1_000);
    planNotifications(daemonB, [view('shared', 'running')], ledger, enabledPrefs, allowAll, 1_000);
    const a = planNotifications(daemonA, [view('shared', 'awaiting_question')], ledger, enabledPrefs, allowAll, 2_000);
    const b = planNotifications(daemonB, [view('shared', 'awaiting_question')], ledger, enabledPrefs, allowAll, 2_000);
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
    snapshot = fleetSnapshot([
      [daemonA, [view('shared', 'awaiting_question', {}, 5), view('other', 'awaiting_question', {}, 5)]],
    ]);
    for (const listener of listeners) listener();
    should(shown.map(spec => spec.scope?.sessionId)).deepEqual(['other']);
    foreground = daemonSessionScope({ daemonId: daemonB }, 'other');
    hidden = true;
    snapshot = fleetSnapshot([[daemonA, [view('shared', 'running'), view('other', 'running')]]]);
    for (const listener of listeners) listener();
    snapshot = fleetSnapshot([[daemonA, [view('shared', 'awaiting_question'), view('other', 'awaiting_question')]]]);
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
    snapshot = fleetSnapshot([[daemonA, [view('s1', 'awaiting_question')]]]);
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
      [daemonA, [view('shared', 'awaiting_question')]],
      [daemonB, [view('shared', 'awaiting_question')]],
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
      [daemonA, [view('shared', 'awaiting_question')]],
      [daemonB, [view('shared', 'awaiting_question')]],
    ]);
    listener?.();
    should(shown).have.length(2);
    snapshot = fleetSnapshot([[daemonB, [view('shared', 'failed')]]]);
    listener?.();
    should(ledger.status(daemonSessionScope({ daemonId: daemonA }, 'shared'))).be.undefined();
    should(ledger.status(daemonSessionScope({ daemonId: daemonB }, 'shared'))).equal('failed');
    snapshot = fleetSnapshot([
      [daemonA, [view('shared', 'awaiting_question')]],
      [daemonB, [view('shared', 'failed')]],
    ]);
    listener?.();
    should(shown).have.length(3);
  });
});

/**
 * THE DAEMON'S TURN FACT DRIVES "YOUR TURN" AND "NEEDS INPUT": exactly once per boundary, never while
 * working, never on first sight, and never missed when a whole turn fell between two polls.
 */
describe('turn-boundary notifications', () => {
  const turnView = (
    turnState: 'working' | 'your-turn' | 'needs-input',
    turnStateAt: string,
    status: SessionStatus = 'running',
  ): SessionView => sessionView('s1', { state: { status, turn: 4, turnState, turnStateAt } });
  const kinds = (specs: readonly NotificationSpec[]) => specs.map(spec => spec.kind);
  const poll = (ledger: DaemonNotificationLedger, views: readonly SessionView[], at = 1_000) =>
    planNotifications(daemonA, views, ledger, enabledPrefs, allowAll, at);

  it('classifies only a changed boundary, and only needs-input, which means a person is wanted', () => {
    should(classifyTurnTransition(undefined, { state: 'your-turn', at: 'a' })).be.null();
    should(classifyTurnTransition({ state: 'working', at: 'a' }, undefined)).be.null();
    should(classifyTurnTransition({ state: 'your-turn', at: 'a' }, { state: 'your-turn', at: 'a' })).be.null();
    should(classifyTurnTransition({ state: 'your-turn', at: 'a' }, { state: 'working', at: 'b' })).be.null();
    should(classifyTurnTransition({ state: 'working', at: 'a' }, { state: 'your-turn', at: 'b' })).be.null();
    should(classifyTurnTransition({ state: 'working', at: 'a' }, { state: 'needs-input', at: 'b' })).equal('question');
    // A whole working stretch fell between two polls: a NEW needs-input boundary all the same.
    should(classifyTurnTransition({ state: 'needs-input', at: 'a' }, { state: 'needs-input', at: 'c' })).equal(
      'question',
    );
    // A ferret that is only waiting for its next message never asks for anything.
    should(classifyTurnTransition({ state: 'your-turn', at: 'a' }, { state: 'your-turn', at: 'c' })).be.null();
    should(turnBoundary(sessionView('s', { state: { status: 'running', turn: 1 } }))).be.undefined();
    should(turnBoundary(turnView('working', 'x'))).deepEqual({ state: 'working', at: 'x' });
    should(turnBoundary(sessionView('s', { state: { status: 'running', turn: 1, turnState: 'working' } }))).deepEqual({
      state: 'working',
      at: '',
    });
  });

  it('never notifies a ferret that is only waiting for its next turn, nor on first sight or while working', () => {
    const ledger = new DaemonNotificationLedger();
    should(poll(ledger, [turnView('your-turn', 't0')])).have.length(0);
    should(poll(ledger, [turnView('working', 't1')])).have.length(0);
    should(poll(ledger, [turnView('working', 't1')])).have.length(0);
    should(poll(ledger, [turnView('your-turn', 't2')], 2_000)).have.length(0);
    should(poll(ledger, [turnView('working', 't3')], 3_000)).have.length(0);
    should(poll(ledger, [turnView('your-turn', 't4')], 4_000)).have.length(0);
  });

  it('notifies a needs-input boundary that fell between two polls, once, never on first sight', () => {
    const ledger = new DaemonNotificationLedger();
    should(poll(ledger, [turnView('needs-input', 't1')])).have.length(0);
    should(kinds(poll(ledger, [turnView('needs-input', 't2')], 2_000))).deepEqual(['question']);
    should(poll(ledger, [turnView('needs-input', 't2')], 3_000)).have.length(0);
  });

  it('notifies needs-input as a question, once per boundary', () => {
    const ledger = new DaemonNotificationLedger();
    poll(ledger, [turnView('working', 't1')]);
    const asked = poll(ledger, [turnView('needs-input', 't2')]);
    should(kinds(asked)).deepEqual(['question']);
    should(asked[0]?.body).equal('Needs your input to continue.');
    should(poll(ledger, [turnView('needs-input', 't2')], 2_000)).have.length(0);
  });

  it('says which dialog a needs-input session is parked on', () => {
    const ledger = new DaemonNotificationLedger();
    const parked = (at: string) =>
      sessionView('s1', {
        state: {
          status: 'running',
          turn: 4,
          turnState: 'needs-input',
          turnStateAt: at,
          turnPrompt: 'Make auto mode your default permission mode?',
        },
      });
    poll(ledger, [turnView('working', 't1')]);
    const asked = poll(ledger, [parked('t2')]);
    should(asked[0]?.body).equal('Blocked by a prompt on screen: Make auto mode your default permission mode?');
  });

  describe('a permission prompt', () => {
    const prompt = (id: string, what: string, teammate?: string): SessionView =>
      sessionView('s1', {
        ...(teammate === undefined ? {} : { config: { teammate } }),
        state: {
          status: 'running',
          turn: 4,
          turnState: 'needs-input',
          turnStateAt: 't2',
          permissionRequest: {
            id,
            harness: 'claude',
            tool: 'Read',
            action: 'read',
            what,
            question: 'Do you want to proceed?',
            options: [
              { number: 1, label: 'Yes', kind: 'allow' },
              { number: 2, label: 'No', kind: 'deny' },
            ],
            selected: 1,
          },
        },
      });
    const FIRST = '0123456789abcdef';
    const SECOND = 'fedcba9876543210';

    it('carries its request id on the boundary, and a new id on the same boundary is a new ask', () => {
      should(turnBoundary(prompt(FIRST, '/etc/hostname'))).deepEqual({
        state: 'needs-input',
        at: 't2',
        permission: FIRST,
      });
      const at = { state: 'needs-input', at: 't2' } as const;
      should(classifyTurnTransition({ ...at, permission: FIRST }, { ...at, permission: FIRST })).be.null();
      should(classifyTurnTransition({ ...at, permission: FIRST }, { ...at, permission: SECOND })).equal('question');
      should(classifyTurnTransition(at, { ...at, permission: FIRST })).equal('question');
      // A prompt that went away is no new ask.
      should(classifyTurnTransition({ ...at, permission: FIRST }, at)).be.null();
    });

    it('notifies each request once, in plain words, keyed by its id', () => {
      const ledger = new DaemonNotificationLedger();
      poll(ledger, [turnView('working', 't1')]);
      const path = '~/.ferretry/sessions/s1/turns/some/deeper/folder/turn-008.md';
      const asked = poll(ledger, [prompt(FIRST, path, 'hadi')]);
      should(kinds(asked)).deepEqual(['question']);
      should(asked[0]?.body).equal('Hadi wants to read ~/…/turn-008.md — Allow?');
      should(asked[0]?.eventKey).containEql(FIRST);
      should(poll(ledger, [prompt(FIRST, path, 'hadi')], 2_000)).have.length(0);
      // Allowed, and parked on the next prompt without the boundary moving.
      const next = poll(ledger, [prompt(SECOND, '/etc/hosts')], 3_000);
      should(next[0]?.body).equal('The agent wants to read /etc/hosts — Allow?');
      should(next[0]?.eventKey).containEql(SECOND);
      should(poll(ledger, [prompt(SECOND, '/etc/hosts')], 4_000)).have.length(0);
    });
  });

  describe('a harness dialog', () => {
    const parked = (id: string, teammate?: string): SessionView =>
      sessionView('s1', {
        ...(teammate === undefined ? {} : { config: { teammate } }),
        state: {
          status: 'running',
          turn: 4,
          turnState: 'needs-input',
          turnStateAt: 't2',
          turnPrompt: 'Hooks need review',
          harnessDialog: {
            id,
            harness: 'codex',
            kind: 'hooks-review',
            title: 'Hooks need review',
            options: [{ number: 1, label: 'Review hooks', grantsTrust: false }],
            selected: 1,
          },
        },
      });
    const FIRST = '0123456789abcdef';
    const SECOND = 'fedcba9876543210';

    it('carries its dialog id on the boundary, and a new id on the same boundary is a new ask', () => {
      should(turnBoundary(parked(FIRST))).deepEqual({ state: 'needs-input', at: 't2', dialog: FIRST });
      const at = { state: 'needs-input', at: 't2' } as const;
      should(classifyTurnTransition({ ...at, dialog: FIRST }, { ...at, dialog: FIRST })).be.null();
      should(classifyTurnTransition({ ...at, dialog: FIRST }, { ...at, dialog: SECOND })).equal('question');
      should(classifyTurnTransition(at, { ...at, dialog: FIRST })).equal('question');
      should(classifyTurnTransition({ ...at, permission: FIRST }, { ...at, dialog: SECOND })).equal('question');
      should(classifyTurnTransition({ ...at, dialog: FIRST }, at)).be.null();
    });

    it('notifies each dialog once, in plain words, keyed by its id', () => {
      const ledger = new DaemonNotificationLedger();
      poll(ledger, [turnView('working', 't1')]);
      const asked = poll(ledger, [parked(FIRST, 'hadi')]);
      should(kinds(asked)).deepEqual(['question']);
      should(asked[0]?.body).equal('Hadi is waiting on Codex: Hooks need review');
      should(asked[0]?.eventKey).containEql(FIRST);
      should(poll(ledger, [parked(FIRST, 'hadi')], 2_000)).have.length(0);
      const next = poll(ledger, [parked(SECOND)], 3_000);
      should(next[0]?.body).equal('The agent is waiting on Codex: Hooks need review');
      should(next[0]?.eventKey).containEql(SECOND);
      should(poll(ledger, [parked(SECOND)], 4_000)).have.length(0);
    });
  });

  it("does not notify the status word beside the turn fact, but keeps a session's failure", () => {
    const ledger = new DaemonNotificationLedger();
    poll(ledger, [turnView('working', 't1')]);
    // The send path's own `awaiting_user` on an interrupt is the ferret waiting, which is silent.
    should(poll(ledger, [turnView('your-turn', 't2', 'awaiting_user')])).have.length(0);
    should(poll(ledger, [turnView('your-turn', 't2', 'awaiting_user')], 2_000)).have.length(0);
    should(kinds(poll(ledger, [turnView('your-turn', 't2', 'failed')], 3_000))).deepEqual(['failed']);
    // A question status beside a needs-input turn fact is one notification, not two.
    should(kinds(poll(ledger, [turnView('needs-input', 't4', 'awaiting_question')], 4_000))).deepEqual(['question']);
  });

  it('forgets the turn baseline with the session and with the daemon', () => {
    const ledger = new DaemonNotificationLedger();
    const scope = daemonSessionScope({ daemonId: daemonA }, 's1');
    poll(ledger, [turnView('working', 't1')]);
    should(ledger.turn(scope)).deepEqual({ state: 'working', at: 't1' });
    poll(ledger, []);
    should(ledger.turn(scope)).be.undefined();
    poll(ledger, [turnView('working', 't1')]);
    ledger.clearDaemon(daemonA);
    should(ledger.turn(scope)).be.undefined();
  });

  it('still notifies a question or failure from the status alone for a daemon with no turn fact', () => {
    should(classifySessionNotification('running', undefined, view('s', 'awaiting_question'))).equal('question');
    should(classifySessionNotification('running', undefined, view('s', 'failed'))).equal('failed');
    should(classifySessionNotification('running', undefined, view('s', 'awaiting_user'))).be.null();
    should(classifySessionNotification('running', undefined, view('s', 'completed'))).be.null();
  });
});
