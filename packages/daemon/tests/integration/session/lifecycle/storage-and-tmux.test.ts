import { afterEach, describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  type FileHandle,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  FileSessionEffectLedger,
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
// Imported from their own modules rather than the barrel: each lifecycle module keeps its OWN copy
// of this helper — no shared filesystem abstraction was introduced — so these are three distinct
// functions, each of which has to be proven on its own. They are named apart rather than sharing one
// name because `lifecycle/index.ts` star-exports all three modules, and a shared name would collide
// there and again in `adapters/index.ts`.
import { fsyncEnvironmentDirectory } from '../../../../src/adapters/session/lifecycle/file-session-environment-store.ts';
import { fsyncTaskDirectory } from '../../../../src/adapters/session/lifecycle/file-session-task-store.ts';
import { fsyncReservedDirectory } from '../../../../src/adapters/session/lifecycle/storage-session-lifecycle-repository.ts';
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

async function openTemporaryStorage(existingHome?: string) {
  const home = existingHome ?? (await mkdtemp(join(tmpdir(), 'ferretry-lifecycle-test-')));
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

  it('should reserve a durable session layout without publishing a record or duplicate create event', async () => {
    // Arrange
    const opened = await openTemporaryStorage();
    const subject = new StorageSessionLifecycleRepository(opened.storage);
    const id = parseSessionId('reserved-session');
    const paths = createSessionPaths(opened.paths, id);
    const environment = new FileSessionEnvironmentStore(held => createSessionPaths(opened.paths, held).directory);
    const capability = 'reserved-capability';
    const capabilityHash = createHash('sha256').update(capability, 'utf8').digest('hex');
    const created = createSessionRecord(
      {
        agent: AGENT,
        cwd: '/workspace/project',
        mode: 'auto',
        prompt: 'Publish me later',
        sessionCapabilityHash: capabilityHash,
      },
      { id, cwd: '/workspace/project', at: NOW, settings: defaultSessionLifecycleSettings },
    );

    // Act — a repeated reservation and a durable plaintext are still not a lifecycle record.
    await subject.reserve(id);
    await environment.write(id, { FY_SESSION_BOARD_CAPABILITY: capability });
    await subject.reserve(id);

    // Assert
    should(await subject.read(id)).be.undefined();
    should(await opened.storage.readConfig(id)).be.undefined();
    should(await opened.storage.readState(id)).be.undefined();
    should(await readFile(paths.marker, 'utf8')).equal('2\n');
    should((await stat(paths.events)).size).equal(0);

    await opened.storage.close();

    // A fresh storage process still sees plaintext but no published/indexed session. Retrying the
    // publication keeps the exact hash agreement and appends one create event, never two.
    const reopened = await openTemporaryStorage(opened.paths.home);
    const recovered = new StorageSessionLifecycleRepository(reopened.storage);
    const recoveredEnvironment = new FileSessionEnvironmentStore(
      held => createSessionPaths(reopened.paths, held).directory,
    );
    should(await recovered.read(id)).be.undefined();
    should(await recoveredEnvironment.read(id)).deepEqual({ FY_SESSION_BOARD_CAPABILITY: capability });
    should((await reopened.storage.rebuildIndex()).sessionCount).equal(0);
    await reopened.storage.reconcile();
    should(reopened.storage.listSessions().map(session => session.id)).deepEqual([]);
    should(await reopened.storage.sessionIdsOnDisk()).deepEqual([]);
    should(await reopened.storage.fleetSessionIds()).deepEqual([]);

    await recovered.write(created.record, created.event);
    should((await recovered.read(id))?.config.sessionCapabilityHash).equal(capabilityHash);
    should(await recoveredEnvironment.read(id)).deepEqual({ FY_SESSION_BOARD_CAPABILITY: capability });
    should(reopened.storage.listSessions().map(session => session.id)).deepEqual([id]);
    should((await readFile(paths.events, 'utf8')).trim().split('\n')).have.length(1);
    await reopened.storage.close();
  });

  it('should persist the sessions entry after the reservation itself is durable', async () => {
    // Arrange: the reservation makes the journal and marker durable, and each of those syncs the
    // SESSION directory — which says nothing about the entry NAMING that session in `sessions/`.
    const opened = await openTemporaryStorage();
    const synced: string[] = [];
    const subject = new StorageSessionLifecycleRepository(opened.storage, undefined, async path => {
      synced.push(path);
    });
    const id = parseSessionId('reserved-ordering');
    const paths = createSessionPaths(opened.paths, id);

    // Act
    await subject.reserve(id);

    // Assert: the layout is complete first, then the SESSION directory — which is where the journal
    // and marker entries live — then the entry naming that session. Innermost first, because an entry
    // lives in its immediate parent and neither sync substitutes for the other.
    should(await readFile(paths.marker, 'utf8')).equal('2\n');
    should(synced).eql([paths.directory, opened.paths.sessions]);
  });

  it('should make a repeated reservation persist the sessions entry again', async () => {
    // Arrange: a retried start reserves twice, and the second attempt creates nothing.
    const opened = await openTemporaryStorage();
    const synced: string[] = [];
    const subject = new StorageSessionLifecycleRepository(opened.storage, undefined, async path => {
      synced.push(path);
    });
    const id = parseSessionId('reserved-repeat');

    // Act — the second call creates nothing at all.
    await subject.reserve(id);
    await subject.reserve(id);

    // Assert: unconditional, and BOTH directories each time. The retry is precisely the call that
    // must sync: storage publishes the marker with an atomic rename and syncs the session directory
    // after it, so an attempt that dies in between leaves a marker a later `ensureSessionDirectory`
    // merely OBSERVES — returning without syncing anything. A created-only rule would skip exactly
    // the call that owes the barrier.
    const directory = createSessionPaths(opened.paths, id).directory;
    should(synced).eql([directory, opened.paths.sessions, directory, opened.paths.sessions]);
  });

  it('should make every concurrent reservation persist the sessions entry on its own behalf', async () => {
    // Arrange: two ids, so they do not share the per-session queue and can genuinely interleave.
    const opened = await openTemporaryStorage();
    const synced: string[] = [];
    const subject = new StorageSessionLifecycleRepository(opened.storage, undefined, async path => {
      synced.push(path);
    });

    // Act
    await Promise.all([subject.reserve(parseSessionId('reserved-a')), subject.reserve(parseSessionId('reserved-b'))]);

    // Assert: each reservation syncs its own session directory and then the shared parent, in that
    // order. Neither relies on the other eventually persisting anything.
    should(synced.filter(path => path === opened.paths.sessions)).have.length(2);
    for (const id of ['reserved-a', 'reserved-b']) {
      const directory = createSessionPaths(opened.paths, parseSessionId(id)).directory;
      should(synced.filter(path => path === directory)).have.length(1);
      should(synced.indexOf(directory)).be.below(synced.lastIndexOf(opened.paths.sessions));
    }
  });

  it('should still publish no session document from a reservation that persists its parent', async () => {
    // Arrange
    const opened = await openTemporaryStorage();
    const subject = new StorageSessionLifecycleRepository(opened.storage);
    const id = parseSessionId('reserved-invisible');

    // Act
    await subject.reserve(id);

    // Assert: durability of the NAME is not publication of the session.
    should(await subject.read(id)).equal(undefined);
    should(opened.storage.findSession(id)).equal(undefined);
  });

  it('should recover a reservation torn after its empty journal but before its marker', async () => {
    // Arrange — marker-last reservation can leave exactly this prefix and no session document.
    const opened = await openTemporaryStorage();
    const subject = new StorageSessionLifecycleRepository(opened.storage);
    const id = parseSessionId('torn-reservation');
    const paths = createSessionPaths(opened.paths, id);
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.events, '');

    // Act + Assert — the lifecycle's collision read sees no record, and retrying reservation repairs
    // the layout without fabricating config, state, or an event.
    should(await subject.read(id)).be.undefined();
    await subject.reserve(id);
    should(await subject.read(id)).be.undefined();
    should(await readFile(paths.marker, 'utf8')).equal('2\n');
    should((await stat(paths.events)).size).equal(0);
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
      // A session with no stored environment still launches carrying its OWN id: the identity is
      // derived from the record, so it does not depend on a file the session may never have had.
      [
        'new-session',
        '-d',
        '-s',
        'fy-tmux-session',
        '-c',
        '/workspace/project',
        '-e',
        'FY_SESSION_ID=tmux-session',
        AGENT,
        '--mode',
        'auto',
      ],
      ['set-option', '-t', 'fy-tmux-session', 'remain-on-exit', 'on'],
      ['has-session', '-t', 'fy-tmux-session'],
      ['has-session', '-t', 'fy-tmux-session'],
      ['kill-session', '-t', 'fy-tmux-session'],
    ]);
  });

  it('should register a launched pane and wait publicly for its startup prompt', async () => {
    // Arrange — use the real launcher, controller and delivery adapter over an inspectable tmux port.
    const port = new RecordingTmuxPort();
    const slept: number[] = [];
    const registered: SessionLifecycleRecord[] = [];
    const controller = new TmuxController(port);
    const subject = new TmuxSessionLifecycleLauncher(
      controller,
      new TmuxPaneDelivery(controller, async milliseconds => {
        slept.push(milliseconds);
      }),
      undefined,
      {
        register: async actual => {
          await Promise.resolve();
          registered.push(actual);
        },
      },
    );
    const input = record('registered-session');

    // Act — registration is part of a completed launch; readiness is a separate public startup step.
    await subject.launch(input);
    port.calls.length = 0;
    port.pollsBeforeReady = 1;
    await subject.ready(input);

    // Assert — the registrar sees the complete record only once launch has completed, while ready only polls.
    should(registered).deepEqual([input]);
    should(slept).deepEqual([100]);
    should(port.commands().filter(command => command === 'display-message')).have.length(2);
    should(port.commands().filter(command => command === 'capture-pane')).have.length(4);
    should(port.commands()).not.containEql('send-keys');
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

  it('should persist the document, its directory and the entries naming it before returning', async () => {
    // Arrange: the lifecycle writes this and then begins the durable turn-one effect, so a document
    // that only reached the page cache lets a power cut strand a session that can never be assigned.
    const home = await mkdtemp(join(tmpdir(), 'ferretry-task-store-'));
    homes.add(home);
    const id = parseSessionId('durable-session');
    const synced: string[] = [];
    const subject = new FileSessionTaskStore(
      session => join(home, session),
      () => 'fixed-id',
      async path => {
        synced.push(path);
      },
    );

    // Act
    const file = await subject.writeAssignedTask(id, 'work\n');

    // Assert: parents first and oldest ancestor first — this mkdir created both the session
    // directory and `turns`, so the chain reaches the home that names the session — then the turns
    // directory again once the rename has published the file into it.
    const turns = join(home, 'durable-session', 'turns');
    should(synced).eql([home, join(home, 'durable-session'), turns, turns]);
    should(await readFile(file, 'utf8')).equal('work\n');
    should(await readdir(turns)).eql(['turn-001.md']);
  });

  it('should sync an identical replay in place rather than replacing the inode', async () => {
    // Arrange: a retried launch and a fork replay both arrive with byte-identical content, and the
    // agent may be mid-read of the very file it was told to open.
    const home = await mkdtemp(join(tmpdir(), 'ferretry-task-store-'));
    homes.add(home);
    const id = parseSessionId('replayed-session');
    const synced: string[] = [];
    const subject = new FileSessionTaskStore(
      session => join(home, session),
      () => 'fixed-id',
      async path => {
        synced.push(path);
      },
    );
    const file = await subject.writeAssignedTask(id, 'same\n');
    const before = await stat(file);
    synced.length = 0;

    // Act
    const again = await subject.writeAssignedTask(id, 'same\n');

    // Assert: the same inode, still durable, and no temporary left behind. The SESSION directory is
    // synced even though this call created nothing — the attempt that created `turns` may not have
    // reached its own sync, so each call persists the entry naming it on its own behalf.
    should(again).equal(file);
    should((await stat(file)).ino).equal(before.ino);
    const replayedTurns = join(home, 'replayed-session', 'turns');
    should(synced).eql([join(home, 'replayed-session'), replayedTurns, replayedTurns]);
    should(await readdir(join(home, 'replayed-session', 'turns'))).eql(['turn-001.md']);
  });

  it('should replace differing content atomically and leave no temporary behind', async () => {
    // Arrange
    const home = await mkdtemp(join(tmpdir(), 'ferretry-task-store-'));
    homes.add(home);
    const id = parseSessionId('changed-session');
    const subject = new FileSessionTaskStore(
      session => join(home, session),
      () => 'fixed-id',
    );
    const file = await subject.writeAssignedTask(id, 'first\n');
    const before = await stat(file);

    // Act
    await subject.writeAssignedTask(id, 'second\n');

    // Assert: a genuinely different assignment does replace the inode, which is what makes the
    // publication atomic — a reader sees one document or the other, never a mixture.
    should(await readFile(file, 'utf8')).equal('second\n');
    should((await stat(file)).ino).not.equal(before.ino);
    should(await readdir(join(home, 'changed-session', 'turns'))).eql(['turn-001.md']);
  });

  it('should refuse when the path stops naming the document it proved, without overwriting it', async () => {
    // Arrange: the exact-replay path proves an inode, then syncs the directory — and THAT await is
    // when a concurrent writer can publish over the name by rename. The substitution happens inside
    // the injected sync, so the interleaving is the test's rather than a hope about timing.
    //
    // The seam fires for the parent walk first (`<session>`, then `turns`) and again for `turns` after
    // the document is proved, so the substitution is armed for the SECOND `turns` sync — the only one
    // that lands after the handle exists. If the walk ever changes shape, this counter is what to fix.
    const home = await mkdtemp(join(tmpdir(), 'ferretry-task-store-'));
    homes.add(home);
    const id = parseSessionId('substituted-session');
    const turns = join(home, 'substituted-session', 'turns');
    const published = join(turns, 'turn-001.md');
    let armed = false;
    let turnsSyncs = 0;
    let substituted = false;
    const subject = new FileSessionTaskStore(
      session => join(home, session),
      () => 'fixed-id',
      async path => {
        if (!armed || path !== turns) return;
        turnsSyncs += 1;
        if (turnsSyncs !== 2 || substituted) return;
        substituted = true;
        // Another writer publishing its own document at the same name, by rename, so the path now
        // reaches a different inode while this call still holds the one it proved.
        const theirs = join(turns, 'theirs.tmp');
        await writeFile(theirs, 'somebody else won the race\n', { encoding: 'utf8', mode: 0o600 });
        await rename(theirs, published);
      },
    );
    await subject.writeAssignedTask(id, 'same\n');
    armed = true;

    // Act: a byte-identical replay, which is the path that claims "the same inode, still durable".
    let refused: Error | undefined;
    try {
      await subject.writeAssignedTask(id, 'same\n');
    } catch (error) {
      refused = error as Error;
    }

    // Assert: it refused rather than reporting a replay it could no longer vouch for, and it did NOT
    // fall through to the overwrite path — the document that won the race is untouched.
    should(substituted).equal(true);
    should(refused?.message).match(/stopped naming the turn-one document this write proved/u);
    should(await readFile(published, 'utf8')).equal('somebody else won the race\n');
  });

  it('should stop owning the temporary name once the document is published', async () => {
    // Arrange: the interleaving itself. After the rename the name is free again, and the directory
    // sync that follows is an await — so the foreign temporary is created DURING that await, which is
    // exactly when a real second writer would take the reused name. Deterministic: the injected sync
    // is the scheduling point rather than a hope about timing.
    const home = await mkdtemp(join(tmpdir(), 'ferretry-task-store-'));
    homes.add(home);
    const id = parseSessionId('published-session');
    const reused = join(home, 'published-session', 'turns', 'turn-001.md.fixed-id.tmp');
    let plantedDuringSync = false;
    const subject = new FileSessionTaskStore(
      session => join(home, session),
      () => 'fixed-id',
      async () => {
        if (plantedDuringSync) return;
        if ((await stat(join(home, 'published-session', 'turns', 'turn-001.md')).catch(() => undefined)) === undefined)
          return;
        plantedDuringSync = true;
        await writeFile(reused, 'another writer\n', { encoding: 'utf8', mode: 0o600 });
      },
    );

    // Act
    const file = await subject.writeAssignedTask(id, 'first\n');

    // Assert: the document is published and the stranger's temporary — created while this call was
    // still inside its own sync — survived the cleanup on the way out.
    should(plantedDuringSync).equal(true);
    should(await readFile(file, 'utf8')).equal('first\n');
    should(await readFile(reused, 'utf8')).equal('another writer\n');
  });

  it('should stop owning the environment temporary once the credential file is published', async () => {
    // Arrange: the same window, in the one file that holds a session's plaintext credential.
    const opened = await openTemporaryStorage();
    const id = parseSessionId('published-environment');
    const directory = createSessionPaths(opened.paths, id).directory;
    const reused = join(directory, 'environment.json.fixed-id.tmp');
    let plantedDuringSync = false;
    const subject = new FileSessionEnvironmentStore(
      held => createSessionPaths(opened.paths, held).directory,
      () => 'fixed-id',
      async () => {
        plantedDuringSync = true;
        await writeFile(reused, 'another writer\n', { encoding: 'utf8', mode: 0o600 });
      },
    );

    // Act
    await subject.write(id, { FY_SESSION_BOARD_CAPABILITY: 'mine' });

    // Assert: the credential is published and the stranger's temporary survives. Cleanup reaching
    // past the rename here would destroy the only copy of somebody else's session credential.
    should(plantedDuringSync).equal(true);
    should(await subject.read(id)).eql({ FY_SESSION_BOARD_CAPABILITY: 'mine' });
    should(await readFile(reused, 'utf8')).equal('another writer\n');
  });

  it('should never delete a colliding temporary it did not create', async () => {
    // Arrange: a temporary already at the name this call would use — another writer's in-flight
    // document. A fixed unique id makes the collision certain rather than astronomically unlikely.
    const home = await mkdtemp(join(tmpdir(), 'ferretry-task-store-'));
    homes.add(home);
    const id = parseSessionId('collided-session');
    const subject = new FileSessionTaskStore(
      session => join(home, session),
      () => 'fixed-id',
    );
    const turns = join(home, 'collided-session', 'turns');
    await mkdir(turns, { recursive: true, mode: 0o700 });
    const foreign = join(turns, 'turn-001.md.fixed-id.tmp');
    await writeFile(foreign, 'someone else is mid-write\n', { encoding: 'utf8', mode: 0o600 });

    // Act
    let refused: unknown;
    try {
      await subject.writeAssignedTask(id, 'mine\n');
    } catch (error) {
      refused = error;
    }

    // Assert: the exclusive create lost, so this call owns nothing — and cleaning up on the way out
    // would have destroyed the other writer's document.
    should((refused as NodeJS.ErrnoException | undefined)?.code).equal('EEXIST');
    should(await readFile(foreign, 'utf8')).equal('someone else is mid-write\n');
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
        effects: new FileSessionEffectLedger(id => createSessionPaths(opened.paths, id).directory),
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
        effects: new FileSessionEffectLedger(id => createSessionPaths(opened.paths, id).directory),
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
    // The stored secret and the DERIVED identity compose rather than displacing one another: the
    // pane gets both, in the same launch, under the two names the CLI reads.
    should(newSession).containDeep(['-e', `FY_SESSION_ID=${id}`]);
    // The id is never written into the environment document. It is on the record already, so storing
    // it would only create a second copy that a merge could contradict.
    should(await environment.read(id)).not.have.property('FY_SESSION_ID');
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
  it('should never delete a colliding environment temporary it did not create', async () => {
    // Arrange: this file is the only place a session's plaintext credential lives, so destroying
    // another writer's in-flight document on the way out of a failure is the worst possible cleanup.
    const opened = await openTemporaryStorage();
    const id = parseSessionId('collided-environment');
    const directory = createSessionPaths(opened.paths, id).directory;
    const subject = new FileSessionEnvironmentStore(
      held => createSessionPaths(opened.paths, held).directory,
      () => 'fixed-id',
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const foreign = join(directory, 'environment.json.fixed-id.tmp');
    await writeFile(foreign, 'another writer\n', { encoding: 'utf8', mode: 0o600 });

    // Act
    let refused: NodeJS.ErrnoException | undefined;
    try {
      await subject.write(id, { FY_SESSION_BOARD_CAPABILITY: 'mine' });
    } catch (error) {
      refused = error as NodeJS.ErrnoException;
    }

    // Assert: the exclusive create lost, so this call owns nothing and cleans up nothing.
    should(refused?.code).equal('EEXIST');
    should(await readFile(foreign, 'utf8')).equal('another writer\n');
  });

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

/** An errno-shaped rejection, exactly as the platform raises one. */
function directoryRefusal(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`the platform refused a directory sync with ${code}`), { code });
}

/**
 * A directory handle that opens and then refuses to sync.
 *
 * The sync-side branch cannot be reached from outside on any filesystem this repository is
 * developed or tested against: all of them sync a directory successfully. The fake varies only
 * which errno the sync raises — the open, the path and the close are still the helper's own.
 */
function handleRefusingToSync(code: string, closes: string[]): FileHandle {
  return {
    async sync(): Promise<void> {
      throw directoryRefusal(code);
    },
    async close(): Promise<void> {
      closes.push('closed');
    },
  } as unknown as FileHandle;
}

/**
 * The repo-standard directory-sync tolerance, across the whole open-then-sync operation.
 *
 * A filesystem that cannot sync a directory usually says so by refusing the READ-ONLY OPEN, not by
 * failing the fsync behind it, so tolerating only the sync left each helper's stated contract untrue
 * on exactly the platforms it was written for. Every lifecycle module that persists a directory
 * entry is driven here, because each carries its own copy of the helper and a fix applied to one of
 * them says nothing about the others.
 */
describe('lifecycle directory durability', () => {
  // Typed to ONE signature rather than inferred `as const`: the three exports are distinct
  // functions, and an inferred union of them would be a union of call signatures rather than the
  // single contract every one of them is required to keep.
  const helpers: ReadonlyArray<{
    readonly owner: string;
    readonly fsyncDirectory: (path: string, openDirectory?: (target: string) => Promise<FileHandle>) => Promise<void>;
  }> = [
    { owner: 'StorageSessionLifecycleRepository', fsyncDirectory: fsyncReservedDirectory },
    { owner: 'FileSessionTaskStore', fsyncDirectory: fsyncTaskDirectory },
    { owner: 'FileSessionEnvironmentStore', fsyncDirectory: fsyncEnvironmentDirectory },
  ];

  for (const { owner, fsyncDirectory } of helpers) {
    for (const code of ['EINVAL', 'ENOTSUP', 'EPERM']) {
      it(`should tolerate ${code} from the directory open in ${owner}`, async () => {
        // Arrange
        const opened: string[] = [];

        // Act: resolving at all is the assertion — a helper that fell through would sync a handle it
        // never received.
        await fsyncDirectory('/state/sessions', async path => {
          opened.push(path);
          throw directoryRefusal(code);
        });

        // Assert
        should(opened).eql(['/state/sessions']);
      });

      it(`should tolerate ${code} from the sync in ${owner}, and still close the handle`, async () => {
        // Arrange
        const closes: string[] = [];

        // Act
        await fsyncDirectory('/state/sessions', async () => handleRefusingToSync(code, closes));

        // Assert
        should(closes).eql(['closed']);
      });
    }

    it(`should propagate an open failure in ${owner} that is not a platform refusal`, async () => {
      // Act + Assert: EIO is a real failure to persist, and swallowing it would report an entry
      // durable that is not.
      await should(
        fsyncDirectory('/state/sessions', async () => {
          throw directoryRefusal('EIO');
        }),
      ).be.rejectedWith(/EIO/u);
    });

    it(`should propagate a sync failure in ${owner}, and still close the handle`, async () => {
      // Arrange
      const closes: string[] = [];

      // Act + Assert
      await should(fsyncDirectory('/state/sessions', async () => handleRefusingToSync('EIO', closes))).be.rejectedWith(
        /EIO/u,
      );
      should(closes).eql(['closed']);
    });

    it(`should persist a real directory through the default opener in ${owner}`, async () => {
      // Arrange: the default argument is what production uses, so it has to be exercised unwrapped.
      const home = await mkdtemp(join(tmpdir(), 'fy-lifecycle-fsync-'));
      homes.add(home);

      // Act + Assert: a real open and a real fsync of a real directory.
      await fsyncDirectory(home);
    });
  }
});
