import { describe, it } from 'bun:test';
import should from 'should';
import {
  DurableTerminalPaneRegistrar,
  DurableTerminalPaneStore,
} from '../../../../../daemon/adapters/session/lifecycle/durable-terminal-pane-reap.ts';
import { InMemoryLaunchGate } from '../../../../../daemon/adapters/session/resume/in-memory-launch-gate.ts';
import { TmuxSessionExitObserver } from '../../../../../daemon/adapters/session/lifecycle/tmux-session-exit-observer.ts';
import type { DaemonStorage } from '../../../../../daemon/adapters/storage/session-storage.ts';
import { createSessionPaths } from '../../../../../daemon/lib/paths.ts';
import { createSessionRecord } from '../../../../../daemon/lib/session/lifecycle/policy.ts';
import { defaultSessionHealthSettings } from '../../../../../daemon/lib/session/health/settings.ts';
import { defaultSessionLifecycleSettings } from '../../../../../daemon/lib/session/lifecycle/settings.ts';
import { PANE_PROOF_FORMAT, type TmuxCommandPort } from '../../../../../daemon/lib/session/peers/tmux-lifecycle.ts';
import { parseSessionId, type SessionId } from '../../../../../daemon/lib/session-id.ts';
import { SelfRestartCoordinator } from '../../../../../daemon/lib/session/health/self-restart.ts';
import type { SessionExitObservation } from '../../../../../daemon/lib/session/health/exit.ts';
import { SessionHealthService } from '../../../../../daemon/lib/session/health/service.ts';
import { UNNAMED_SELF_CHECK_STAGES } from '../../../../../daemon/lib/session/health/types.ts';
import { FakeIncarnation, FakeTmux } from '../../../../support/daemon/fake-tmux.ts';
import { MEMORY_PATHS, MemoryFileSystem } from '../../../../support/daemon/memory-file-system.ts';
import { memoryStorage, sessionState } from '../../../../support/daemon/storage.ts';

/**
 * A session whose agent exits must stop reading `running` on the self-check's own tick.
 *
 * The facts that matter are tmux's: that a launch's `remain-on-exit` keeps the dead pane, that
 * `pane_dead_status` carries the harness's exit status, and that the dead pane is still the registered
 * one by the shared pane proof. Ferrets is core and cannot import a plugin's code (§2.1), so tmux here is
 * the test's own (`FakeTmux`), answering the raw vocabulary the observer speaks, over the session store
 * on the kernel's memory state folder.
 */

const DAEMON = 'exit-test-daemon';
const NOW = '2026-09-26T10:00:00.000Z';
const AGENT = '/opt/fleet/bin/claude-auto-loge';

interface ExitFixture {
  readonly id: SessionId;
  readonly tmuxSession: string;
  readonly exitCode: number;
  readonly storage: DaemonStorage;
  readonly files: MemoryFileSystem;
  readonly store: DurableTerminalPaneStore;
  readonly tmux: FakeTmux;
  readonly gate: InMemoryLaunchGate;
  readonly events: { readonly type: string; readonly data: unknown }[];
}

async function fixture(exitCode: number): Promise<ExitFixture> {
  const { storage } = await memoryStorage({ clock: { now: () => NOW } });
  const record = createSessionRecord(
    { agent: AGENT, cwd: '/workspace/project', mode: 'interactive', prompt: 'Exit when told', command: [AGENT] },
    {
      id: parseSessionId('exit-session'),
      cwd: '/workspace/project',
      at: NOW,
      settings: defaultSessionLifecycleSettings,
    },
  ).record;
  const id = record.config.id;
  await storage.writeState(id, sessionState(id, { status: 'created' }));
  const tmux = new FakeTmux();
  await tmux.launch({ session: record.config.tmuxSession, cwd: '/workspace/project', command: [AGENT] });
  const files = new MemoryFileSystem();
  await new DurableTerminalPaneRegistrar(DAEMON, tmux, files, MEMORY_PATHS, new FakeIncarnation()).register(record);
  await storage.writeState(id, sessionState(id, { status: 'running', health: 'healthy' }));
  const events: { readonly type: string; readonly data: unknown }[] = [];
  storage.subscribeEvents(event => events.push({ type: event.type, data: event.data }));
  return {
    id,
    tmuxSession: record.config.tmuxSession,
    exitCode,
    storage,
    files,
    store: new DurableTerminalPaneStore(storage, files, MEMORY_PATHS),
    tmux,
    gate: new InMemoryLaunchGate(async () => undefined),
    events,
  };
}

function observer(subject: ExitFixture, commands: TmuxCommandPort = subject.tmux): TmuxSessionExitObserver {
  return new TmuxSessionExitObserver(DAEMON, subject.storage, subject.store, commands, subject.gate, {
    now: () => NOW,
  });
}

/** The fake server for everything but the pane-exit read, which gets the given answer. */
function metadataAnswers(subject: ExitFixture, answer: () => { code: number; stdout: string }): TmuxCommandPort {
  return {
    execute: async (arguments_, stdin) =>
      arguments_[0] === 'display-message' && arguments_.at(-1)?.startsWith('#{pane_dead}') === true
        ? { stderr: '', ...answer() }
        : await subject.tmux.execute(arguments_, stdin),
  };
}

/** tmux 3.8: the pane proof read with a dead pane's pid blanked, as 3.8 prints it once the pane's process is gone. */
function asTmux38(commands: TmuxCommandPort): TmuxCommandPort {
  return {
    execute: async (arguments_, stdin) => {
      const result = await commands.execute(arguments_, stdin);
      return arguments_.at(-1) === PANE_PROOF_FORMAT && result.code === 0
        ? { ...result, stdout: result.stdout.replace(/^(%[0-9]+)\|[0-9]*\|1\|/u, '$1||1|') }
        : result;
    },
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
      survey: { survey: async () => await subject.storage.surveySessionDirectories() },
      repair: { startMonitor: async () => undefined, rearmWarden: async () => undefined },
      activities: UNNAMED_SELF_CHECK_STAGES,
      exits: observer(subject),
      events: { emit: async () => undefined },
      clock: { now: () => NOW },
      wallClock: { nowMs: () => Date.parse(NOW) },
      monotonic: { elapsedMs: () => 0 },
      loop: { blockedMs: () => 0 },
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

/** The harness answers its prompt and exits with the fixture's code; `remain-on-exit` keeps the pane, dead. */
async function exitHarness(subject: ExitFixture): Promise<void> {
  subject.tmux.exit(subject.tmuxSession, { exitStatus: subject.exitCode });
}

/** One tick of the self-check, the way the daemon's timer would run it. */
async function tickUntilSettled(_subject: ExitFixture, service: SessionHealthService) {
  return await service.selfCheck();
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
          signal: null,
        },
      },
    ]);
    // The dead pane is left for snapshot and resume: nothing in this pass kills.
    should(await subject.tmux.alive(subject.tmuxSession)).be.true();
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
    await subject.tmux.execute(['kill-server']);

    // Act
    const actual = await selfCheck(subject).selfCheck();

    // Assert
    should(actual.exited).deepEqual([subject.id]);
    const settled = await state(subject);
    should(settled).match({ status: 'failed', health: 'unknown' });
    should(settled).not.have.property('exitCode');
    should(subject.events[0]).match({ data: { pane: 'gone', exitCode: null, signal: null } });
  }, 20_000);

  it('should observe nothing while the harness is alive, launching, or no longer claimed running', async () => {
    // Arrange
    const subject = await fixture(0);
    const alive = await observer(subject).observe();
    await exitHarness(subject);
    const launch = subject.gate.register(subject.id);
    const launching = await observer(subject).observe();
    launch.release();
    await subject.storage.writeState(subject.id, sessionState(subject.id, { status: 'stopped' }));

    // Act
    const stopped = await observer(subject).observe();

    // Assert
    should([alive, launching, stopped]).deepEqual([[], [], []]);
  }, 20_000);

  it('should look for exits only among the sessions the check’s own survey found', async () => {
    // Arrange — the pane-exit answer is fixed, so the only thing deciding the outcome is the survey.
    const subject = await fixture(1);
    await exitHarness(subject);
    const dead = observer(
      subject,
      metadataAnswers(subject, () => ({ code: 0, stdout: '1|1|' })),
    );

    // Act
    const surveyed = await dead.observe(await subject.storage.surveySessionDirectories());
    const unsurveyed = await dead.observe([]);

    // Assert
    should(surveyed.map(observation => observation.id)).deepEqual([subject.id]);
    should(unsurveyed).deepEqual([]);
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
    const path = createSessionPaths(MEMORY_PATHS, subject.id).terminalPane;
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
    await subject.files.removeFile(path);
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
    const path = createSessionPaths(MEMORY_PATHS, subject.id).terminalPane;
    const registration = JSON.parse((await subject.files.readText(path)) ?? '{}') as Record<string, unknown>;
    const failing = (answer: (arguments_: readonly string[]) => { code: number; stderr: string }): TmuxCommandPort => ({
      execute: async (arguments_, stdin) =>
        arguments_[0] === 'has-session' || arguments_[0] === 'display-message'
          ? { stdout: '', ...answer(arguments_) }
          : await subject.tmux.execute(arguments_, stdin),
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
    const unnamed = new TmuxSessionExitObserver('', subject.storage, subject.store, subject.tmux, subject.gate, {
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

  it('should ask the real server to reap only for a dead pane that has no exit status or signal', async () => {
    // Arrange — every command still reaches the real server, so the nudge must be one it accepts.
    const subject = await fixture(0);
    await exitHarness(subject);
    const nudges: { readonly answer: string; readonly code: number }[] = [];
    const recording = (answer: string): TmuxCommandPort => {
      const reads = metadataAnswers(subject, () => ({ code: 0, stdout: answer }));
      return {
        execute: async (arguments_, stdin) => {
          const result = await reads.execute(arguments_, stdin);
          if (arguments_[0] === 'run-shell') {
            should(arguments_).deepEqual(['run-shell', '-b', 'true']);
            nudges.push({ answer, code: result.code });
          }
          return result;
        },
      };
    };

    // Act
    for (const answer of ['1||', '1|3|', '1||9', '0||']) await observer(subject, recording(answer)).observe();

    // Assert
    should(nudges).deepEqual([{ answer: '1||', code: 0 }]);
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

  it('should keep counting a missing status across a partial look that did not see the pane', async () => {
    // Arrange
    const subject = await fixture(0);
    await exitHarness(subject);
    const never = observer(
      subject,
      metadataAnswers(subject, () => ({ code: 0, stdout: '1||' })),
    );
    await never.observe();
    await never.observe();

    // Act — one session's own settle, about another session, between two whole checks.
    const partial = await never.observe([], { partial: true });
    const third = await never.observe();

    // Assert
    should(partial).deepEqual([]);
    should(third.map(item => item.exit)).deepEqual([{ kind: 'exited', exitStatus: undefined, signal: undefined }]);
  }, 20_000);

  it('should forget a missing status after a whole check that did not see the pane', async () => {
    // Arrange
    const subject = await fixture(0);
    await exitHarness(subject);
    const never = observer(
      subject,
      metadataAnswers(subject, () => ({ code: 0, stdout: '1||' })),
    );
    await never.observe();
    await never.observe();

    // Act
    await never.observe([]);
    const third = await never.observe();

    // Assert — the count started again, so the third look is only its first miss.
    should(third).deepEqual([]);
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

  it('should prove a dead pane tmux 3.8 prints no pid for by the second its session was created', async () => {
    // Arrange — the registration as the launch wrote it, and tmux answering as 3.8 does for a dead pane.
    const subject = await fixture(3);
    await exitHarness(subject);
    const registration = await subject.store.registration(DAEMON, subject.id);
    const as38 = observer(subject, asTmux38(metadataAnswers(subject, () => ({ code: 0, stdout: '1|3|' }))));
    const proof = await asTmux38(subject.tmux).execute([
      'display-message',
      '-p',
      '-t',
      subject.tmuxSession,
      PANE_PROOF_FORMAT,
    ]);

    // Act
    const recorded = await as38.observe();

    // Assert — tmux printed no pid and the stamp proved the pane.
    should(proof.stdout).match(/^%[0-9]+\|\|1\|[0-9]+\n$/u);
    should(registration?.sessionCreated).be.a.Number();
    should(recorded.map(item => item.exit)).deepEqual([{ kind: 'exited', exitStatus: 3, signal: undefined }]);
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
