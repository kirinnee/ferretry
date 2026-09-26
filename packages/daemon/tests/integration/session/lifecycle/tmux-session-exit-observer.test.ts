import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  BunTmuxProcess,
  DaemonStorageFactory,
  DurableTerminalPaneRegistrar,
  DurableTerminalPaneStore,
  InMemoryLaunchGate,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystem,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
  TmuxSessionExitObserver,
} from '../../../../src/adapters/index.ts';
import {
  createSessionPaths,
  createSessionRecord,
  defaultSessionHealthSettings,
  defaultSessionLifecycleSettings,
  parseSessionId,
  SelfRestartCoordinator,
  SessionHealthService,
  type SessionExitObservation,
  type SessionId,
  type TmuxCommandPort,
  TmuxController,
} from '../../../../src/lib/index.ts';

/**
 * A session whose agent exits must stop reading `running` on the self-check's own tick.
 *
 * Real tmux and the repository's fake harness, because the facts that matter are tmux's: that a
 * launch's `remain-on-exit` keeps the dead pane, that `pane_dead_status` carries the harness's exit
 * status, and that the dead pane still names the pane id and pid the registration recorded. It
 * spends nothing — the harness is `scripts/test/fake-harness.ts` reading a scripted scenario.
 */

const REPOSITORY = resolve(import.meta.dir, '../../../../../..');
const DAEMON = 'exit-test-daemon';
const NOW = '2026-09-26T10:00:00.000Z';
const AGENT = '/opt/fleet/bin/claude-auto-loge';
const cleanups = new Set<() => Promise<void>>();

afterEach(async () => {
  await Promise.all([...cleanups].map(cleanup => cleanup()));
  cleanups.clear();
});

interface ExitFixture {
  readonly home: string;
  readonly id: SessionId;
  readonly tmuxSession: string;
  readonly storage: Awaited<ReturnType<DaemonStorageFactory['open']>>['storage'];
  readonly files: StateFileSystem;
  readonly store: DurableTerminalPaneStore;
  readonly commands: BunTmuxProcess;
  readonly controller: TmuxController;
  readonly gate: InMemoryLaunchGate;
  readonly tmuxExecutable: string;
  readonly events: { readonly type: string; readonly data: unknown }[];
}

async function fixture(exitCode: number): Promise<ExitFixture> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-session-exit-'));
  const tmuxExecutable = Bun.which('tmux');
  if (tmuxExecutable === null) throw new Error('tmux is required for session-exit integration coverage');
  const opened = await new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  ).open();
  const record = createSessionRecord(
    { agent: AGENT, cwd: process.cwd(), mode: 'interactive', prompt: 'Exit when told', command: [AGENT] },
    { id: parseSessionId('exit-session'), cwd: process.cwd(), at: NOW, settings: defaultSessionLifecycleSettings },
  ).record;
  const id = record.config.id;
  await opened.storage.writeState(id, { id, status: 'created' });
  const scenario = join(home, 'scenario.json');
  await writeFile(
    scenario,
    JSON.stringify({
      version: 1,
      steps: [
        { type: 'say', text: 'harness ready' },
        { type: 'ask', text: '>', expect: 'go' },
        { type: 'exit', code: exitCode },
      ],
    }),
  );
  const commands = new BunTmuxProcess(tmuxExecutable, join(home, 'tmux.sock'));
  const controller = new TmuxController(commands);
  await controller.launch({
    session: record.config.tmuxSession,
    cwd: process.cwd(),
    command: [process.execPath, join(REPOSITORY, 'scripts/test/fake-harness.ts')],
    env: { FY_E2E_HARNESS_SCRIPT: scenario, FY_E2E_HARNESS_INVOCATIONS: join(home, 'invocations.jsonl') },
  });
  const files = new StateFileSystem(opened.paths);
  await new DurableTerminalPaneRegistrar(DAEMON, controller, files, opened.paths).register(record);
  await opened.storage.writeState(id, { id, status: 'running', health: 'healthy' });
  const events: { readonly type: string; readonly data: unknown }[] = [];
  const unsubscribe = opened.storage.subscribeEvents(event => events.push({ type: event.type, data: event.data }));
  cleanups.add(async () => {
    unsubscribe();
    await Bun.spawn([tmuxExecutable, '-S', join(home, 'tmux.sock'), 'kill-server'], {
      stdout: 'ignore',
      stderr: 'ignore',
    }).exited;
    await opened.storage.close();
    await rm(home, { recursive: true, force: true });
  });
  return {
    home,
    id,
    tmuxSession: record.config.tmuxSession,
    storage: opened.storage,
    files,
    store: new DurableTerminalPaneStore(opened.storage, files, opened.paths),
    commands,
    controller,
    gate: new InMemoryLaunchGate(milliseconds => Bun.sleep(milliseconds)),
    tmuxExecutable,
    events,
  };
}

function observer(subject: ExitFixture, commands: TmuxCommandPort = subject.commands): TmuxSessionExitObserver {
  return new TmuxSessionExitObserver(DAEMON, subject.storage, subject.store, commands, subject.gate, {
    now: () => NOW,
  });
}

/** The real server for everything but the pane-exit read, which gets the given answer. */
function metadataAnswers(subject: ExitFixture, answer: () => { code: number; stdout: string }): TmuxCommandPort {
  return {
    execute: async (arguments_, stdin) =>
      arguments_[0] === 'display-message' && arguments_.at(-1)?.includes('pane_dead') === true
        ? { stderr: '', ...answer() }
        : await subject.commands.execute(arguments_, stdin),
  };
}

/** The self-check with every port but the exit pass inert, so a tick does exactly one thing. */
function selfCheck(subject: ExitFixture): SessionHealthService {
  const settings = defaultSessionHealthSettings;
  return new SessionHealthService(
    {
      inventory: {
        observe: async () => ({
          sessions: [],
          sweep: { timerArmed: false, intervalMs: settings.selfCheckIntervalMs },
          bootstrapFinished: true,
          bootstrapErrors: [],
          supervisesMonitors: false,
          supervisesWarden: false,
        }),
      },
      consistency: {
        run: async () => ({ missingFromIndex: [], staleRows: [], zombies: [], repaired: [], unhealable: [] }),
      },
      repair: { startMonitor: async () => undefined, rearmWarden: async () => undefined },
      exits: observer(subject),
      events: { emit: async () => undefined },
      clock: { now: () => NOW },
      wallClock: { nowMs: () => Date.parse(NOW) },
      monotonic: { elapsedMs: () => 0 },
      restarts: new SelfRestartCoordinator(
        { read: async () => undefined, write: async () => undefined, clear: async () => undefined },
        { restart: async () => false },
        settings,
      ),
      version: '0.0.0-test',
    },
    settings,
  );
}

/**
 * Waits on the condition itself, never on a fixed sleep. The deadline is generous because a loaded
 * CI host is exactly where these moments stretch; a healthy run returns in milliseconds.
 */
async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function exitHarness(subject: ExitFixture): Promise<void> {
  await until(async () => (await subject.controller.capture(subject.tmuxSession, false)).includes('>'), 'the prompt');
  await subject.controller.sendLiteral(subject.tmuxSession, 'go');
  await subject.controller.sendKey(subject.tmuxSession, 'Enter');
  await until(async () => (await subject.controller.state(subject.tmuxSession)).dead, 'the pane to die');
}

/** What the host says about a harness tmux has not reaped, so a CI failure explains itself. */
async function diagnose(subject: ExitFixture, pid: number): Promise<string> {
  const read = async (path: string): Promise<string> =>
    await Bun.file(path)
      .text()
      .catch(() => '(unreadable)');
  const socket = join(subject.home, 'tmux.sock');
  const ask = async (format: string): Promise<string> =>
    (
      await new Response(
        Bun.spawn([subject.tmuxExecutable, '-S', socket, 'display-message', '-p', '-t', subject.tmuxSession, format])
          .stdout,
      ).text()
    ).trim();
  const server = await ask('#{pid}');
  const signals = (text: string): string =>
    text
      .split('\n')
      .filter(line => /^(State|PPid|Sig(Blk|Ign|Cgt))/.test(line))
      .join(' ');
  return [
    `pane: ${await ask('#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}|#{pane_pid}')}`,
    `harness ${pid}: ${signals(await read(`/proc/${pid}/status`))}`,
    `tmux server ${server}: ${signals(await read(`/proc/${server}/status`))}`,
    `test runner: ${signals(await read('/proc/self/status'))}`,
  ].join('\n');
}

/** Whether a pid no longer names any process, zombie included — so tmux has reaped it. */
function reaped(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/**
 * Ticks the self-check until it settles something, the way the daemon's timer would.
 *
 * Deliberately NOT one tick after the pane died: tmux marks a pane dead when its terminal closes and
 * records how it ended only after it reaps the child, and on a loaded host a tick can land between.
 * The observer leaves such a pane running for the next tick, so the test ticks too — and first waits
 * for the harness to be reaped, so the exit it asserts on is one tmux has certainly recorded.
 */
async function tickUntilSettled(subject: ExitFixture, service: SessionHealthService) {
  const registration = await subject.store.registration(DAEMON, subject.id);
  if (registration === undefined) throw new Error('the pane registration is missing');
  await until(async () => reaped(registration.pid), 'tmux to reap the harness').catch(async error => {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${await diagnose(subject, registration.pid)}`,
    );
  });
  let outcome = await service.selfCheck();
  await until(async () => {
    if (outcome.exited.length > 0) return true;
    outcome = await service.selfCheck();
    return outcome.exited.length > 0;
  }, 'a self-check to settle the exited session');
  return outcome;
}

async function state(subject: ExitFixture): Promise<Record<string, unknown>> {
  return (await subject.storage.readState(subject.id)) as Record<string, unknown>;
}

describe('tmux session exit observer', () => {
  it('should move a running session whose harness exited to failed with its exit status', async () => {
    // Arrange
    const subject = await fixture(3);
    const service = selfCheck(subject);
    should((await service.selfCheck()).exited).deepEqual([]);
    await exitHarness(subject);

    // Act
    const actual = await tickUntilSettled(subject, service);

    // Assert
    should(actual.exited).deepEqual([subject.id]);
    should(await state(subject)).match({
      status: 'failed',
      health: 'crashed',
      reason: 'the agent exited on its own (exit status 3)',
      exitCode: 3,
      finishedAt: NOW,
      promptReady: false,
    });
    should(subject.events).deepEqual([
      {
        type: 'session.exited',
        data: {
          reason: 'the agent exited on its own (exit status 3)',
          from: 'running',
          status: 'failed',
          pane: 'exited',
          exitCode: 3,
        },
      },
    ]);
    // The dead pane is left for snapshot and resume: nothing in this pass kills.
    should(await subject.controller.alive(subject.tmuxSession)).be.true();
  }, 20_000);

  it('should read a harness that exited 0 as completed', async () => {
    // Arrange
    const subject = await fixture(0);
    await exitHarness(subject);

    // Act
    const actual = await tickUntilSettled(subject, selfCheck(subject));

    // Assert
    should(actual.exited).deepEqual([subject.id]);
    should(await state(subject)).match({ status: 'completed', health: 'idle', exitCode: 0 });
  }, 20_000);

  it('should settle a session whose whole tmux server is gone without inventing an exit status', async () => {
    // Arrange
    const subject = await fixture(0);
    await Bun.spawn([subject.tmuxExecutable, '-S', join(subject.home, 'tmux.sock'), 'kill-server']).exited;

    // Act
    const actual = await selfCheck(subject).selfCheck();

    // Assert
    should(actual.exited).deepEqual([subject.id]);
    const settled = await state(subject);
    should(settled).match({ status: 'failed', health: 'unknown' });
    should(settled).not.have.property('exitCode');
    should(subject.events[0]).match({ data: { pane: 'gone', exitCode: null } });
  }, 20_000);

  it('should observe nothing while the harness is alive, launching, or no longer claimed running', async () => {
    // Arrange
    const subject = await fixture(0);
    await until(async () => (await subject.controller.capture(subject.tmuxSession, false)).includes('>'), 'the prompt');
    const alive = await observer(subject).observe();
    await exitHarness(subject);
    const launch = subject.gate.register(subject.id);
    const launching = await observer(subject).observe();
    launch.release();
    await subject.storage.writeState(subject.id, { id: subject.id, status: 'stopped' });

    // Act
    const stopped = await observer(subject).observe();

    // Assert
    should([alive, launching, stopped]).deepEqual([[], [], []]);
  }, 20_000);

  it('should refuse to settle once the pane was re-registered, the status moved, or a launch began', async () => {
    // Arrange
    const subject = await fixture(1);
    await exitHarness(subject);
    // The pane-exit answer is fixed so this test is about the settle guards, not tmux reaping speed.
    const [observed] = await observer(
      subject,
      metadataAnswers(subject, () => ({ code: 0, stdout: '1|1|' })),
    ).observe();
    if (observed === undefined) throw new Error('the dead pane was not observed');
    const transition = { status: 'failed', health: 'crashed', reason: 'exited', exitCode: 1 } as const;
    const path = createSessionPaths(subject.storage.paths, subject.id).terminalPane;
    const original = await subject.files.readText(path);
    if (original === undefined) throw new Error('no registration was written');

    // Act
    await subject.files.writeTextAtomic(
      path,
      `${JSON.stringify({ ...observed.registration, paneId: '%7', pid: observed.registration.pid + 1 })}\n`,
    );
    const replaced = await observer(subject).settle(observed, transition);
    await subject.files.writeTextAtomic(path, original);
    const moved = await observer(subject).settle({ ...observed, status: 'thinking' }, transition);
    const launch = subject.gate.register(subject.id);
    const launching = await observer(subject).settle(observed, transition);
    launch.release();
    await rm(path);
    const unregistered = await observer(subject).settle(observed, transition);

    // Assert
    should([replaced, moved, launching, unregistered]).deepEqual([false, false, false, false]);
    should(await state(subject)).match({ status: 'running' });
    should(subject.events).deepEqual([]);
  }, 20_000);

  it('should prove nothing from a pane that is not the registered one or a tmux that will not answer', async () => {
    // Arrange
    const subject = await fixture(0);
    await exitHarness(subject);
    const path = createSessionPaths(subject.storage.paths, subject.id).terminalPane;
    const registration = JSON.parse((await subject.files.readText(path)) ?? '{}') as Record<string, unknown>;
    const failing = (answer: (arguments_: readonly string[]) => { code: number; stderr: string }): TmuxCommandPort => ({
      execute: async (arguments_, stdin) =>
        arguments_[0] === 'has-session' || arguments_[0] === 'display-message'
          ? { stdout: '', ...answer(arguments_) }
          : await subject.commands.execute(arguments_, stdin),
    });
    const refusedHasSession = failing(() => ({ code: 1, stderr: 'server exited unexpectedly' }));
    const refusedDisplay = failing(arguments_ =>
      arguments_[0] === 'has-session' ? { code: 0, stderr: '' } : { code: 1, stderr: 'no current target' },
    );
    const throwing: TmuxCommandPort = {
      execute: async () => {
        throw new Error('tmux could not be spawned');
      },
    };
    const results: (readonly SessionExitObservation[])[] = [];

    // Act
    results.push(await observer(subject, refusedHasSession).observe());
    results.push(await observer(subject, refusedDisplay).observe());
    results.push(await observer(subject, throwing).observe());
    await subject.files.writeTextAtomic(path, `${JSON.stringify({ ...registration, paneId: '%9' })}\n`);
    results.push(await observer(subject).observe());
    const unnamed = new TmuxSessionExitObserver('', subject.storage, subject.store, subject.commands, subject.gate, {
      now: () => NOW,
    });
    results.push(await unnamed.observe());

    // Assert
    should(results).deepEqual([[], [], [], [], []]);
  }, 20_000);

  it('should leave a dead pane with no exit status running until a later tick sees one', async () => {
    // Arrange — tmux has marked the pane dead but not yet reaped its child.
    const subject = await fixture(0);
    await exitHarness(subject);
    let reads = 0;
    const late = metadataAnswers(subject, () => {
      reads += 1;
      return { code: 0, stdout: reads < 2 ? '1||' : '1|7|' };
    });
    const tracker = observer(subject, late);

    // Act
    const first = await tracker.observe();
    const second = await tracker.observe();

    // Assert
    should(first).deepEqual([]);
    should(second.map(item => item.exit)).deepEqual([{ kind: 'exited', exitStatus: 7, signal: undefined }]);
  }, 20_000);

  it('should settle as not recorded only after the status stayed missing for three ticks', async () => {
    // Arrange
    const subject = await fixture(0);
    await exitHarness(subject);
    const never = observer(
      subject,
      metadataAnswers(subject, () => ({ code: 0, stdout: '1||' })),
    );

    // Act
    const ticks = [await never.observe(), await never.observe(), await never.observe()];

    // Assert
    should(ticks.map(tick => tick.map(item => item.exit))).deepEqual([
      [],
      [],
      [{ kind: 'exited', exitStatus: undefined, signal: undefined }],
    ]);
  }, 20_000);

  it('should start the missing-status count again for a pane that came back or was replaced', async () => {
    // Arrange
    const subject = await fixture(0);
    await exitHarness(subject);
    let answer = '1||';
    const flaky = observer(
      subject,
      metadataAnswers(subject, () => ({ code: 0, stdout: answer })),
    );
    await flaky.observe();
    await flaky.observe();
    answer = '0||';
    await flaky.observe();
    answer = '1||';

    // Act
    const afterReset = [await flaky.observe(), await flaky.observe()];

    // Assert — two misses, a live read that forgets them, then two more misses: still not settled.
    should(afterReset).deepEqual([[], []]);
  }, 20_000);

  it('should settle a pane a signal ended at once, naming the signal', async () => {
    // Arrange
    const subject = await fixture(0);
    await exitHarness(subject);
    const signalled = observer(
      subject,
      metadataAnswers(subject, () => ({ code: 0, stdout: '1||9' })),
    );
    const refused = observer(
      subject,
      metadataAnswers(subject, () => ({ code: 1, stdout: '' })),
    );

    // Act
    const killed = await signalled.observe();
    const unreadable = await refused.observe();

    // Assert
    should(killed.map(item => item.exit)).deepEqual([{ kind: 'exited', exitStatus: undefined, signal: 9 }]);
    should(unreadable).deepEqual([]);
  }, 20_000);
});
