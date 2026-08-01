import { afterEach, describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  FileSessionEnvironmentStore,
  FileSessionTaskStore,
  KeyedSerialExecutor,
  NodeSessionCredentialIssuer,
  NodeWorkingDirectoryResolver,
  type PaneDeliveryOptions,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  StorageSessionLifecycleRepository,
  SystemClock,
  TimeSessionIdFactory,
  TmuxPaneDelivery,
  TmuxSessionLifecycleLauncher,
  UnusableSessionRecordError,
} from '../../../../src/adapters/index.ts';
import {
  createSessionPaths,
  createSessionRecord,
  defaultSessionLifecycleSettings,
  parseSessionId,
  type SessionEnvironmentStore,
  type SessionLifecycleRecord,
  SessionLifecycleService,
  type TmuxCommandPort,
  TmuxController,
  transitionSessionRecord,
} from '../../../../src/lib/index.ts';
import { FakeTmuxServer } from '../../support/fake-tmux-server.ts';

const homes = new Set<string>();
const NOW = '2026-07-31T10:00:00.000Z';
const AGENT = '/opt/fleet/bin/claude-auto-loge';

async function openTemporaryStorage() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-lifecycle-test-'));
  homes.add(home);
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  );
  return await factory.open();
}

function record(id = 'stored-session', overrides: Record<string, unknown> = {}): SessionLifecycleRecord {
  return createSessionRecord(
    { agent: AGENT, cwd: '/workspace/project', mode: 'auto', prompt: 'Persist me', ...overrides },
    { id: parseSessionId(id), cwd: '/workspace/project', at: NOW, settings: defaultSessionLifecycleSettings },
  ).record;
}

/**
 * A tmux server the test owns: it answers the real command vocabulary the controller emits, so the
 * launcher is exercised through actual argument construction rather than a stubbed controller.
 */
class RecordingTmuxPort implements TmuxCommandPort {
  readonly calls: Array<readonly string[]> = [];
  alive = false;
  dead = false;
  /** How many `state` polls report a busy pane before the prompt appears. */
  pollsBeforeReady = 0;
  readonly failures = new Map<string, string>();
  private captures = 0;

  async execute(arguments_: readonly string[]) {
    this.calls.push(arguments_);
    const command = arguments_[0] ?? '';
    const failure = this.failures.get(command);
    if (failure !== undefined) return { code: 1, stdout: '', stderr: failure };
    if (command === 'has-session') return { code: this.alive ? 0 : 1, stdout: '', stderr: '' };
    if (command === 'new-session') this.alive = true;
    if (command === 'kill-session') this.alive = false;
    if (command === 'display-message') return { code: 0, stdout: `${this.dead ? '1' : '0'}|||0|0|24|80`, stderr: '' };
    if (command === 'capture-pane') {
      // Two captures per `state` call, so readiness is counted in pairs.
      this.captures += 1;
      const ready = Math.ceil(this.captures / 2) > this.pollsBeforeReady;
      return { code: 0, stdout: ready ? '> ' : 'Loading model…', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }

  commands(): readonly string[] {
    return this.calls.map(call => call[0] ?? '');
  }
}

function launcher(port: TmuxCommandPort, options: PaneDeliveryOptions = {}, environment?: SessionEnvironmentStore) {
  const slept: number[] = [];
  const controller = new TmuxController(port);
  const instance = new TmuxSessionLifecycleLauncher(
    controller,
    new TmuxPaneDelivery(
      controller,
      async milliseconds => {
        slept.push(milliseconds);
      },
      options,
    ),
    environment,
  );
  return { instance, slept };
}

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('StorageSessionLifecycleRepository', () => {
  it('should persist and read the lifecycle record through the authoritative daemon store', async () => {
    // Arrange
    const opened = await openTemporaryStorage();
    const subject = new StorageSessionLifecycleRepository(opened.storage);
    const created = createSessionRecord(
      { agent: AGENT, cwd: '/workspace/project', mode: 'auto', prompt: 'Persist me' },
      {
        id: parseSessionId('stored-session'),
        cwd: '/workspace/project',
        at: NOW,
        settings: defaultSessionLifecycleSettings,
      },
    );

    // Act
    await subject.write(created.record, created.event);
    const actual = await subject.read(created.record.config.id);
    const paths = createSessionPaths(opened.paths, created.record.config.id);

    // Assert
    should(actual).deepEqual(created.record);
    // The DOCUMENT records the wrapper NAME, because one file serves both this schema and the
    // protocol's, whose `agent` is the name every account is published under. The absolute executable
    // the lifecycle authorizes against is `command[0]`, which is where the read above recovered it
    // from — so the record round-trips while the document stays the one every mounted surface parses.
    should(await opened.storage.readConfig(created.record.config.id)).deepEqual({
      ...created.record.config,
      agent: 'claude-auto-loge',
    });
    should(await opened.storage.readState(created.record.config.id)).deepEqual(created.record.state);
    should((await readFile(paths.events, 'utf8')).trim()).containEql('"type":"session.created"');
    should(paths.directory).endWith('/state/sessions/stored-session');
    await opened.storage.close();
  });

  it('should report an unknown session as missing rather than inventing one', async () => {
    // Arrange
    const opened = await openTemporaryStorage();
    const subject = new StorageSessionLifecycleRepository(opened.storage);

    // Act
    const actual = await subject.read(parseSessionId('never-created'));

    // Assert
    should(actual).be.undefined();
    await opened.storage.close();
  });

  it('should recover a create that tore between its configuration and state writes', async () => {
    // Arrange — exactly what a crash between the two writes leaves on disk.
    const opened = await openTemporaryStorage();
    const subject = new StorageSessionLifecycleRepository(opened.storage);
    const torn = record('torn-session');
    await opened.storage.writeConfig(torn.config.id, torn.config);

    // Act
    const actual = await subject.read(torn.config.id);

    // Assert — nothing was launched, so `created` is the truthful reading and the record is usable.
    should(actual).deepEqual({ config: torn.config, state: { id: 'torn-session', status: 'created' } });
    const stopped = transitionSessionRecord(torn, 'stopped', '2026-07-31T10:05:00.000Z', 'cleaned up');
    await subject.write(stopped.record, stopped.event);
    should((await subject.read(torn.config.id))?.state.status).equal('stopped');
    await opened.storage.close();
  });

  it('should name the damage when a record cannot be trusted at all', async () => {
    // Arrange
    const opened = await openTemporaryStorage();
    const subject = new StorageSessionLifecycleRepository(opened.storage);
    const orphan = parseSessionId('state-only-session');
    const invalid = record('invalid-session');
    await opened.storage.writeState(orphan, { id: orphan, status: 'running' });
    await opened.storage.writeConfig(invalid.config.id, { ...invalid.config, command: [] });
    await opened.storage.writeState(invalid.config.id, invalid.state);

    // Act + Assert
    await should(subject.read(orphan)).be.rejectedWith(UnusableSessionRecordError);
    await should(subject.read(orphan)).be.rejectedWith(/configuration document is missing/u);
    await should(subject.read(invalid.config.id)).be.rejectedWith(/config\.command/u);
    await opened.storage.close();
  });

  it('should keep the journal behind the state it describes', async () => {
    // Arrange
    const opened = await openTemporaryStorage();
    const subject = new StorageSessionLifecycleRepository(opened.storage);
    const created = record('journal-session');
    const started = transitionSessionRecord(created, 'starting', '2026-07-31T10:01:00.000Z');

    // Act
    await subject.write(created, { type: 'session.created', data: {} });
    await subject.write(started.record, started.event);
    const journal = await readFile(createSessionPaths(opened.paths, created.config.id).events, 'utf8');

    // Assert
    should(
      journal
        .trim()
        .split('\n')
        .map(line => JSON.parse(line).type),
    ).deepEqual(['session.created', 'session.starting']);
    should((await subject.read(created.config.id))?.state.status).equal('starting');
    await opened.storage.close();
  });
});

describe('TmuxSessionLifecycleLauncher', () => {
  it('should launch and stop only through the injected isolated tmux controller', async () => {
    // Arrange
    const port = new RecordingTmuxPort();
    const subject = launcher(port).instance;
    const input = record('tmux-session', { command: [AGENT, '--mode', 'auto'] });

    // Act
    const before = await subject.alive(input);
    await subject.launch(input);
    const during = await subject.alive(input);
    await subject.stop(input);

    // Assert
    should([before, during]).deepEqual([false, true]);
    should(port.calls).deepEqual([
      ['has-session', '-t', 'fy-tmux-session'],
      ['has-session', '-t', 'fy-tmux-session'],
      ['new-session', '-d', '-s', 'fy-tmux-session', '-c', '/workspace/project', AGENT, '--mode', 'auto'],
      ['set-option', '-t', 'fy-tmux-session', 'remain-on-exit', 'on'],
      ['has-session', '-t', 'fy-tmux-session'],
      ['has-session', '-t', 'fy-tmux-session'],
      ['kill-session', '-t', 'fy-tmux-session'],
    ]);
  });

  it('should wait for a ready prompt before typing the first turn into the pane', async () => {
    // Arrange — the harness is still drawing itself for the first two `state` polls.
    const server = new FakeTmuxServer();
    server.alive = false;
    server.bootCaptures = 4;
    const { instance: subject } = launcher(server);
    const input = record('deliver-session');
    await subject.launch(input);
    server.calls.length = 0;

    // Act
    await subject.deliver(input, 'Read the file /turns/turn-001.md now');

    // Assert — nothing is typed while the pane is booting, and the pane received the whole turn.
    const firstKey = server.commands().indexOf('send-keys');
    should(server.commands().slice(0, firstKey)).not.containEql('send-keys');
    should(firstKey).be.greaterThan(6, 'the boot frames are polled before anything is typed');
    should(server.submitted).deepEqual(['Read the file /turns/turn-001.md now']);
  });

  it('should refuse to deliver into a pane that is gone or already dead', async () => {
    // Arrange
    const missing = new FakeTmuxServer();
    missing.alive = false;
    const died = new FakeTmuxServer();
    died.dead = true;
    const input = record('gone-session');

    // Act + Assert
    await should(launcher(missing).instance.deliver(input, 'anything')).be.rejectedWith(
      /the interactive harness exited; tmux reported no exit code/u,
    );
    await should(launcher(died).instance.deliver(input, 'anything')).be.rejectedWith(/harness exited/u);
    should(died.calls.some(call => call[0] === 'send-keys')).be.false();
  });

  it('should give up on a pane that never becomes ready instead of typing into a booting terminal', async () => {
    // Arrange
    const server = new FakeTmuxServer();
    server.alive = false;
    server.bootCaptures = Number.MAX_SAFE_INTEGER;
    const { instance: subject, slept } = launcher(server, { readinessAttempts: 2 });
    const input = record('wedged-session');
    await subject.launch(input);

    // Act + Assert
    await should(subject.deliver(input, 'anything')).be.rejectedWith(
      'tmux session fy-wedged-session did not become ready to accept a turn',
    );
    should(slept).deepEqual([100, 200]);
    should(server.commands().filter(command => command === 'send-keys')).deepEqual([]);
  });

  it('should surface a tmux failure rather than reporting a launch or stop that did not happen', async () => {
    // Arrange
    const launchPort = new RecordingTmuxPort();
    launchPort.failures.set('new-session', 'no server running on /tmp/fy.sock');
    const stopPort = new RecordingTmuxPort();
    stopPort.alive = true;
    stopPort.failures.set('kill-session', 'session not found');
    const sendPort = new RecordingTmuxPort();
    sendPort.alive = true;
    sendPort.failures.set('send-keys', 'pane is unwritable');
    const input = record('failing-session');

    // Act + Assert
    await should(launcher(launchPort).instance.launch(input)).be.rejectedWith('no server running on /tmp/fy.sock');
    await should(launcher(stopPort).instance.stop(input)).be.rejectedWith('session not found');
    await should(launcher(sendPort).instance.deliver(input, 'anything')).be.rejectedWith('pane is unwritable');
  });

  it('should reject an invalid record before issuing a tmux launch command', async () => {
    // Arrange
    const port = new RecordingTmuxPort();
    const subject = launcher(port).instance;
    const input = record('empty-command', { mode: 'interactive', prompt: undefined });
    const malformed = { ...input, config: { ...input.config, command: [] } };

    // Act + Assert
    await should(subject.launch(malformed)).be.rejectedWith('session command is empty');
    should(port.calls).deepEqual([]);
  });
});

describe('FileSessionTaskStore', () => {
  it('should write turn one privately inside the session directory and return the file to open', async () => {
    // Arrange
    const home = await mkdtemp(join(tmpdir(), 'ferretry-task-store-'));
    homes.add(home);
    const id = parseSessionId('task-session');
    const subject = new FileSessionTaskStore(
      session => join(home, session),
      () => 'fixed-id',
    );

    // Act
    const actual = await subject.writeAssignedTask(id, '# Assigned task\n\nDo the work\n');

    // Assert
    should(actual).equal(join(home, 'task-session', 'turns', 'turn-001.md'));
    should(await readFile(actual, 'utf8')).equal('# Assigned task\n\nDo the work\n');
    should((await stat(actual)).mode & 0o777).equal(0o600);
    should((await stat(join(home, 'task-session', 'turns'))).mode & 0o777).equal(0o700);
  });

  it('should be repeatable so a retried launch can re-deliver the same assignment', async () => {
    // Arrange
    const home = await mkdtemp(join(tmpdir(), 'ferretry-task-store-'));
    homes.add(home);
    const id = parseSessionId('retried-session');
    const subject = new FileSessionTaskStore(session => join(home, session));

    // Act
    const first = await subject.writeAssignedTask(id, 'first\n');
    const second = await subject.writeAssignedTask(id, 'second\n');

    // Assert
    should(second).equal(first);
    should(await readFile(first, 'utf8')).equal('second\n');
  });
});

describe('NodeWorkingDirectoryResolver', () => {
  it('should canonicalize a real directory so the record and the pane agree', async () => {
    // Arrange
    const home = await mkdtemp(join(tmpdir(), 'ferretry-cwd-'));
    homes.add(home);
    const target = join(home, 'project');
    const link = join(home, 'link');
    await mkdir(target);
    await symlink(target, link);
    const subject = new NodeWorkingDirectoryResolver();

    // Act
    const actual = await subject.resolve(`  ${link}  `);

    // Assert
    should(actual).equal(await subject.resolve(target));
    should(actual).endWith('/project');
  });

  it('should refuse a directory the agent could not actually start in', async () => {
    // Arrange
    const home = await mkdtemp(join(tmpdir(), 'ferretry-cwd-'));
    homes.add(home);
    const file = join(home, 'not-a-directory');
    await writeFile(file, 'x');
    const subject = new NodeWorkingDirectoryResolver();

    // Act + Assert
    await should(subject.resolve('relative/dir')).be.rejectedWith(
      'session working directory must be absolute: "relative/dir"',
    );
    await should(subject.resolve(join(home, 'missing'))).be.rejectedWith(/is not a directory/u);
    await should(subject.resolve(file)).be.rejectedWith(`session working directory is not a directory: ${file}`);
  });
});

describe('the composed session lifecycle', () => {
  it('should give a started auto session its task through real storage and a real turn file', async () => {
    // Arrange — every adapter is the production one; only the tmux process boundary is a double.
    const opened = await openTemporaryStorage();
    const server = new FakeTmuxServer();
    server.alive = false;
    const cwd = await mkdtemp(join(tmpdir(), 'ferretry-lifecycle-cwd-'));
    homes.add(cwd);
    const subject = new SessionLifecycleService(
      {
        repository: new StorageSessionLifecycleRepository(opened.storage),
        launcher: launcher(server).instance,
        tasks: new FileSessionTaskStore(id => createSessionPaths(opened.paths, id).directory),
        directories: new NodeWorkingDirectoryResolver(),
        ids: new TimeSessionIdFactory(
          () => Date.parse(NOW),
          () => 'ABCDEF12-3456-7890-ABCD-EF1234567890',
        ),
        clock: new SystemClock(() => new Date(NOW)),
        serial: new KeyedSerialExecutor(),
      },
      defaultSessionLifecycleSettings,
    );

    // Act
    const running = await subject.createAndStart({
      agent: AGENT,
      command: [AGENT, '--mode', 'auto'],
      cwd,
      mode: 'auto',
      prompt: 'Finish the lifecycle unit',
    });
    const taskFile = join(createSessionPaths(opened.paths, running.config.id).directory, 'turns', 'turn-001.md');
    const typed = server.calls.find(call => call[0] === 'send-keys' && call[3] === '-l');
    const stopped = await subject.stop(running.config.id, 'work complete');

    // Assert — the agent was told to read the file that exists and holds its assignment.
    should(running.config.id).equal('ms8ru4g0-abcdef12');
    should(running.state.status).equal('running');
    should(await readFile(taskFile, 'utf8')).equal('# Assigned task\n\nFinish the lifecycle unit\n');
    should(typed?.at(-1)).equal(
      `Read the file ${taskFile} now, then carefully follow every instruction inside it. This is your complete task for this turn.`,
    );
    should(server.commands()).containDeep(['new-session', 'set-option']);
    should(stopped.state).containDeep({ status: 'stopped', reason: 'work complete' });
    should(server.commands().at(-1)).equal('kill-session');
    should(
      (await readFile(createSessionPaths(opened.paths, running.config.id).events, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line).type),
    ).deepEqual(['session.created', 'session.starting', 'session.running', 'session.stopped']);
    await opened.storage.close();
  });

  it('should hand the launched pane its own credential through tmux, keeping the plaintext off the session document', async () => {
    // Arrange — the real credential issuer, the real environment file, and the real launcher, so the
    // only fake in the chain is the tmux server itself.
    const opened = await openTemporaryStorage();
    const cwd = await mkdtemp(join(tmpdir(), 'ferretry-lifecycle-cwd-'));
    homes.add(cwd);
    const server = new FakeTmuxServer();
    server.alive = false;
    const environment = new FileSessionEnvironmentStore(id => createSessionPaths(opened.paths, id).directory);
    const subject = new SessionLifecycleService(
      {
        repository: new StorageSessionLifecycleRepository(opened.storage),
        launcher: launcher(server, {}, environment).instance,
        tasks: new FileSessionTaskStore(id => createSessionPaths(opened.paths, id).directory),
        directories: new NodeWorkingDirectoryResolver(),
        ids: new TimeSessionIdFactory(
          () => Date.parse(NOW),
          () => 'ABCDEF12-3456-7890-ABCD-EF1234567890',
        ),
        clock: new SystemClock(() => new Date(NOW)),
        serial: new KeyedSerialExecutor(),
        credentials: new NodeSessionCredentialIssuer(),
        environment,
      },
      defaultSessionLifecycleSettings,
    );

    // Act
    const running = await subject.createAndStart({
      agent: AGENT,
      command: [AGENT, '--mode', 'auto'],
      cwd,
      mode: 'auto',
      prompt: 'Prove the credential arrives',
    });
    const id = running.config.id;
    const capability = (await environment.read(id)).FY_SESSION_BOARD_CAPABILITY;
    const newSession = server.calls.find(call => call[0] === 'new-session');

    // Assert — the pane really was launched carrying the secret, under the name the CLI reads.
    should(capability).be.a.String().and.not.be.empty();
    should(newSession).containDeep(['-e', `FY_SESSION_BOARD_CAPABILITY=${capability}`]);
    // `-e` is an option of new-session, so it has to precede the agent word to be an environment
    // entry at all rather than an argument handed to the agent.
    should(newSession?.indexOf('-e')).be.below(newSession?.indexOf(AGENT) ?? -1);
    // The hash is durable on the record — it is what the task-board domain keys grants on — and the
    // capability itself appears nowhere any reader of the session document can reach.
    should(running.config.sessionCapabilityHash).equal(
      createHash('sha256')
        .update(capability ?? '', 'utf8')
        .digest('hex'),
    );
    const document = await readFile(createSessionPaths(opened.paths, id).config, 'utf8');
    should(document).not.containEql(capability);
    should(document).containEql(running.config.sessionCapabilityHash);
    // Only the owning daemon may read the one copy of the plaintext.
    should((await stat(environment.file(id))).mode & 0o777).equal(0o600);
    await opened.storage.close();
  });
});

describe('TimeSessionIdFactory', () => {
  it('should mint sortable, path-safe ids the schema accepts', async () => {
    // Arrange
    const fixed = new TimeSessionIdFactory(
      () => Date.parse('2026-07-31T10:00:00.000Z'),
      () => 'ABCDEF12-3456-7890-ABCD-EF1234567890',
    );
    const production = new TimeSessionIdFactory();

    // Act
    const actual = fixed.next();
    const [first, second] = [production.next(), production.next()];

    // Assert
    should(actual).equal('ms8ru4g0-abcdef12');
    should(parseSessionId(actual)).equal(actual);
    should(first).not.equal(second);
    should(parseSessionId(second)).equal(second);
  });
});
