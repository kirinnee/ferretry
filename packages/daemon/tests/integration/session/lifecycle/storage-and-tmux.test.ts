import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  FileSessionTaskStore,
  KeyedSerialExecutor,
  NodeWorkingDirectoryResolver,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  StorageSessionLifecycleRepository,
  SystemClock,
  TimeSessionIdFactory,
  TmuxSessionLifecycleLauncher,
  UnusableSessionRecordError,
} from '../../../../src/adapters/index.ts';
import {
  createSessionPaths,
  createSessionRecord,
  defaultSessionLifecycleSettings,
  parseSessionId,
  TmuxController,
  transitionSessionRecord,
  type SessionLifecycleRecord,
  type TmuxCommandPort,
} from '../../../../src/lib/index.ts';

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

function launcher(port: RecordingTmuxPort, readinessAttempts?: number) {
  const slept: number[] = [];
  const instance = new TmuxSessionLifecycleLauncher(
    new TmuxController(port),
    async milliseconds => {
      slept.push(milliseconds);
    },
    readinessAttempts,
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
    should(await opened.storage.readConfig(created.record.config.id)).deepEqual(created.record.config);
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
    // Arrange
    const port = new RecordingTmuxPort();
    port.pollsBeforeReady = 2;
    const { instance: subject, slept } = launcher(port);
    const input = record('deliver-session');
    await subject.launch(input);
    port.calls.length = 0;

    // Act
    await subject.deliver(input, 'Read the file /turns/turn-001.md now');

    // Assert — nothing is typed until the third poll reports a prompt.
    should(port.commands()).deepEqual([
      'has-session',
      'display-message',
      'capture-pane',
      'capture-pane',
      'has-session',
      'display-message',
      'capture-pane',
      'capture-pane',
      'has-session',
      'display-message',
      'capture-pane',
      'capture-pane',
      'send-keys',
      'send-keys',
    ]);
    should(port.calls.at(-2)).deepEqual([
      'send-keys',
      '-t',
      'fy-deliver-session',
      '-l',
      'Read the file /turns/turn-001.md now',
    ]);
    should(port.calls.at(-1)).deepEqual(['send-keys', '-t', 'fy-deliver-session', 'Enter']);
    should(slept).deepEqual([100, 200]);
  });

  it('should refuse to deliver into a pane that is gone or already dead', async () => {
    // Arrange
    const missing = new RecordingTmuxPort();
    const died = new RecordingTmuxPort();
    died.alive = true;
    died.dead = true;
    const input = record('gone-session');

    // Act + Assert
    await should(launcher(missing).instance.deliver(input, 'anything')).be.rejectedWith(
      'tmux session fy-gone-session is not running; its first turn cannot be delivered',
    );
    await should(launcher(died).instance.deliver(input, 'anything')).be.rejectedWith(/is not running/u);
  });

  it('should give up on a pane that never becomes ready instead of typing into a booting terminal', async () => {
    // Arrange
    const port = new RecordingTmuxPort();
    port.pollsBeforeReady = Number.MAX_SAFE_INTEGER;
    const { instance: subject, slept } = launcher(port, 2);
    const input = record('wedged-session');
    await subject.launch(input);

    // Act + Assert
    await should(subject.deliver(input, 'anything')).be.rejectedWith(
      'tmux session fy-wedged-session did not become ready to accept its first turn',
    );
    should(slept).deepEqual([100, 200]);
    should(port.commands().filter(command => command === 'send-keys')).deepEqual([]);
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
    should(actual).equal(`${Date.parse('2026-07-31T10:00:00.000Z').toString(36)}-abcdef12`);
    should(parseSessionId(actual)).equal(actual);
    should(first).not.equal(second);
    should(parseSessionId(second)).equal(second);
  });
});
