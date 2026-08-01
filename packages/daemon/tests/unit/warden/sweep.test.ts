import { describe, it } from 'bun:test';
import should from 'should';
import {
  collapseUnsupervisedMonitors,
  defaultWardenConfig,
  UNSUPERVISED_FLEET_KEY,
  WARDEN_LABEL,
  WardenSweepService,
  type WardenAnomaly,
  type WardenConfig,
  type WardenFleetSession,
  type WardenRuntimeState,
  type WardenSpawnFacts,
  type WardenSpawnProvenance,
  type WardenSpawnRequest,
  type WardenSweepPorts,
  type WardenSweepSettings,
} from '../../../src/lib/warden/index.ts';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

const settings = (overrides: Partial<WardenSweepSettings> = {}): WardenSweepSettings => ({
  clientName: 'fy',
  wardenCwd: '/state',
  supervisesMonitors: true,
  mayAct: false,
  ...overrides,
});

const session = (overrides: {
  readonly id: string;
  readonly status?: WardenFleetSession['state']['status'];
  readonly label?: string;
  readonly mode?: 'auto' | 'interactive';
  readonly state?: Partial<WardenFleetSession['state']>;
  readonly hasLiveMonitor?: boolean;
}): WardenFleetSession => ({
  config: {
    id: overrides.id,
    mode: overrides.mode ?? 'auto',
    agent: 'claude-auto-a',
    intervalSeconds: 30,
    ...(overrides.label === undefined ? {} : { label: overrides.label }),
  },
  state: { status: overrides.status ?? 'running', ...overrides.state },
  directory: `/state/sessions/${overrides.id}`,
  cwd: '/home/dev/repo',
  turn: 1,
  hasLiveMonitor: overrides.hasLiveMonitor ?? true,
});

/** A session the detector will flag as an unanswered question: waiting, idle, no declared wait. */
const unattended = (id: string): WardenFleetSession =>
  session({ id, status: 'awaiting_user', state: { lastActivityAt: at(-600) } });

/**
 * A session the detector will flag for the shared fleet triage rather than an assigned warden.
 *
 * A rate-limited session whose reset time has passed and which was never resumed. It is used instead
 * of the more obvious `abandoned_wreckage` because that class is unreachable from a sweep in both
 * this daemon and kteam: the sweep scans only `WARDEN_SCANNABLE_STATUSES`, which excludes the very
 * `failed` and `stalled` statuses wreckage is made of.
 */
const triageable = (id: string): WardenFleetSession =>
  session({ id, status: 'rate_limited', state: { quota: { resetAt: NOW - 60_000 } } });

interface Harness {
  readonly service: WardenSweepService;
  readonly journal: { readonly type: string; readonly data: Record<string, unknown> }[];
  readonly spawns: WardenSpawnRequest[];
  readonly provenance: Map<string, WardenSpawnProvenance>;
  state(): WardenRuntimeState;
  setState(value: unknown): void;
  setFleet(fleet: readonly WardenFleetSession[]): void;
  storedConfig(): unknown;
}

function harness(
  options: {
    readonly config?: unknown;
    readonly state?: unknown;
    readonly fleet?: readonly WardenFleetSession[];
    readonly settings?: Partial<WardenSweepSettings>;
    readonly installed?: () => Promise<readonly string[]>;
    readonly usage?: () => Promise<readonly { readonly agent: string; readonly atLimit?: boolean }[]>;
    readonly spawn?: (request: WardenSpawnRequest, call: number) => Promise<WardenSpawnFacts>;
    readonly reports?: Readonly<Record<string, string | undefined>>;
    readonly latest?: () => Promise<{ readonly reportId: string; readonly head: string } | undefined>;
    readonly writeProvenance?: () => Promise<void>;
  } = {},
): Harness {
  let configDocument: unknown = options.config ?? defaultWardenConfig;
  let stateDocument: unknown = options.state ?? {};
  let fleet: readonly WardenFleetSession[] = options.fleet ?? [];
  const journal: { readonly type: string; readonly data: Record<string, unknown> }[] = [];
  const spawns: WardenSpawnRequest[] = [];
  const provenance = new Map<string, WardenSpawnProvenance>();
  let spawnCall = 0;
  let capability = 0;

  const ports: WardenSweepPorts = {
    fleet: { fleet: async () => fleet },
    spawner: {
      spawn: async request => {
        spawns.push(request);
        const call = spawnCall;
        spawnCall += 1;
        return await (options.spawn?.(request, call) ??
          Promise.resolve({
            sessionId: `w${call}`,
            createdAt: at(0),
            agent: request.agent,
            harness: 'claude' as const,
            model: request.model ?? 'glm-5.2',
            modelSource: 'configured' as const,
          }));
      },
    },
    artifacts: {
      writeProvenance: async (path, value) => {
        if (options.writeProvenance !== undefined) return await options.writeProvenance();
        provenance.set(path, value);
      },
      readReport: async path => (options.reports ?? {})[path],
      latest: async () => await (options.latest?.() ?? Promise.resolve(undefined)),
      reportPath: (instant, targetId) =>
        `/state/warden/reports/${instant.replaceAll(/[:.]/gu, '-')}${targetId === undefined ? '' : `-${targetId}`}.md`,
    },
    state: {
      read: async () => stateDocument,
      write: async value => {
        stateDocument = JSON.parse(JSON.stringify(value));
      },
    },
    config: {
      read: async () => configDocument,
      write: async value => {
        configDocument = JSON.parse(JSON.stringify(value));
      },
    },
    agents: { installed: async () => await (options.installed?.() ?? Promise.resolve(['claude-auto-glm52a'])) },
    usage: { accounts: async () => await (options.usage?.() ?? Promise.resolve([])) },
    journal: { record: (type, data) => void journal.push({ type, data: { ...data } }) },
    nowMs: () => NOW,
    capabilities: () => {
      capability += 1;
      return `capability-${capability}`;
    },
  };

  return {
    service: new WardenSweepService(ports, settings(options.settings)),
    journal,
    spawns,
    provenance,
    state: () => stateDocument as WardenRuntimeState,
    setState: value => {
      stateDocument = value;
    },
    setFleet: value => {
      fleet = value;
    },
    storedConfig: () => configDocument,
  };
}

const enabled = (overrides: Partial<WardenConfig> = {}): WardenConfig => ({
  ...defaultWardenConfig,
  enabled: true,
  minSpawnGapMinutes: 0,
  ...overrides,
});

const journalTypes = (subject: Harness): string[] => subject.journal.map(entry => entry.type);

describe('collapsing an unwatched fleet into one fault', () => {
  const dead = (id: string): WardenAnomaly => ({
    kind: 'dead_monitor',
    sessionId: id,
    status: 'running',
    detail: 'no live monitor handle',
  });
  const other: WardenAnomaly = {
    kind: 'sus_thinking',
    sessionId: 's9',
    status: 'thinking',
    detail: 'quiet transcript',
  };

  it('should leave the anomalies alone when the daemon does run monitors', () => {
    // Arrange / Act
    const actual = collapseUnsupervisedMonitors([dead('s1'), dead('s2')], true);

    // Assert
    should(actual).have.length(2);
  });

  it('should leave the anomalies alone when nothing was flagged as unmonitored', () => {
    // Arrange / Act
    const actual = collapseUnsupervisedMonitors([other], false);

    // Assert
    should(actual).deepEqual([other]);
  });

  it('should report one fault carrying every affected session', () => {
    // Arrange / Act
    const actual = collapseUnsupervisedMonitors([dead('s2'), dead('s1')], false);

    // Assert
    should(actual).have.length(1);
    should(actual[0]?.fleetKey).equal(UNSUPERVISED_FLEET_KEY);
    should(actual[0]?.affectedSessionIds).deepEqual(['s1', 's2']);
    should(actual[0]?.sessionId).equal('s1');
  });

  it('should never hide an unwatched fleet, so a sweep over one cannot read as clean', () => {
    // Arrange / Act
    const actual = collapseUnsupervisedMonitors([dead('s1')], false);

    // Assert
    should(actual).have.length(1);
    should(actual[0]?.detail).match(/no per-session monitor subsystem/u);
  });

  it('should keep every other anomaly beside the collapsed one', () => {
    // Arrange / Act
    const actual = collapseUnsupervisedMonitors([dead('s1'), other], false);

    // Assert
    should(actual.map(item => item.kind)).deepEqual(['sus_thinking', 'dead_monitor']);
  });

  it('should say "session" rather than "sessions" for exactly one', () => {
    // Arrange / Act
    const actual = collapseUnsupervisedMonitors([dead('s1')], false);

    // Assert
    should(actual[0]?.detail).match(/1 active session unsupervised/u);
  });

  it('should never ask for an assigned warden: the fault is the daemon, not a session', () => {
    // Arrange / Act
    const actual = collapseUnsupervisedMonitors([dead('s1')], false);

    // Assert
    should(actual[0]?.assignedWarden).be.undefined();
  });
});

describe('reading the warden configuration', () => {
  it('should report the stored configuration with its accounts', async () => {
    // Arrange
    const subject = harness({ config: enabled() });

    // Act
    const actual = await subject.service.view();

    // Assert
    should(actual.config.enabled).be.true();
    should(actual.accounts).deepEqual([{ agent: 'claude-auto-glm52a' }]);
  });

  it('should carry both the loader warning and the configuration warnings', async () => {
    // Arrange
    const subject = harness({ config: { enabled: true }, installed: async () => ['someone-else'] });

    // Act
    const actual = await subject.service.view();

    // Assert
    should(actual.warnings).matchAny(/did not validate/u);
    should(actual.warnings).matchAny(/not installed on this host/u);
  });

  it('should warn about nobody when the host inventory cannot be read', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      installed: async () => {
        throw new Error('the fleet manifest is unreadable');
      },
    });

    // Act
    const actual = await subject.service.view();

    // Assert
    should(actual.warnings).be.empty();
  });
});

describe('changing the warden configuration', () => {
  it('should persist the merged result', async () => {
    // Arrange
    const subject = harness({ config: enabled({ intervalMinutes: 5 }) });

    // Act
    await subject.service.updateConfig({ intervalMinutes: 9 });

    // Assert
    should((subject.storedConfig() as WardenConfig).intervalMinutes).equal(9);
  });

  it('should compose two successive single-field patches', async () => {
    // Arrange
    const subject = harness({ config: defaultWardenConfig });

    // Act
    await subject.service.updateConfig({ enabled: true });
    const actual = await subject.service.updateConfig({ blessMinutes: 45 });

    // Assert
    should(actual.config.enabled).be.true();
    should(actual.config.blessMinutes).equal(45);
  });

  it('should repair a stored document that did not parse rather than being blocked by it', async () => {
    // Arrange
    const subject = harness({ config: { intervalMinutes: 0 } });

    // Act
    const actual = await subject.service.updateConfig({ enabled: true });

    // Assert
    should(actual.config.intervalMinutes).equal(defaultWardenConfig.intervalMinutes);
    should(actual.config.enabled).be.true();
  });

  it('should journal which fields changed', async () => {
    // Arrange
    const subject = harness();

    // Act
    await subject.service.updateConfig({ enabled: true, blessMinutes: 5 });

    // Assert
    should(subject.journal[0]).deepEqual({
      type: 'fleet.warden_config_changed',
      data: { fields: ['enabled', 'blessMinutes'] },
    });
  });
});

describe('the warden status', () => {
  it('should omit the sweep instant entirely until a sweep has run', async () => {
    // Arrange: "nothing has run" must never be confusable with "a sweep found nothing".
    const actual = await harness().service.status();

    // Assert
    should(actual.lastSweepAt).be.undefined();
    should(actual.anomalies).be.empty();
    should(actual.fingerprint).equal('');
  });

  it('should report what the last sweep found without measuring again', async () => {
    // Arrange
    const subject = harness({ fleet: [unattended('s1')], config: enabled() });
    await subject.service.run({ force: false });
    subject.setFleet([]);

    // Act
    const actual = await subject.service.status();

    // Assert
    should(actual.anomalies.map(item => item.sessionId)).deepEqual(['s1']);
  });

  it('should name the live warden and omit it when none is running', async () => {
    // Arrange
    const live = session({ id: 'w1', label: WARDEN_LABEL });
    const subject = harness({ fleet: [live] });

    // Act
    const withWarden = await subject.service.status();
    subject.setFleet([session({ id: 'w1', label: WARDEN_LABEL, status: 'completed' })]);
    const withoutWarden = await subject.service.status();

    // Assert
    should(withWarden.liveWarden).equal('w1');
    should(withoutWarden.liveWarden).be.undefined();
  });

  it('should carry the last spawn instant once one has happened', async () => {
    // Arrange
    const subject = harness({ state: { lastSpawnAt: at(-30) } });

    // Act / Assert
    should((await subject.service.status()).lastSpawnAt).equal(at(-30));
  });

  it('should carry the newest report when one exists', async () => {
    // Arrange
    const subject = harness({ latest: async () => ({ reportId: 'r.md', head: 'Verdict: LEAVE' }) });

    // Act / Assert
    should((await subject.service.status()).lastReport).deepEqual({ reportId: 'r.md', head: 'Verdict: LEAVE' });
  });

  it('should omit the report rather than failing when the directory cannot be read', async () => {
    // Arrange
    const subject = harness({
      latest: async () => {
        throw new Error('the reports directory is unreadable');
      },
    });

    // Act / Assert
    should((await subject.service.status()).lastReport).be.undefined();
  });

  it('should report an eligible account with no reason', async () => {
    // Arrange
    const subject = harness({ config: enabled() });

    // Act
    const actual = await subject.service.status();

    // Assert
    should(actual.failover?.accounts).deepEqual([{ agent: 'claude-auto-glm52a', eligible: true }]);
  });

  it('should report why an account is ineligible', async () => {
    // Arrange
    const subject = harness({ installed: async () => ['someone-else'] });

    // Act
    const actual = await subject.service.status();

    // Assert
    should(actual.failover?.accounts[0]?.eligible).be.false();
    should(actual.failover?.accounts[0]?.reason).match(/not installed/u);
  });

  it('should report a configured model, a demotion, its strikes and its live quota', async () => {
    // Arrange
    const subject = harness({
      config: enabled({ accounts: [{ agent: 'a', model: 'm' }] }),
      installed: async () => ['a'],
      usage: async () => [{ agent: 'a', atLimit: false }],
      state: {
        failover: { demotedUntil: { a: at(30) }, strikes: { a: { count: 2, lastAt: at(-1), lastReason: 'boom' } } },
      },
    });

    // Act
    const actual = await subject.service.status();

    // Assert
    should(actual.failover?.accounts[0]).deepEqual({
      agent: 'a',
      model: 'm',
      eligible: false,
      reason: `demoted until ${at(30)}`,
      demotedUntil: at(30),
      strikes: 2,
      quota: { atLimit: false },
    });
  });

  it('should carry the last selection and any exhaustion episode', async () => {
    // Arrange
    const lastSelection = { agent: 'a', policy: 'fallback' as const, at: at(-1), reason: 'preferred' as const };
    const subject = harness({ state: { failover: { lastSelection, exhaustedSince: at(-2) } } });

    // Act
    const actual = await subject.service.status();

    // Assert
    should(actual.failover?.lastSelection).deepEqual(lastSelection);
    should(actual.failover?.exhaustedSince).equal(at(-2));
  });

  it('should serve an empty account health rather than failing when the usage feed is down', async () => {
    // Arrange
    const subject = harness({
      usage: async () => {
        throw new Error('the collector is not listening');
      },
    });

    // Act / Assert
    should((await subject.service.status()).failover?.accounts).have.length(1);
  });
});

describe('one sweep', () => {
  it('should record the instant it swept and the anomalies it found', async () => {
    // Arrange
    const subject = harness({ fleet: [unattended('s1')] });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.sweptAt).equal(at(0));
    should(actual.anomalies.map(item => item.kind)).deepEqual(['unattended_question']);
    should(subject.state().lastSweepAt).equal(at(0));
  });

  it('should scan only live sessions while still reading terminal history', async () => {
    // Arrange: a peer wait whose peer is finished is unanswerable, and telling that apart from a
    // typo needs the whole index.
    const waiter = session({
      id: 's1',
      status: 'waiting',
      state: { waiting: { since: at(-1), peer: 's2', peerName: 'scout' } },
    });
    const subject = harness({ fleet: [waiter, session({ id: 's2', status: 'completed' })] });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.anomalies.map(item => item.kind)).containEql('peer_wait_unanswerable');
  });

  it('should collapse the unwatched fleet when no monitor subsystem is mounted', async () => {
    // Arrange
    const subject = harness({
      fleet: [session({ id: 's1', hasLiveMonitor: false }), session({ id: 's2', hasLiveMonitor: false })],
      settings: { supervisesMonitors: false },
    });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.anomalies).have.length(1);
    should(actual.anomalies[0]?.affectedSessionIds).deepEqual(['s1', 's2']);
  });

  it('should copy the anomaly arrays out of the domain on the way to the wire', async () => {
    // Arrange
    const subject = harness({
      fleet: [session({ id: 's1', hasLiveMonitor: false })],
      settings: { supervisesMonitors: false },
    });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.anomalies[0]?.affectedSessionIds).deepEqual(['s1']);
  });

  it('should carry the liveness ledger through to the wire for a sus anomaly', async () => {
    // Arrange
    const suspect = session({
      id: 's1',
      status: 'thinking',
      state: { startedAt: at(-120), lastCounterAdvanceAt: at(0), lastTranscriptAt: at(-60) },
    });
    const subject = harness({ fleet: [suspect] });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.anomalies[0]?.kind).equal('sus_thinking');
    should(actual.anomalies[0]?.ledger?.lastTranscriptAt).equal(at(-60));
  });

  it('should bump the recovery generation when the fleet goes clean', async () => {
    // Arrange
    const subject = harness({ fleet: [unattended('s1')] });
    await subject.service.run({ force: false });

    // Act
    subject.setFleet([]);
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().recoveryGeneration).equal(1);
  });

  it('should drop a blessing whose session changed status and say so', async () => {
    // Arrange
    const subject = harness({
      fleet: [session({ id: 's1', status: 'running' })],
      state: {
        blessings: {
          s1: { sessionId: 's1', kinds: ['sus_thinking'], status: 'thinking', blessedAt: at(-1), expiresAt: at(10) },
        },
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(journalTypes(subject)).containEql('fleet.warden_bless_revoked');
    should(subject.state().blessings).deepEqual({});
  });
});

describe('escalating to a fleet warden', () => {
  it('should refuse while escalation is disabled', async () => {
    // Arrange
    const subject = harness({ fleet: [triageable('s1')] });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.message).equal('escalation disabled (enabled=false)');
    should(subject.spawns).be.empty();
  });

  it('should say plainly that there was nothing to escalate', async () => {
    // Arrange
    const subject = harness({ config: enabled() });

    // Act / Assert
    should((await subject.service.run({ force: false })).message).equal('no anomalies to escalate');
  });

  it('should spawn a fleet warden and record it', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [triageable('s1')] });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.spawned).equal('w0');
    should(subject.spawns[0]?.name).equal('warden-sweep');
    should(subject.spawns[0]?.stopCapability).be.undefined();
    should(subject.state().lastSpawnAt).equal(at(0));
    should(journalTypes(subject)).containEql('fleet.warden_spawned');
  });

  it('should write provenance beside the report it told the warden to write', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [triageable('s1')] });

    // Act
    await subject.service.run({ force: false });

    // Assert
    const [path] = [...subject.provenance.keys()];
    should(path).match(/2026-07-31T12-00-00-000Z\.md$/u);
    should(subject.provenance.get(path as string)?.wardenSessionId).equal('w0');
  });

  it('should refuse a second escalation for an unchanged anomaly set', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [triageable('s1')] });
    await subject.service.run({ force: false });
    subject.setFleet([triageable('s1'), session({ id: 'w0', label: WARDEN_LABEL, status: 'completed' })]);

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.message).equal('anomaly set unchanged since the last escalation');
  });

  it('should escalate the same set again after a clean recovery', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [triageable('s1')] });
    await subject.service.run({ force: false });
    const retired = session({ id: 'w0', label: WARDEN_LABEL, status: 'completed' });
    subject.setFleet([retired]);
    await subject.service.run({ force: false });

    // Act
    subject.setFleet([triageable('s1'), retired]);
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.spawned).equal('w1');
  });

  it('should refuse while the concurrency cap is full', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [triageable('s1'), session({ id: 'w1', label: WARDEN_LABEL })],
    });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.message).equal('warden concurrency cap reached (1/1 live)');
  });

  it('should refuse while the spawn gap has not elapsed', async () => {
    // Arrange
    const subject = harness({
      config: enabled({ minSpawnGapMinutes: 15 }),
      fleet: [triageable('s1')],
      state: { lastSpawnAt: at(-5) },
    });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.message).match(/spawn gap not elapsed/u);
  });

  it('should bypass the gap, the flag and the suppression when an operator forces a run', async () => {
    // Arrange
    const subject = harness({
      config: { ...defaultWardenConfig, minSpawnGapMinutes: 15 },
      fleet: [triageable('s1')],
      state: { lastSpawnAt: at(-1), lastSpawnFingerprint: '0:abandoned_wreckage:s1' },
    });

    // Act
    const actual = await subject.service.run({ force: true });

    // Assert
    should(actual.spawned).equal('w0');
  });

  it('should never bypass the concurrency cap for a forced run', async () => {
    // Arrange: the cap protects the host, not the operator's patience.
    const subject = harness({
      config: enabled(),
      fleet: [triageable('s1'), session({ id: 'w1', label: WARDEN_LABEL })],
    });

    // Act / Assert
    should((await subject.service.run({ force: true })).message).match(/concurrency cap reached/u);
  });

  it('should not consume the spawn gap when every account is ineligible', async () => {
    // Arrange: the next sweep after any account recovers must escalate immediately.
    const subject = harness({
      config: enabled(),
      fleet: [triageable('s1')],
      installed: async () => ['someone-else'],
    });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.message).match(/exhausted/u);
    should(subject.state().lastSpawnAt).be.undefined();
    should(subject.state().lastSpawnFingerprint).be.undefined();
  });

  it('should consume the spawn gap but not the suppression key when a launch fails', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [triageable('s1')],
      spawn: async () => {
        throw new Error('tmux refused the pane');
      },
    });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.message).match(/warden spawn failed: tmux refused the pane/u);
    should(subject.state().lastSpawnAt).equal(at(0));
    should(subject.state().lastSpawnFingerprint).be.undefined();
    should(journalTypes(subject)).containEql('fleet.warden_spawn_failed');
  });

  it('should describe a non-error launch failure rather than dropping it', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [triageable('s1')],
      spawn: async () => {
        throw 'the launcher rejected the request';
      },
    });

    // Act / Assert
    should((await subject.service.run({ force: false })).message).match(/the launcher rejected the request/u);
  });

  it('should clear the account strikes after a launch that worked', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [triageable('s1')],
      state: {
        failover: { strikes: { 'claude-auto-glm52a': { count: 1, lastAt: at(-9), lastReason: 'boom' } } },
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().failover?.strikes).deepEqual({});
  });

  it('should journal a provenance write failure without striking a working account', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [triageable('s1')],
      writeProvenance: async () => {
        throw new Error('the state home is read-only');
      },
    });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.spawned).equal('w0');
    should(journalTypes(subject)).containEql('fleet.warden_provenance_failed');
    should(subject.state().failover?.strikes ?? {}).deepEqual({});
  });
});

describe('assigning a warden to one suspect session', () => {
  const suspect = (id: string): WardenFleetSession =>
    session({ id, status: 'awaiting_user', state: { lastActivityAt: at(-600) } });

  it('should spawn one warden per suspect target with its own capability', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [suspect('s1')] });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.assignedWardens).deepEqual(['w0']);
    should(subject.spawns[0]?.name).equal('warden:s1');
    should(subject.spawns[0]?.stopCapability).equal('capability-1');
    should(subject.state().assignments?.s1?.kinds).deepEqual(['unattended_question']);
    should(journalTypes(subject)).containEql('fleet.warden_assigned');
  });

  it('should do nothing at all when there is no suspect, no queue and no assignment', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [session({ id: 's1' })] });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.assignedWardens).be.undefined();
    should(subject.spawns).be.empty();
  });

  it('should still reconcile a finished assignment while escalation is disabled', async () => {
    // Arrange: a finished warden left in the record holds its target's slot forever.
    const subject = harness({
      fleet: [session({ id: 's1' })],
      state: {
        assignments: {
          s1: { wardenId: 'w0', spawnedAt: at(-30), capability: 'c', kinds: ['sus_thinking'], reportPath: '/r.md' },
        },
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().assignments).deepEqual({});
    should(subject.state().assignedCooldowns?.s1).equal(at(0));
  });

  it('should bless a target whose warden cleared it', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [session({ id: 's1', status: 'thinking' })],
      reports: { '/r.md': 'Verdict: LEAVE\n\nAll good.' },
      state: {
        assignments: {
          s1: { wardenId: 'w0', spawnedAt: at(-30), capability: 'c', kinds: ['sus_thinking'], reportPath: '/r.md' },
        },
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().blessings?.s1?.kinds).deepEqual(['sus_thinking']);
    should(journalTypes(subject)).containEql('fleet.warden_blessed');
  });

  it.each([
    { label: 'no report was written', reports: {} },
    { label: 'the report is empty', reports: { '/r.md': '   ' } },
    { label: 'the report says something else', reports: { '/r.md': 'Verdict: KILL\n\nBurning tokens.' } },
  ])('should refuse to bless when $label', async ({ reports }) => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [session({ id: 's1', status: 'thinking' })],
      reports,
      state: {
        assignments: {
          s1: { wardenId: 'w0', spawnedAt: at(-30), capability: 'c', kinds: ['sus_thinking'], reportPath: '/r.md' },
        },
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().blessings ?? {}).deepEqual({});
  });

  it('should refuse to bless a target that has since vanished', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [],
      reports: { '/r.md': 'Verdict: LEAVE' },
      state: {
        assignments: {
          s1: { wardenId: 'w0', spawnedAt: at(-30), capability: 'c', kinds: ['sus_thinking'], reportPath: '/r.md' },
        },
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().blessings ?? {}).deepEqual({});
  });

  it('should refuse to bless when the warden was shown no anomaly kind at all', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [session({ id: 's1', status: 'thinking' })],
      reports: { '/r.md': 'Verdict: LEAVE' },
      state: {
        assignments: { s1: { wardenId: 'w0', spawnedAt: at(-30), capability: 'c', kinds: [], reportPath: '/r.md' } },
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().blessings ?? {}).deepEqual({});
  });

  it('should treat an unreadable report as no evidence rather than failing the sweep', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [session({ id: 's1', status: 'thinking' })],
      state: {
        assignments: {
          s1: { wardenId: 'w0', spawnedAt: at(-30), capability: 'c', kinds: ['sus_thinking'], reportPath: '/boom' },
        },
      },
    });
    // The fake report reader throws for this one path only.
    // eslint-disable-next-line no-param-reassign -- exercising the catch on a port that can fail.

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().blessings ?? {}).deepEqual({});
  });

  it('should leave a blessed target alone before it can occupy the single warden slot', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [suspect('s1')],
      state: {
        blessings: {
          s1: {
            sessionId: 's1',
            kinds: ['unattended_question'],
            status: 'awaiting_user',
            blessedAt: at(-1),
            expiresAt: at(10),
          },
        },
      },
    });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.assignedWardens).be.undefined();
  });

  it('should leave a target alone inside its post-assignment cooldown', async () => {
    // Arrange
    const subject = harness({
      config: enabled({ assignedCooldownMinutes: 30 }),
      fleet: [suspect('s1')],
      state: { assignedCooldowns: { s1: at(-5) } },
    });

    // Act / Assert
    should((await subject.service.run({ force: false })).assignedWardens).be.undefined();
  });

  it('should ignore the cooldown for a forced run', async () => {
    // Arrange
    const subject = harness({
      config: enabled({ assignedCooldownMinutes: 30 }),
      fleet: [suspect('s1')],
      state: { assignedCooldowns: { s1: at(-5) } },
    });

    // Act / Assert
    should((await subject.service.run({ force: true })).assignedWardens).deepEqual(['w0']);
  });

  it('should queue a still-suspect target it had no slot for', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [suspect('s1'), suspect('s2')] });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.assignedWardens).deepEqual(['w0']);
    should(subject.state().assignedQueue?.map(item => item.sessionId)).deepEqual(['s2']);
  });

  it('should retry a queued target before a fresh one', async () => {
    // Arrange
    const queued: WardenAnomaly = {
      kind: 'unattended_question',
      sessionId: 's2',
      status: 'awaiting_user',
      detail: 'queued last sweep',
    };
    const subject = harness({
      config: enabled(),
      fleet: [suspect('s1'), suspect('s2')],
      state: { assignedQueue: [queued] },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.spawns[0]?.name).equal('warden:s2');
  });

  it('should drop a queued target that went terminal and say the investigation was closed', async () => {
    // Arrange: a target that finished is neither spawned nor re-queued — the investigation is
    // closed rather than lost, and the journal is what makes the difference visible.
    const queued: WardenAnomaly = {
      kind: 'unattended_question',
      sessionId: 's2',
      status: 'awaiting_user',
      detail: 'queued last sweep',
    };
    const subject = harness({
      config: enabled(),
      fleet: [session({ id: 's2', status: 'completed' })],
      state: { assignedQueue: [queued] },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().assignedQueue).be.empty();
    should(journalTypes(subject)).containEql('fleet.warden_dequeued');
  });

  it('should cool a target down and strike the account when its warden could not launch', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [suspect('s1')],
      spawn: async () => {
        throw new Error('tmux refused the pane');
      },
    });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.assignedWardens).be.undefined();
    should(subject.state().assignedCooldowns?.s1).equal(at(0));
    should(subject.state().failover?.strikes?.['claude-auto-glm52a']?.count).equal(1);
    should(journalTypes(subject)).containEql('fleet.warden_spawn_failed');
  });

  it('should queue rather than cool down a target it skipped for want of an account', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [suspect('s1')], installed: async () => ['someone-else'] });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().assignedQueue?.map(item => item.sessionId)).deepEqual(['s1']);
    should(subject.state().assignedCooldowns ?? {}).deepEqual({});
  });

  it('should never put a second warden on a target already under investigation', async () => {
    // Arrange
    const subject = harness({
      config: enabled({ maxAssignedWardens: 4 }),
      fleet: [suspect('s1'), session({ id: 'w0', label: WARDEN_LABEL })],
      state: {
        assignments: {
          s1: { wardenId: 'w0', spawnedAt: at(-1), capability: 'c', kinds: ['sus_thinking'], reportPath: '/r.md' },
        },
      },
    });

    // Act / Assert
    should((await subject.service.run({ force: false })).assignedWardens).be.undefined();
  });
});

describe('choosing the account a warden runs on', () => {
  it('should journal a restored account when the feed positively contradicts its demotion', async () => {
    // Arrange
    const subject = harness({
      config: enabled({ accounts: [{ agent: 'a' }] }),
      fleet: [triageable('s1')],
      installed: async () => ['a'],
      usage: async () => [{ agent: 'a', authOk: true, atLimit: false, unavailable: false }],
      state: { failover: { demotedUntil: { a: at(30) } } },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(journalTypes(subject)).containEql('fleet.warden_account_restored');
  });

  it('should journal exhaustion once per episode rather than once per sweep', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [triageable('s1')], installed: async () => ['someone-else'] });

    // Act
    await subject.service.run({ force: false });
    await subject.service.run({ force: false });

    // Assert
    should(journalTypes(subject).filter(type => type === 'fleet.warden_exhausted')).have.length(1);
  });

  it('should journal a health-driven change of account', async () => {
    // Arrange
    const subject = harness({
      config: enabled({ accounts: [{ agent: 'a' }, { agent: 'b' }] }),
      fleet: [triageable('s1')],
      installed: async () => ['b'],
      state: { failover: { lastSelection: { agent: 'a', policy: 'fallback', at: at(-9), reason: 'preferred' } } },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.journal.find(entry => entry.type === 'fleet.warden_failover')?.data).match({ from: 'a', to: 'b' });
  });

  it('should not journal a routine round-robin rotation', async () => {
    // Arrange
    const subject = harness({
      config: enabled({
        accounts: [{ agent: 'a' }, { agent: 'b' }],
        failover: { ...defaultWardenConfig.failover, policy: 'round_robin' },
      }),
      fleet: [triageable('s1')],
      installed: async () => ['a', 'b'],
      state: {
        failover: { rrCursor: 0, lastSelection: { agent: 'a', policy: 'round_robin', at: at(-9), reason: 'rotation' } },
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(journalTypes(subject)).not.containEql('fleet.warden_failover');
  });

  it('should demote an account the usage feed already condemned, in one strike', async () => {
    // Arrange
    const subject = harness({
      config: enabled({ accounts: [{ agent: 'a' }] }),
      fleet: [triageable('s1')],
      installed: async () => ['a'],
      spawn: async () => {
        throw new Error('the account is at its usage limit');
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(journalTypes(subject)).containEql('fleet.warden_account_demoted');
    should(subject.state().failover?.demotedUntil?.a).equal(at(30));
  });

  it('should not demote on a first raw launch error', async () => {
    // Arrange
    const subject = harness({
      config: enabled({ accounts: [{ agent: 'a' }] }),
      fleet: [triageable('s1')],
      installed: async () => ['a'],
      spawn: async () => {
        throw new Error('tmux refused the pane');
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(journalTypes(subject)).not.containEql('fleet.warden_account_demoted');
  });

  it('should record the configured first choice in provenance', async () => {
    // Arrange
    const subject = harness({
      config: enabled({ accounts: [{ agent: 'a' }, { agent: 'b' }] }),
      fleet: [triageable('s1')],
      installed: async () => ['b'],
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    const [spawn] = [...subject.provenance.values()];
    should(spawn?.configuredFirst).equal('a');
    should(spawn?.failedOver).be.true();
  });
});

describe('what the daemon asks the sweep about itself', () => {
  it('should report the cadence its timer should fire on', async () => {
    // Arrange / Act / Assert
    should(await harness({ config: enabled({ intervalMinutes: 7 }) }).service.intervalMs()).equal(7 * 60_000);
  });

  it('should report no last sweep until one has completed', async () => {
    // Arrange
    const subject = harness();

    // Act / Assert
    should(await subject.service.lastSweepAt()).be.undefined();
  });

  it('should report the last sweep once one has completed', async () => {
    // Arrange
    const subject = harness();
    await subject.service.run({ force: false });

    // Act / Assert
    should(await subject.service.lastSweepAt()).equal(at(0));
  });

  it('should authorize a stop only for the target its live assignment names', async () => {
    // Arrange
    const subject = harness({
      state: {
        assignments: {
          s1: { wardenId: 'w0', spawnedAt: at(-1), capability: 'secret', kinds: ['sus_thinking'], reportPath: '/r.md' },
        },
      },
    });

    // Act / Assert
    should(await subject.service.mayStop('secret', 's1')).be.true();
    should(await subject.service.mayStop('secret', 's2')).be.false();
    should(await subject.service.mayStop('guessed', 's1')).be.false();
  });
});
