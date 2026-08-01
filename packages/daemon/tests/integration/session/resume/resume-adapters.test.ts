import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  FileResumeTurnStore,
  InMemoryLaunchGate,
  KeyedSerialExecutor,
  NoMonitorSupervision,
  type PaneDeliveryOptions,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  StorageResumeRepository,
  SystemClock,
  TmuxPaneDelivery,
  TmuxResumeLauncher,
} from '../../../../src/adapters/index.ts';
import { parseSessionId, type TmuxCommandPort, TmuxController } from '../../../../src/lib/index.ts';
import { FakeTmuxServer } from '../../support/fake-tmux-server.ts';

const homes = new Set<string>();
const NOW = '2026-07-31T10:00:00.000Z';
const ID = parseSessionId('session-1');

async function openStorage() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-resume-test-'));
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
  return { home, opened: await factory.open() };
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    name: 'Revive me',
    agent: '/opt/fleet/bin/claude-auto-loge',
    command: ['/opt/fleet/bin/claude-auto-loge'],
    cwd: '/workspace/project',
    mode: 'auto',
    turn: 3,
    tmuxSession: 'fy-session-1',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** A tmux server the test owns, answering the real command vocabulary the controller emits. */
class RecordingTmuxPort implements TmuxCommandPort {
  readonly calls: Array<readonly string[]> = [];
  alive = true;
  dead = false;
  promptReady = true;
  visible = 'the last frame';

  async execute(argv: readonly string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    this.calls.push(argv);
    const command = argv[0];
    if (command === 'has-session') return this.result(this.alive ? '' : 'no such session', this.alive ? 0 : 1);
    // `#{pane_dead}|#{pane_dead_status}|#{cursor_x}|#{cursor_y}|#{pane_height}|#{pane_width}`
    if (command === 'display-message') return this.result(`${this.dead ? 1 : 0}||0|1|24|80\n`);
    if (command === 'capture-pane')
      return this.result(this.promptReady ? `${this.visible}\n> \n` : `${this.visible}\n`);
    return this.result('');
  }

  private result(stdout: string, code = 0) {
    return { stdout, stderr: '', code };
  }
}

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('resume turn store', () => {
  it('should write a numbered turn document atomically inside the session directory', async () => {
    // Arrange
    const { home, opened } = await openStorage();
    const store = new FileResumeTurnStore(() => join(home, 'sessions', 'session-1'));

    // Act
    const file = await store.writeTurn(ID, 4, 'Continue the assigned task.\n');

    // Assert
    should(file).endWith('turns/turn-004.md');
    should(await readFile(file, 'utf8')).equal('Continue the assigned task.\n');
    should((await stat(file)).mode & 0o777).equal(0o600);
    await opened.storage.close();
  });

  it('should remove stale completion markers, and tolerate ones that were never written', async () => {
    // Arrange — a `done` marker from the previous turn would end the new turn the moment it starts.
    const { home, opened } = await openStorage();
    const directory = join(home, 'sessions', 'session-1');
    const store = new FileResumeTurnStore(() => directory);
    await store.writeTurn(ID, 4, 'anything');
    await writeFile(join(directory, 'done.marker'), 'done', 'utf8');

    // Act
    await store.clearMarkers(ID);
    await store.clearMarkers(ID);

    // Assert
    await should(stat(join(directory, 'done.marker'))).be.rejected();
    await opened.storage.close();
  });
});

describe('storage resume repository', () => {
  it('should read a durable session as a resume target', async () => {
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeConfig(ID, config({ label: 'my-batch', retry: { transientAttempts: 2 } }));
    await opened.storage.writeState(ID, { id: 'session-1', status: 'stopped', retryAttempt: 1 });

    // Act
    const actual = await new StorageResumeRepository(opened.storage).read(ID);

    // Assert
    should(actual).deepEqual({
      id: ID,
      status: 'stopped',
      mode: 'auto',
      cwd: '/workspace/project',
      label: 'my-batch',
      turn: 3,
      retryAttempt: 1,
      transientRetryBudget: 2,
    });
    await opened.storage.close();
  });

  it('should take the turn from the document that actually moves', async () => {
    // Both documents carry a turn and only the STATE's is ever updated: a revive records the turn it
    // handed over through `transition({ turn })`, and nothing rewrites the configuration's copy.
    // Reading the configuration first froze every session at the turn it was created on, so the
    // SECOND revive planned the same number again and overwrote the first revive's assignment.
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeConfig(ID, config());
    await opened.storage.writeState(ID, { id: 'session-1', status: 'stopped', turn: 7 });

    // Act
    const actual = await new StorageResumeRepository(opened.storage).read(ID);

    // Assert
    should(actual).have.property('turn', 7);
    await opened.storage.close();
  });

  it('should report nothing for a session that was never written', async () => {
    // Arrange
    const { opened } = await openStorage();

    // Act
    const actual = await new StorageResumeRepository(opened.storage).read(ID);

    // Assert
    should(actual).be.undefined();
    await opened.storage.close();
  });

  it('should refuse to guess at a record whose status or mode will not parse', async () => {
    // Arrange — resume replaces terminals, so acting on a record it could not read is the one
    // mistake that costs an operator a live agent.
    const { opened } = await openStorage();
    await opened.storage.writeConfig(ID, config({ mode: 'telepathy' }));
    await opened.storage.writeState(ID, { id: 'session-1', status: 'running' });
    const other = parseSessionId('session-2');
    await opened.storage.writeConfig(other, config({ id: 'session-2', tmuxSession: 'fy-session-2' }));
    await opened.storage.writeState(other, { id: 'session-2', status: 'transcending' });

    // Act
    const actual = await Promise.all([
      new StorageResumeRepository(opened.storage).read(ID),
      new StorageResumeRepository(opened.storage).read(other),
    ]);

    // Assert
    should(actual).deepEqual([undefined, undefined]);
    await opened.storage.close();
  });

  it('should carry a pending question through, and drop one with no tool id', async () => {
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeConfig(ID, config());
    await opened.storage.writeState(ID, {
      id: 'session-1',
      status: 'running',
      pendingQuestion: { toolUseId: 'tool-1' },
      needsHumanKind: 'picker_cleanup',
    });
    const other = parseSessionId('session-2');
    await opened.storage.writeConfig(other, config({ id: 'session-2', tmuxSession: 'fy-session-2' }));
    await opened.storage.writeState(other, { id: 'session-2', status: 'running', pendingQuestion: {} });

    // Act
    const repository = new StorageResumeRepository(opened.storage);
    const actual = [await repository.read(ID), await repository.read(other)];

    // Assert
    should(actual[0]?.pendingQuestion).deepEqual({ toolUseId: 'tool-1' });
    should(actual[0]?.needsHumanKind).equal('picker_cleanup');
    should(actual[1]?.pendingQuestion).be.undefined();
    await opened.storage.close();
  });

  it('should list every readable session and silently skip the unreadable ones', async () => {
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeConfig(ID, config());
    await opened.storage.writeState(ID, { id: 'session-1', status: 'running' });
    const broken = parseSessionId('session-2');
    await opened.storage.writeConfig(broken, config({ id: 'session-2', tmuxSession: 'fy-session-2' }));
    await opened.storage.writeState(broken, { id: 'session-2', status: 'nonsense' });

    // Act
    const actual = await new StorageResumeRepository(opened.storage).list();

    // Assert
    should(actual.map(item => item.id)).deepEqual(['session-1']);
    await opened.storage.close();
  });

  it('should write the state before it journals the event that describes it', async () => {
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeConfig(ID, config());
    await opened.storage.writeState(ID, { id: 'session-1', status: 'stopped', needsHumanKind: 'picker_cleanup' });

    // Act
    const actual = await new StorageResumeRepository(opened.storage).transition(ID, {
      event: 'session.resumed',
      status: 'running',
      retryAttempt: 0,
      reason: 'revived by an operator',
      clearNeedsHuman: true,
    });

    // Assert
    should(actual.status).equal('running');
    should(actual.needsHumanKind).be.undefined();
    should(actual.retryAttempt).equal(0);
    const state = (await opened.storage.readState(ID)) as Record<string, unknown>;
    should(state.reason).equal('revived by an operator');
    await opened.storage.close();
  });

  it('should clear a pending question on the transition that abandons it', async () => {
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeConfig(ID, config());
    await opened.storage.writeState(ID, {
      id: 'session-1',
      status: 'stopped',
      pendingQuestion: { toolUseId: 'tool-1' },
    });

    // Act
    const actual = await new StorageResumeRepository(opened.storage).transition(ID, {
      event: 'session.question_cancelled',
      clearPendingQuestion: true,
      data: { abandoned: true },
    });

    // Assert
    should(actual.pendingQuestion).be.undefined();
    await opened.storage.close();
  });

  it('should refuse to report success for a transition it can no longer read back', async () => {
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeConfig(ID, config({ mode: 'telepathy' }));
    await opened.storage.writeState(ID, { id: 'session-1', status: 'stopped' });

    // Act / Assert
    await should(
      new StorageResumeRepository(opened.storage).transition(ID, { event: 'session.resumed', status: 'running' }),
    ).be.rejectedWith(/unreadable after a resume transition/u);
    await opened.storage.close();
  });
});

describe('tmux resume launcher', () => {
  function launcher(
    port: TmuxCommandPort,
    options: PaneDeliveryOptions = {},
    snapshots?: { write(id: string, text: string): Promise<void> },
  ) {
    const controller = new TmuxController(port);
    return new TmuxResumeLauncher(
      controller,
      async () => ({ tmuxSession: 'fy-session-1', cwd: '/workspace/project', command: ['/opt/fleet/bin/agent'] }),
      new TmuxPaneDelivery(controller, async () => {}, options),
      snapshots,
    );
  }

  it('should observe a live prompt-ready pane', async () => {
    // Arrange
    const port = new RecordingTmuxPort();

    // Act
    const actual = await launcher(port).observe(ID);

    // Assert
    should(actual).deepEqual({ alive: true, dead: false, promptReady: true });
  });

  it('should capture the final frame before the pane is destroyed', async () => {
    // Arrange
    const port = new RecordingTmuxPort();
    const writes: Array<readonly [string, string]> = [];
    const subject = launcher(port, {}, { write: async (id, text) => void writes.push([id, text]) });

    // Act
    await subject.snapshot(ID);

    // Assert
    should(writes).have.length(1);
    should(writes[0]?.[0]).equal(ID);
    should(writes[0]?.[1]).containEql('the last frame');
  });

  it('should address only this session name when it kills or relaunches', async () => {
    // Arrange
    const port = new RecordingTmuxPort();
    const subject = launcher(port);

    // Act
    await subject.kill(ID, 'cleanup before resume');
    // The kill is what makes the name free again; the controller refuses to launch over a live one.
    port.alive = false;
    await subject.relaunch(ID);

    // Assert
    const addressed = port.calls.flat().filter(argument => argument.startsWith('fy-'));
    should(new Set(addressed)).deepEqual(new Set(['fy-session-1']));
  });

  it('should refuse to relaunch a session whose command is empty', async () => {
    // Arrange
    const subject = new TmuxResumeLauncher(
      new TmuxController(new RecordingTmuxPort()),
      async () => ({ tmuxSession: 'fy-session-1', cwd: '/workspace/project', command: [] }),
      new TmuxPaneDelivery(new TmuxController(new RecordingTmuxPort()), async () => {}),
    );

    // Act / Assert
    await should(subject.relaunch(ID)).be.rejectedWith(/empty command/u);
  });

  it('should answer the resume gate a large session comes back on before typing the turn', async () => {
    // Arrange — the menu a revive of a long-running session always lands on.
    const server = new FakeTmuxServer();
    server.bootCaptures = 2;
    server.modal = [
      'This session is 2h 45m old and 382k tokens.',
      '❯ 1. Resume from summary (recommended)',
      '  2. Resume full session as-is',
      "  3. Don't ask me again",
    ].join('\n');

    // Act
    await launcher(server).deliver(ID, 'read your new turn');

    // Assert — the menu was walked to "Resume full session", then the turn was delivered.
    should(server.calls.filter(call => call[0] === 'send-keys').map(call => call.at(-1))).containDeep([
      'Down',
      'Enter',
    ]);
    should(server.submitted).deepEqual(['read your new turn']);
  });

  it('should refuse to type into a pane whose harness is gone', async () => {
    // Arrange
    const server = new FakeTmuxServer();
    server.dead = true;

    // Act / Assert
    await should(launcher(server).deliver(ID, 'anything')).be.rejectedWith(/harness exited/u);
  });

  it('should give up rather than type into a terminal that never becomes ready', async () => {
    // Arrange
    const server = new FakeTmuxServer();
    server.bootCaptures = Number.MAX_SAFE_INTEGER;

    // Act / Assert
    await should(launcher(server, { readinessAttempts: 2 }).deliver(ID, 'anything')).be.rejectedWith(
      /did not become ready/u,
    );
    should(server.calls.some(call => call[0] === 'send-keys')).be.false();
  });

  it('should confirm an exit only when the pane itself agrees the harness is gone', async () => {
    // Arrange
    const alive = new RecordingTmuxPort();
    const gone = new RecordingTmuxPort();
    gone.alive = false;

    // Act
    const actual = [await launcher(alive).confirmExit(ID), await launcher(gone).confirmExit(ID)];

    // Assert
    should(actual[0]?.confirmed).be.false();
    should(actual[0]?.pane.promptReady).be.true();
    should(actual[1]?.confirmed).be.true();
  });

  it('should assume the harness is gone when even the probe fails', async () => {
    // Arrange
    const subject = new TmuxResumeLauncher(
      new TmuxController(new RecordingTmuxPort()),
      async () => {
        throw new Error('config is unreadable');
      },
      new TmuxPaneDelivery(new TmuxController(new RecordingTmuxPort()), async () => {}),
    );

    // Act
    const actual = await subject.confirmExit(ID);

    // Assert
    should(actual).deepEqual({ confirmed: true, pane: { alive: false, dead: true, promptReady: false } });
  });
});

describe('in-memory launch gate', () => {
  it('should report a registered launch as in flight until it is released', async () => {
    // Arrange
    const gate = new InMemoryLaunchGate(async () => {}, 1);

    // Act
    const registration = gate.register(ID);
    const during = gate.launching(ID);
    registration.release();

    // Assert
    should(during).be.true();
    should(gate.launching(ID)).be.false();
  });

  it('should answer immediately for a session with no launch in flight', async () => {
    // Arrange
    const gate = new InMemoryLaunchGate(async () => {}, 1);

    // Act
    const actual = await gate.awaitSettled(ID, 50);

    // Assert
    should(actual).be.true();
  });

  it('should report that a launch did not settle within the budget', async () => {
    // Arrange
    const gate = new InMemoryLaunchGate(async () => {}, 5);
    gate.register(ID);

    // Act
    const actual = await gate.awaitSettled(ID, 20);

    // Assert
    should(actual).be.false();
  });

  it('should resolve once the launch settles mid-wait', async () => {
    // Arrange
    const gate = new InMemoryLaunchGate(async () => {}, 1);
    const registration = gate.register(ID);

    // Act
    const settled = gate.awaitSettled(ID, 1_000);
    registration.release();

    // Assert
    should(await settled).be.true();
  });

  it('should ignore a late release from a registration that was already superseded', async () => {
    // Arrange
    const gate = new InMemoryLaunchGate(async () => {}, 1);
    const first = gate.register(ID);
    const second = gate.register(ID);

    // Act
    first.release();

    // Assert
    should(gate.launching(ID)).be.true();
    second.release();
    should(gate.launching(ID)).be.false();
  });
});

describe('unmounted monitor supervision', () => {
  it('should be a genuine no-op, since there is no monitor to arm or disarm', async () => {
    // Arrange
    const monitors = new NoMonitorSupervision();

    // Act / Assert
    await should(monitors.stop()).be.fulfilled();
    await should(monitors.start()).be.fulfilled();
  });
});
