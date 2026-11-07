import { describe, it } from 'bun:test';
import should from 'should';
import {
  DurableTerminalPaneRegistrar,
  DurableTerminalPaneStore,
  ExactTmuxPaneReaper,
} from '../../../../../daemon/adapters/session/lifecycle/durable-terminal-pane-reap.ts';
import type { DaemonStorage } from '../../../../../daemon/adapters/storage/session-storage.ts';
import { createSessionPaths } from '../../../../../daemon/lib/paths.ts';
import { createSessionRecord } from '../../../../../daemon/lib/session/lifecycle/policy.ts';
import { defaultSessionLifecycleSettings } from '../../../../../daemon/lib/session/lifecycle/settings.ts';
import type { PaneSighting, TmuxController } from '../../../../../daemon/lib/session/peers/tmux-lifecycle.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';
import type { RegisteredTerminalPane } from '../../../../../daemon/lib/session/reap.ts';
import { TerminalReapService } from '../../../../../daemon/lib/session/reap-service.ts';
import { FakeIncarnation, FakeTmux } from '../../../../support/daemon/fake-tmux.ts';
import { MEMORY_PATHS, MemoryFileSystem } from '../../../../support/daemon/memory-file-system.ts';
import { memoryStorage, sessionState } from '../../../../support/daemon/storage.ts';

/**
 * The durable pane registrations, the reap that reads them, and the exact reaper. Ferrets is core and cannot
 * import a plugin's code (§2.1), so tmux here is the test's own (`FakeTmux`): its panes carry the identity the
 * real server reports — pane id, pid, the second the session was created — and a process start per pid
 * (`FakeIncarnation`). The registrations live in a memory filesystem; the session documents in the kernel's
 * memory state folder.
 */

const DAEMON = 'reap-test-daemon';
const NOW = '2026-08-01T10:00:00.000Z';
const AGENT = '/opt/fleet/bin/claude-auto-loge';
const EXIT_OUTPUT = 'ferretry: DEEPSEEK_TOKEN is not set';

interface ReapFixture {
  readonly files: MemoryFileSystem;
  readonly storage: DaemonStorage;
  readonly record: ReturnType<typeof createSessionRecord>['record'];
  readonly controller: FakeTmux;
  readonly incarnation: FakeIncarnation;
  readonly registrar: DurableTerminalPaneRegistrar;
  readonly store: DurableTerminalPaneStore;
  readonly runtime: ExactTmuxPaneReaper;
}

function lifecycleRecord(id = 'reap-session') {
  return createSessionRecord(
    { agent: AGENT, cwd: '/workspace/project', mode: 'auto', prompt: 'Keep this pane alive', command: [AGENT] },
    { id: parseSessionId(id), cwd: '/workspace/project', at: NOW, settings: defaultSessionLifecycleSettings },
  ).record;
}

/**
 * @param exits When true, the pane's harness has already ended with status 2, printing {@link EXIT_OUTPUT}, and
 *   tmux holds it as a dead pane (`remain-on-exit`).
 */
async function fixture(exits = false): Promise<ReapFixture> {
  const { storage } = await memoryStorage({ clock: { now: () => NOW } });
  const record = lifecycleRecord('reap-session');
  // The lifecycle store writes the session before its launcher writes a pane registration there.
  await storage.writeState(record.config.id, sessionState(record.config.id, { status: 'created' }));
  const controller = new FakeTmux();
  // A fresh server assigns its first pane `%0`; the registrar and reaper must prove that first-pane identity.
  await controller.launch({ session: record.config.tmuxSession, cwd: '/workspace/project', command: [AGENT] });
  if (exits) {
    controller.pane(record.config.tmuxSession).history = EXIT_OUTPUT;
    controller.exit(record.config.tmuxSession, { exitStatus: 2 });
  }
  const files = new MemoryFileSystem();
  const incarnation = new FakeIncarnation();
  const registrar = new DurableTerminalPaneRegistrar(DAEMON, controller, files, MEMORY_PATHS, incarnation);
  const store = new DurableTerminalPaneStore(storage, files, MEMORY_PATHS);
  const runtime = new ExactTmuxPaneReaper(controller, incarnation);
  return { files, storage, record, controller, incarnation, registrar, store, runtime };
}

/** The fixture's tmux, except that every pane sighting is the given one. */
function sightingOnly(tmux: FakeTmux, sighting: PaneSighting): TmuxController {
  return {
    alive: async session => await tmux.alive(session),
    state: async (session, options) => await tmux.state(session, options),
    paneIdentities: async () => await tmux.paneIdentities(),
    paneIdentity: async session => await tmux.paneIdentity(session),
    paneSighting: async () => sighting,
    killPaneExact: async paneId => await tmux.killPaneExact(paneId),
    launch: async launch => await tmux.launch(launch),
    stop: async session => await tmux.stop(session),
  };
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
  await subject.storage.writeState(
    subject.record.config.id,
    sessionState(subject.record.config.id, { status: 'completed', finishedAt: NOW }),
  );
}

async function registration(subject: ReapFixture): Promise<RegisteredTerminalPane> {
  const [actual] = await subject.store.registrations(DAEMON);
  if (actual === undefined) throw new Error('test setup did not persist a terminal pane registration');
  return actual;
}

describe('durable terminal pane reap adapters', () => {
  it('should round-trip a registration only from the durable directory that owns it', async () => {
    // Arrange
    const subject = await fixture();
    await subject.registrar.register(subject.record);
    const path = createSessionPaths(MEMORY_PATHS, subject.record.config.id).terminalPane;
    const persisted = JSON.parse(subject.files.text(path) ?? 'null') as RegisteredTerminalPane;
    should(persisted.paneId).equal('%0');
    // The second the pane's session was created, as tmux reports it: what proves it once it is dead on tmux 3.8.
    should(persisted.sessionCreated).equal(subject.controller.pane(subject.record.config.tmuxSession).sessionCreated);
    should(persisted.processStartTicks).equal(await subject.incarnation.startOf(persisted.pid));
    const foreignId = parseSessionId('foreign-session');
    await subject.storage.writeState(foreignId, sessionState(foreignId, { status: 'completed', finishedAt: NOW }));
    await subject.files.writeTextAtomic(
      createSessionPaths(MEMORY_PATHS, foreignId).terminalPane,
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
    const path = createSessionPaths(MEMORY_PATHS, subject.record.config.id).terminalPane;
    const disagreements = [
      { ...original, paneId: '%999999' },
      { ...original, pid: original.pid + 1 },
      { ...original, processStartTicks: original.processStartTicks + 1 },
    ];

    // Act + Assert -- each registry value reaches the tmux observer, but none may be killed.
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
    const neverStarted = new FakeTmux();
    neverStarted.serverGone = true;
    const missingServer = new ExactTmuxPaneReaper(neverStarted, subject.incarnation);

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

    // Act -- tmux resolves the pane id, but the supplied registration is for another process.
    await subject.runtime.reap({ ...original, pid: original.pid + 1 });

    // Assert
    should(await subject.controller.alive(subject.record.config.tmuxSession)).be.true();
  });

  it('should answer every observation asked for at once from ONE listing of the panes', async () => {
    // Arrange
    const subject = await fixture();
    await subject.registrar.register(subject.record);
    const original = await registration(subject);
    const counted = new ExactTmuxPaneReaper(subject.controller, subject.incarnation);
    subject.controller.calls.length = 0;

    // Act
    const observed = await Promise.all([
      counted.observe(original),
      counted.observe(original),
      counted.observe(original),
    ]);
    const later = await counted.observe(original);

    // Assert — one listing for the three asked together, a fresh one for the one asked after.
    should(observed).deepEqual(
      [original, original, original].map(({ daemonId: _d, sessionId: _s, sessionCreated: _c, ...pane }) => pane),
    );
    should(later).deepEqual(observed[0]);
    should(subject.controller.methods()).deepEqual(['paneIdentities', 'paneIdentities']);
  });

  it('should ask about the pane on its own when tmux will not list the panes', async () => {
    // Arrange
    const subject = await fixture();
    await subject.registrar.register(subject.record);
    const original = await registration(subject);
    subject.controller.noListing = true;
    subject.controller.calls.length = 0;
    const refusing = new ExactTmuxPaneReaper(subject.controller, subject.incarnation);

    // Act
    const actual = await refusing.observe(original);

    // Assert
    should(actual).match({ paneId: original.paneId, pid: original.pid });
    should(subject.controller.methods()).deepEqual(['paneIdentities', 'paneIdentity']);
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
    const subject = await fixture(true);

    // Act / Assert
    await should(subject.registrar.register(subject.record)).be.rejectedWith(
      'the interactive harness exited (2): its last output was "ferretry: DEEPSEEK_TOKEN is not set"',
    );
  });

  it('should report the exit even when tmux answers the dead pane with no pid at all', async () => {
    // Arrange -- tmux 3.8 prints an empty `#{pane_pid}` for a pane it has reaped: `%0||1|<created>`.
    const subject = await fixture(true);
    const blank = sightingOnly(subject.controller, { paneId: '%0', dead: true, sessionCreated: 1792626406 });
    const registrar = new DurableTerminalPaneRegistrar(DAEMON, blank, subject.files, MEMORY_PATHS, subject.incarnation);

    // Act / Assert
    await should(registrar.register(subject.record)).be.rejectedWith(
      'the interactive harness exited (2): its last output was "ferretry: DEEPSEEK_TOKEN is not set"',
    );
  });

  it('should still refuse a live pane whose pid tmux does not answer', async () => {
    // Arrange
    const subject = await fixture();
    const blank = sightingOnly(subject.controller, { paneId: '%0', dead: false, sessionCreated: 1792626406 });
    const registrar = new DurableTerminalPaneRegistrar(DAEMON, blank, subject.files, MEMORY_PATHS, subject.incarnation);

    // Act / Assert -- a live pane is not an exit, so the identity refusal stands.
    await should(registrar.register(subject.record)).be.rejectedWith('tmux did not prove the launched pane identity');
  });

  it('should still refuse a live pane whose process start cannot be read', async () => {
    // Arrange
    const subject = await fixture();
    const registrar = new DurableTerminalPaneRegistrar(DAEMON, subject.controller, subject.files, MEMORY_PATHS, {
      startOf: async () => undefined,
    });

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
    await subject.storage.writeState(sessionId, sessionState(sessionId, { status: 'running' }));
    await subject.files.writeTextAtomic(createSessionPaths(MEMORY_PATHS, sessionId).terminalPane, text);
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
          sessionCreated: 1792626406,
        }),
        reported: /invalid/u,
      },
      {
        text: JSON.stringify({
          daemonId: DAEMON,
          sessionId: DAMAGED,
          tmuxSession: 'fy-damaged',
          paneId: '%4',
          pid: 4242,
          processStartTicks: 99,
          sessionCreated: 'yesterday',
        }),
        reported: /incomplete/u,
      },
      {
        text: JSON.stringify({
          daemonId: DAEMON,
          sessionId: DAMAGED,
          tmuxSession: 'fy-damaged',
          paneId: '%4',
          pid: 4242,
          processStartTicks: 99,
        }),
        reported: /incomplete/u,
      },
      {
        text: JSON.stringify({
          daemonId: DAEMON,
          sessionId: DAMAGED,
          tmuxSession: 'fy-damaged',
          paneId: '%4',
          pid: 4242,
          processStartTicks: 99,
          sessionCreated: 0,
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
