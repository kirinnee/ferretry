import { describe, it } from 'bun:test';
import { DEFAULT_WARDEN_CONFIG, type WardenAction, type WardenConfig } from '@ferretry/protocol';
import should from 'should';
import {
  EMPTY_REVIVE_STATE,
  REVIVE_TMUX_WAIT_TRIES,
  type ReviveEvent,
  type ReviveState,
  WARDEN_LABEL,
  WardenReviveService,
  type WardenResumeOutcome,
  type WardenReviveNotice,
  type WardenSessionView,
} from '../../../src/lib/warden/index.ts';

const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const ago = (seconds: number): string => new Date(NOW - seconds * 1000).toISOString();

const config = (revive: Partial<WardenConfig['revive']> = {}, enabled = true): WardenConfig => ({
  ...DEFAULT_WARDEN_CONFIG,
  enabled,
  revive: { ...DEFAULT_WARDEN_CONFIG.revive, ...revive },
});

const view = (
  id: string,
  overrides: {
    status?: string;
    finishedAt?: string | null;
    mode?: 'auto' | 'interactive';
    parent?: string;
    label?: string;
    wardenLineage?: boolean;
  } = {},
): WardenSessionView =>
  ({
    config: {
      id,
      mode: overrides.mode ?? 'auto',
      ...(overrides.parent === undefined ? {} : { parent: overrides.parent }),
      ...(overrides.label === undefined ? {} : { label: overrides.label }),
      ...(overrides.wardenLineage === undefined ? {} : { wardenLineage: overrides.wardenLineage }),
    },
    state: {
      status: overrides.status ?? 'failed',
      ...(overrides.finishedAt === null ? {} : { finishedAt: overrides.finishedAt ?? ago(60) }),
    },
    hasLiveMonitor: false,
  }) as WardenSessionView;

const gone = (time = ago(60)): ReviveEvent => ({
  type: 'session.exited',
  time,
  data: { status: 'failed', pane: 'gone', exitCode: null },
});

interface Harness {
  readonly service: WardenReviveService;
  readonly resumed: { id: string; message: string }[];
  readonly emitted: { id: string; type: string; data: unknown }[];
  readonly journal: { type: string; data: unknown }[];
  readonly notices: WardenReviveNotice[];
  readonly sleeps: number[];
  readonly persisted: { revive: ReviveState; actions: readonly WardenAction[] }[];
  readonly persist: (revive: ReviveState, actions: readonly WardenAction[]) => Promise<void>;
  readonly tmuxProbes: () => number;
}

const harness = (
  events: Record<string, readonly ReviveEvent[]>,
  options: {
    resume?: (id: string) => WardenResumeOutcome;
    tmux?: (probe: number) => boolean;
  } = {},
): Harness => {
  const resumed: { id: string; message: string }[] = [];
  const emitted: { id: string; type: string; data: unknown }[] = [];
  const journal: { type: string; data: unknown }[] = [];
  const notices: WardenReviveNotice[] = [];
  const sleeps: number[] = [];
  const persisted: { revive: ReviveState; actions: readonly WardenAction[] }[] = [];
  let probes = 0;
  const service = new WardenReviveService({
    events: {
      read: async id => events[id] ?? [],
      emit: async (id, type, data) => {
        emitted.push({ id, type, data });
      },
    },
    resume: async (id, message) => {
      resumed.push({ id, message });
      return options.resume?.(id) ?? { ok: true };
    },
    tmuxReady: async () => options.tmux?.(++probes) ?? true,
    sleep: async ms => {
      sleeps.push(ms);
    },
    notifyOwner: async notice => {
      notices.push(notice);
    },
    journal: { record: (type, data) => journal.push({ type, data }) },
  });
  return {
    service,
    resumed,
    emitted,
    journal,
    notices,
    sleeps,
    persisted,
    persist: async (revive, actions) => {
      persisted.push({ revive, actions });
    },
    tmuxProbes: () => probes,
  };
};

const run = (h: Harness, fleet: readonly WardenSessionView[], revive?: ReviveState, cfg: WardenConfig = config()) =>
  h.service.run({ fleet, config: cfg, revive, nowMs: NOW }, h.persist);

describe('auto-revive of a session that died', () => {
  it('should start an auto session again, telling it why and to continue, and spend its cooldown', async () => {
    // Arrange
    const h = harness({ a: [gone()] });

    // Act
    const result = await run(h, [view('a')]);

    // Assert
    should(h.resumed).have.length(1);
    should(h.resumed[0]?.message).startWith('[ferretry] Your terminal ended because its terminal disappeared at ');
    should(h.resumed[0]?.message).containEql('Re-read your last turn file and continue');
    should([...result.revived]).deepEqual(['a']);
    should(result.revive.sessions.a).containEql({ attempts: 1, crashRevives: 0 });
    should(h.emitted.map(entry => entry.type)).deepEqual(['warden.revive_planned', 'warden.revived']);
    should(h.emitted[0]?.data).deepEqual({ cause: 'terminal_gone', wave: 1 });
    should(h.emitted[1]?.data).deepEqual({ cause: 'terminal_gone', attempt: 1 });
    should(h.journal.map(entry => entry.type)).deepEqual(['fleet.warden_revived']);
    should(result.actions).have.length(1);
    should(result.actions[0]).containEql({
      sessionId: 'a',
      action: 'revive',
      outcome: 'done',
      by: 'warden',
      actor: 'auto',
    });
    should(result.actions[0]?.detail).containEql('re-read its last turn');
  });

  it('should give an interactive session the notice and no instruction', async () => {
    // Arrange
    const h = harness({ p: [gone()] });

    // Act
    const result = await run(h, [view('p', { mode: 'interactive' })]);

    // Assert
    should(h.resumed[0]?.message).not.containEql('Re-read');
    should(result.actions[0]?.detail).containEql('Told it so, nothing more');
  });

  it('should count a crash of the agent toward its one allowed revive', async () => {
    // Arrange
    const h = harness({ a: [{ type: 'session.exited', time: ago(60), data: { status: 'failed', exitCode: 2 } }] });
    const previous: ReviveState = {
      ...EMPTY_REVIVE_STATE,
      sessions: { a: { revivedAt: ago(7200), attempts: 1, crashRevives: 0 } },
    };

    // Act
    const result = await run(h, [view('a')], previous);

    // Assert
    should(result.revive.sessions.a).containEql({ attempts: 2, crashRevives: 1 });
    should(h.resumed[0]?.message).containEql('the agent crashed (exit 2)');
  });

  it('should do nothing at all while auto-revive, or the Warden, is off', async () => {
    // Arrange
    const h = harness({ a: [gone()] });

    // Act
    const off = await run(h, [view('a')], undefined, config({ enabled: false }));
    const wardenOff = await run(h, [view('a')], undefined, config({}, false));

    // Assert
    should(h.resumed).deepEqual([]);
    should(off.revive).equal(EMPTY_REVIVE_STATE);
    should(wardenOff.actions).deepEqual([]);
    should(h.persisted).deepEqual([]);
  });

  it('should leave alone investigators, live sessions, and deaths with no finish time or long past', async () => {
    // Arrange
    const h = harness({ w: [gone()], l: [gone()], r: [gone()], n: [gone()], o: [gone()] });
    const fleet = [
      view('w', { label: WARDEN_LABEL }),
      view('l', { wardenLineage: true }),
      view('r', { status: 'running' }),
      view('n', { finishedAt: null }),
      view('o', { finishedAt: ago(40 * 60) }),
    ];

    // Act
    const result = await run(h, fleet);

    // Assert
    should(h.resumed).deepEqual([]);
    should(result.actions).deepEqual([]);
    should(h.persisted).have.length(1);
  });

  it('should journal a stopped session once, and never revive it', async () => {
    // Arrange
    const h = harness({ a: [gone(), { type: 'session.stopped', time: ago(30), data: {} }] });
    const first = await run(h, [view('a')]);

    // Act
    await run(h, [view('a')], first.revive);

    // Assert
    should(h.resumed).deepEqual([]);
    should(h.emitted).deepEqual([{ id: 'a', type: 'warden.revive_refused', data: { why: 'stopped' } }]);
    should(h.journal.map(entry => entry.type)).deepEqual(['fleet.warden_revive_refused']);
  });

  it('should list a revive the resume service refused as failed, and never retry it', async () => {
    // Arrange
    const h = harness({ a: [gone()] }, { resume: () => ({ ok: false, reason: 'guard_failed' }) });
    const first = await run(h, [view('a')]);

    // Act
    const second = await run(h, [view('a')], first.revive);

    // Assert
    should(first.actions[0]).containEql({ outcome: 'failed' });
    should(first.actions[0]?.detail).containEql('guard_failed');
    should(first.revived.size).equal(0);
    should(h.emitted.map(entry => entry.data)).containEql({ why: 'refused:guard_failed' });
    should(h.resumed).have.length(1);
    should(second.actions).deepEqual([]);
    should(first.revive.sessions).deepEqual({});
  });

  it('should refuse a session revived inside its cooldown, journalling why', async () => {
    // Arrange
    const h = harness({ a: [gone()] });
    const previous: ReviveState = {
      ...EMPTY_REVIVE_STATE,
      sessions: { a: { revivedAt: ago(600), attempts: 1, crashRevives: 0 } },
    };

    // Act
    await run(h, [view('a')], previous);

    // Assert
    should(h.resumed).deepEqual([]);
    should(h.emitted).deepEqual([{ id: 'a', type: 'warden.revive_refused', data: { why: 'cooldown' } }]);
  });

  it('should forget sessions that are gone and explanations older than a day', async () => {
    // Arrange
    const h = harness({});
    const previous: ReviveState = {
      ...EMPTY_REVIVE_STATE,
      sessions: {
        gone: { revivedAt: ago(100), attempts: 1, crashRevives: 0 },
        kept: { revivedAt: ago(100), attempts: 1, crashRevives: 0 },
      },
      refused: { 'x@y': ago(3 * 24 * 3600), 'z@w': ago(60) },
    };

    // Act
    const result = await run(h, [view('kept', { status: 'running' })], previous);

    // Assert
    should(Object.keys(result.revive.sessions)).deepEqual(['kept']);
    should(Object.keys(result.revive.refused)).deepEqual(['z@w']);
  });
});

describe('a fleet-wide death', () => {
  const cascade = (): { events: Record<string, ReviveEvent[]>; fleet: WardenSessionView[] } => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    return {
      events: Object.fromEntries(ids.map((id, index) => [id, [gone(ago(60 - index))]])),
      fleet: ids.map(id => view(id)),
    };
  };

  it('should wait for tmux, then revive in waves of three ten seconds apart, naming the tmux server', async () => {
    // Arrange
    const { events, fleet } = cascade();
    const h = harness(events, { tmux: probe => probe >= 3 });

    // Act
    const result = await run(h, fleet);

    // Assert
    should(h.tmuxProbes()).equal(3);
    should(h.sleeps).deepEqual([5000, 5000, 10_000]);
    should(h.resumed.map(entry => entry.id)).deepEqual(['a', 'b', 'c', 'd', 'e']);
    should(h.resumed[0]?.message).containEql('the tmux server crashed');
    should(h.persisted.map(entry => entry.actions.length)).deepEqual([3, 2]);
    should(result.actions).have.length(5);
    should(result.revive.batches.map(batch => batch.ids)).deepEqual([
      ['a', 'b', 'c'],
      ['d', 'e'],
    ]);
  });

  it('should defer, spending no cooldown, when tmux never answers', async () => {
    // Arrange
    const { events, fleet } = cascade();
    const h = harness(events, { tmux: () => false });

    // Act
    const result = await run(h, fleet);

    // Assert
    should(h.tmuxProbes()).equal(REVIVE_TMUX_WAIT_TRIES);
    should(h.resumed).deepEqual([]);
    should(result.revive.sessions).deepEqual({});
    should(result.actions).deepEqual([]);
    should(h.journal.map(entry => entry.type)).deepEqual(['fleet.warden_revive_deferred']);
    should(h.persisted).have.length(1);
  });
});

describe('the circuit breaker', () => {
  const dyingAgain = (): { events: Record<string, ReviveEvent[]>; previous: ReviveState } => ({
    events: { a: [gone(ago(20))] },
    previous: { ...EMPTY_REVIVE_STATE, sessions: { a: { revivedAt: ago(100), attempts: 1, crashRevives: 0 } } },
  });

  it('should open on a quick second death, tell the owner once and revive nothing', async () => {
    // Arrange
    const { events, previous } = dyingAgain();
    const h = harness(events);

    // Act
    const first = await run(h, [view('a', { finishedAt: ago(20) })], previous);
    const second = await run(h, [view('a', { finishedAt: ago(20) })], first.revive);

    // Assert
    should(h.resumed).deepEqual([]);
    should(h.notices).have.length(1);
    should(h.notices[0]?.sessionId).equal('a');
    should(h.notices[0]?.title).equal('Auto-revive paused');
    should(first.revive.breaker?.why).containEql('a died again within 2 minutes');
    should(h.journal.map(entry => entry.type)).containEql('fleet.warden_revive_breaker_opened');
    should(h.emitted).deepEqual([{ id: 'a', type: 'warden.revive_refused', data: { why: 'breaker_open' } }]);
    should(second.revive.breaker).not.be.undefined();
  });

  it('should close once its pause has passed, and journal that', async () => {
    // Arrange
    const h = harness({});
    const previous: ReviveState = {
      ...EMPTY_REVIVE_STATE,
      breaker: { openedAt: ago(7200), until: ago(60), why: 'x' },
    };

    // Act
    const result = await run(h, [], previous);

    // Assert
    should(result.revive.breaker).be.undefined();
    should(h.journal.map(entry => entry.type)).deepEqual(['fleet.warden_revive_breaker_closed']);
  });

  it('should not notify when nothing but the breaker state moved', async () => {
    // Arrange
    const h = harness({ a: [gone(ago(20))] });
    const previous: ReviveState = {
      ...EMPTY_REVIVE_STATE,
      sessions: { a: { revivedAt: ago(100), attempts: 1, crashRevives: 0 } },
      batches: [{ at: ago(100), ids: ['a'] }],
    };

    // Act
    const result = await run(h, [view('a')], previous);

    // Assert
    should(result.revive.breaker).not.be.undefined();
    should(h.notices).have.length(1);
  });
});
