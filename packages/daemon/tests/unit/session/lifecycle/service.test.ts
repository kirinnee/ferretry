import { describe, it } from 'bun:test';
import should from 'should';
import { parseSessionId, type ClockPort, type SerialExecutor, type SessionId } from '../../../../src/lib/index.ts';
import {
  defaultSessionLifecycleSettings,
  SessionLifecycleService,
  type CreateSessionLifecycleRequest,
  type SessionCredential,
  type SessionCredentialIssuer,
  type SessionEnvironmentStore,
  type SessionIdFactory,
  type SessionLifecycleEvent,
  type SessionLifecycleLauncher,
  type SessionLifecyclePorts,
  type SessionLifecycleRecord,
  type SessionLifecycleRepository,
  type SessionLifecycleSettings,
  type SessionTaskStore,
  type WorkingDirectoryResolver,
} from '../../../../src/lib/session/lifecycle/index.ts';

const AGENT = '/opt/fleet/bin/claude-auto-loge';
const ID = 'ms8-abcd1234';

/** Round-trips through JSON the way the real store does, so no test can rely on object identity. */
class MemoryRepository implements SessionLifecycleRepository {
  readonly documents = new Map<string, string>();
  readonly events: SessionLifecycleEvent[] = [];

  async read(id: SessionId): Promise<SessionLifecycleRecord | undefined> {
    const document = this.documents.get(id);
    return document === undefined ? undefined : (JSON.parse(document) as SessionLifecycleRecord);
  }

  async write(record: SessionLifecycleRecord, event: SessionLifecycleEvent): Promise<void> {
    this.documents.set(record.config.id, JSON.stringify(record));
    this.events.push(event);
  }

  current(id = ID): SessionLifecycleRecord {
    const document = this.documents.get(id);
    if (document === undefined) throw new Error(`no record for ${id}`);
    return JSON.parse(document) as SessionLifecycleRecord;
  }
}

class RecordingLauncher implements SessionLifecycleLauncher {
  readonly calls: string[] = [];
  live = false;
  launchErrors: unknown[] = [];
  deliverError?: unknown;
  stopError?: unknown;
  /** Set when a launch must make the pane appear, as a real tmux launch does. */
  livenessFromLaunch = false;
  /** Set when a *failing* launch still leaves a pane behind — the case retrying must not fight. */
  liveAfterFailure = false;

  async alive(): Promise<boolean> {
    this.calls.push('alive');
    return this.live;
  }

  async launch(): Promise<void> {
    this.calls.push('launch');
    const failure = this.launchErrors.shift();
    if (failure) {
      if (this.liveAfterFailure) this.live = true;
      throw failure;
    }
    if (this.livenessFromLaunch) this.live = true;
  }

  async deliver(_record: SessionLifecycleRecord, instruction: string): Promise<void> {
    this.calls.push(`deliver:${instruction}`);
    if (this.deliverError) throw this.deliverError;
  }

  async stop(): Promise<void> {
    this.calls.push('stop');
    if (this.stopError) throw this.stopError;
  }

  launches(): number {
    return this.calls.filter(call => call === 'launch').length;
  }
}

class RecordingTaskStore implements SessionTaskStore {
  readonly documents = new Map<string, string>();
  failure?: unknown;

  async writeAssignedTask(id: SessionId, document: string): Promise<string> {
    if (this.failure) throw this.failure;
    this.documents.set(id, document);
    return `/state/sessions/${id}/turns/turn-001.md`;
  }
}

const CAPABILITY = 'a-very-secret-session-capability';
const HASH = 'f'.repeat(64);

class FixedCredentialIssuer implements SessionCredentialIssuer {
  issue(): SessionCredential {
    return { capability: CAPABILITY, hash: HASH };
  }
}

class RecordingEnvironmentStore implements SessionEnvironmentStore {
  readonly written = new Map<string, Readonly<Record<string, string>>>();

  async write(id: SessionId, environment: Readonly<Record<string, string>>): Promise<void> {
    this.written.set(id, environment);
  }

  async read(id: SessionId): Promise<Readonly<Record<string, string>>> {
    return this.written.get(id) ?? {};
  }
}

class FakeDirectoryResolver implements WorkingDirectoryResolver {
  readonly requested: string[] = [];
  failure?: unknown;
  constructor(private readonly canonical = '/canonical/project') {}

  async resolve(cwd: string): Promise<string> {
    this.requested.push(cwd);
    if (this.failure) throw this.failure;
    return this.canonical;
  }
}

class FixedIdFactory implements SessionIdFactory {
  constructor(private readonly ids: string[] = [ID]) {}
  next(): SessionId {
    return parseSessionId(this.ids.shift() ?? ID);
  }
}

class SequenceClock implements ClockPort {
  private index = 0;
  now(): string {
    this.index += 1;
    return `2026-07-31T10:${String(this.index).padStart(2, '0')}:00.000Z`;
  }
}

/** Serializes per key exactly as the production executor does, and records the interleaving. */
class QueueingSerialExecutor implements SerialExecutor {
  readonly keys: string[] = [];
  private readonly tails = new Map<string, Promise<unknown>>();
  private depth = 0;
  maxDepth = 0;

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    this.keys.push(key);
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous
      .catch(() => undefined)
      .then(async () => {
        this.depth += 1;
        this.maxDepth = Math.max(this.maxDepth, this.depth);
        try {
          return await work();
        } finally {
          this.depth -= 1;
        }
      });
    this.tails.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return await result;
  }

  async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    return await work();
  }
}

interface Harness {
  readonly repository: MemoryRepository;
  readonly launcher: RecordingLauncher;
  readonly tasks: RecordingTaskStore;
  readonly directories: FakeDirectoryResolver;
  readonly serial: QueueingSerialExecutor;
  readonly subject: SessionLifecycleService;
}

function harness(
  overrides: Partial<SessionLifecyclePorts> = {},
  settings?: Partial<SessionLifecycleSettings>,
): Harness {
  const repository = new MemoryRepository();
  const launcher = new RecordingLauncher();
  const tasks = new RecordingTaskStore();
  const directories = new FakeDirectoryResolver();
  const serial = new QueueingSerialExecutor();
  const ports: SessionLifecyclePorts = {
    repository,
    launcher,
    tasks,
    directories,
    ids: new FixedIdFactory(),
    clock: new SequenceClock(),
    serial,
    ...overrides,
  };
  return {
    repository,
    launcher,
    tasks,
    directories,
    serial,
    subject: new SessionLifecycleService(ports, { ...defaultSessionLifecycleSettings, ...settings }),
  };
}

function input(overrides: Record<string, unknown> = {}): CreateSessionLifecycleRequest {
  return {
    agent: AGENT,
    cwd: '/workspace/project',
    mode: 'auto',
    prompt: 'Build it',
    ...overrides,
  } as CreateSessionLifecycleRequest;
}

describe('SessionLifecycleService', () => {
  it('should persist a created session under a server-minted id and canonical directory', async () => {
    // Arrange
    const { repository, directories, serial, subject } = harness();

    // Act
    const actual = await subject.create(input());

    // Assert
    should(actual.config).containDeep({ id: ID, cwd: '/canonical/project', tmuxSession: `fy-${ID}` });
    should(actual.state.status).equal('created');
    should(directories.requested).deepEqual(['/workspace/project']);
    should(repository.current()).deepEqual(actual);
    should(serial.keys).deepEqual([ID]);
    should(repository.events).deepEqual([
      { type: 'session.created', data: { agent: AGENT, mode: 'auto', cwd: '/canonical/project' } },
    ]);
  });

  it('should mint a session credential, record only its hash, and deliver the plaintext through the environment', async () => {
    // Arrange
    const environment = new RecordingEnvironmentStore();
    const { repository, subject } = harness({ credentials: new FixedCredentialIssuer(), environment });

    // Act
    const actual = await subject.create(input());

    // Assert
    should(actual.config.sessionCapabilityHash).equal(HASH);
    should(repository.current().config.sessionCapabilityHash).equal(HASH);
    // The record is what every reader of the session document gets, so the SECRET must not be
    // anywhere in it — only the hash the task-board domain keys its grants on.
    should(JSON.stringify(repository.current())).not.containEql(CAPABILITY);
    should(environment.written.get(ID)).deepEqual({ FY_SESSION_BOARD_CAPABILITY: CAPABILITY });
  });

  it('should leave the session and its environment untouched when no credential issuer is wired', async () => {
    // Arrange
    const environment = new RecordingEnvironmentStore();
    const { repository, subject } = harness({ environment });

    // Act
    await subject.create(input());

    // Assert
    should(repository.current().config.sessionCapabilityHash).be.undefined();
    should([...environment.written.keys()]).deepEqual([]);
  });

  it('should not write an environment for a create that never produced a record', async () => {
    // Arrange
    const environment = new RecordingEnvironmentStore();
    const { launcher, subject } = harness({ credentials: new FixedCredentialIssuer(), environment });
    launcher.live = true;

    // Act
    await should(subject.create(input())).be.rejectedWith(/already live/u);

    // Assert
    // A secret on disk for a session that does not exist is a credential nothing can ever revoke.
    should([...environment.written.keys()]).deepEqual([]);
  });

  it('should refuse to create over an existing record or a live terminal of the same name', async () => {
    // Arrange
    const existing = harness();
    await existing.subject.create(input());
    const live = harness();
    live.launcher.live = true;

    // Act + Assert
    await should(existing.subject.create(input())).be.rejectedWith(`session already exists: ${ID}`);
    await should(live.subject.create(input())).be.rejectedWith(`tmux session fy-${ID} is already live`);
    should(existing.repository.current().state.status).equal('created');
    should(live.repository.documents.size).equal(0);
  });

  it('should not persist anything when the requested directory cannot be resolved', async () => {
    // Arrange
    const { repository, directories, subject } = harness();
    directories.failure = new Error('session working directory is not a directory: /gone');

    // Act + Assert
    await should(subject.create(input({ cwd: '/gone' }))).be.rejectedWith(/is not a directory/u);
    should(repository.documents.size).equal(0);
  });

  it('should deliver the assigned task to the terminal before reporting a session as running', async () => {
    // Arrange
    const { repository, launcher, tasks, subject } = harness();
    launcher.livenessFromLaunch = true;

    // Act
    const actual = await subject.createAndStart(input());

    // Assert
    should(actual.state.status).equal('running');
    should(launcher.calls).deepEqual([
      'alive',
      'alive',
      'launch',
      `deliver:Read the file /state/sessions/${ID}/turns/turn-001.md now, then carefully follow every instruction inside it. This is your complete task for this turn.`,
    ]);
    should(tasks.documents.get(ID)).equal('# Assigned task\n\nBuild it\n');
    should(repository.events.map(entry => entry.type)).deepEqual([
      'session.created',
      'session.starting',
      'session.running',
    ]);
  });

  it('should never type into a bare interactive terminal', async () => {
    // Arrange
    const { launcher, tasks, subject } = harness();

    // Act
    const actual = await subject.createAndStart(input({ mode: 'interactive', prompt: undefined }));

    // Assert
    should(actual.state.status).equal('running');
    should(launcher.calls.filter(call => call.startsWith('deliver'))).deepEqual([]);
    should(tasks.documents.size).equal(0);
  });

  it('should fail the launch, not report a running agent, when the task cannot be delivered', async () => {
    // Arrange
    const { repository, launcher, subject } = harness();
    launcher.deliverError = new Error('pane did not become ready');

    // Act + Assert
    await should(subject.createAndStart(input())).be.rejectedWith('pane did not become ready');
    should(repository.current().state).containDeep({ status: 'failed', reason: 'pane did not become ready' });
    should(repository.events.map(entry => entry.type)).deepEqual([
      'session.created',
      'session.starting',
      'session.failed',
    ]);
  });

  it('should fail the launch when the assigned task cannot be persisted for the agent', async () => {
    // Arrange
    const { repository, launcher, tasks, subject } = harness();
    tasks.failure = new Error('EACCES: turns directory is not writable');

    // Act + Assert
    await should(subject.createAndStart(input())).be.rejectedWith(/EACCES/u);
    should(repository.current().state.status).equal('failed');
    should(launcher.calls.filter(call => call.startsWith('deliver'))).deepEqual([]);
  });

  it('should retry a transient launch failure within its budget', async () => {
    // Arrange
    const { repository, launcher, subject } = harness();
    launcher.launchErrors = [new Error('tmux server was starting')];

    // Act
    const actual = await subject.createAndStart(input());

    // Assert
    should(actual.state.status).equal('running');
    should(launcher.launches()).equal(2);
    should(repository.events.map(entry => entry.type)).deepEqual([
      'session.created',
      'session.starting',
      'session.running',
    ]);
  });

  it('should record a failure once the launch budget is spent', async () => {
    // Arrange
    const { repository, launcher, subject } = harness({}, { launchAttempts: 2 });
    launcher.launchErrors = [new Error('first'), new Error('second'), new Error('third')];

    // Act + Assert
    await should(subject.createAndStart(input())).be.rejectedWith('second');
    should(launcher.launches()).equal(2);
    should(repository.current().state).containDeep({ status: 'failed', reason: 'second' });
  });

  it('should stop retrying when a pane appears under the session name', async () => {
    // Arrange
    const { repository, launcher, subject } = harness();
    await subject.create(input());
    launcher.launchErrors = [new Error('tmux session already exists: fy-session')];
    launcher.liveAfterFailure = true;

    // Act + Assert
    await should(subject.start(ID)).be.rejectedWith(/already exists/u);
    should(launcher.launches()).equal(1);
    should(repository.current().state.status).equal('failed');
  });

  it('should let a failed launch be started again', async () => {
    // Arrange
    const { repository, launcher, subject } = harness();
    launcher.launchErrors = [new Error('tmux exploded'), new Error('tmux exploded'), new Error('tmux exploded')];
    await should(subject.createAndStart(input())).be.rejected();

    // Act
    const actual = await subject.start(ID);

    // Assert
    should(actual.state.status).equal('running');
    should(repository.events.map(entry => entry.type)).deepEqual([
      'session.created',
      'session.starting',
      'session.failed',
      'session.starting',
      'session.running',
    ]);
  });

  it('should launch exactly one terminal when two starts race', async () => {
    // Arrange
    const { repository, launcher, serial, subject } = harness();
    launcher.livenessFromLaunch = true;
    await subject.create(input());

    // Act
    const [first, second] = await Promise.all([subject.start(ID), subject.start(ID)]);

    // Assert
    should(launcher.launches()).equal(1);
    should(first.state.status).equal('running');
    should(second.state.status).equal('running');
    should(serial.maxDepth).equal(1);
    should(repository.events.map(entry => entry.type)).deepEqual([
      'session.created',
      'session.starting',
      'session.running',
    ]);
  });

  it('should adopt the pane a crash left behind instead of opening a second one', async () => {
    // Arrange
    const { launcher, subject } = harness();
    await subject.create(input());
    launcher.deliverError = new Error('lost the daemon mid-launch');
    await should(subject.start(ID)).be.rejected();
    // The record is `failed` with a live pane, exactly as a crashed launch leaves it.
    launcher.deliverError = undefined;
    launcher.live = true;

    // Act
    const actual = await subject.start(ID);

    // Assert
    should(actual.state.status).equal('running');
    should(launcher.launches()).equal(1);
  });

  it('should relaunch a starting record whose pane is gone rather than wedging it', async () => {
    // Arrange
    const { repository, launcher, subject } = harness();
    await subject.create(input());
    launcher.deliverError = new Error('daemon died before the prompt landed');
    await should(subject.start(ID)).be.rejected();
    const interrupted = repository.current();
    await repository.write(
      { ...interrupted, state: { ...interrupted.state, status: 'starting' } },
      {
        type: 'session.starting',
        data: {},
      },
    );
    launcher.deliverError = undefined;

    // Act
    const actual = await subject.start(ID);

    // Assert
    should(actual.state.status).equal('running');
    should(launcher.launches()).equal(2);
    should(repository.current().state.status).equal('running');
  });

  it('should treat starting an already running session as a no-op, and refuse one whose pane vanished', async () => {
    // Arrange
    const live = harness();
    live.launcher.livenessFromLaunch = true;
    const running = await live.subject.createAndStart(input());
    const vanished = harness();
    await vanished.subject.createAndStart(input());

    // Act
    const restarted = await live.subject.start(ID);

    // Assert
    should(restarted).deepEqual(running);
    should(live.launcher.launches()).equal(1);
    await should(vanished.subject.start(ID)).be.rejectedWith(
      `session ${ID} is running but its terminal is gone; stop it before starting it again`,
    );
  });

  it('should stop a live session once and leave an already stopped session untouched', async () => {
    // Arrange
    const { repository, launcher, subject } = harness();
    launcher.livenessFromLaunch = true;
    await subject.createAndStart(input());

    // Act
    const stopped = await subject.stop(ID, 'work complete');
    const repeated = await subject.stop(ID);

    // Assert
    should(stopped.state).containDeep({ status: 'stopped', reason: 'work complete' });
    should(repeated).deepEqual(stopped);
    should(launcher.calls.filter(call => call === 'stop')).deepEqual(['stop']);
    should(repository.events.at(-1)).deepEqual({ type: 'session.stopped', data: { reason: 'work complete' } });
  });

  it('should use the configured default reason when a client gives none', async () => {
    // Arrange
    const { repository, subject } = harness({}, { defaultStopReason: 'stopped by the operator' });
    await subject.create(input());

    // Act
    await subject.stop(ID);

    // Assert
    should(repository.current().state.reason).equal('stopped by the operator');
  });

  it('should record a pane that refused to die as evidence instead of leaving it invisible', async () => {
    // Arrange
    const { repository, launcher, subject } = harness();
    launcher.livenessFromLaunch = true;
    await subject.createAndStart(input());
    launcher.stopError = new Error('tmux: no server running');

    // Act + Assert
    await should(subject.stop(ID, 'timeout')).be.rejectedWith('tmux: no server running');
    should(repository.current().state).containDeep({
      status: 'kill_failed',
      reason: 'timeout: tmux: no server running',
    });
    should(repository.events.at(-1)).deepEqual({
      type: 'session.kill_failed',
      data: { reason: 'timeout: tmux: no server running' },
    });

    // A later kill that works resolves the record rather than stranding it.
    launcher.stopError = undefined;
    should((await subject.stop(ID, 'killed on retry')).state.status).equal('stopped');
  });

  it('should stringify a thrown non-error so the durable reason is never empty', async () => {
    // Arrange
    const { repository, launcher, subject } = harness();
    launcher.livenessFromLaunch = true;
    await subject.createAndStart(input());
    launcher.stopError = 'tmux did not stop';

    // Act
    let failure: unknown;
    try {
      await subject.stop(ID);
    } catch (error) {
      failure = error;
    }

    // Assert
    should(failure).equal('tmux did not stop');
    should(repository.current().state.reason).equal('stopped by client: tmux did not stop');
  });

  it('should reject malformed and unknown session identifiers before terminal work', async () => {
    // Arrange
    const { launcher, subject } = harness();

    // Act + Assert
    await should(subject.start('../escape')).be.rejectedWith(/path-safe/u);
    await should(subject.stop('missing')).be.rejectedWith('session not found: missing');
    should(launcher.calls).deepEqual([]);
  });
});
