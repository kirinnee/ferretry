import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  BunTmuxProcess,
  DaemonStorageFactory,
  DurableTerminalPaneRegistrar,
  DurableTerminalPaneStore,
  ExactTmuxPaneReaper,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystem,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../../../src/adapters/index.ts';
import {
  createSessionPaths,
  createSessionRecord,
  defaultSessionLifecycleSettings,
  parseSessionId,
  type RegisteredTerminalPane,
  TerminalReapService,
  TmuxController,
} from '../../../../src/lib/index.ts';

const DAEMON = 'reap-test-daemon';
const NOW = '2026-08-01T10:00:00.000Z';
const AGENT = '/opt/fleet/bin/claude-auto-loge';
const cleanups = new Set<() => Promise<void>>();

interface ReapFixture {
  readonly home: string;
  readonly files: StateFileSystem;
  readonly storage: Awaited<ReturnType<DaemonStorageFactory['open']>>['storage'];
  readonly record: ReturnType<typeof createSessionRecord>['record'];
  readonly controller: TmuxController;
  readonly registrar: DurableTerminalPaneRegistrar;
  readonly store: DurableTerminalPaneStore;
  readonly runtime: ExactTmuxPaneReaper;
  readonly tmuxExecutable: string;
}

function lifecycleRecord(id = 'reap-session') {
  return createSessionRecord(
    { agent: AGENT, cwd: process.cwd(), mode: 'auto', prompt: 'Keep this pane alive', command: [AGENT] },
    { id: parseSessionId(id), cwd: process.cwd(), at: NOW, settings: defaultSessionLifecycleSettings },
  ).record;
}

async function fixture(id = 'reap-session'): Promise<ReapFixture> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-terminal-reap-'));
  const tmuxExecutable = Bun.which('tmux');
  if (tmuxExecutable === null) throw new Error('tmux is required for terminal-reap integration coverage');
  const opened = await new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  ).open();
  const record = lifecycleRecord(id);
  // The lifecycle store creates the directory and journal before its launcher writes a pane
  // registration there; a registrar must never create a bare session directory by itself.
  await opened.storage.writeState(record.config.id, { id: record.config.id, status: 'created' });
  const tmux = new BunTmuxProcess(tmuxExecutable, join(home, 'throwaway-tmux.sock'));
  const controller = new TmuxController(tmux);
  // A fresh private server assigns its first pane `%0`; the production registrar and reaper must
  // prove that real first-pane identity rather than avoiding it with a bootstrap session.
  await controller.launch({
    session: record.config.tmuxSession,
    cwd: process.cwd(),
    command: ['/bin/sh', '-c', 'exec sleep 600'],
  });
  const files = new StateFileSystem(opened.paths);
  const registrar = new DurableTerminalPaneRegistrar(DAEMON, controller, files, opened.paths);
  const store = new DurableTerminalPaneStore(opened.storage, files, opened.paths);
  const runtime = new ExactTmuxPaneReaper(controller);
  cleanups.add(async () => {
    await controller.stop(record.config.tmuxSession);
    await opened.storage.close();
    await rm(home, { recursive: true, force: true });
  });
  return { home, files, storage: opened.storage, record, controller, registrar, store, runtime, tmuxExecutable };
}

function service(subject: ReapFixture, runtime = subject.runtime): TerminalReapService {
  return new TerminalReapService(
    DAEMON,
    { list: daemonId => subject.store.registrations(daemonId) },
    { list: daemonId => subject.store.sessions(daemonId) },
    runtime,
    runtime,
  );
}

async function complete(subject: ReapFixture): Promise<void> {
  await subject.storage.writeState(subject.record.config.id, {
    id: subject.record.config.id,
    status: 'completed',
    finishedAt: NOW,
  });
}

async function registration(subject: ReapFixture): Promise<RegisteredTerminalPane> {
  const [actual] = await subject.store.registrations(DAEMON);
  if (actual === undefined) throw new Error('test setup did not persist a terminal pane registration');
  return actual;
}

afterEach(async () => {
  await Promise.all([...cleanups].map(cleanup => cleanup()));
  cleanups.clear();
});

describe('durable terminal pane reap adapters', () => {
  it('should round-trip a registration only from the durable directory that owns it', async () => {
    // Arrange
    const subject = await fixture();
    await subject.registrar.register(subject.record);
    const path = createSessionPaths(subject.storage.paths, subject.record.config.id).terminalPane;
    const persisted = JSON.parse(await readFile(path, 'utf8')) as RegisteredTerminalPane;
    should(persisted.paneId).equal('%0');
    const foreignId = parseSessionId('foreign-session');
    await subject.storage.writeState(foreignId, { id: foreignId, status: 'completed', finishedAt: NOW });
    await subject.files.writeTextAtomic(
      createSessionPaths(subject.storage.paths, foreignId).terminalPane,
      `${JSON.stringify(persisted)}\n`,
    );

    // Act
    const actual = await subject.store.registrations(DAEMON);

    // Assert -- the forged copy is ignored because its directory does not own its session id.
    should(actual).deepEqual([persisted]);
  });

  it('should reap an exact terminal pane after its durable terminal state is recorded', async () => {
    // Arrange
    const subject = await fixture();
    await subject.registrar.register(subject.record);
    await complete(subject);

    // Act
    const actual = await service(subject).sweep();

    // Assert
    should(actual).deepEqual({ planned: 1, reaped: 1 });
    should(await subject.controller.alive(subject.record.config.tmuxSession)).be.false();
  });

  it('should refuse observations whose pane id, pid, or process incarnation differs', async () => {
    // Arrange
    const subject = await fixture();
    await subject.registrar.register(subject.record);
    await complete(subject);
    const original = await registration(subject);
    const path = createSessionPaths(subject.storage.paths, subject.record.config.id).terminalPane;
    const disagreements = [
      { ...original, paneId: '%999999' },
      { ...original, pid: original.pid + 1 },
      { ...original, processStartTicks: original.processStartTicks + 1 },
    ];

    // Act + Assert -- each registry value reaches the real tmux observer, but none may be killed.
    for (const mismatch of disagreements) {
      await subject.files.writeTextAtomic(path, `${JSON.stringify(mismatch)}\n`);
      should(await service(subject).sweep()).deepEqual({ planned: 0, reaped: 0 });
      should(await subject.controller.alive(subject.record.config.tmuxSession)).be.true();
    }
  });

  it('should treat a missing tmux server or an already-gone pane as a refusal', async () => {
    // Arrange
    const subject = await fixture();
    await subject.registrar.register(subject.record);
    await complete(subject);
    const missingServer = new ExactTmuxPaneReaper(
      new TmuxController(new BunTmuxProcess(subject.tmuxExecutable, join(subject.home, 'never-started.sock'))),
    );

    // Act + Assert -- both failures merely withhold the exact observation from the sweep.
    should(await service(subject, missingServer).sweep()).deepEqual({ planned: 0, reaped: 0 });
    await subject.controller.stop(subject.record.config.tmuxSession);
    should(await service(subject).sweep()).deepEqual({ planned: 0, reaped: 0 });
  });

  it('should refuse a pane id that now identifies a different process incarnation', async () => {
    // Arrange
    const subject = await fixture();
    await subject.registrar.register(subject.record);
    const original = await registration(subject);

    // Act -- tmux resolves the real pane id, but the supplied registration is for another process.
    await subject.runtime.reap({ ...original, pid: original.pid + 1 });

    // Assert
    should(await subject.controller.alive(subject.record.config.tmuxSession)).be.true();
  });

  it('should not ask tmux to kill anything when this daemon has no registrations', async () => {
    // Arrange
    const subject = await fixture();

    // Act
    const actual = await service(subject).sweep();

    // Assert -- the live pane is intentionally unregistered, so the adapter never discovers it.
    should(actual).deepEqual({ planned: 0, reaped: 0 });
    should(await subject.controller.alive(subject.record.config.tmuxSession)).be.true();
  });
});

/**
 * One hand-edited registration, read by the two callers that want opposite things from it.
 *
 * A sweep KILLS, so a ledger it cannot read whole is not one it may act on at all. A settings
 * surface reports, so it wants the panes that ARE readable plus the name of the one that is not —
 * a thrown exception there took the whole resource-limit panel down on one bad file.
 */
describe('a registration ledger with one damaged document', () => {
  const DAMAGED = 'reap-damaged';

  async function damage(subject: ReapFixture, text: string): Promise<void> {
    const sessionId = parseSessionId(DAMAGED);
    await subject.storage.writeState(sessionId, { id: sessionId, status: 'running' });
    await subject.files.writeTextAtomic(createSessionPaths(subject.storage.paths, sessionId).terminalPane, text);
  }

  it('should name the damaged session and still hand back every readable registration', async () => {
    // Arrange
    const subject = await fixture();
    await subject.registrar.register(subject.record);
    await damage(subject, '{ not json at all');

    // Act
    const scanned = await subject.store.scan(DAEMON);

    // Assert
    should(scanned.registrations.map(value => value.sessionId)).deepEqual(['reap-session']);
    should(scanned.damaged.map(value => value.sessionId)).deepEqual([DAMAGED]);
  });

  it('should refuse the REAP view of that same ledger', async () => {
    // Arrange
    const subject = await fixture();
    await subject.registrar.register(subject.record);
    await damage(subject, '{ not json at all');

    // Act / Assert
    await should(subject.store.registrations(DAEMON)).be.rejectedWith(/unreadable terminal pane registration/u);
  });

  it('should let the session listing carry on past it', async () => {
    // Arrange
    const subject = await fixture();
    await subject.registrar.register(subject.record);
    await damage(subject, '{ not json at all');

    // Act / Assert -- the limits surface reads this, and one bad file may not blank it.
    should((await subject.store.sessions(DAEMON)).map(value => value.sessionId)).deepEqual(['reap-session']);
  });

  it('should refuse every shape that is not a complete, safe registration', async () => {
    // Arrange -- each of these is a distinct way a document stops being authority for a pane.
    const shapes: readonly { readonly text: string; readonly reported: RegExp }[] = [
      { text: JSON.stringify({ daemonId: 7 }), reported: /malformed/u },
      { text: JSON.stringify({ daemonId: DAEMON, sessionId: DAMAGED }), reported: /incomplete/u },
      {
        text: JSON.stringify({
          daemonId: DAEMON,
          sessionId: DAMAGED,
          tmuxSession: 'fy-damaged',
          paneId: 'not-a-pane-id',
          pid: 4242,
          processStartTicks: 99,
        }),
        reported: /invalid/u,
      },
    ];

    for (const shape of shapes) {
      const subject = await fixture();
      await damage(subject, shape.text);

      // Act
      const scanned = await subject.store.scan(DAEMON);

      // Assert
      should(scanned.damaged).have.length(1);
      const [first] = scanned.damaged;
      should(first === undefined ? '' : String(first.error)).match(shape.reported);
    }
  });
});
