import { describe, it } from 'bun:test';
import should from 'should';
import type { CgroupConfig } from '@ferretry/protocol';
import {
  CgroupError,
  CgroupDocumentReadFailure,
  CgroupLaunchPlanner,
  CgroupService,
  cleanCgroupApplyStatus,
  defaultCgroupConfig,
  FLEET_SLICE,
  type CgroupApplyStatus,
  type CgroupApplyStatusStore,
  type CgroupCommandPort,
  type CgroupConfigStore,
  type CgroupHostFacts,
  type CgroupPaneLedger,
  type CgroupPlacementPort,
  type ManagedPane,
  type SessionSpawnFacts,
  type SessionSpawnFactsPort,
  parseStoredCgroupConfig,
} from '../../../src/lib/cgroups/index.ts';
import type { SerialExecutor } from '../../../src/lib/ports.ts';
import { WARDEN_LABEL } from '../../../src/lib/warden/index.ts';

const DAEMON_PID = 4242;
/** A placement outside every managed slice — where this daemon and supervision belong. */
const OUTSIDE = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/daemon.service';
const scoped = (scope: string): string => `0::/user@1000.service/${FLEET_SLICE}/${scope}`;

const host = (overrides: Partial<CgroupHostFacts> = {}): CgroupHostFacts => ({
  platform: 'linux',
  unifiedHierarchy: true,
  cpus: 4,
  memoryBytes: 1_000_000,
  ...overrides,
});

const enabled: CgroupConfig = { ...defaultCgroupConfig, enabled: true };

const recordedStatus = (
  config: CgroupConfig = enabled,
  overrides: Partial<CgroupApplyStatus> = {},
): CgroupApplyStatus => ({ config, scopes: [], unproven: [], ...overrides });

class MemoryConfigStore implements CgroupConfigStore {
  saved: unknown;
  writes = 0;
  constructor(initial?: unknown) {
    this.saved = initial;
  }
  async read(): Promise<unknown> {
    return this.saved;
  }
  async write(config: CgroupConfig): Promise<void> {
    this.writes += 1;
    this.saved = config;
  }
}

/** Retains the real document while simulating a transient adapter read failure. Writes remain
 * available so the regression proves the domain refuses them rather than relying on EACCES to do
 * so accidentally. */
class ReadFailingConfigStore extends MemoryConfigStore {
  constructor(
    initial: CgroupConfig,
    private readonly failure: string,
  ) {
    super(initial);
  }
  override async read(): Promise<unknown> {
    return new CgroupDocumentReadFailure(this.failure);
  }
}

class RecordingCommands implements CgroupCommandPort {
  readonly argv: (readonly string[])[] = [];
  constructor(private readonly refuse: (argv: readonly string[]) => string | undefined = () => undefined) {}
  async execute(argv: readonly string[]) {
    this.argv.push(argv);
    const stderr = this.refuse(argv);
    return stderr === undefined ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr };
  }
}

const placements = (byPid: Readonly<Record<number, string | Error>>): CgroupPlacementPort => ({
  placement: async pid => {
    const value = byPid[pid];
    if (value === undefined) throw new Error(`no such process: ${pid}`);
    if (value instanceof Error) throw value;
    return value;
  },
});

const ledger = (panes: readonly ManagedPane[]): CgroupPaneLedger => ({
  live: async () => ({ panes, unproven: [] }),
});

const facts = (bySession: Readonly<Record<string, SessionSpawnFacts | undefined>>): SessionSpawnFactsPort => ({
  facts: async sessionId => bySession[sessionId],
});

/** Runs the work immediately. Ordering itself is proved against the real executor in the
 *  integration tier, where that adapter lives. */
const immediateSerial: SerialExecutor = {
  run: async (_key, work) => await work(),
  runExclusive: async work => await work(),
};

/** The durable record of what a save could not apply, in memory. `write` may be made to refuse, so
 *  the one path that must never turn a recorded refusal into silence can be proved. */
class MemoryApplyStatusStore implements CgroupApplyStatusStore {
  saved: unknown;
  readonly writes: CgroupApplyStatus[] = [];
  private attempts = 0;
  constructor(
    initial?: unknown,
    private readonly refuse?: string,
    private readonly refuseOnAttempt = 1,
  ) {
    this.saved = initial;
  }
  async read(): Promise<unknown> {
    return this.saved;
  }
  async write(status: CgroupApplyStatus): Promise<void> {
    this.attempts += 1;
    if (this.refuse !== undefined && this.attempts === this.refuseOnAttempt) throw new Error(this.refuse);
    this.writes.push(status);
    this.saved = status;
  }
}

const service = (parts: {
  store?: MemoryConfigStore;
  applyStatus?: CgroupApplyStatusStore;
  host?: CgroupHostFacts;
  commands?: CgroupCommandPort;
  placements?: CgroupPlacementPort;
  panes?: CgroupPaneLedger;
  sessions?: SessionSpawnFactsPort;
  serial?: SerialExecutor;
}): CgroupService => {
  const store = parts.store ?? new MemoryConfigStore();
  const storedConfig = parseStoredCgroupConfig(store.saved).config;
  return new CgroupService({
    store,
    applyStatus: parts.applyStatus ?? new MemoryApplyStatusStore(cleanCgroupApplyStatus(storedConfig)),
    host: parts.host ?? host(),
    commands: parts.commands ?? new RecordingCommands(),
    placements: parts.placements ?? placements({ [DAEMON_PID]: OUTSIDE }),
    panes: parts.panes ?? ledger([]),
    sessions: parts.sessions ?? facts({}),
    serial: parts.serial ?? immediateSerial,
    daemonPid: DAEMON_PID,
  });
};

describe('reporting what this daemon enforces', () => {
  it('should report an untouched state home as the defaults on the measured host', async () => {
    // Arrange
    const subject = service({});

    // Act
    const view = await subject.config();

    // Assert
    should(view.config).deepEqual(defaultCgroupConfig);
    should(view.supported).be.true();
    should(view.fleetSlice).equal(FLEET_SLICE);
    should(view.effective.fleet).deepEqual({ cpuQuota: '360%', memoryMax: '900000' });
    should(view.warnings).be.empty();
  });

  it('should report a host that cannot enforce anything as unsupported', async () => {
    // Arrange
    const subject = service({ host: host({ platform: 'darwin', unifiedHierarchy: false }) });

    // Act / Assert
    should((await subject.config()).supported).be.false();
  });

  it('should carry the saved documents own complaint into the view', async () => {
    // Arrange
    const subject = service({ store: new MemoryConfigStore({ enabled: 'yes' }) });

    // Act / Assert
    should((await subject.config()).warnings.join(' ')).match(/did not validate/u);
  });

  it('should say plainly when the saved document asks for enforcement this host cannot give', async () => {
    // Arrange
    const subject = service({ store: new MemoryConfigStore(enabled), host: host({ unifiedHierarchy: false }) });

    // Act / Assert
    should((await subject.config()).warnings.join(' ')).match(/cannot enforce it/u);
  });

  it('should ask an already-managed session for no restart', async () => {
    // Arrange
    const subject = service({
      store: new MemoryConfigStore(enabled),
      panes: ledger([{ sessionId: 's1', pid: 11 }]),
      placements: placements({ [DAEMON_PID]: OUTSIDE, 11: scoped('ferretry-agent-s1-ab.scope') }),
      sessions: facts({ s1: {} }),
    });

    // Act / Assert
    should((await subject.config()).restartRequiredSessions).be.empty();
  });

  it('should ask an unmanaged session to restart while enforcement is on', async () => {
    // Arrange
    const subject = service({
      store: new MemoryConfigStore(enabled),
      panes: ledger([{ sessionId: 's1', pid: 11 }]),
      placements: placements({ [DAEMON_PID]: OUTSIDE, 11: OUTSIDE }),
      sessions: facts({ s1: {} }),
    });

    // Act / Assert
    should((await subject.config()).restartRequiredSessions).deepEqual(['s1']);
  });

  it('should ask a still-scoped session to restart while enforcement is off', async () => {
    // Arrange
    const subject = service({
      panes: ledger([{ sessionId: 's1', pid: 11 }]),
      placements: placements({ [DAEMON_PID]: OUTSIDE, 11: scoped('ferretry-agent-s1-ab.scope') }),
      sessions: facts({ s1: {} }),
    });

    // Act / Assert
    should((await subject.config()).restartRequiredSessions).deepEqual(['s1']);
  });

  it('should warn and conservatively demand a restart when a pane placement cannot be read', async () => {
    // Arrange
    const subject = service({
      store: new MemoryConfigStore(enabled),
      panes: ledger([{ sessionId: 's1', pid: 11 }]),
      placements: placements({ [DAEMON_PID]: OUTSIDE, 11: new Error('EACCES') }),
      sessions: facts({ s1: {} }),
    });

    // Act
    const view = await subject.config();

    // Assert — unknown is never reported as uncapped.
    should(view.restartRequiredSessions).deepEqual(['s1']);
    should(view.warnings.join(' ')).match(/could not read the cgroup placement of s1 \(pid 11\): EACCES/u);
  });

  it('should never ask supervision to restart, in either enforcement state', async () => {
    // Arrange
    const parts = {
      panes: ledger([{ sessionId: 'w1', pid: 12 }]),
      placements: placements({ [DAEMON_PID]: OUTSIDE, 12: OUTSIDE }),
      sessions: facts({ w1: { label: WARDEN_LABEL } }),
    };

    // Act
    const off = await service(parts).config();
    const on = await service({ ...parts, store: new MemoryConfigStore(enabled) }).config();

    // Assert
    should(off.restartRequiredSessions).be.empty();
    should(on.restartRequiredSessions).be.empty();
  });

  it('should MEASURE supervision exclusion rather than assert it', async () => {
    // Arrange — a warden that somehow ended up inside the capped slice.
    const subject = service({
      store: new MemoryConfigStore(enabled),
      panes: ledger([{ sessionId: 'w1', pid: 12 }]),
      placements: placements({ [DAEMON_PID]: OUTSIDE, 12: scoped('anything.scope') }),
      sessions: facts({ w1: { wardenLineage: true } }),
    });

    // Act
    const view = await subject.config();

    // Assert
    should(view.warnings.join(' ')).match(/w1 is supervision but is inside ferretry-fleet\.slice/u);
    should(view.restartRequiredSessions).deepEqual(['w1']);
  });

  it('should never ask a warden DESCENDANT to restart either, resolved by the parent walk', async () => {
    // Arrange — the child carries no marker of its own; only the walk to its parent proves descent,
    // and that walk is the only mechanism that works on a real host today.
    const subject = service({
      store: new MemoryConfigStore(enabled),
      panes: ledger([{ sessionId: 'child', pid: 13 }]),
      placements: placements({ [DAEMON_PID]: OUTSIDE, 13: OUTSIDE }),
      sessions: facts({ child: { parent: 'w1' }, w1: { label: WARDEN_LABEL } }),
    });

    // Act
    const view = await subject.config();

    // Assert
    should(view.restartRequiredSessions).be.empty();
    should(view.warnings).be.empty();
  });

  it('should refuse to call a same-named scope OUTSIDE the configured slice managed', async () => {
    // Arrange — a unit carrying this product's scope naming, sitting somewhere else entirely: left
    // over from a previous fleet slice, or run by hand. The name is not a placement.
    const subject = service({
      store: new MemoryConfigStore(enabled),
      panes: ledger([{ sessionId: 's1', pid: 11 }]),
      placements: placements({
        [DAEMON_PID]: OUTSIDE,
        11: '0::/user@1000.service/somebody-elses.slice/ferretry-agent-s1-ab.scope',
      }),
      sessions: facts({ s1: {} }),
    });

    // Act
    const view = await subject.config();

    // Assert — reporting it as managed would claim enforcement this daemon's slice is not providing.
    should(view.restartRequiredSessions).deepEqual(['s1']);
    should(view.warnings.join(' ')).match(/not beneath ferretry-fleet\.slice/u);
  });

  it('should warn about a session whose own spawn record could not be read, and demand its restart', async () => {
    // Arrange
    const subject = service({
      store: new MemoryConfigStore(enabled),
      panes: ledger([{ sessionId: 's9', pid: 13 }]),
      placements: placements({ [DAEMON_PID]: OUTSIDE, 13: OUTSIDE }),
      sessions: facts({}),
    });

    // Act
    const view = await subject.config();

    // Assert — the launch left it uncapped on purpose; this is the half that refuses to be silent.
    should(view.warnings.join(' ')).match(/could not read the spawn record of s9/u);
    should(view.restartRequiredSessions).deepEqual(['s9']);
  });

  it('should say nothing about its own placement when it PROVES it is outside the slice', async () => {
    // Arrange / Act / Assert
    should((await service({}).config()).warnings).be.empty();
  });

  it('should refuse to rely on limits when this very daemon is inside the slice it caps', async () => {
    // Arrange
    const subject = service({ placements: placements({ [DAEMON_PID]: scoped('x.scope') }) });

    // Act / Assert
    should((await subject.config()).warnings.join(' ')).match(/is itself inside ferretry-fleet\.slice/u);
  });

  it('should distinguish "we could not look" from "we looked and it is outside"', async () => {
    // Arrange
    const subject = service({ placements: placements({}) });

    // Act / Assert
    should((await subject.config()).warnings.join(' ')).match(/could not prove this daemon is outside/u);
  });
});

describe('saving a change', () => {
  it('should merge onto what is stored NOW and persist the whole document', async () => {
    // Arrange
    const store = new MemoryConfigStore({ ...defaultCgroupConfig, fleet: { cpuPercent: 50, memoryPercent: 60 } });
    const subject = service({ store });

    // Act
    const view = await subject.updateConfig({ perAgent: { cpuPercent: 10 } });

    // Assert
    should(view.config.fleet).deepEqual({ cpuPercent: 50, memoryPercent: 60 });
    should(view.config.perAgent.cpuPercent).equal(10);
    should(store.saved).deepEqual(view.config);
  });

  it('should reject a partial PATCH before either document changes when the stored config cannot be read', async () => {
    // Arrange — the actual document is enabled and non-default, but this read returns EIO. The
    // store is deliberately writable: safety must come from the domain, not an incidental EIO on
    // the later write.
    const original: CgroupConfig = {
      enabled: true,
      fleet: { cpuPercent: 70, memoryPercent: 80 },
      perAgent: { cpuPercent: 20, memoryPercent: 30 },
    };
    const store = new ReadFailingConfigStore(original, 'EIO: input/output error');
    const applyStatus = new MemoryApplyStatusStore(cleanCgroupApplyStatus(original));
    const commands = new RecordingCommands();
    const subject = service({ store, applyStatus, commands });

    // Act / Assert — merging onto the GET fallback would reset every unspecified value and could
    // disable enforcement. No write-ahead record may be started for an edit that cannot be based on
    // the operator's real document.
    await should(subject.updateConfig({ perAgent: { cpuPercent: 5 } })).be.rejectedWith(
      /stored configuration could not be read .* no configuration or apply record was changed/u,
    );
    should(store.saved).deepEqual(original);
    should(store.writes).equal(0);
    should(applyStatus.writes).be.empty();
    should(commands.argv).be.empty();
  });

  it('should refuse a merge the whole document could not survive', async () => {
    // Arrange
    const subject = service({});
    let failure: string | undefined;

    // Act
    await subject.updateConfig({ fleet: { cpuPercent: 1 } }).catch(error => {
      failure = error instanceof CgroupError ? error.failure : undefined;
    });

    // Assert
    should(failure).equal('invalid');
  });

  it('should refuse enforcement on a host that cannot provide it, and persist nothing', async () => {
    // Arrange
    const store = new MemoryConfigStore();
    const subject = service({ store, host: host({ platform: 'darwin' }) });
    let failure: CgroupError | undefined;

    // Act
    await subject.updateConfig({ enabled: true }).catch(error => {
      failure = error instanceof CgroupError ? error : undefined;
    });

    // Assert
    should(failure?.failure).equal('unsupported');
    should(failure?.message).match(/darwin/u);
    should(store.writes).equal(0);
  });

  it('should name the missing hierarchy when Linux itself is not the obstacle', async () => {
    // Arrange
    const subject = service({ host: host({ unifiedHierarchy: false }) });

    // Act / Assert
    await should(subject.updateConfig({ enabled: true })).be.rejectedWith(/linux without it/u);
  });

  it('should let an unsupported host still turn enforcement OFF', async () => {
    // Arrange
    const store = new MemoryConfigStore(enabled);
    const subject = service({ store, host: host({ platform: 'darwin' }) });

    // Act
    const view = await subject.updateConfig({ enabled: false });

    // Assert
    should(view.config.enabled).be.false();
    should(store.writes).equal(1);
  });

  it('should put the aggregate on the slice and the per-agent cap on each discovered scope', async () => {
    // Arrange
    const commands = new RecordingCommands();
    const subject = service({
      commands,
      panes: ledger([{ sessionId: 's1', pid: 11 }]),
      placements: placements({ [DAEMON_PID]: OUTSIDE, 11: scoped('ferretry-agent-s1-ab.scope') }),
      sessions: facts({ s1: {} }),
    });

    // Act
    const view = await subject.updateConfig({ enabled: true });

    // Assert
    should(commands.argv).deepEqual([
      ['systemctl', '--user', 'set-property', '--runtime', FLEET_SLICE, 'CPUQuota=360%', 'MemoryMax=900000'],
      [
        'systemctl',
        '--user',
        'set-property',
        '--runtime',
        'ferretry-agent-s1-ab.scope',
        'CPUQuota=100%',
        'MemoryMax=250000',
      ],
    ]);
    should(view.restartRequiredSessions).be.empty();
  });

  it('should never write a property onto a scope outside the slice it configures', async () => {
    // Arrange
    const commands = new RecordingCommands();
    const subject = service({
      commands,
      panes: ledger([{ sessionId: 's1', pid: 11 }]),
      placements: placements({
        [DAEMON_PID]: OUTSIDE,
        11: '0::/user@1000.service/somebody-elses.slice/ferretry-agent-s1-ab.scope',
      }),
      sessions: facts({ s1: {} }),
    });

    // Act
    const view = await subject.updateConfig({ enabled: true });

    // Assert — only the aggregate; the foreign scope's limits are not this daemon's to change.
    should(commands.argv).have.length(1);
    should(view.restartRequiredSessions).deepEqual(['s1']);
    should(view.warnings.join(' ')).match(/not beneath ferretry-fleet\.slice/u);
  });

  it('should never write a property onto a supervision session', async () => {
    // Arrange
    const commands = new RecordingCommands();
    const subject = service({
      commands,
      panes: ledger([{ sessionId: 'w1', pid: 12 }]),
      placements: placements({ [DAEMON_PID]: OUTSIDE, 12: OUTSIDE }),
      sessions: facts({ w1: { label: WARDEN_LABEL } }),
    });

    // Act
    await subject.updateConfig({ enabled: true });

    // Assert — only the aggregate; nothing addressed the warden.
    should(commands.argv).have.length(1);
  });

  it('should store the intent, report the host refusal, and demand a restart of everything affected', async () => {
    // Arrange
    const store = new MemoryConfigStore();
    const commands = new RecordingCommands(() => 'Failed to connect to bus: No such file or directory');
    const subject = service({
      store,
      commands,
      panes: ledger([{ sessionId: 's1', pid: 11 }]),
      placements: placements({ [DAEMON_PID]: OUTSIDE, 11: OUTSIDE }),
      sessions: facts({ s1: {} }),
    });

    // Act
    const view = await subject.updateConfig({ enabled: true });

    // Assert
    should((store.saved as CgroupConfig).enabled).be.true();
    should(view.warnings.join(' ')).match(/Failed to connect to bus.*are not in force/su);
    should(view.restartRequiredSessions).deepEqual(['s1']);
    // Nothing was attempted per-scope beneath an aggregate that is not there.
    should(commands.argv).have.length(1);
  });

  it('should report one scope the manager refused without abandoning the rest', async () => {
    // Arrange
    const commands = new RecordingCommands(argv =>
      argv[4] === 'ferretry-agent-s1-ab.scope' ? 'Unit vanished' : undefined,
    );
    const subject = service({
      commands,
      panes: ledger([
        { sessionId: 's1', pid: 11 },
        { sessionId: 's2', pid: 12 },
      ]),
      placements: placements({
        [DAEMON_PID]: OUTSIDE,
        11: scoped('ferretry-agent-s1-ab.scope'),
        12: scoped('ferretry-agent-s2-cd.scope'),
      }),
      sessions: facts({ s1: {}, s2: {} }),
    });

    // Act
    const view = await subject.updateConfig({ enabled: true });

    // Assert
    should(view.restartRequiredSessions).deepEqual(['s1']);
    should(view.warnings.join(' ')).match(/s1: Unit vanished/u);
    should(commands.argv).have.length(3);
  });

  it('should ask an unmanaged live session to restart when enforcement is switched on', async () => {
    // Arrange
    const subject = service({
      panes: ledger([{ sessionId: 's1', pid: 11 }]),
      placements: placements({ [DAEMON_PID]: OUTSIDE, 11: OUTSIDE }),
      sessions: facts({ s1: {} }),
    });

    // Act / Assert — a live process cannot be adopted into a transient scope after the fact.
    should((await subject.updateConfig({ enabled: true })).restartRequiredSessions).deepEqual(['s1']);
  });

  it('should write NOTHING to the host when enforcement is turned off', async () => {
    // Arrange
    const commands = new RecordingCommands();
    const subject = service({
      store: new MemoryConfigStore(enabled),
      commands,
      panes: ledger([{ sessionId: 's1', pid: 11 }]),
      placements: placements({ [DAEMON_PID]: OUTSIDE, 11: scoped('ferretry-agent-s1-ab.scope') }),
      sessions: facts({ s1: {} }),
    });

    // Act
    const view = await subject.updateConfig({ enabled: false });

    // Assert — no `CPUQuota=infinity`; the scoped session keeps its cap and is told to restart.
    should(commands.argv).be.empty();
    should(view.restartRequiredSessions).deepEqual(['s1']);
  });

  it('should leave an already-unscoped session alone when enforcement is turned off', async () => {
    // Arrange
    const subject = service({
      store: new MemoryConfigStore(enabled),
      panes: ledger([{ sessionId: 's1', pid: 11 }]),
      placements: placements({ [DAEMON_PID]: OUTSIDE, 11: OUTSIDE }),
      sessions: facts({ s1: {} }),
    });

    // Act / Assert
    should((await subject.updateConfig({ enabled: false })).restartRequiredSessions).be.empty();
  });

  it('should treat an unreadable placement as restart-required while DISABLING too', async () => {
    // Arrange
    const subject = service({
      store: new MemoryConfigStore(enabled),
      panes: ledger([{ sessionId: 's1', pid: 11 }]),
      placements: placements({ [DAEMON_PID]: OUTSIDE, 11: new Error('gone') }),
      sessions: facts({ s1: {} }),
    });

    // Act / Assert — never claim a cap was lifted on evidence nobody has.
    should((await subject.updateConfig({ enabled: false })).restartRequiredSessions).deepEqual(['s1']);
  });

  it('should take the lifecycle executor EXCLUSIVELY rather than under a key of its own', async () => {
    // Arrange
    const taken: string[] = [];
    const recording: SerialExecutor = {
      run: async (key, work) => {
        taken.push(`run:${key}`);
        return await work();
      },
      runExclusive: async work => {
        taken.push('exclusive');
        return await work();
      },
    };
    const subject = service({ serial: recording });

    // Act
    await subject.updateConfig({ perAgent: { cpuPercent: 5 } });

    // Assert — a keyed run would order this against ONE session rather than against all of them.
    should(taken).deepEqual(['exclusive']);
  });

  it('should sort and de-duplicate the restart list so one session is named once', async () => {
    // Arrange
    const subject = service({
      store: new MemoryConfigStore(enabled),
      panes: ledger([
        { sessionId: 's2', pid: 12 },
        { sessionId: 's1', pid: 11 },
      ]),
      placements: placements({ [DAEMON_PID]: OUTSIDE, 11: new Error('gone'), 12: new Error('gone') }),
      sessions: facts({ s1: {}, s2: {} }),
    });

    // Act / Assert
    should((await subject.config()).restartRequiredSessions).deepEqual(['s1', 's2']);
  });
});

describe('what a save could not put into force, on every LATER read', () => {
  const s1 = { sessionId: 's1', pid: 11 };

  it('should still report a scope the manager refused after the save that met the refusal', async () => {
    // Arrange — the pane keeps its old cap, so its SHAPE says "scoped, enforcement on, all fine".
    const applyStatus = new MemoryApplyStatusStore();
    const commands = new RecordingCommands(argv =>
      argv[4] === 'ferretry-agent-s1-ab.scope' ? 'Unit vanished' : undefined,
    );
    const subject = service({
      applyStatus,
      commands,
      panes: ledger([s1]),
      placements: placements({ [DAEMON_PID]: OUTSIDE, 11: scoped('ferretry-agent-s1-ab.scope') }),
      sessions: facts({ s1: {} }),
    });
    await subject.updateConfig({ enabled: true });

    // Act — the page refresh that used to clear the only record of a stale cap.
    const later = await subject.config();

    // Assert
    should(later.restartRequiredSessions).deepEqual(['s1']);
    should(later.warnings.join(' ')).match(/s1: Unit vanished/u);
  });

  it('should record the exact scope, so a RELAUNCH supersedes the refusal by itself', async () => {
    // Arrange
    const tree: Record<number, string> = { [DAEMON_PID]: OUTSIDE, 11: scoped('ferretry-agent-s1-ab.scope') };
    const subject = service({
      commands: new RecordingCommands(argv => (argv[4] === 'ferretry-agent-s1-ab.scope' ? 'Unit vanished' : undefined)),
      panes: ledger([s1]),
      placements: placements(tree),
      sessions: facts({ s1: {} }),
    });
    await subject.updateConfig({ enabled: true });

    // Act — a new incarnation, in a scope minted with a new nonce, launched with the saved limits.
    tree[11] = scoped('ferretry-agent-s1-zz.scope');
    const later = await subject.config();

    // Assert — nobody had to clear the record for it to stop applying.
    should(later.restartRequiredSessions).be.empty();
    should(later.warnings).be.empty();
  });

  it('should say nothing about a refused scope whose session is no longer live', async () => {
    // Arrange
    const applyStatus = new MemoryApplyStatusStore({
      config: enabled,
      scopes: [{ sessionId: 's1', scope: 'ferretry-agent-s1-ab.scope', failure: 'Unit vanished' }],
      unproven: [],
    });
    const subject = service({ store: new MemoryConfigStore(enabled), applyStatus });

    // Act / Assert
    should((await subject.config()).restartRequiredSessions).be.empty();
  });

  it('should keep saying the saved limits are not in force after a refused aggregate', async () => {
    // Arrange
    const subject = service({
      commands: new RecordingCommands(() => 'Failed to connect to bus: No such file or directory'),
      panes: ledger([s1]),
      placements: placements({ [DAEMON_PID]: OUTSIDE, 11: OUTSIDE }),
      sessions: facts({ s1: {} }),
    });
    await subject.updateConfig({ enabled: true });

    // Act
    const later = await subject.config();

    // Assert — the intent persisted, and the surface still says the numbers are not on the host,
    // that a launch will now REFUSE rather than run uncapped, and how to get out of it.
    should(later.config.enabled).be.true();
    should(later.restartRequiredSessions).deepEqual(['s1']);
    should(later.warnings.join(' ')).match(/are not in force on ferretry-fleet\.slice/u);
    should(later.warnings.join(' ')).match(/fail-closed/u);
  });

  it('should never name supervision in the fallout of an aggregate it is not inside', async () => {
    // Arrange
    const applyStatus = new MemoryApplyStatusStore(recordedStatus(enabled, { fleet: 'Failed to connect to bus' }));
    const subject = service({
      store: new MemoryConfigStore(enabled),
      applyStatus,
      panes: ledger([{ sessionId: 'w1', pid: 12 }]),
      placements: placements({ [DAEMON_PID]: OUTSIDE, 12: OUTSIDE }),
      sessions: facts({ w1: { label: WARDEN_LABEL } }),
    });

    // Act / Assert
    should((await subject.config()).restartRequiredSessions).be.empty();
  });

  it('should let a later clean save supersede the recorded refusal', async () => {
    // Arrange
    const applyStatus = new MemoryApplyStatusStore(recordedStatus(enabled, { fleet: 'Failed to connect to bus' }));
    const subject = service({
      store: new MemoryConfigStore(enabled),
      applyStatus,
      panes: ledger([s1]),
      placements: placements({ [DAEMON_PID]: OUTSIDE, 11: scoped('ferretry-agent-s1-ab.scope') }),
      sessions: facts({ s1: {} }),
    });

    // Act
    await subject.updateConfig({ perAgent: { cpuPercent: 5 } });
    const later = await subject.config();

    // Assert — the save re-attempted every write the record was about, and this time they landed.
    should(applyStatus.writes.at(-1)).deepEqual(
      cleanCgroupApplyStatus({ ...enabled, perAgent: { ...enabled.perAgent, cpuPercent: 5 } }),
    );
    should(later.warnings).be.empty();
    should(later.restartRequiredSessions).be.empty();
  });

  it('should let turning enforcement OFF supersede it too', async () => {
    // Arrange
    const applyStatus = new MemoryApplyStatusStore(recordedStatus(enabled, { fleet: 'Failed to connect to bus' }));
    const subject = service({ store: new MemoryConfigStore(enabled), applyStatus });

    // Act
    await subject.updateConfig({ enabled: false });

    // Assert — nothing is written to the host, so there is nothing left it could have failed.
    should(applyStatus.saved).deepEqual(cleanCgroupApplyStatus({ ...enabled, enabled: false }));
  });

  it('should treat a record it cannot read as "nothing is established", not as "nothing failed"', async () => {
    // Arrange
    const subject = service({
      store: new MemoryConfigStore(enabled),
      applyStatus: new MemoryApplyStatusStore('{ hand-edited'),
      panes: ledger([s1]),
      placements: placements({ [DAEMON_PID]: OUTSIDE, 11: scoped('ferretry-agent-s1-ab.scope') }),
      sessions: facts({ s1: {} }),
    });

    // Act
    const view = await subject.config();

    // Assert
    should(view.restartRequiredSessions).deepEqual(['s1']);
    should(view.warnings.join(' ')).match(/did not validate/u);
  });

  it('should treat an absent record beside enabled intent as an interrupted or legacy save', async () => {
    // Arrange
    const subject = service({
      store: new MemoryConfigStore(enabled),
      applyStatus: new MemoryApplyStatusStore(),
      panes: ledger([s1]),
      placements: placements({ [DAEMON_PID]: OUTSIDE, 11: scoped('ferretry-agent-s1-ab.scope') }),
      sessions: facts({ s1: {} }),
    });

    // Act
    const view = await subject.config();

    // Assert
    should(view.restartRequiredSessions).deepEqual(['s1']);
    should(view.warnings.join(' ')).match(/record .* is absent/u);
  });

  it('should refuse before changing config when write-ahead apply evidence cannot be written', async () => {
    // Arrange
    const store = new MemoryConfigStore();
    const subject = service({ store, applyStatus: new MemoryApplyStatusStore(undefined, 'EROFS') });

    // Act / Assert
    await should(subject.updateConfig({ enabled: true })).be.rejectedWith(/could not begin recording/u);
    should(store.saved).be.undefined();
  });

  it('should leave the write-ahead record conservative when the exact final outcome cannot be written', async () => {
    // Arrange — the first status write succeeds; only the final replacement fails.
    const store = new MemoryConfigStore();
    const applyStatus = new MemoryApplyStatusStore(undefined, 'EROFS', 2);
    const subject = service({
      store,
      applyStatus,
      panes: ledger([s1]),
      placements: placements({ [DAEMON_PID]: OUTSIDE, 11: scoped('ferretry-agent-s1-ab.scope') }),
      sessions: facts({ s1: {} }),
    });

    // Act
    const view = await subject.updateConfig({ enabled: true });
    const later = await subject.config();

    // Assert — intent and host state changed, while the durable write-ahead record prevents a later
    // GET from calling the exact outcome clean.
    should((store.saved as CgroupConfig).enabled).be.true();
    should(view.warnings.join(' ')).match(/could not record the exact outcome .*\(EROFS\)/u);
    should(later.restartRequiredSessions).deepEqual(['s1']);
    should(later.warnings.join(' ')).match(/did not finish recording/u);
  });
});

describe('a pane ledger that could not prove itself', () => {
  it('should warn about an unproven registration and conservatively demand its restart', async () => {
    // Arrange — a damaged registration, or a pid the multiplexer no longer vouches for.
    const subject = service({
      store: new MemoryConfigStore(enabled),
      panes: {
        live: async () => ({ panes: [], unproven: [{ sessionId: 's9', failure: 'its registration is malformed' }] }),
      },
    });

    // Act
    const view = await subject.config();

    // Assert
    should(view.restartRequiredSessions).deepEqual(['s9']);
    should(view.warnings.join(' ')).match(/its registration is malformed/u);
  });

  it('should never address a property write at a pane it could not prove', async () => {
    // Arrange
    const commands = new RecordingCommands();
    const subject = service({
      commands,
      panes: {
        live: async () => ({ panes: [], unproven: [{ sessionId: 's9', failure: 'recycled pid' }] }),
      },
    });

    // Act
    const view = await subject.updateConfig({ enabled: true });

    // Assert — the aggregate only; there is no scope this daemon may claim belongs to `s9`.
    should(commands.argv).have.length(1);
    should(view.restartRequiredSessions).deepEqual(['s9']);
  });

  it('should keep a named pane unapplied after its registration later repairs', async () => {
    // Arrange — during PATCH there is no safe pid or scope to write. The following GET sees a
    // perfectly shaped managed scope, but shape cannot prove that old incarnation received the
    // save it missed.
    let scan: Awaited<ReturnType<CgroupPaneLedger['live']>> = {
      panes: [],
      unproven: [{ sessionId: 's9', failure: 'the registered pid incarnation did not match' }],
    };
    const applyStatus = new MemoryApplyStatusStore(cleanCgroupApplyStatus(defaultCgroupConfig));
    const subject = service({
      applyStatus,
      panes: { live: async () => scan },
      placements: placements({ [DAEMON_PID]: OUTSIDE, 19: scoped('ferretry-agent-s9-ab.scope') }),
      sessions: facts({ s9: {} }),
    });
    await subject.updateConfig({ enabled: true });

    // Act — the ledger repairs without another save.
    scan = { panes: [{ sessionId: 's9', pid: 19 }], unproven: [] };
    const later = await subject.config();

    // Assert
    should(later.restartRequiredSessions).deepEqual(['s9']);
    should(later.warnings.join(' ')).match(/last save could not prove a safe live pane/u);
  });

  it('should carry a ledger it could not enumerate at all into the view', async () => {
    // Arrange
    const subject = service({
      panes: { live: async () => ({ panes: [], unproven: [], incomplete: 'the ledger could not be read (EIO)' }) },
    });

    // Act / Assert — an empty set with nothing said about it would read as "no session is running".
    should((await subject.config()).warnings.join(' ')).match(/the ledger could not be read \(EIO\)/u);
  });

  it('should say so on a SAVE as well, where it also means the apply reached nothing', async () => {
    // Arrange
    const subject = service({
      panes: { live: async () => ({ panes: [], unproven: [], incomplete: 'the ledger could not be read (EIO)' }) },
    });

    // Act / Assert
    should((await subject.updateConfig({ enabled: true })).warnings.join(' ')).match(/EIO/u);
  });

  it('should keep a repaired ledger globally conservative after an incomplete save scan', async () => {
    // Arrange
    let scan: Awaited<ReturnType<CgroupPaneLedger['live']>> = {
      panes: [],
      unproven: [],
      incomplete: 'the ledger could not be read (EIO)',
    };
    const subject = service({
      panes: { live: async () => scan },
      placements: placements({ [DAEMON_PID]: OUTSIDE, 11: scoped('ferretry-agent-s1-ab.scope') }),
      sessions: facts({ s1: {} }),
    });
    await subject.updateConfig({ enabled: true });

    // Act
    scan = { panes: [{ sessionId: 's1', pid: 11 }], unproven: [] };
    const later = await subject.config();

    // Assert — the repaired enumeration does not rewrite history about what PATCH reached.
    should(later.restartRequiredSessions).deepEqual(['s1']);
    should(later.warnings.join(' ')).match(/ledger could not be read \(EIO\)/u);
    should(later.warnings.join(' ')).match(/save.*again/u);
  });
});

describe('choosing the argv one pane execs', () => {
  const planner = (parts: {
    store?: MemoryConfigStore;
    host?: CgroupHostFacts;
    commands?: CgroupCommandPort;
    sessions?: SessionSpawnFactsPort;
  }): CgroupLaunchPlanner =>
    new CgroupLaunchPlanner({
      store: parts.store ?? new MemoryConfigStore(enabled),
      host: parts.host ?? host(),
      commands: parts.commands ?? new RecordingCommands(),
      sessions: parts.sessions ?? facts({ s1: {} }),
      nonce: () => 'ab',
    });

  it('should hand back the command BYTE FOR BYTE when enforcement is off', async () => {
    // Arrange
    const commands = new RecordingCommands();
    const subject = planner({ store: new MemoryConfigStore(), commands });

    // Act
    const argv = await subject.command('s1', ['claude', '--x']);

    // Assert — no wrapper and no probe: a daemon with limits off behaves as one built without them.
    should(argv).deepEqual(['claude', '--x']);
    should(commands.argv).be.empty();
  });

  it('should hand back the command unchanged on a host that cannot enforce anything', async () => {
    // Arrange / Act / Assert
    should(await planner({ host: host({ platform: 'darwin' }) }).command('s1', ['claude'])).deepEqual(['claude']);
  });

  it('should never wrap supervision', async () => {
    // Arrange
    const commands = new RecordingCommands();
    const subject = planner({ commands, sessions: facts({ w1: { label: WARDEN_LABEL } }) });

    // Act / Assert
    should(await subject.command('w1', ['claude'])).deepEqual(['claude']);
    should(commands.argv).be.empty();
  });

  it('should never wrap a warden descendant, resolved by WALKING to its parent', async () => {
    // Arrange — no stamp on the child, because nothing in this daemon writes one; the walk is what
    // makes descendant exemption true on a real host rather than only in a fixture.
    const commands = new RecordingCommands();
    const subject = planner({ commands, sessions: facts({ c1: { parent: 'w1' }, w1: { label: WARDEN_LABEL } }) });

    // Act / Assert
    should(await subject.command('c1', ['claude'])).deepEqual(['claude']);
    should(commands.argv).be.empty();
  });

  it('should still honour a lineage stamp for the day one is written', async () => {
    // Arrange / Act / Assert
    should(await planner({ sessions: facts({ c1: { wardenLineage: true } }) }).command('c1', ['claude'])).deepEqual([
      'claude',
    ]);
  });

  it('should WRAP a session whose parent was pruned, rather than shielding it on absent evidence', async () => {
    // Arrange — the common case for a finished warden's sibling: exempting on an unresolvable parent
    // would silently uncap every session whose ancestor has been collected.
    const subject = planner({ sessions: facts({ s1: { parent: 'gone' } }) });

    // Act / Assert
    should(await subject.command('s1', ['claude'])).containEql('systemd-run');
  });

  it('should leave a session whose own document is unreadable uncapped rather than risk the watchdog', async () => {
    // Arrange
    const subject = planner({ sessions: facts({}) });

    // Act / Assert
    should(await subject.command('unknown', ['claude'])).deepEqual(['claude']);
  });

  it('should prepare the aggregate BEFORE it puts a scope underneath it', async () => {
    // Arrange
    const commands = new RecordingCommands();
    const subject = planner({ commands });

    // Act
    const argv = await subject.command('s1', ['claude', '--dangerously']);

    // Assert
    should(commands.argv).deepEqual([
      ['systemctl', '--user', 'set-property', '--runtime', FLEET_SLICE, 'CPUQuota=360%', 'MemoryMax=900000'],
    ]);
    should(argv).deepEqual([
      'systemd-run',
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '--unit=ferretry-agent-s1-ab.scope',
      `--slice=${FLEET_SLICE}`,
      '--property=CPUQuota=100%',
      '--property=MemoryMax=250000',
      '--',
      'claude',
      '--dangerously',
    ]);
  });

  it('should read the SAVED document per launch, so a save is honoured by the very next agent', async () => {
    // Arrange
    const store = new MemoryConfigStore(enabled);
    const subject = planner({ store });

    // Act
    const before = await subject.command('s1', ['claude']);
    store.saved = { ...enabled, perAgent: { cpuPercent: 5, memoryPercent: 5 } };
    const after = await subject.command('s1', ['claude']);

    // Assert
    should(before).containEql('--property=CPUQuota=100%');
    should(after).containEql('--property=CPUQuota=20%');
  });

  it('should FAIL the launch when the aggregate cannot be prepared, rather than escaping the cap', async () => {
    // Arrange
    const subject = planner({ commands: new RecordingCommands(() => 'Failed to connect to bus') });

    // Act / Assert
    await should(subject.command('s1', ['claude'])).be.rejectedWith(/Failed to connect to bus/u);
  });

  it('should sanitise a session id before it can reach a unit name', async () => {
    // Arrange
    const subject = planner({ sessions: facts({ 'a/b c': {} }) });

    // Act
    const argv = await subject.command('a/b c', ['claude']);

    // Assert
    should(argv).containEql('--unit=ferretry-agent-a-b-c-ab.scope');
  });
});
