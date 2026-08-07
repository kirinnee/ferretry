import { describe, it } from 'bun:test';
import type { CgroupConfig } from '@ferretry/protocol';
import should from 'should';
import { TmuxSessionLifecycleLauncher } from '../../../src/adapters/session/lifecycle/tmux-session-lifecycle-launcher.ts';
import { TmuxResumeLauncher } from '../../../src/adapters/session/resume/tmux-resume-launcher.ts';
import { KeyedSerialExecutor } from '../../../src/adapters/system/keyed-serial-executor.ts';
import {
  CgroupLaunchPlanner,
  CgroupService,
  defaultCgroupConfig,
  FLEET_SLICE,
  type CgroupApplyStatusStore,
  type CgroupCommandPort,
  type CgroupConfigStore,
  type CgroupHostFacts,
  type SessionSpawnFacts,
} from '../../../src/lib/cgroups/index.ts';
import type { SessionEffectKey, SessionEffectLedger } from '../../../src/lib/session/effects/index.ts';
import {
  defaultSessionLifecycleSettings,
  SessionLifecycleService,
  type SessionLifecycleEvent,
  type SessionLifecycleRecord,
  type SessionLifecycleRepository,
} from '../../../src/lib/session/lifecycle/index.ts';
import {
  defaultSessionResumeSettings,
  SessionResumeService,
  UnregisteredResumeReplacement,
  type ResumeTarget,
  type ResumeTransition,
} from '../../../src/lib/session/resume/index.ts';
import {
  parseSessionId,
  type SessionId,
  type TmuxCommandPort,
  type TmuxCommandResult,
} from '../../../src/lib/index.ts';
import { TmuxController } from '../../../src/lib/tmux/index.ts';
import { WARDEN_LABEL } from '../../../src/lib/warden/index.ts';
import type { TmuxPaneDelivery } from '../../../src/adapters/tmux/pane-delivery.ts';

/**
 * The launch seam and the serialization barrier, assembled exactly as the composition root does.
 *
 * WHY THIS TIER. Two of the three claims cannot be proved anywhere else. That the SETTINGS surface
 * and a SESSION BOOTSTRAP contend on one barrier is a property of the real `KeyedSerialExecutor`,
 * not of any fake — a test that asserted "both were handed the same object" would pass against an
 * executor whose `runExclusive` did nothing. And that the compiled daemon's own launch path applies
 * the wrapper is a property of `TmuxSessionLifecycleLauncher`, which is where the argv is finally
 * handed to the multiplexer.
 */

const AGENT = '/opt/fleet/bin/claude-auto-alpha';
const HARNESS_COMMAND = [AGENT, '--print'] as const;
const HOST: CgroupHostFacts = { platform: 'linux', unifiedHierarchy: true, cpus: 4, memoryBytes: 1_000_000 };
const ENABLED: CgroupConfig = { ...defaultCgroupConfig, enabled: true };

/** A fixture-local durable-effect stand-in, matching the lifecycle integration fixture semantics. */
function memoryEffectLedger(): SessionEffectLedger {
  const held = new Map<string, { readonly fingerprint: string; readonly settled: boolean }>();
  const identity = (key: SessionEffectKey): string => JSON.stringify([key.sessionId, key.effectId]);

  return {
    inspect: async (key, fingerprint) => {
      const effect = held.get(identity(key));
      if (effect === undefined) return 'unclaimed';
      if (effect.fingerprint !== fingerprint) return 'conflict';
      return effect.settled ? 'settled' : 'unsettled';
    },
    begin: async (key, fingerprint) => {
      const effect = held.get(identity(key));
      if (effect !== undefined) {
        if (effect.fingerprint !== fingerprint) return 'conflict';
        return effect.settled ? 'settled' : 'unsettled';
      }
      held.set(identity(key), { fingerprint, settled: false });
      return 'perform';
    },
    settle: async (key, fingerprint) => {
      const effect = held.get(identity(key));
      if (effect === undefined || effect.fingerprint !== fingerprint)
        throw new Error(`cannot settle unclaimed or conflicting effect ${key.effectId}`);
      held.set(identity(key), { fingerprint, settled: true });
    },
  };
}

/** A multiplexer that records the argv it was handed and can be held mid-launch. */
class GatedTmux implements TmuxCommandPort {
  readonly calls: (readonly string[])[] = [];
  /** Resolves when a launch has reached the multiplexer and is being held. */
  reachedLaunch: Promise<void>;
  private announceLaunch: () => void = () => undefined;
  private release: Promise<void> | undefined;
  alive = false;
  /** A multiplexer that refuses to kill the session it was asked to kill. */
  unkillable = false;

  constructor(private readonly log: string[] = []) {
    this.reachedLaunch = new Promise(resolve => {
      this.announceLaunch = resolve;
    });
  }

  /** Holds the next `new-session` until the returned function is called. */
  hold(): () => void {
    let open = (): void => undefined;
    this.release = new Promise<void>(resolve => {
      open = resolve;
    });
    return open;
  }

  async execute(argv: readonly string[]): Promise<TmuxCommandResult> {
    this.calls.push(argv);
    if (argv[0] === 'has-session') return { code: this.alive ? 0 : 1, stdout: '', stderr: '' };
    if (argv[0] === 'kill-session' && this.unkillable) return { code: 1, stdout: '', stderr: 'tmux refused' };
    if (argv[0] === 'new-session') {
      this.log.push('launch:tmux-start');
      this.announceLaunch();
      if (this.release !== undefined) await this.release;
      this.alive = true;
      this.log.push('launch:tmux-end');
    }
    return { code: 0, stdout: '', stderr: '' };
  }

  /**
   * The argv of the one `new-session` call, with the multiplexer own flags stripped.
   *
   * The program is whichever of the wrapper or the harness comes FIRST: a wrapped launch holds
   * both, and slicing from the harness would silently report a wrapped argv as a direct one.
   */
  launched(): readonly string[] {
    const call = this.calls.find(candidate => candidate[0] === 'new-session');
    if (call === undefined) throw new Error('nothing was ever launched');
    const start = call.findIndex(part => part === 'systemd-run' || part === AGENT);
    if (start < 0) throw new Error(`no program in the launch argv: ${call.join(' ')}`);
    return call.slice(start);
  }
}

class MemoryRepository implements SessionLifecycleRepository {
  readonly documents = new Map<string, string>();
  readonly events: SessionLifecycleEvent[] = [];
  async reserve(_id: SessionId): Promise<void> {}
  async read(id: SessionId): Promise<SessionLifecycleRecord | undefined> {
    const document = this.documents.get(id);
    return document === undefined ? undefined : (JSON.parse(document) as SessionLifecycleRecord);
  }
  async write(record: SessionLifecycleRecord, event: SessionLifecycleEvent): Promise<void> {
    this.documents.set(record.config.id, JSON.stringify(record));
    this.events.push(event);
  }
  record(id: string): SessionLifecycleRecord {
    const document = this.documents.get(id);
    if (document === undefined) throw new Error(`no record for ${id}`);
    return JSON.parse(document) as SessionLifecycleRecord;
  }
}

class LoggingConfigStore implements CgroupConfigStore {
  saved: unknown;
  constructor(
    private readonly log: string[],
    initial?: unknown,
  ) {
    this.saved = initial;
  }
  async read(): Promise<unknown> {
    this.log.push('store:read');
    return this.saved;
  }
  async write(config: CgroupConfig): Promise<void> {
    this.log.push('store:write');
    this.saved = config;
  }
}

const commands = (log: string[], refusal?: string): CgroupCommandPort => ({
  execute: async () => {
    log.push('host:set-property');
    return refusal === undefined ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: refusal };
  },
});

/** The durable apply record, in memory: this file is about ordering and argv, not about evidence. */
const memoryApplyStatus = (): CgroupApplyStatusStore => {
  let saved: unknown;
  return {
    read: async () => saved,
    write: async status => {
      saved = status;
    },
  };
};

/** Delivery is not what this file is about; the first turn is not exercised. */
const NO_DELIVERY = { deliver: async () => undefined } as unknown as TmuxPaneDelivery;

interface Harness {
  readonly log: string[];
  readonly tmux: GatedTmux;
  readonly store: LoggingConfigStore;
  readonly lifecycle: SessionLifecycleService;
  readonly limits: CgroupService;
  readonly repository: MemoryRepository;
}

function harness(input: {
  readonly id: string;
  readonly facts?: SessionSpawnFacts;
  /** No saved document at all, which is what an untouched state home means: enforcement off. */
  readonly unsaved?: true;
  readonly refusal?: string;
}): Harness {
  const log: string[] = [];
  const tmux = new GatedTmux(log);
  const store = new LoggingConfigStore(log, input.unsaved === true ? undefined : ENABLED);
  const host = commands(log, input.refusal);
  const sessions = { facts: async () => input.facts };
  // THE production executor, and ONE of it — the composition root shares this exact instance
  // between every session mutation and the resource-limit save.
  const serial = new KeyedSerialExecutor();
  const repository = new MemoryRepository();
  const launcher = new TmuxSessionLifecycleLauncher(
    new TmuxController(tmux),
    NO_DELIVERY,
    undefined,
    undefined,
    undefined,
    new CgroupLaunchPlanner({ store, host: HOST, commands: host, sessions, nonce: () => 'ab' }),
  );
  return {
    log,
    tmux,
    store,
    repository,
    lifecycle: new SessionLifecycleService(
      {
        repository,
        launcher,
        tasks: { writeAssignedTask: async () => '/turns/turn-001.md' },
        effects: memoryEffectLedger(),
        directories: { resolve: async () => '/canonical' },
        ids: { next: () => parseSessionId(input.id) },
        clock: { now: () => '2026-08-06T00:00:00.000Z' },
        serial,
      },
      defaultSessionLifecycleSettings,
    ),
    limits: new CgroupService({
      store,
      applyStatus: memoryApplyStatus(),
      host: HOST,
      commands: host,
      placements: { placement: async () => '0::/user@1000.service/app.slice/daemon.service' },
      panes: { live: async () => ({ panes: [], unproven: [] }) },
      sessions,
      serial,
      daemonPid: process.pid,
    }),
  };
}

const create = {
  agent: AGENT,
  command: [...HARNESS_COMMAND],
  cwd: '/project',
  mode: 'auto' as const,
  // An auto session must carry an opening turn; the lifecycle refuses one that cannot do anything.
  prompt: 'do the work',
};

describe('what the compiled launch path actually execs', () => {
  it('should hand the multiplexer the WRAPPED argv while the durable record keeps the harness command', async () => {
    // Arrange
    const subject = harness({ id: 'ms8-aaaa1111', facts: {} });
    await subject.lifecycle.create(create);

    // Act
    await subject.lifecycle.start('ms8-aaaa1111');

    // Assert
    should(subject.tmux.launched()).deepEqual([
      'systemd-run',
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '--unit=ferretry-agent-ms8-aaaa1111-ab.scope',
      `--slice=${FLEET_SLICE}`,
      '--property=CPUQuota=100%',
      '--property=MemoryMax=250000',
      '--',
      AGENT,
      '--print',
    ]);
    // The record is what a relaunch replays, so the wrapper must never be baked into it.
    should(subject.repository.record('ms8-aaaa1111').config.command).deepEqual([...HARNESS_COMMAND]);
  });

  it('should prepare the aggregate before the multiplexer is asked to create the pane', async () => {
    // Arrange
    const subject = harness({ id: 'ms8-aaaa1111', facts: {} });
    await subject.lifecycle.create(create);

    // Act
    await subject.lifecycle.start('ms8-aaaa1111');

    // Assert
    should(subject.log.indexOf('host:set-property')).be.lessThan(subject.log.indexOf('launch:tmux-start'));
  });

  it('should launch supervision DIRECTLY, proving the exclusion in the shipped path', async () => {
    // Arrange
    const subject = harness({ id: 'ms8-bbbb2222', facts: { label: WARDEN_LABEL } });
    await subject.lifecycle.create(create);

    // Act
    await subject.lifecycle.start('ms8-bbbb2222');

    // Assert — no wrapper, and the host manager was never asked for anything.
    should(subject.tmux.launched()).deepEqual([AGENT, '--print']);
    should(subject.log).not.containEql('host:set-property');
  });

  it('should launch a warden descendant directly too', async () => {
    // Arrange
    const subject = harness({ id: 'ms8-cccc3333', facts: { wardenLineage: true } });
    await subject.lifecycle.create(create);

    // Act
    await subject.lifecycle.start('ms8-cccc3333');

    // Assert
    should(subject.tmux.launched()).deepEqual([AGENT, '--print']);
  });

  it('should launch byte-for-byte directly when enforcement is off', async () => {
    // Arrange
    const subject = harness({ id: 'ms8-dddd4444', facts: {}, unsaved: true });
    await subject.lifecycle.create(create);

    // Act
    await subject.lifecycle.start('ms8-dddd4444');

    // Assert
    should(subject.tmux.launched()).deepEqual([AGENT, '--print']);
    should(subject.log).not.containEql('host:set-property');
  });

  it('should REFUSE the agent launch when the aggregate cannot be prepared, and say why', async () => {
    // Arrange
    const subject = harness({ id: 'ms8-eeee5555', facts: {}, refusal: 'Failed to connect to bus' });
    await subject.lifecycle.create(create);

    // Act
    const failure = await subject.lifecycle.start('ms8-eeee5555').then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    // Assert — no pane exists, and the reason is the manager's own.
    should(failure).match(/Failed to connect to bus/u);
    should(subject.tmux.calls.some(call => call[0] === 'new-session')).be.false();
  });

  it('should keep the settings surface answering after a launch the host refused', async () => {
    // Arrange
    const subject = harness({ id: 'ms8-eeee5555', facts: {}, refusal: 'Failed to connect to bus' });
    await subject.lifecycle.create(create);
    await subject.lifecycle.start('ms8-eeee5555').catch(() => undefined);

    // Act
    const view = await subject.limits.config();

    // Assert — the daemon is alive and still describing itself; only that agent failed.
    should(view.config.enabled).be.true();
    should(view.supported).be.true();
  });
});

interface ResumeHarness {
  readonly log: string[];
  readonly tmux: GatedTmux;
  readonly store: LoggingConfigStore;
  readonly serial: KeyedSerialExecutor;
  readonly resume: TmuxResumeLauncher;
  readonly limits: CgroupService;
  readonly registrations: Array<{ readonly sessionId: SessionId; readonly tmuxSession: string }>;
}

/** The production resume adapter, planner and PATCH barrier over inspectable ports. */
function resumeHarness(input: {
  readonly id: SessionId;
  readonly facts: Readonly<Record<string, SessionSpawnFacts | undefined>>;
  readonly serial?: KeyedSerialExecutor;
  readonly host?: CgroupCommandPort;
  /** How many registration attempts lose the race with the pane before one wins. */
  readonly registrationFailures?: number;
  readonly unkillable?: true;
}): ResumeHarness {
  const log: string[] = [];
  const tmux = new GatedTmux(log);
  tmux.unkillable = input.unkillable === true;
  const store = new LoggingConfigStore(log, ENABLED);
  const serial = input.serial ?? new KeyedSerialExecutor();
  const host = input.host ?? commands(log);
  const sessions = { facts: async (sessionId: string) => input.facts[sessionId] };
  const planner = new CgroupLaunchPlanner({ store, host: HOST, commands: host, sessions, nonce: () => 'resume' });
  const registrations: Array<{ readonly sessionId: SessionId; readonly tmuxSession: string }> = [];
  let remainingFailures = input.registrationFailures ?? 0;
  // The SHIPPED retry policy, deliberately not overridden: the bound this daemon actually applies
  // is part of what these tests are about, and a fake one would prove a policy nothing runs.
  const resume = new TmuxResumeLauncher(
    new TmuxController(tmux),
    async () => ({ tmuxSession: `fy-${input.id}`, cwd: '/canonical', command: [...HARNESS_COMMAND] }),
    NO_DELIVERY,
    undefined,
    planner,
    {
      registerSession: async (sessionId, tmuxSession) => {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error('tmux has not proved the pane');
        }
        log.push('register:replacement-pane');
        registrations.push({ sessionId, tmuxSession });
      },
    },
  );
  return {
    log,
    tmux,
    store,
    serial,
    resume,
    registrations,
    limits: new CgroupService({
      store,
      applyStatus: memoryApplyStatus(),
      host: HOST,
      commands: host,
      placements: { placement: async () => '0::/user@1000.service/app.slice/daemon.service' },
      panes: { live: async () => ({ panes: [], unproven: [] }) },
      sessions,
      serial,
      daemonPid: process.pid,
    }),
  };
}

describe('what the compiled RESUME path actually execs', () => {
  it('should wrap an ordinary replacement from the current config and register its new process identity', async () => {
    // Arrange
    const id = parseSessionId('ms8-abcd1111');
    const subject = resumeHarness({ id, facts: { [id]: {} } });

    // Act
    await subject.resume.relaunch(id);

    // Assert — the durable spec remains the direct harness command; only tmux receives the wrapper.
    should(subject.tmux.launched()).deepEqual([
      'systemd-run',
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '--unit=ferretry-agent-ms8-abcd1111-resume.scope',
      `--slice=${FLEET_SLICE}`,
      '--property=CPUQuota=100%',
      '--property=MemoryMax=250000',
      '--',
      ...HARNESS_COMMAND,
    ]);
    should(subject.registrations).deepEqual([{ sessionId: id, tmuxSession: `fy-${id}` }]);
    should(subject.log.indexOf('register:replacement-pane')).be.greaterThan(subject.log.indexOf('launch:tmux-end'));
  });

  it('should retry a registration that lost the race with the pane it is about', async () => {
    // Arrange — both ways this write fails are races with the launch that just happened: tmux has
    // not published the pane yet, or its process is not readable yet. Both resolve in milliseconds.
    const id = parseSessionId('ms8-cdea6666');
    const subject = resumeHarness({ id, facts: { [id]: {} }, registrationFailures: 2 });

    // Act
    await subject.resume.relaunch(id);

    // Assert — the durable identity names the replacement, and no pane was thrown away over a race.
    should(subject.registrations).deepEqual([{ sessionId: id, tmuxSession: `fy-${id}` }]);
    should(subject.tmux.calls.some(call => call[0] === 'kill-session')).be.false();
  });

  it('should tear the replacement down and FAIL when its identity cannot be recorded at all', async () => {
    // Arrange — a live pane nothing can name is worse than no pane: the recovery would find it
    // alive and report the session preserved, while every durable reader still named the killed pid.
    const id = parseSessionId('ms8-deab7777');
    const subject = resumeHarness({ id, facts: { [id]: {} }, registrationFailures: Number.POSITIVE_INFINITY });

    // Act
    const failure = await subject.resume.relaunch(id).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    // Assert
    should(failure).match(/could not be registered \(tmux has not proved the pane\)/u);
    should(failure).match(/the unregistered replacement pane was killed/u);
    should(subject.registrations).be.empty();
    should(subject.tmux.calls.some(call => call[0] === 'kill-session')).be.true();
  });

  it('should say so when it could not even kill the replacement it cannot name', async () => {
    // Arrange
    const id = parseSessionId('ms8-eabc8888');
    const subject = resumeHarness({
      id,
      facts: { [id]: {} },
      registrationFailures: Number.POSITIVE_INFINITY,
      unkillable: true,
    });

    // Act
    const failure = await subject.resume.relaunch(id).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    // Assert — the worst state this daemon can be in must not be the quietest one.
    should(failure).match(/could not be killed either/u);
  });

  it('should fail through SessionResumeService when the unregistered replacement is still alive', async () => {
    // Arrange — this is the complete failure chain from the shipped tmux adapter through generic
    // resume recovery: all registration attempts fail, kill-session fails, and the independent
    // probe sees the replacement alive. That last observation must not turn missing durable
    // identity into a preserved session.
    const id = parseSessionId('ms8-fabc9999');
    const subject = resumeHarness({
      id,
      facts: { [id]: {} },
      registrationFailures: Number.POSITIVE_INFINITY,
      unkillable: true,
    });
    let current: ResumeTarget = { id, status: 'stopped', mode: 'interactive', cwd: '/canonical', turn: 3 };
    const transitions: ResumeTransition[] = [];
    const resume = new SessionResumeService(
      {
        repository: {
          read: async () => current,
          list: async () => [current],
          transition: async (_sessionId, change) => {
            transitions.push(change);
            current = {
              ...current,
              ...(change.status === undefined ? {} : { status: change.status }),
              ...(change.turn === undefined ? {} : { turn: change.turn }),
              ...(change.retryAttempt === undefined ? {} : { retryAttempt: change.retryAttempt }),
            };
            return current;
          },
        },
        launcher: subject.resume,
        // This case never reaches a released advisory: registration fails before any dismissal is
        // owed, so the port is present to satisfy the contract and records nothing.
        answerAttention: { acknowledge: async () => undefined },
        turns: { writeTurn: async () => '/unused', clearMarkers: async () => undefined },
        monitors: { stop: async () => undefined, start: async () => undefined },
        gate: {
          launching: () => false,
          awaitSettled: async () => true,
          register: () => ({ release: () => undefined }),
        },
        serial: subject.serial,
      },
      defaultSessionResumeSettings,
    );

    // Act
    const failure = resume.resume({ id, actor: 'admin-ui' });

    // Assert — the pane really did survive both teardown attempts, yet the durable state says the
    // resume failed and no false-terminal event claims it was preserved.
    await should(failure).be.rejectedWith(UnregisteredResumeReplacement);
    should(subject.tmux.alive).be.true();
    should(transitions.map(change => change.event)).containEql('session.failed');
    should(transitions.map(change => change.event)).not.containEql('session.resume_false_terminal_averted');
  });

  it('should resume a durable-parent Warden descendant directly', async () => {
    // Arrange — no lineage fixture: the parent walk is the mechanism production writes today.
    const id = parseSessionId('ms8-bcde2222');
    const warden = parseSessionId('ms8-cdef3333');
    const subject = resumeHarness({
      id,
      facts: { [id]: { parent: warden }, [warden]: { label: WARDEN_LABEL } },
    });

    // Act
    await subject.resume.relaunch(id);

    // Assert
    should(subject.tmux.launched()).deepEqual([...HARNESS_COMMAND]);
    should(subject.log).not.containEql('host:set-property');
    should(subject.registrations).have.length(1);
  });
});

describe('the barrier a resource-limit save and a session RESUME share', () => {
  it('should hold PATCH until an in-flight replacement pane has been registered', async () => {
    // Arrange
    const id = parseSessionId('ms8-defa4444');
    const subject = resumeHarness({ id, facts: { [id]: {} } });
    const open = subject.tmux.hold();
    const resuming = subject.serial.run(id, async () => await subject.resume.relaunch(id));
    await subject.tmux.reachedLaunch;

    // Act
    const saving = subject.limits.updateConfig({ perAgent: { cpuPercent: 5, memoryPercent: 5 } });
    await Bun.sleep(20);
    const beforeRelease = [...subject.log];
    open();
    await resuming;
    await saving;

    // Assert
    should(beforeRelease).not.containEql('store:write');
    should(subject.log.indexOf('store:write')).be.greaterThan(subject.log.indexOf('register:replacement-pane'));
  });

  it('should hold a replacement launch while PATCH is applying', async () => {
    // Arrange
    const id = parseSessionId('ms8-efab5555');
    let releaseHost = (): void => undefined;
    const parked = new Promise<void>(resolve => {
      releaseHost = resolve;
    });
    let reachedHost = (): void => undefined;
    const atHost = new Promise<void>(resolve => {
      reachedHost = resolve;
    });
    const host: CgroupCommandPort = {
      execute: async () => {
        reachedHost();
        await parked;
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const subject = resumeHarness({ id, facts: { [id]: {} }, host });

    // Act
    const saving = subject.limits.updateConfig({ perAgent: { cpuPercent: 5, memoryPercent: 5 } });
    await atHost;
    const resuming = subject.serial.run(id, async () => await subject.resume.relaunch(id));
    await Bun.sleep(20);
    const beforeRelease = [...subject.tmux.calls];
    releaseHost();
    await saving;
    await resuming;

    // Assert
    should(beforeRelease.some(call => call[0] === 'new-session')).be.false();
    should(subject.tmux.launched()).containEql('--property=CPUQuota=20%');
  });
});

describe('the barrier a resource-limit save and a session bootstrap share', () => {
  it('should hold a save until an IN-FLIGHT bootstrap has finished, not merely queue behind its key', async () => {
    // Arrange — a bootstrap parked inside the multiplexer, exactly the window a save must not enter.
    const subject = harness({ id: 'ms8-ffff6666', facts: {} });
    await subject.lifecycle.create(create);
    const open = subject.tmux.hold();
    const starting = subject.lifecycle.start('ms8-ffff6666');
    await subject.tmux.reachedLaunch;

    // Act — fired while the pane does not yet exist. A per-session key would let this straight in.
    const saving = subject.limits.updateConfig({ perAgent: { cpuPercent: 5, memoryPercent: 5 } });
    // Give the save every chance to interleave before the launch is released.
    await Bun.sleep(20);
    const beforeRelease = [...subject.log];
    open();
    await starting;
    await saving;

    // Assert
    should(beforeRelease).not.containEql('store:write');
    should(subject.log.indexOf('store:write')).be.greaterThan(subject.log.indexOf('launch:tmux-end'));
  });

  it('should give the launch the limits that were saved BEFORE it, never a value written mid-flight', async () => {
    // Arrange
    const subject = harness({ id: 'ms8-ffff6666', facts: {} });
    await subject.lifecycle.create(create);
    const open = subject.tmux.hold();
    const starting = subject.lifecycle.start('ms8-ffff6666');
    await subject.tmux.reachedLaunch;

    // Act
    const saving = subject.limits.updateConfig({ perAgent: { cpuPercent: 5, memoryPercent: 5 } });
    await Bun.sleep(20);
    open();
    await starting;
    await saving;

    // Assert — the pane carries the pre-save cap; the next launch carries the new one.
    should(subject.tmux.launched()).containEql('--property=CPUQuota=100%');
    should((subject.store.saved as CgroupConfig).perAgent.cpuPercent).equal(5);
  });

  it('should hold a bootstrap that arrives while a save is in flight', async () => {
    // Arrange — a save whose host call parks, with a start fired underneath it.
    const log: string[] = [];
    const serial = new KeyedSerialExecutor();
    let releaseHost = (): void => undefined;
    const parked = new Promise<void>(resolve => {
      releaseHost = resolve;
    });
    let reachedHost = (): void => undefined;
    const atHost = new Promise<void>(resolve => {
      reachedHost = resolve;
    });
    const store = new LoggingConfigStore(log, ENABLED);
    const limits = new CgroupService({
      store,
      applyStatus: memoryApplyStatus(),
      host: HOST,
      commands: {
        execute: async () => {
          log.push('host:set-property');
          reachedHost();
          await parked;
          return { code: 0, stdout: '', stderr: '' };
        },
      },
      placements: { placement: async () => '0::/app.slice/daemon.service' },
      panes: { live: async () => ({ panes: [], unproven: [] }) },
      sessions: { facts: async () => ({}) },
      serial,
      daemonPid: process.pid,
    });
    const tmux = new GatedTmux(log);
    const lifecycle = new SessionLifecycleService(
      {
        repository: new MemoryRepository(),
        launcher: new TmuxSessionLifecycleLauncher(
          new TmuxController(tmux),
          NO_DELIVERY,
          undefined,
          undefined,
          undefined,
          new CgroupLaunchPlanner({
            store,
            host: HOST,
            commands: { execute: async () => ({ code: 0, stdout: '', stderr: '' }) },
            sessions: { facts: async () => ({}) },
            nonce: () => 'ab',
          }),
        ),
        tasks: { writeAssignedTask: async () => '/turns/turn-001.md' },
        effects: memoryEffectLedger(),
        directories: { resolve: async () => '/canonical' },
        ids: { next: () => parseSessionId('ms8-9999aaaa') },
        clock: { now: () => '2026-08-06T00:00:00.000Z' },
        serial,
      },
      defaultSessionLifecycleSettings,
    );

    // Act
    const saving = limits.updateConfig({ enabled: true });
    await atHost;
    const creating = lifecycle.createAndStart(create);
    await Bun.sleep(20);
    const beforeRelease = [...log];
    releaseHost();
    await saving;
    await creating;

    // Assert — the bootstrap did not begin while the save held the barrier.
    should(beforeRelease).not.containEql('launch:tmux-start');
    should(log.indexOf('launch:tmux-start')).be.greaterThan(log.indexOf('host:set-property'));
  });
});
