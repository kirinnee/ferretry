import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processIncarnationFor } from '@ferretry/protocol/process-incarnation';
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
  SessionAttachService,
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

/** A harness that waits for `gate` and then runs `script` -- exiting only when the test says so. */
function gatedHarness(gate: string, script: string): readonly [string, ...string[]] {
  return ['/bin/sh', '-c', `while [ ! -e '${gate}' ]; do sleep 0.05; done; ${script}`];
}

/**
 * @param exits When given, the first pane runs this script to its end instead of `sleep 600`, and the
 *   fixture returns once tmux holds it as a dead pane with that script's exit status. The pane is the
 *   private server's FIRST, never a relaunch: stopping the only session makes tmux exit asynchronously,
 *   and a server started on the same socket while the old one is still leaving can lose its socket to
 *   the old server's exit-time unlink, so the new session reads as gone for good.
 */
async function fixture(exits?: string): Promise<ReapFixture> {
  const id = 'reap-session';
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
  const socket = join(home, 'throwaway-tmux.sock');
  const tmux = new BunTmuxProcess(tmuxExecutable, socket);
  const controller = new TmuxController(tmux);
  // A fresh private server assigns its first pane `%0`; the production registrar and reaper must
  // prove that real first-pane identity rather than avoiding it with a bootstrap session.
  const gate = join(home, 'harness-may-exit');
  await controller.launch({
    session: record.config.tmuxSession,
    cwd: process.cwd(),
    command: exits === undefined ? ['/bin/sh', '-c', 'exec sleep 600'] : gatedHarness(gate, exits),
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
  if (exits !== undefined) await awaitExit(controller, record.config.tmuxSession, gate, { tmuxExecutable, socket });
  return { home, files, storage: opened.storage, record, controller, registrar, store, runtime, tmuxExecutable };
}

/**
 * The gate is opened only once launch() has returned, so remain-on-exit is already set and the pane
 * can only end as a dead pane. The wait is for an exit STATUS, not just `dead`: a metadata read that
 * fails under load also reads as dead, and registering then would find the process still running. The
 * bound is generous because it is only ever spent when something is wrong.
 *
 * tmux 3.4 (the CI runner's) can miss the SIGCHLD of a pane process that ends: the pane reads dead, but
 * the process stays an unreaped zombie and tmux never learns its status -- on CI 23 of 40 panes sat
 * like that until the server was sent another SIGCHLD, which makes it reap at once. So a dead pane
 * without a status gets that signal; it is a harmless "reap anything finished" request to the server.
 */
async function awaitExit(
  controller: TmuxController,
  session: string,
  gate: string,
  server: { readonly tmuxExecutable: string; readonly socket: string },
): Promise<void> {
  await writeFile(gate, '');
  const deadline = Date.now() + 30_000;
  let last = 'no state read';
  while (Date.now() < deadline) {
    const pane = await controller.state(session);
    last = JSON.stringify({ alive: pane.alive, dead: pane.dead, exitCode: pane.exitCode });
    if (pane.alive && pane.dead && pane.exitCode === 2) return;
    if (pane.alive && pane.dead && pane.exitCode === undefined) askServerToReap(server);
    await Bun.sleep(50);
  }
  throw new Error(`test setup: the pane never exited (last state ${last})`);
}

function askServerToReap(server: { readonly tmuxExecutable: string; readonly socket: string }): void {
  const asked = Bun.spawnSync([server.tmuxExecutable, '-S', server.socket, 'display-message', '-p', '#{pid}'], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const pid = Number(new TextDecoder().decode(asked.stdout).trim());
  if (Number.isInteger(pid) && pid > 1) process.kill(pid, 'SIGCHLD');
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

  it('should prove an attach target whose start identity is the one the CLI reads back from the live pane', async () => {
    // Arrange
    const subject = await fixture();
    await subject.registrar.register(subject.record);
    const attach = new SessionAttachService(
      DAEMON,
      '/run/user/1000/fy/tmux.sock',
      { list: daemonId => subject.store.registrations(daemonId) },
      subject.runtime,
    );

    // Act
    const target = await attach.resolve(subject.record.config.id);

    // Assert -- `fy attach` re-reads this value through `@ferretry/protocol/process-incarnation`;
    // if the daemon wrote it any other way, every attach on that platform would be refused.
    should(target.processStartTicks).equal(await processIncarnationFor().startOf(target.pid));
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

  it('should answer every observation asked for at once from ONE listing of the panes', async () => {
    // Arrange
    const subject = await fixture();
    await subject.registrar.register(subject.record);
    const original = await registration(subject);
    const real = new BunTmuxProcess(subject.tmuxExecutable, join(subject.home, 'throwaway-tmux.sock'));
    const asked: string[] = [];
    const counted = new ExactTmuxPaneReaper(
      new TmuxController({
        execute: async (arguments_, stdin) => {
          asked.push(arguments_[0] as string);
          return await real.execute(arguments_, stdin);
        },
      }),
    );

    // Act
    const observed = await Promise.all([
      counted.observe(original),
      counted.observe(original),
      counted.observe(original),
    ]);
    const later = await counted.observe(original);

    // Assert — one listing for the three asked together, a fresh one for the one asked after.
    should(observed).deepEqual([original, original, original].map(({ daemonId: _d, sessionId: _s, ...pane }) => pane));
    should(later).deepEqual(observed[0]);
    should(asked).deepEqual(['list-panes', 'list-panes']);
  });

  it('should ask about the pane on its own when tmux will not list the panes', async () => {
    // Arrange
    const subject = await fixture();
    await subject.registrar.register(subject.record);
    const original = await registration(subject);
    const real = new BunTmuxProcess(subject.tmuxExecutable, join(subject.home, 'throwaway-tmux.sock'));
    const asked: string[] = [];
    const refusing = new ExactTmuxPaneReaper(
      new TmuxController({
        execute: async (arguments_, stdin) => {
          asked.push(arguments_[0] as string);
          return arguments_[0] === 'list-panes'
            ? { code: 1, stdout: '', stderr: 'server exited unexpectedly\n' }
            : await real.execute(arguments_, stdin);
        },
      }),
    );

    // Act
    const actual = await refusing.observe(original);

    // Assert
    should(actual).match({ paneId: original.paneId, pid: original.pid });
    should(asked).deepEqual(['list-panes', 'display-message']);
  });

  it('should withhold the observation of a live pane whose process start cannot be read, and never kill it', async () => {
    // Arrange -- the pane is real and listed, but its incarnation cannot be proved.
    const subject = await fixture();
    await subject.registrar.register(subject.record);
    const original = await registration(subject);
    const unreadable = new ExactTmuxPaneReaper(subject.controller, { startOf: async () => undefined });

    // Act
    const observed = await unreadable.observe(original);
    await unreadable.reap(original);

    // Assert -- no identity means no authority: nothing is observed and the pane is left running.
    should(observed).be.undefined();
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
 * A harness that exits before its pane is registered — the start the owner saw fail as "no stable
 * incarnation identity" on every provider runtime. tmux keeps the dead pane and its pid, the process
 * is gone, and the reason must be the exit and what the process printed, not the identity read.
 */
describe('registering a pane whose harness has already exited', () => {
  it('should report the exit status and the last output instead of the identity read', async () => {
    // Arrange
    const subject = await fixture(`echo 'ferretry: DEEPSEEK_TOKEN is not set' >&2; exit 2`);

    // Act / Assert
    await should(subject.registrar.register(subject.record)).be.rejectedWith(
      'the interactive harness exited (2): its last output was "ferretry: DEEPSEEK_TOKEN is not set"',
    );
  });

  it('should still refuse a live pane whose process start cannot be read', async () => {
    // Arrange
    const subject = await fixture();
    const registrar = new DurableTerminalPaneRegistrar(
      DAEMON,
      subject.controller,
      subject.files,
      subject.storage.paths,
      {
        startOf: async () => undefined,
      },
    );

    // Act / Assert -- nothing on disk may claim a pane it cannot tell from a later one.
    await should(registrar.register(subject.record)).be.rejectedWith(
      'the launched pane process has no stable incarnation identity',
    );
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

  it('should survey once for two scans asked together, and see a registration change between scans', async () => {
    // Arrange — a sweep asks for the registrations and the sessions in the same breath.
    const subject = await fixture();
    await subject.registrar.register(subject.record);
    const survey = subject.storage.sessionIdsOnDisk.bind(subject.storage);
    let surveys = 0;
    subject.storage.sessionIdsOnDisk = async () => {
      surveys += 1;
      return await survey();
    };

    // Act
    const [first, second] = await Promise.all([subject.store.scan(DAEMON), subject.store.scan(DAEMON)]);
    const together = surveys;
    await damage(subject, '{ not json at all');
    const later = await subject.store.scan(DAEMON);

    // Assert
    should(together).equal(1);
    should(second).equal(first);
    should(later.damaged.map(value => value.sessionId)).deepEqual([DAMAGED]);
    should(surveys).equal(2);
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
      { text: JSON.stringify('a registration'), reported: /malformed/u },
      { text: JSON.stringify([DAEMON]), reported: /malformed/u },
      { text: 'null', reported: /malformed/u },
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
