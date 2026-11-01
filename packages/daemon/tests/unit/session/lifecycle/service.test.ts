import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { type SessionLaunchInstructions, SessionStatusSchema } from '@ferretry/protocol';
import should from 'should';
import { CredentialAgentIdentities } from '../../../../src/lib/agent-tools/policy.ts';
import { isTerminalStatus, WARDEN_TERMINAL_STATUSES } from '../../../../src/lib/warden/types.ts';
import { type ClockPort, parseSessionId, type SerialExecutor, type SessionId } from '../../../../src/lib/index.ts';
import type {
  SessionEffectAdmission,
  SessionEffectKey,
  SessionEffectLedger,
  SessionEffectStanding,
} from '../../../../src/lib/session/effects/index.ts';
import {
  type CreateSessionLifecycleRequest,
  defaultSessionLifecycleSettings,
  lifecyclePhase,
  type SessionCapabilityHashStore,
  type SessionCredential,
  type SessionCredentialIssuer,
  SessionCredentialRotation,
  type SessionEnvironmentStore,
  type SessionIdFactory,
  type SessionLifecycleEvent,
  type SessionLifecycleLauncher,
  type SessionLifecyclePorts,
  type SessionLifecycleRecord,
  type SessionLifecycleRepository,
  SessionLifecycleService,
  type SessionLifecycleSettings,
  SessionStopPending,
  type SessionTaskStore,
  type WorkingDirectoryResolver,
} from '../../../../src/lib/session/lifecycle/index.ts';

const AGENT = '/opt/fleet/bin/claude-auto-loge';
const LAUNCHED: SessionLaunchInstructions = {
  sections: [
    { id: 'tools', chars: 600 },
    { id: 'settings', chars: 450 },
    { id: 'pack', chars: 900 },
  ],
  mode: 'auto',
  questions: false,
};
const ID = 'ms8-abcd1234';
const FIRST_TURN_INSTRUCTION =
  `Read the file /state/sessions/${ID}/turns/turn-001.md now, then carefully follow every instruction ` +
  'inside it. This is your complete task for this turn.';

/** Round-trips through JSON the way the real store does, so no test can rely on object identity. */
class MemoryRepository implements SessionLifecycleRepository {
  readonly documents = new Map<string, string>();
  readonly events: SessionLifecycleEvent[] = [];
  readonly reservations: SessionId[] = [];
  reserveFailure?: unknown;
  writeFailure?: unknown;
  exposeDocumentBeforeFailure = false;

  async reserve(id: SessionId): Promise<void> {
    this.reservations.push(id);
    if (this.reserveFailure !== undefined) throw this.reserveFailure;
  }

  async read(id: SessionId): Promise<SessionLifecycleRecord | undefined> {
    const document = this.documents.get(id);
    return document === undefined ? undefined : (JSON.parse(document) as SessionLifecycleRecord);
  }

  async write(record: SessionLifecycleRecord, event: SessionLifecycleEvent): Promise<void> {
    if (this.writeFailure !== undefined && !this.exposeDocumentBeforeFailure) throw this.writeFailure;
    this.documents.set(record.config.id, JSON.stringify(record));
    if (this.writeFailure !== undefined) throw this.writeFailure;
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
  readyError?: unknown;
  deliverError?: unknown;
  stopError?: unknown;
  snapshotError?: unknown;
  /** Set when `deliver` must return without ever running the pre-write admission callback. */
  skipBeforeWrite = false;
  /** Set when a launch must make the pane appear, as a real tmux launch does. */
  livenessFromLaunch = false;
  /** Set when a *failing* launch still leaves a pane behind — the case retrying must not fight. */
  liveAfterFailure = false;

  constructor(private readonly order: string[] = []) {}

  private record(call: string): void {
    this.calls.push(call);
    this.order.push(call);
  }

  async alive(): Promise<boolean> {
    this.record('alive');
    return this.live;
  }

  /** What a successful launch says its pane was told; `undefined` is a launcher that cannot say. */
  launched: SessionLaunchInstructions | undefined;

  async launch(): Promise<SessionLaunchInstructions | undefined> {
    this.record('launch');
    const failure = this.launchErrors.shift();
    if (failure) {
      if (this.liveAfterFailure) this.live = true;
      throw failure;
    }
    if (this.livenessFromLaunch) this.live = true;
    return this.launched;
  }

  async ready(_record: SessionLifecycleRecord): Promise<void> {
    this.record('ready');
    if (this.readyError) throw this.readyError;
  }

  async deliver(
    _record: SessionLifecycleRecord,
    instruction: string,
    beforeWrite?: () => Promise<void>,
  ): Promise<void> {
    if (beforeWrite !== undefined && !this.skipBeforeWrite) {
      this.order.push('beforeWrite');
      await beforeWrite();
    }
    this.record(`deliver:${instruction}`);
    if (this.deliverError) throw this.deliverError;
  }

  async snapshot(): Promise<void> {
    this.record('snapshot');
    if (this.snapshotError) throw this.snapshotError;
  }

  async stop(): Promise<void> {
    this.record('stop');
    if (this.stopError) throw this.stopError;
  }

  launches(): number {
    return this.calls.filter(call => call === 'launch').length;
  }
}

/** A stateful durable-effect fake: the state survives every retry through one harness. */
class RecordingEffectLedger implements SessionEffectLedger {
  readonly calls: string[] = [];
  standing: SessionEffectStanding = 'unclaimed';
  scriptedBegin?: SessionEffectAdmission;
  beginErrorAfterRecord?: unknown;
  settleError?: unknown;
  private fingerprint?: string;

  constructor(private readonly order: string[] = []) {}

  private record(call: string): void {
    this.calls.push(call);
    this.order.push(call);
  }

  private standingFor(fingerprint: string): SessionEffectStanding {
    return this.fingerprint !== undefined && this.fingerprint !== fingerprint ? 'conflict' : this.standing;
  }

  async inspect(key: SessionEffectKey, fingerprint: string): Promise<SessionEffectStanding> {
    this.record(`effect:inspect:${key.effectId}`);
    return this.standingFor(fingerprint);
  }

  async begin(key: SessionEffectKey, fingerprint: string, _at: string): Promise<SessionEffectAdmission> {
    this.record(`effect:begin:${key.effectId}`);
    if (this.scriptedBegin !== undefined) {
      const admission = this.scriptedBegin;
      if (admission === 'perform' || admission === 'unsettled') {
        this.fingerprint = fingerprint;
        this.standing = 'unsettled';
      } else if (admission === 'settled') {
        this.fingerprint = fingerprint;
        this.standing = 'settled';
      }
      return admission;
    }
    const standing = this.standingFor(fingerprint);
    if (standing !== 'unclaimed') return standing;
    this.fingerprint = fingerprint;
    this.standing = 'unsettled';
    if (this.beginErrorAfterRecord !== undefined) throw this.beginErrorAfterRecord;
    return 'perform';
  }

  async settle(key: SessionEffectKey, fingerprint: string, _at: string): Promise<void> {
    this.record(`effect:settle:${key.effectId}`);
    if (this.settleError !== undefined) throw this.settleError;
    if (this.standingFor(fingerprint) !== 'unsettled')
      throw new Error(`effect ${key.effectId} cannot settle from ${this.standingFor(fingerprint)}`);
    this.standing = 'settled';
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
const credential = (capability: string): SessionCredential => ({
  capability,
  hash: createHash('sha256').update(capability, 'utf8').digest('hex'),
});
const HASH = credential(CAPABILITY).hash;

class FixedCredentialIssuer implements SessionCredentialIssuer {
  issues = 0;

  issue(): SessionCredential {
    this.issues += 1;
    return credential(CAPABILITY);
  }
}

class SequenceCredentialIssuer implements SessionCredentialIssuer {
  issues = 0;

  constructor(private readonly credentials: readonly SessionCredential[]) {}

  issue(): SessionCredential {
    const credential = this.credentials[this.issues];
    if (credential === undefined) throw new Error('credential sequence exhausted');
    this.issues += 1;
    return credential;
  }
}

class RecordingEnvironmentStore implements SessionEnvironmentStore {
  readonly written = new Map<string, Readonly<Record<string, string>>>();
  writeFailure?: unknown;

  async write(id: SessionId, environment: Readonly<Record<string, string>>): Promise<void> {
    if (this.writeFailure !== undefined) throw this.writeFailure;
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
  readonly effects: RecordingEffectLedger;
  readonly directories: FakeDirectoryResolver;
  readonly serial: QueueingSerialExecutor;
  readonly order: string[];
  readonly subject: SessionLifecycleService;
}

function harness(
  overrides: Partial<SessionLifecyclePorts> = {},
  settings?: Partial<SessionLifecycleSettings>,
): Harness {
  const order: string[] = [];
  const repository = new MemoryRepository();
  const launcher = new RecordingLauncher(order);
  const tasks = new RecordingTaskStore();
  const effects = new RecordingEffectLedger(order);
  const directories = new FakeDirectoryResolver();
  const serial = new QueueingSerialExecutor();
  const ports: SessionLifecyclePorts = {
    repository,
    launcher,
    tasks,
    effects,
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
    effects,
    directories,
    serial,
    order,
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
    should(repository.reservations).deepEqual([ID]);
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
    should(environment.written.get(ID)).deepEqual({ FY_SESSION_BOARD_CAPABILITY: CAPABILITY, FY_SESSION_MODE: 'auto' });
  });

  it('should publish no credential hash when the durable environment write fails, and allow a clean retry', async () => {
    // Arrange
    const environment = new RecordingEnvironmentStore();
    environment.writeFailure = new Error('environment rename failed');
    const credentials = new SequenceCredentialIssuer([credential('discarded-capability'), credential(CAPABILITY)]);
    const { repository, subject } = harness({ credentials, environment });

    // Act + Assert — the plaintext never became durable, so neither may its hash.
    await should(subject.create(input())).be.rejectedWith('environment rename failed');
    should(repository.documents.size).equal(0);
    should(repository.events).deepEqual([]);
    should([...environment.written.keys()]).deepEqual([]);

    // The failed attempt left no record for a retry to mistake for a completed create.
    environment.writeFailure = undefined;
    const retried = await subject.create(input());
    should(retried.config.sessionCapabilityHash).equal(HASH);
    should(credentials.issues).equal(2);
    should(repository.reservations).deepEqual([ID, ID]);
    should(environment.written.get(ID)).deepEqual({ FY_SESSION_BOARD_CAPABILITY: CAPABILITY, FY_SESSION_MODE: 'auto' });
  });

  it('should overwrite a staged plaintext with a fresh matching credential when record publication fails', async () => {
    // Arrange — the reservation and first plaintext land, but the repository fails before exposing
    // any lifecycle document. This is the durable prefix a daemon crash leaves for a retry.
    const environment = new RecordingEnvironmentStore();
    const credentials = new SequenceCredentialIssuer([credential('first-capability'), credential(CAPABILITY)]);
    const { repository, subject } = harness({ credentials, environment });
    repository.writeFailure = new Error('config write failed');

    // Act + Assert
    await should(subject.create(input())).be.rejectedWith('config write failed');
    should(repository.documents.size).equal(0);
    should(environment.written.get(ID)).deepEqual({
      FY_SESSION_BOARD_CAPABILITY: 'first-capability',
      FY_SESSION_MODE: 'auto',
    });

    repository.writeFailure = undefined;
    const retried = await subject.create(input());
    should(retried.config.sessionCapabilityHash).equal(HASH);
    should(repository.current().config.sessionCapabilityHash).equal(HASH);
    should(environment.written.get(ID)).deepEqual({ FY_SESSION_BOARD_CAPABILITY: CAPABILITY, FY_SESSION_MODE: 'auto' });
    should(credentials.issues).equal(2);
    should(repository.reservations).deepEqual([ID, ID]);
  });

  it('should durably store the matching plaintext before a torn repository write exposes its hash', async () => {
    // Arrange — model a repository that makes config.json visible and then fails before completing
    // the state/journal tail of its create write.
    const environment = new RecordingEnvironmentStore();
    const credentials = new FixedCredentialIssuer();
    const { repository, subject } = harness({ credentials, environment });
    repository.exposeDocumentBeforeFailure = true;
    repository.writeFailure = new Error('state write failed');

    // Act
    await should(subject.create(input())).be.rejectedWith('state write failed');

    // Assert — any reader that can already see the hash can also read its exact plaintext. A retry
    // refuses the existing record without minting or overwriting that credential.
    should(repository.current().config.sessionCapabilityHash).equal(HASH);
    should(environment.written.get(ID)).deepEqual({ FY_SESSION_BOARD_CAPABILITY: CAPABILITY, FY_SESSION_MODE: 'auto' });
    await should(subject.create(input())).be.rejectedWith(`session already exists: ${ID}`);
    should(credentials.issues).equal(1);
    should(environment.written.get(ID)).deepEqual({ FY_SESSION_BOARD_CAPABILITY: CAPABILITY, FY_SESSION_MODE: 'auto' });
  });

  it('should refuse credential issuance when no durable environment store is wired', async () => {
    // Arrange
    const credentials = new FixedCredentialIssuer();
    const { repository, subject } = harness({ credentials });

    // Act + Assert
    await should(subject.create(input())).be.rejectedWith(/requires a durable environment store/u);
    should(credentials.issues).equal(0);
    should(repository.documents.size).equal(0);
  });

  it('should refuse a caller-supplied hash that has no lifecycle-issued plaintext', async () => {
    // Arrange
    const { repository, subject } = harness();

    // Act + Assert
    await should(subject.create(input({ sessionCapabilityHash: HASH }))).be.rejectedWith(
      /requires a lifecycle-issued credential/u,
    );
    should(repository.reservations).deepEqual([]);
    should(repository.documents.size).equal(0);
  });

  it('should publish neither environment nor record when reserving the session layout fails', async () => {
    // Arrange
    const environment = new RecordingEnvironmentStore();
    const { repository, subject } = harness({ credentials: new FixedCredentialIssuer(), environment });
    repository.reserveFailure = new Error('session marker write failed');

    // Act + Assert
    await should(subject.create(input())).be.rejectedWith('session marker write failed');
    should(repository.documents.size).equal(0);
    should(repository.events).deepEqual([]);
    should([...environment.written.keys()]).deepEqual([]);
  });

  it('should record only the session mode in the environment when no credential issuer is wired', async () => {
    // Arrange
    const environment = new RecordingEnvironmentStore();
    const { repository, subject } = harness({ environment });

    // Act
    await subject.create(input());

    // Assert
    should(repository.current().config.sessionCapabilityHash).be.undefined();
    should(environment.written.get(ID)).deepEqual({ FY_SESSION_MODE: 'auto' });
  });

  it('should record an interactive session as interactive so its wrapper keeps the question tool', async () => {
    // Arrange
    const environment = new RecordingEnvironmentStore();
    const { subject } = harness({ environment });

    // Act
    await subject.create(input({ mode: 'interactive' }));

    // Assert
    should(environment.written.get(ID)).deepEqual({ FY_SESSION_MODE: 'interactive' });
  });

  it('should not write an environment for a create refused by a live terminal collision', async () => {
    // Arrange
    const environment = new RecordingEnvironmentStore();
    const { launcher, subject } = harness({ credentials: new FixedCredentialIssuer(), environment });
    launcher.live = true;

    // Act
    await should(subject.create(input())).be.rejectedWith(/already live/u);

    // Assert
    // A colliding terminal is rejected before either durable half of credentialled creation.
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

  it('should make no explicit ready call when there is no before-first-turn callback', async () => {
    // Arrange
    const { repository, launcher, tasks, subject } = harness();
    launcher.livenessFromLaunch = true;

    // Act
    const actual = await subject.createAndStart(input());

    // Assert
    should(actual.state.status).equal('running');
    should(launcher.calls).deepEqual(['alive', 'alive', 'launch', `deliver:${FIRST_TURN_INSTRUCTION}`]);
    should(tasks.documents.get(ID)).equal('# Assigned task\n\nBuild it\n');
    should(repository.events.map(entry => entry.type)).deepEqual([
      'session.created',
      'session.starting',
      'session.running',
    ]);
  });

  it('should launch, wait for readiness, run startup work and admit the write in that order', async () => {
    // Arrange
    const { launcher, order, subject } = harness();
    launcher.livenessFromLaunch = true;

    // Act
    const actual = await subject.createAndStart(input(), async record => {
      launcher.calls.push(`configure:${record.config.tmuxSession}`);
      order.push('beforeFirstTurn');
    });

    // Assert
    should(actual.state.status).equal('running');
    should(launcher.calls).deepEqual([
      'alive',
      'alive',
      'launch',
      'ready',
      `configure:fy-${ID}`,
      `deliver:${FIRST_TURN_INSTRUCTION}`,
    ]);
    should(order.slice(order.indexOf('launch'))).deepEqual([
      'launch',
      'ready',
      'beforeFirstTurn',
      'beforeWrite',
      'effect:begin:turn-1',
      `deliver:${FIRST_TURN_INSTRUCTION}`,
      'effect:settle:turn-1',
    ]);
  });

  it('should record readiness failure and deliver nothing', async () => {
    // Arrange
    const { effects, launcher, repository, tasks, subject } = harness();
    launcher.livenessFromLaunch = true;
    launcher.readyError = new Error('the harness exited before its prompt became ready');

    // Act + Assert
    await should(subject.createAndStart(input(), async () => undefined)).be.rejectedWith(
      'the harness exited before its prompt became ready',
    );
    should(repository.current().state).containDeep({
      status: 'failed',
      reason: 'the harness exited before its prompt became ready',
    });
    should(launcher.calls).containEql('ready');
    should(launcher.calls.filter(call => call.startsWith('deliver:'))).deepEqual([]);
    should(tasks.documents.size).equal(0);
    should(effects.standing).equal('unclaimed');
  });

  it('should record failed startup runtime setup without delivering turn one', async () => {
    // Arrange
    const { repository, launcher, tasks, subject } = harness();
    launcher.livenessFromLaunch = true;

    // Act + Assert
    await should(
      subject.createAndStart(input(), async () => {
        throw new Error('effort is unavailable');
      }),
    ).be.rejectedWith('effort is unavailable');
    should(repository.current().state).containDeep({ status: 'failed', reason: 'effort is unavailable' });
    should(launcher.calls.filter(call => call.startsWith('deliver'))).deepEqual([]);
    should(tasks.documents.size).equal(0);
  });

  it('should skip an already settled first turn and still finish the live session as running', async () => {
    // Arrange
    const { effects, launcher, order, repository, tasks, subject } = harness();
    await subject.create(input());
    launcher.live = true;
    effects.standing = 'settled';

    // Act
    const actual = await subject.start(ID, async () => {
      order.push('beforeFirstTurn');
    });

    // Assert — the durable outcome, not a second callback or composer write, is resumed.
    should(actual.state.status).equal('running');
    should(launcher.launches()).equal(0);
    should(launcher.calls.filter(call => call === 'ready' || call.startsWith('deliver:'))).deepEqual([]);
    should(order).not.containEql('beforeFirstTurn');
    should(tasks.documents.size).equal(0);
    should(repository.events.map(entry => entry.type)).deepEqual([
      'session.created',
      'session.starting',
      'session.running',
    ]);
  });

  it('should treat a first turn settled between inspect and begin as a successful replay', async () => {
    // Arrange: inspection sees the default `unclaimed`; another attempt settles before this one wins
    // the compare-and-set at the launcher's exact pre-write callback.
    const { effects, launcher, repository, subject } = harness();
    launcher.livenessFromLaunch = true;
    effects.scriptedBegin = 'settled';

    // Act
    const actual = await subject.createAndStart(input());

    // Assert — `settled` aborts before the fake records any composer write, but it is a completed
    // first turn rather than a launch failure.
    should(actual.state.status).equal('running');
    should(effects.calls).deepEqual(['effect:inspect:turn-1', 'effect:begin:turn-1']);
    should(launcher.calls.filter(call => call.startsWith('deliver:'))).deepEqual([]);
    should(repository.events.map(entry => entry.type)).deepEqual([
      'session.created',
      'session.starting',
      'session.running',
    ]);
    should(repository.current().state.reason).be.undefined();
  });

  it('should fail an unsettled first turn without launching or delivering it again', async () => {
    // Arrange
    const { effects, launcher, repository, tasks, subject } = harness();
    await subject.create(input());
    effects.standing = 'unsettled';

    // Act + Assert
    await should(subject.start(ID)).be.rejectedWith(/began but never settled/u);
    should(repository.current().state).containDeep({ status: 'failed' });
    should(launcher.launches()).equal(0);
    should(launcher.calls.filter(call => call.startsWith('deliver:'))).deepEqual([]);
    should(tasks.documents.size).equal(0);
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
    launcher.deliverError = new Error('the pane write failed');

    // Act + Assert
    await should(subject.createAndStart(input())).be.rejectedWith('the pane write failed');
    should(repository.current().state).containDeep({ status: 'failed', reason: 'the pane write failed' });
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

  it('should record what the launched pane was told on the running record', async () => {
    // Arrange
    const { repository, launcher, subject } = harness();
    launcher.livenessFromLaunch = true;
    launcher.launched = LAUNCHED;

    // Act
    const actual = await subject.createAndStart(input());

    // Assert
    should(actual.state.status).equal('running');
    should(actual.state.launchInstructions).deepEqual(LAUNCHED);
    should(repository.current().state.launchInstructions).deepEqual(LAUNCHED);
  });

  it('should keep a launched pane’s instructions through a failure, and keep them when the next launcher cannot say', async () => {
    // Arrange
    const { repository, launcher, subject } = harness();
    launcher.launched = LAUNCHED;
    const failing = async (): Promise<void> => {
      throw new Error('runtime setup failed');
    };
    await should(subject.createAndStart(input({ mode: 'interactive', prompt: undefined }), failing)).be.rejected();
    const failed = repository.current().state;
    launcher.launched = undefined;

    // Act
    const actual = await subject.start(ID);

    // Assert
    should(failed.status).equal('failed');
    should(failed.launchInstructions).deepEqual(LAUNCHED);
    should(actual.state.status).equal('running');
    should(actual.state.launchInstructions).deepEqual(LAUNCHED);
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

  it('should not replay when the durable before-write callback records intent and loses its response', async () => {
    // Arrange
    const { effects, launcher, repository, subject } = harness();
    launcher.livenessFromLaunch = true;
    effects.beginErrorAfterRecord = new Error('lost the effect admission response');

    // Act: the callback durably began the effect, then died before the launcher recorded a write.
    await should(subject.createAndStart(input())).be.rejectedWith('lost the effect admission response');
    should(effects.standing).equal('unsettled');
    should(launcher.calls.filter(call => call.startsWith('deliver:'))).deepEqual([]);
    should(repository.current().state.status).equal('failed');

    // A restart sees the durable middle state and refuses rather than guessing that no write began.
    effects.beginErrorAfterRecord = undefined;
    await should(subject.start(ID)).be.rejectedWith(/began but never settled/u);
    should(launcher.calls.filter(call => call.startsWith('deliver:'))).deepEqual([]);
    should(launcher.launches()).equal(1);
  });

  it('should not replay when delivery may have landed and its result was lost', async () => {
    // Arrange
    const { effects, launcher, repository, subject } = harness();
    launcher.livenessFromLaunch = true;
    launcher.deliverError = new Error('lost the pane delivery response');

    // Act: the fake records the composer write after `beforeWrite`, then loses its answer.
    await should(subject.createAndStart(input())).be.rejectedWith('lost the pane delivery response');
    should(effects.standing).equal('unsettled');
    should(launcher.calls.filter(call => call.startsWith('deliver:'))).have.length(1);
    should(repository.current().state.status).equal('failed');

    // Retrying the failed lifecycle may adopt the pane, but may never type the assignment twice.
    launcher.deliverError = undefined;
    await should(subject.start(ID)).be.rejectedWith(/began but never settled/u);
    should(launcher.calls.filter(call => call.startsWith('deliver:'))).have.length(1);
    should(launcher.launches()).equal(1);
  });

  it('should relaunch a starting record whose pane is gone rather than wedging it', async () => {
    // Arrange
    const { repository, launcher, tasks, subject } = harness();
    await subject.create(input());
    tasks.failure = new Error('daemon died before the task document landed');
    await should(subject.start(ID)).be.rejected();
    const interrupted = repository.current();
    await repository.write(
      { ...interrupted, state: { ...interrupted.state, status: 'starting' } },
      {
        type: 'session.starting',
        data: {},
      },
    );
    tasks.failure = undefined;

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
    should(launcher.calls.filter(call => call === 'snapshot' || call === 'stop')).deepEqual(['snapshot', 'stop']);
    should(repository.events.at(-1)).deepEqual({ type: 'session.stopped', data: { reason: 'work complete' } });
  });

  it('should stop a session in any status the protocol defines, ending the pane unless it already ended', async () => {
    for (const status of SessionStatusSchema.options) {
      // Arrange
      const { repository, launcher, subject } = harness();
      launcher.livenessFromLaunch = true;
      await subject.createAndStart(input());
      const running = repository.current();
      repository.documents.set(ID, JSON.stringify({ ...running, state: { ...running.state, status } }));
      const stopsBefore = launcher.calls.filter(call => call === 'stop').length;

      // Act
      const actual = await subject.stop(ID, 'owner pressed stop');

      // Assert
      const alreadyOver = status === 'stopped' || status === 'completed';
      should(actual.state.status).equal(alreadyOver ? status : 'stopped');
      should(launcher.calls.filter(call => call === 'stop').length - stopsBefore).equal(alreadyOver ? 0 : 1);
    }
  });

  it('should stop a session whose turn was interrupted, keeping the rest of its state', async () => {
    // Arrange
    const { repository, launcher, subject } = harness();
    launcher.livenessFromLaunch = true;
    await subject.createAndStart(input());
    const running = repository.current();
    repository.documents.set(
      ID,
      JSON.stringify({
        ...running,
        state: { ...running.state, status: 'interrupted', reason: 'interrupted by client' },
      }),
    );

    // Act
    const stopped = await subject.stop(ID, 'owner pressed stop');

    // Assert
    should(stopped.state).containDeep({ status: 'stopped', reason: 'owner pressed stop' });
    should(repository.events.at(-1)).deepEqual({ type: 'session.stopped', data: { reason: 'owner pressed stop' } });
  });

  it('should treat starting a session in any turn-level status as a no-op while its pane lives', async () => {
    const turnLevel = SessionStatusSchema.options.filter(
      option => lifecyclePhase(option) === 'running' && option !== 'running',
    );
    for (const status of turnLevel) {
      // Arrange
      const { repository, launcher, subject } = harness();
      launcher.livenessFromLaunch = true;
      await subject.createAndStart(input());
      const running = repository.current();
      const recorded = { ...running, state: { ...running.state, status } };
      repository.documents.set(ID, JSON.stringify(recorded));

      // Act
      const actual = await subject.start(ID);

      // Assert
      should(actual).deepEqual(recorded);
      should(launcher.launches()).equal(1);
    }
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

/** Records every claim and release. */
class RecordingLeases {
  readonly calls: string[] = [];
  claimError?: unknown;
  releaseError?: unknown;

  async claim(sessionId: string, command: readonly string[]): Promise<void> {
    this.calls.push(`claim:${sessionId}:${command.join(' ')}`);
    if (this.claimError !== undefined) throw this.claimError;
  }

  async release(sessionId: string): Promise<void> {
    this.calls.push(`release:${sessionId}`);
    if (this.releaseError !== undefined) throw this.releaseError;
  }
}

describe('SessionLifecycleService conversation leases', () => {
  function leased(): Harness & { readonly leases: RecordingLeases } {
    const leases = new RecordingLeases();
    return { ...harness({ leases }), leases };
  }

  it('should claim the conversation the launch argv names before the pane exists, and release it on stop', async () => {
    // Arrange
    const built = leased();
    const command = [AGENT, '--session-id', '0b7e4c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21'];
    built.launcher.livenessFromLaunch = true;
    await built.subject.create(input({ command }));

    // Act
    await built.subject.start(ID);
    await built.subject.stop(ID);

    // Assert
    should(built.leases.calls).deepEqual([`claim:${ID}:${command.join(' ')}`, `release:${ID}`]);
    should(built.launcher.launches()).equal(1);
  });

  it('should fail the start naming the holder, launch nothing, and release what it held', async () => {
    // Arrange
    const built = leased();
    built.leases.claimError = new Error('conversation c is being written by session s-2 on claude-review');
    await built.subject.create(input());

    // Act
    const starting = built.subject.start(ID);

    // Assert
    await should(starting).be.rejectedWith(/being written by session s-2/u);
    should(built.launcher.launches()).equal(0);
    should(built.repository.current().state).containDeep({
      status: 'failed',
      reason: 'conversation c is being written by session s-2 on claude-review',
    });
    should(built.leases.calls.at(-1)).equal(`release:${ID}`);
  });

  it('should release the conversation when the launch fails for good', async () => {
    // Arrange
    const built = leased();
    built.launcher.launchErrors = [new Error('a'), new Error('b'), new Error('c'), new Error('d')];
    await built.subject.create(input());

    // Act
    const starting = built.subject.start(ID);

    // Assert
    await should(starting).be.rejected();
    should(built.leases.calls.at(-1)).equal(`release:${ID}`);
  });

  it('should still report a stop when the release fails, because the daemon reads that lease as stale', async () => {
    // Arrange
    const built = leased();
    built.leases.releaseError = new Error('disk full');
    built.launcher.livenessFromLaunch = true;
    await built.subject.createAndStart(input());

    // Act
    const stopped = await built.subject.stop(ID);

    // Assert
    should(stopped.state.status).equal('stopped');
  });
});

/** A launch gate as the stop reads it: what is in flight, and whether it settles inside the budget. */
class ScriptedLaunches {
  readonly waits: Array<{ id: string; timeoutMs: number }> = [];

  constructor(
    private readonly inFlight: ReadonlySet<string>,
    private readonly settles: boolean,
  ) {}

  launching(id: SessionId): boolean {
    return this.inFlight.has(id);
  }

  async awaitSettled(id: SessionId, timeoutMs: number): Promise<boolean> {
    this.waits.push({ id, timeoutMs });
    return this.settles;
  }
}

describe('SessionLifecycleService stop and launches in flight', () => {
  /** A record a dead daemon left mid-launch: `starting`, and no pane anywhere. */
  function stranded(built: Harness): void {
    const running = built.repository.current();
    built.repository.documents.set(ID, JSON.stringify({ ...running, state: { ...running.state, status: 'starting' } }));
    built.launcher.live = false;
  }

  it('should stop a record left starting by a restart at once, waiting on no launch', async () => {
    // Arrange
    const launches = new ScriptedLaunches(new Set(), false);
    const built = harness({ launches });
    built.launcher.livenessFromLaunch = true;
    await built.subject.createAndStart(input());
    stranded(built);

    // Act
    const stopped = await built.subject.stop(ID, 'owner pressed stop');

    // Assert
    should(stopped.state).containDeep({ status: 'stopped', reason: 'owner pressed stop' });
    should(launches.waits).be.empty();
  });

  it('should answer pending rather than queue forever behind a relaunch that never settles', async () => {
    // Arrange
    const launches = new ScriptedLaunches(new Set([ID]), false);
    const built = harness({ launches }, { stopLaunchWaitMs: 45_000 });
    built.launcher.livenessFromLaunch = true;
    await built.subject.createAndStart(input());
    stranded(built);
    // The hung relaunch: it holds the session's queue and will never let go of it.
    void built.serial.run(ID, async () => await new Promise<never>(() => {}));
    const stopsBefore = built.launcher.calls.filter(call => call === 'stop').length;

    // Act
    const refusal = await built.subject.stop(ID).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(refusal).be.instanceOf(SessionStopPending);
    should(refusal).containDeep({
      name: 'SessionStopPending',
      message: `session ${ID} is still launching after 45s; nothing was stopped — stop it again once the launch settles`,
      sessionId: ID,
    });
    should(launches.waits).deepEqual([{ id: ID, timeoutMs: 45_000 }]);
    should(built.launcher.calls.filter(call => call === 'stop').length).equal(stopsBefore);
    should(built.repository.current().state.status).equal('starting');
  });

  it('should wait for a launch that settles in time and then stop the session', async () => {
    // Arrange
    const launches = new ScriptedLaunches(new Set([ID]), true);
    const built = harness({ launches });
    built.launcher.livenessFromLaunch = true;
    await built.subject.createAndStart(input());

    // Act
    const stopped = await built.subject.stop(ID);

    // Assert
    should(stopped.state.status).equal('stopped');
    should(launches.waits).deepEqual([{ id: ID, timeoutMs: defaultSessionLifecycleSettings.stopLaunchWaitMs }]);
  });
});

describe('SessionLifecycleService first-turn standing and failure evidence', () => {
  it('should refuse to relaunch a delivered first turn whose terminal is gone, and leave the record alone', async () => {
    // Arrange
    const { effects, launcher, repository, subject } = harness();
    await subject.create(input());
    effects.standing = 'settled';
    launcher.live = false;

    // Act + Assert — launching again would repeat startup, so the operator is told to revive instead.
    await should(subject.start(ID)).be.rejectedWith(/already delivered its first turn but its terminal is gone/u);
    should(repository.current().state.status).equal('created');
    should(launcher.launches()).equal(0);
    should(repository.events.map(entry => entry.type)).deepEqual(['session.created']);
  });

  it('should finish a settled first turn on a record a crash left already starting', async () => {
    // Arrange — the record is `starting` already, so resuming must go straight to `running` rather than
    // attempting a `starting` -> `starting` transition it can never make.
    const { effects, launcher, repository, subject } = harness();
    const created = await subject.create(input());
    await repository.write(
      { ...created, state: { ...created.state, status: 'starting' } },
      { type: 'session.starting', data: {} },
    );
    launcher.live = true;
    effects.standing = 'settled';

    // Act
    const actual = await subject.start(ID);

    // Assert
    should(actual.state.status).equal('running');
    should(launcher.launches()).equal(0);
    should(repository.events.map(entry => entry.type)).deepEqual([
      'session.created',
      'session.starting',
      'session.running',
    ]);
  });

  it('should refuse to type a first turn whose effect id another assignment already holds', async () => {
    // Arrange — inspection saw it unclaimed; the compare-and-set at the pre-write boundary lost to a
    // different assignment.
    const { effects, launcher, repository, subject } = harness();
    launcher.livenessFromLaunch = true;
    effects.scriptedBegin = 'conflict';

    // Act + Assert
    await should(subject.createAndStart(input())).be.rejectedWith(
      `session ${ID}'s first-turn effect id is held for a different assignment`,
    );
    should(repository.current().state.status).equal('failed');
    should(launcher.calls.filter(call => call.startsWith('deliver:'))).deepEqual([]);
    should(effects.calls).not.containEql('effect:settle:turn-1');
  });

  it('should fail a launch whose deliver returned without ever admitting the pane write', async () => {
    // Arrange — a launcher that skips the pre-write callback would let an assignment be typed with no
    // durable record that it was.
    const { effects, launcher, repository, subject } = harness();
    launcher.livenessFromLaunch = true;
    launcher.skipBeforeWrite = true;

    // Act + Assert
    await should(subject.createAndStart(input())).be.rejectedWith(
      `session ${ID}'s launcher delivered a first turn without durably admitting the pane write`,
    );
    should(repository.current().state.status).equal('failed');
    should(effects.calls).not.containEql('effect:settle:turn-1');
  });

  it('should still record the failure, and report the original error, when the frame capture fails', async () => {
    // Arrange
    const { launcher, repository, subject } = harness({}, { launchAttempts: 1 });
    launcher.launchErrors = [new Error('the agent binary is missing')];
    launcher.snapshotError = new Error('the pane is already gone');

    // Act + Assert — the missing frame is the optional artifact, so the real cause is what surfaces.
    await should(subject.createAndStart(input())).be.rejectedWith('the agent binary is missing');
    should(repository.current().state).containDeep({ status: 'failed', reason: 'the agent binary is missing' });
    should(launcher.calls).containEql('snapshot');
  });
});

describe('SessionLifecycleService board stamping', () => {
  const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

  it('should stamp the board the resolver names for the canonical cwd and the parent', async () => {
    // Arrange
    const starts: Array<{ readonly cwd: string; readonly parent?: string }> = [];
    const projects = {
      projectForStart: async (start: { readonly cwd: string; readonly parent?: string }) => {
        starts.push(start);
        return PROJECT_ID;
      },
    };
    const { repository, subject } = harness({ projects });

    // Act
    const actual = await subject.create(input({ parent: 'ms8-parent01' }));

    // Assert
    should(actual.config.projectId).equal(PROJECT_ID);
    should(repository.current().config.projectId).equal(PROJECT_ID);
    should(starts).deepEqual([{ cwd: '/canonical/project', parent: 'ms8-parent01' }]);
  });

  it('should ask without a parent when the request has none', async () => {
    // Arrange
    const starts: Array<{ readonly cwd: string; readonly parent?: string }> = [];
    const projects = {
      projectForStart: async (start: { readonly cwd: string; readonly parent?: string }) => {
        starts.push(start);
        return 'unfiled' as const;
      },
    };
    const { subject } = harness({ projects });

    // Act
    const actual = await subject.create(input());

    // Assert
    should(actual.config.projectId).equal('unfiled');
    should(starts).deepEqual([{ cwd: '/canonical/project' }]);
  });

  it('should create the session without a board when no resolver is wired', async () => {
    // Arrange
    const { subject } = harness();

    // Act
    const actual = await subject.create(input());

    // Assert
    should(actual.config).not.have.property('projectId');
  });

  it('should never block a start on a resolver that fails', async () => {
    // Arrange
    const projects = {
      projectForStart: async (): Promise<never> => {
        throw new Error('registry unreadable');
      },
    };
    const { subject } = harness({ projects });

    // Act
    const actual = await subject.create(input());

    // Assert
    should(actual.config).not.have.property('projectId');
    should(actual.state.status).equal('created');
  });
});

/** The rotation's hash write, applied to the stored record the way the storage merge applies it. */
class RepositoryHashStore implements SessionCapabilityHashStore {
  failures: unknown[] = [];

  constructor(
    private readonly repository: MemoryRepository,
    private readonly order: string[],
  ) {}

  async record(id: SessionId, hash: string): Promise<void> {
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    this.order.push('hash');
    const current = this.repository.current(id);
    this.repository.documents.set(
      id,
      JSON.stringify({ ...current, config: { ...current.config, sessionCapabilityHash: hash } }),
    );
  }

  async erase(id: SessionId): Promise<void> {
    this.order.push('erase');
    const current = this.repository.current(id);
    const { sessionCapabilityHash: _revoked, ...config } = current.config;
    this.repository.documents.set(id, JSON.stringify({ ...current, config }));
  }
}

describe('SessionLifecycleService credential per launch', () => {
  const capabilities = ['created-capability', 'first-pane-capability', 'second-pane-capability'] as const;

  function rotating(): Harness & {
    readonly environment: RecordingEnvironmentStore;
    readonly credentials: SequenceCredentialIssuer;
    readonly hashes: RepositoryHashStore;
    /** The session id a presented capability authenticates as, through the real identity resolver. */
    readonly resolve: (capability: string) => Promise<string | undefined>;
  } {
    const environment = new RecordingEnvironmentStore();
    const credentials = new SequenceCredentialIssuer(capabilities.map(credential));
    // The hash store needs the harness's own repository, which exists only once the harness does.
    let hashes: RepositoryHashStore | undefined;
    const rotation = new SessionCredentialRotation({
      credentials,
      environment,
      hashes: {
        record: async (id, hash) => {
          await hashes?.record(id, hash);
        },
        erase: async id => {
          await hashes?.erase(id);
        },
      },
    });
    const built = harness({ credentials, environment, rotation });
    hashes = new RepositoryHashStore(built.repository, built.order);
    const identities = new CredentialAgentIdentities(
      {
        snapshot: async () => {
          const record = built.repository.current();
          const hash = record.config.sessionCapabilityHash;
          return hash === undefined
            ? []
            : [{ id: record.config.id, name: null, active: true, sessionCapabilityHash: hash }];
        },
      },
      capability => credential(capability).hash,
      (left, right) => left === right,
    );
    return {
      ...built,
      environment,
      credentials,
      hashes,
      resolve: async capability => (await identities.resolve(capability))?.sessionId,
    };
  }

  it('should hand the first pane a fresh credential, so the one creation minted stops authenticating', async () => {
    // Arrange
    const built = rotating();
    built.launcher.livenessFromLaunch = true;
    await built.subject.create(input());
    should(await built.resolve('created-capability')).equal(ID);

    // Act
    const actual = await built.subject.start(ID);

    // Assert
    should(actual.config.sessionCapabilityHash).equal(credential('first-pane-capability').hash);
    should(built.repository.current().config.sessionCapabilityHash).equal(credential('first-pane-capability').hash);
    should(built.environment.written.get(ID)).deepEqual({
      FY_SESSION_BOARD_CAPABILITY: 'first-pane-capability',
      FY_SESSION_MODE: 'auto',
    });
    should(await built.resolve('first-pane-capability')).equal(ID);
    should(await built.resolve('created-capability')).be.undefined();
    // Recorded before the pane exists, so the pane is never holding a credential nothing accepts.
    should(built.order.indexOf('hash')).be.below(built.order.indexOf('launch'));
  });

  it('should re-issue on every relaunch, so the replaced pane credential dies with it', async () => {
    // Arrange — a first pane that came up and then failed, as one a revive would replace.
    const built = rotating();
    await built.subject.create(input());
    const failing = async () => {
      throw new Error('startup setup failed after the pane opened');
    };
    await should(built.subject.start(ID, failing)).be.rejectedWith('startup setup failed after the pane opened');
    should(await built.resolve('first-pane-capability')).equal(ID);

    // Act
    await built.subject.start(ID);

    // Assert
    should(await built.resolve('second-pane-capability')).equal(ID);
    should(await built.resolve('first-pane-capability')).be.undefined();
    should(built.launcher.launches()).equal(2);
    should(built.credentials.issues).equal(3);
  });

  it('should erase a stopped session’s credential, so its pane’s value authenticates nothing again', async () => {
    // Arrange — this resolver counts every stored hash as live, so only the ERASURE can revoke it here.
    const built = rotating();
    built.launcher.livenessFromLaunch = true;
    await built.subject.create(input());
    await built.subject.start(ID);
    should(await built.resolve('first-pane-capability')).equal(ID);

    // Act
    const stopped = await built.subject.stop(ID);

    // Assert
    should(stopped.state.status).equal('stopped');
    should(stopped.config.sessionCapabilityHash).be.undefined();
    should(built.repository.current().config.sessionCapabilityHash).be.undefined();
    should(await built.resolve('first-pane-capability')).be.undefined();
    // After the stop is durable: a crash in between leaves a stopped session, which the lookup refuses.
    should(built.order.lastIndexOf('erase')).be.above(built.order.lastIndexOf('hash'));
  });

  it('should bring no ended session back on the value its old pane held, whatever status it ended in', async () => {
    // Arrange — a resolver that consults only ACTIVE sessions, as production's does.
    for (const status of WARDEN_TERMINAL_STATUSES) {
      const built = rotating();
      built.launcher.livenessFromLaunch = true;
      await built.subject.create(input());
      await built.subject.start(ID);
      const live = new CredentialAgentIdentities(
        {
          snapshot: async () => {
            const record = built.repository.current();
            const hash = record.config.sessionCapabilityHash;
            return hash === undefined
              ? []
              : [{ id: ID, name: null, active: !isTerminalStatus(record.state.status), sessionCapabilityHash: hash }];
          },
        },
        capability => credential(capability).hash,
        (left, right) => left === right,
      );
      const current = built.repository.current();
      built.repository.documents.set(ID, JSON.stringify({ ...current, state: { ...current.state, status } }));
      built.launcher.livenessFromLaunch = false;
      built.launcher.live = false;

      // Act — the ended session is started again, through the one path that revives a pane here.
      const ended = await live.resolve('first-pane-capability');
      await built.subject.start(ID).catch(() => undefined);

      // Assert — the old value names nobody, before or after; only a fresh launch's value can.
      should({ status, ended }).deepEqual({ status, ended: undefined });
      should({ status, after: await live.resolve('first-pane-capability') }).deepEqual({ status, after: undefined });
    }
  });

  it('should keep the credential of a pane that is still live when a start is retried', async () => {
    // Arrange — a launch a daemon restart interrupted after the pane was opened: the record still
    // says `starting`, and the pane is running with the environment it was launched with.
    const built = rotating();
    await built.subject.create(input());
    const created = built.repository.current();
    built.repository.documents.set(ID, JSON.stringify({ ...created, state: { ...created.state, status: 'starting' } }));
    built.launcher.live = true;

    // Act
    const resumed = await built.subject.start(ID);
    const retried = await built.subject.start(ID);

    // Assert — nothing was minted, because no pane was launched to hold it.
    should(resumed.state.status).equal('running');
    should(retried.state.status).equal('running');
    should(built.credentials.issues).equal(1);
    should(built.launcher.launches()).equal(0);
    should(await built.resolve('created-capability')).equal(ID);
  });

  it('should launch again after a crash between the new plaintext and its hash', async () => {
    // Arrange — the new plaintext is durable, its hash never landed: the torn pair a crash leaves.
    const built = rotating();
    built.hashes.failures = [new Error('the daemon died before the hash was written')];
    await built.subject.create(input());

    // Act + Assert — nothing was launched holding the unrecorded credential.
    await should(built.subject.start(ID)).be.rejectedWith('the daemon died before the hash was written');
    should(built.repository.current().state.status).equal('failed');
    should(built.repository.current().config.sessionCapabilityHash).equal(credential('created-capability').hash);
    should(built.environment.written.get(ID)?.FY_SESSION_BOARD_CAPABILITY).equal('first-pane-capability');
    should(built.launcher.launches()).equal(0);

    // The retry re-issues rather than adopting the torn pair, and the pane it launches is accepted.
    const actual = await built.subject.start(ID);
    should(actual.state.status).equal('running');
    should(built.launcher.launches()).equal(1);
    should(await built.resolve('second-pane-capability')).equal(ID);
    should(await built.resolve('first-pane-capability')).be.undefined();
    should(await built.resolve('created-capability')).be.undefined();
  });
});
