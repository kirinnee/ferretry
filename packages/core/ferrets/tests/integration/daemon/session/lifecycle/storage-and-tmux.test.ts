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
import { FileSessionEffectLedger } from '../../../../../daemon/adapters/session/effects/file-session-effect-ledger.ts';
import { FileSessionEnvironmentStore } from '../../../../../daemon/adapters/session/lifecycle/file-session-environment-store.ts';
import { FileSessionTaskStore } from '../../../../../daemon/adapters/session/lifecycle/file-session-task-store.ts';
import { NodeSessionCredentialIssuer } from '../../../../../daemon/adapters/session/lifecycle/node-session-credential-issuer.ts';
import { NodeWorkingDirectoryResolver } from '../../../../../daemon/adapters/session/lifecycle/node-working-directory-resolver.ts';
import {
  StorageSessionLifecycleRepository,
  UnusableSessionRecordError,
} from '../../../../../daemon/adapters/session/lifecycle/storage-session-lifecycle-repository.ts';
import { TimeSessionIdFactory } from '../../../../../daemon/adapters/session/lifecycle/time-session-id-factory.ts';
import { TmuxSessionLifecycleLauncher } from '../../../../../daemon/adapters/session/lifecycle/tmux-session-lifecycle-launcher.ts';
import { KeyedSerialExecutor } from '../../../../../daemon/adapters/storage/keyed-serial-executor.ts';
// Imported from their own modules rather than the barrel: each lifecycle module keeps its OWN copy
// of this helper — no shared filesystem abstraction was introduced — so these are distinct
// functions, each of which has to be proven on its own. They are named apart rather than sharing one
// name because `lifecycle/index.ts` star-exports both modules, and a shared name would collide
// there and again in `adapters/index.ts`.
import { fsyncEnvironmentDirectory } from '../../../../../daemon/adapters/session/lifecycle/file-session-environment-store.ts';
import { fsyncTaskDirectory } from '../../../../../daemon/adapters/session/lifecycle/file-session-task-store.ts';
import {
  type DaemonStorage,
  InvalidStateDocumentError,
} from '../../../../../daemon/adapters/storage/session-storage.ts';
import type { SessionLaunchInstructions } from '../../../../../daemon/lib/protocol/session.ts';
import { SessionStatusSchema } from '../../../../../daemon/lib/protocol/session.ts';
import { FerretStateFile } from '../../../../../contract/index.ts';
import { createSessionRecord, transitionSessionRecord } from '../../../../../daemon/lib/session/lifecycle/policy.ts';
import { SessionLifecycleService } from '../../../../../daemon/lib/session/lifecycle/service.ts';
import { defaultSessionLifecycleSettings } from '../../../../../daemon/lib/session/lifecycle/settings.ts';
import type {
  SessionEnvironmentStore,
  SessionLifecycleRecord,
} from '../../../../../daemon/lib/session/lifecycle/types.ts';
import type { AccountLaunchEnvironment, AccountLaunchRenewal } from '../../../../../daemon/lib/session/peers/fleet.ts';
import type { TmuxLaunch } from '../../../../../daemon/lib/session/peers/tmux-lifecycle.ts';
import { parseSessionId, type SessionId } from '../../../../../daemon/lib/session-id.ts';
import { FakePaneDelivery, FakeTmux } from '../../../../support/daemon/fake-tmux.ts';
import { memoryStorage, sessionEnvelope } from '../../../../support/daemon/storage.ts';

/**
 * The lifecycle's storage-backed repository, its tmux launcher and its file stores, composed.
 *
 * The session documents and journal live in the kernel's state port (`memoryStorage`); the tmux the launcher drives is
 * the injected `TmuxController`/`TmuxPaneDelivery` pair (`FakeTmux`/`FakePaneDelivery`), because the real controller
 * and delivery belong to the terminals plugin and are tested there. The turn, environment and effect files are still
 * this package's own `node:fs` adapters, so those run against real temporary directories.
 */

const homes = new Set<string>();
const NOW = '2026-07-31T10:00:00.000Z';
const AGENT = '/opt/fleet/bin/claude-auto-loge';

async function temporaryHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  homes.add(home);
  return home;
}

async function openStorage(): Promise<DaemonStorage> {
  return (await memoryStorage({ clock: { now: () => NOW } })).storage;
}

/** The event types a session's journal holds, in order. */
async function journal(storage: DaemonStorage, id: SessionId): Promise<readonly string[]> {
  return (await storage.replay(id)).events.map(event => event.type);
}

function record(id = 'stored-session', overrides: Record<string, unknown> = {}): SessionLifecycleRecord {
  return createSessionRecord(
    { agent: AGENT, cwd: '/workspace/project', mode: 'auto', prompt: 'Persist me', ...overrides },
    { id: parseSessionId(id), cwd: '/workspace/project', at: NOW, settings: defaultSessionLifecycleSettings },
  ).record;
}

/** A record's configuration as the store holds it: the protocol envelope beneath, the lifecycle's own fields over it. */
function storedConfig(held: SessionLifecycleRecord): Record<string, unknown> {
  return { ...sessionEnvelope(), ...held.config, agent: 'claude-auto-loge' };
}

/** A launcher over a fresh fake tmux, with the delivery that reads it. */
function launcher(environment?: SessionEnvironmentStore) {
  const tmux = new FakeTmux();
  const delivery = new FakePaneDelivery(tmux);
  const instance = new TmuxSessionLifecycleLauncher(tmux, delivery, environment);
  return { instance, tmux, delivery };
}

/** The environment the first launch handed its pane. */
function firstLaunchEnv(tmux: FakeTmux): Readonly<Record<string, string>> {
  return tmux.launches[0]?.env ?? {};
}

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('StorageSessionLifecycleRepository', () => {
  it('should persist and read the lifecycle record through the authoritative daemon store', async () => {
    // Arrange
    const storage = await openStorage();
    const subject = new StorageSessionLifecycleRepository(storage, sessionEnvelope());
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

    // Assert
    should(actual).deepEqual(created.record);
    // The DOCUMENT records the wrapper NAME, because one file serves both this schema and the
    // protocol's, whose `agent` is the name every account is published under. The absolute executable
    // the lifecycle authorizes against is `command[0]`, which is where the read above recovered it
    // from — so the record round-trips while the document stays the one every mounted surface parses.
    // beneath it, the protocol envelope the start decided, which the declared schema demands of every document.
    should(await storage.readConfig(created.record.config.id)).deepEqual({
      ...sessionEnvelope(),
      ...created.record.config,
      agent: 'claude-auto-loge',
    });
    should(await storage.readState(created.record.config.id)).deepEqual({
      ...created.record.state,
      turn: sessionEnvelope().turn,
    });
    should(await journal(storage, created.record.config.id)).containEql('session.created');
    await storage.close();
  });

  it('should report an unknown session as missing rather than inventing one', async () => {
    // Arrange
    const storage = await openStorage();
    const subject = new StorageSessionLifecycleRepository(storage, sessionEnvelope());

    // Act
    const actual = await subject.read(parseSessionId('never-created'));

    // Assert
    should(actual).be.undefined();
    await storage.close();
  });

  it('should reserve a session without publishing a record or duplicate create event', async () => {
    // Arrange
    const storage = await openStorage();
    const subject = new StorageSessionLifecycleRepository(storage, sessionEnvelope());
    const id = parseSessionId('reserved-session');
    const capability = 'reserved-capability';
    const capabilityHash = createHash('sha256').update(capability, 'utf8').digest('hex');
    const created = createSessionRecord(
      {
        agent: AGENT,
        cwd: '/workspace/project',
        mode: 'auto',
        prompt: 'Publish me later',
        capabilityHash: capabilityHash,
      },
      { id, cwd: '/workspace/project', at: NOW, settings: defaultSessionLifecycleSettings },
    );

    // Act — a repeated reservation is still not a lifecycle record.
    await subject.reserve(id);
    await subject.reserve(id);

    // Assert
    should(await subject.read(id)).be.undefined();
    should(await storage.readConfig(id)).be.undefined();
    should(await storage.readState(id)).be.undefined();
    should(storage.listSessions().map(session => session.id)).deepEqual([]);

    // Publishing keeps the exact hash agreement and appends one create event, never two.
    await subject.write(created.record, created.event);
    should((await subject.read(id))?.config.capabilityHash).equal(capabilityHash);
    should(storage.listSessions().map(session => session.id)).deepEqual([id]);
    should(await journal(storage, id)).deepEqual(['session.created']);
    await storage.close();
  });

  it('should still publish no session document from a reservation', async () => {
    // Arrange
    const storage = await openStorage();
    const subject = new StorageSessionLifecycleRepository(storage, sessionEnvelope());
    const id = parseSessionId('reserved-invisible');

    // Act
    await subject.reserve(id);

    // Assert: a reservation is not publication of the session.
    should(await subject.read(id)).equal(undefined);
    should(storage.findSession(id)).equal(undefined);
  });

  it('should recover a create that tore between its configuration and state writes', async () => {
    // Arrange — exactly what a crash between the two writes leaves behind.
    const storage = await openStorage();
    const subject = new StorageSessionLifecycleRepository(storage, sessionEnvelope());
    const torn = record('torn-session');
    await storage.writeConfig(torn.config.id, storedConfig(torn));

    // Act
    const actual = await subject.read(torn.config.id);

    // Assert — nothing was launched, so `created` is the truthful reading and the record is usable.
    should(actual).deepEqual({ config: torn.config, state: { id: 'torn-session', status: 'created' } });
    const stopped = transitionSessionRecord(torn, 'stopped', '2026-07-31T10:05:00.000Z', 'cleaned up');
    await subject.write(stopped.record, stopped.event);
    should((await subject.read(torn.config.id))?.state.status).equal('stopped');
    await storage.close();
  });

  it('should name the damage when a record cannot be trusted at all', async () => {
    // Arrange
    const storage = await openStorage();
    const subject = new StorageSessionLifecycleRepository(storage, sessionEnvelope());
    const orphan = parseSessionId('state-only-session');
    const invalid = record('invalid-session');
    await storage.writeState(orphan, { id: orphan, status: 'running', turn: 0 });
    await storage.writeConfig(invalid.config.id, { ...storedConfig(invalid), command: [] });
    await storage.writeState(invalid.config.id, { ...invalid.state, turn: 0 });

    // Act + Assert
    await should(subject.read(orphan)).be.rejectedWith(UnusableSessionRecordError);
    await should(subject.read(orphan)).be.rejectedWith(/configuration document is missing/u);
    await should(subject.read(invalid.config.id)).be.rejectedWith(/config\.command/u);
    await storage.close();
  });

  it('should read, and let a stop write, a session whose turn was interrupted by a client', async () => {
    // Arrange — the exact state a person's Stop met: the send path wrote a turn-level status.
    const storage = await openStorage();
    const subject = new StorageSessionLifecycleRepository(storage, sessionEnvelope());
    const interrupted = record('interrupted-session');
    await storage.writeConfig(interrupted.config.id, storedConfig(interrupted));
    await storage.writeState(interrupted.config.id, {
      id: interrupted.config.id,
      status: 'interrupted',
      turn: 2,
      startedAt: '2026-10-22T09:07:17.045Z',
      turnState: 'working',
      turnStateAt: '2026-10-22T09:09:40.200Z',
      health: 'idle',
      promptReady: true,
      turnCompleted: false,
      reason: 'interrupted by client',
    });

    // Act
    const read = await subject.read(interrupted.config.id);
    if (read === undefined) throw new Error('the interrupted session was not read');
    const stopped = transitionSessionRecord(read, 'stopped', '2026-10-22T09:12:00.000Z', 'stopped by client');
    await subject.write(stopped.record, stopped.event);

    // Assert — usable, and the stop merged over the turn fields it does not own.
    should(read.state.status).equal('interrupted');
    const state = await storage.readState(interrupted.config.id);
    should(state).containDeep({ status: 'stopped', reason: 'stopped by client', turn: 2, turnState: 'working' });
    await storage.close();
  });

  it('should read a session carrying any status the protocol defines', async () => {
    // Arrange
    const { storage, folder } = await memoryStorage({ clock: { now: () => NOW } });
    const subject = new StorageSessionLifecycleRepository(storage, sessionEnvelope());
    const held = record('every-status');
    await storage.writeConfig(held.config.id, storedConfig(held));

    for (const status of SessionStatusSchema.options) {
      await storage.writeState(held.config.id, { id: held.config.id, status, turn: 0 });

      // Act + Assert
      should((await subject.read(held.config.id))?.state.status).equal(status);
    }
    // The store refuses to write a status the protocol does not name, so the document is laid on disk as a foreign
    // file would be; reading it names the damage rather than guessing a status.
    folder.plant(
      FerretStateFile,
      JSON.stringify({ format: 1, id: held.config.id, status: 'not-a-status', turn: 0 }),
      held.config.id,
    );
    await should(subject.read(held.config.id)).be.rejectedWith(InvalidStateDocumentError);
    await should(subject.read(held.config.id)).be.rejectedWith(/every-status\/state\.json.*does not match its schema/u);
    await storage.close();
  });

  it('should keep the journal behind the state it describes', async () => {
    // Arrange
    const storage = await openStorage();
    const subject = new StorageSessionLifecycleRepository(storage, sessionEnvelope());
    const created = record('journal-session');
    const started = transitionSessionRecord(created, 'starting', '2026-07-31T10:01:00.000Z');

    // Act
    await subject.write(created, { type: 'session.created', data: {} });
    await subject.write(started.record, started.event);

    // Assert
    should(await journal(storage, created.config.id)).deepEqual(['session.created', 'session.starting']);
    should((await subject.read(created.config.id))?.state.status).equal('starting');
    await storage.close();
  });
});

describe('TmuxSessionLifecycleLauncher', () => {
  it('should launch and stop only through the injected isolated tmux controller', async () => {
    // Arrange
    const { instance: subject, tmux } = launcher();
    const input = record('tmux-session', { command: [AGENT, '--mode', 'auto'] });

    // Act
    const before = await subject.alive(input);
    await subject.launch(input);
    const during = await subject.alive(input);
    await subject.stop(input);

    // Assert
    should([before, during]).deepEqual([false, true]);
    should(tmux.calls).deepEqual([
      ['alive', 'fy-tmux-session'],
      ['launch', 'fy-tmux-session'],
      ['alive', 'fy-tmux-session'],
      ['stop', 'fy-tmux-session'],
    ]);
    // A session with no stored environment still launches carrying its OWN id: the identity is
    // derived from the record, so it does not depend on a file the session may never have had.
    should(tmux.launches).deepEqual([
      {
        session: 'fy-tmux-session',
        cwd: '/workspace/project',
        command: [AGENT, '--mode', 'auto'],
        env: { FY_HYPERMEDIA: '0', FY_SESSION_ID: 'tmux-session' },
      } satisfies TmuxLaunch,
    ]);
  });

  it('should register a launched pane and wait publicly for its startup prompt', async () => {
    // Arrange — the real launcher over the injected controller and delivery.
    const tmux = new FakeTmux();
    const delivery = new FakePaneDelivery(tmux);
    const registered: SessionLifecycleRecord[] = [];
    let announceRegistrarEntry = (): void => undefined;
    const entered = new Promise<void>(resolve => {
      announceRegistrarEntry = resolve;
    });
    let releaseRegistration = (): void => undefined;
    const registrationRelease = new Promise<void>(resolve => {
      releaseRegistration = resolve;
    });
    const subject = new TmuxSessionLifecycleLauncher(tmux, delivery, undefined, {
      register: async actual => {
        registered.push(actual);
        announceRegistrarEntry();
        await registrationRelease;
      },
    });
    const input = record('registered-session');

    // Act — a fire-and-forget registrar would let this launch settle while registration remains held.
    let launchSettled = false;
    const launch = subject.launch(input).then(
      result => {
        launchSettled = true;
        return result;
      },
      error => {
        launchSettled = true;
        throw error;
      },
    );
    await entered;
    await Promise.resolve();

    // Assert — the complete record entered the registrar, but launch cannot finish until it releases.
    should(registered).deepEqual([input]);
    should(launchSettled).be.false();
    should(delivery.calls).deepEqual([]);

    // Act — registration is now complete; readiness remains a separate public startup step.
    releaseRegistration();
    await launch;
    await subject.ready(input);

    // Assert — ready is the delivery's startup wait, asked only after the awaited registration, and nothing is typed.
    should(delivery.calls).deepEqual([['waitReady', 'fy-registered-session', undefined]]);
    should(delivery.delivered).deepEqual([]);
  });

  it('should kill the pane it launched when that pane cannot be registered', async () => {
    // Arrange — the pane exists by the time registration runs. Left alive, it is an agent no record
    // names: the lifecycle sees a live pane and records the failure without retrying, the reap reads
    // only registrations, and it outlives `fy daemon stop`.
    const tmux = new FakeTmux();
    const subject = new TmuxSessionLifecycleLauncher(tmux, new FakePaneDelivery(tmux), undefined, {
      register: async () => {
        throw new Error('tmux did not prove the launched pane identity');
      },
    });

    // Act + Assert
    await should(subject.launch(record('unregistered-session'))).be.rejectedWith(
      'tmux did not prove the launched pane identity',
    );
    should(tmux.methods()).containEql('stop');
    should(tmux.panes.has('fy-unregistered-session')).be.false();
  });

  it('should say so when the pane it could not register cannot be killed either', async () => {
    // Arrange
    const tmux = new FakeTmux();
    tmux.failures.set('stop', 'server exited unexpectedly');
    const subject = new TmuxSessionLifecycleLauncher(tmux, new FakePaneDelivery(tmux), undefined, {
      register: async () => {
        throw new Error('tmux did not prove the launched pane identity');
      },
    });

    // Act + Assert — both failures are named, so nobody believes the pane is gone.
    await should(subject.launch(record('stuck-session'))).be.rejectedWith(
      'tmux did not prove the launched pane identity; the unregistered pane could not be stopped either (server exited unexpectedly)',
    );
  });

  it('should hand the first turn to the delivery for the pane it launched', async () => {
    // Arrange
    const { instance: subject, delivery } = launcher();
    const input = record('deliver-session');
    await subject.launch(input);
    const order: string[] = [];

    // Act
    await subject.deliver(input, 'Read the file /turns/turn-001.md now', async () => {
      order.push('before-write');
    });

    // Assert — the delivery owns the wait and the write; the launcher names the pane and passes the hook through.
    should(order).deepEqual(['before-write']);
    should(delivery.delivered).deepEqual([
      { session: 'fy-deliver-session', text: 'Read the file /turns/turn-001.md now' },
    ]);
  });

  it('should surface a tmux failure rather than reporting a launch or stop that did not happen', async () => {
    // Arrange
    const launchFails = launcher();
    launchFails.tmux.failures.set('launch', 'no server running on /tmp/fy.sock');
    const stopFails = launcher();
    stopFails.tmux.open('fy-failing-session');
    stopFails.tmux.failures.set('stop', 'session not found');
    const sendFails = launcher();
    sendFails.tmux.open('fy-failing-session');
    sendFails.delivery.failures.set('deliver', 'pane is unwritable');
    const input = record('failing-session');

    // Act + Assert
    await should(launchFails.instance.launch(input)).be.rejectedWith('no server running on /tmp/fy.sock');
    await should(stopFails.instance.stop(input)).be.rejectedWith('session not found');
    await should(sendFails.instance.deliver(input, 'anything')).be.rejectedWith('pane is unwritable');
  });

  it('should reject an invalid record before issuing a tmux launch command', async () => {
    // Arrange
    const { instance: subject, tmux } = launcher();
    const input = record('empty-command', { mode: 'interactive', prompt: undefined });
    const malformed = { ...input, config: { ...input.config, command: [] } };

    // Act + Assert
    await should(subject.launch(malformed)).be.rejectedWith('session command is empty');
    should(tmux.calls).deepEqual([]);
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
    const home = await temporaryHome('ferretry-environment-store-');
    const id = parseSessionId('published-environment');
    const directory = join(home, id);
    const reused = join(directory, 'environment.json.fixed-id.tmp');
    let plantedDuringSync = false;
    const subject = new FileSessionEnvironmentStore(
      held => join(home, held),
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
    // Arrange — every adapter is the production one; only the tmux ports are doubles.
    const storage = await openStorage();
    const files = await temporaryHome('ferretry-lifecycle-files-');
    const { instance, tmux, delivery } = launcher();
    const cwd = await temporaryHome('ferretry-lifecycle-cwd-');
    const subject = new SessionLifecycleService(
      {
        repository: new StorageSessionLifecycleRepository(storage, sessionEnvelope()),
        launcher: instance,
        tasks: new FileSessionTaskStore(id => join(files, id)),
        effects: new FileSessionEffectLedger(id => join(files, id)),
        directories: new NodeWorkingDirectoryResolver(),
        ids: new TimeSessionIdFactory(
          () => Date.parse(NOW),
          () => 'ABCDEF12-3456-7890-ABCD-EF1234567890',
        ),
        clock: { now: () => NOW },
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
    const taskFile = join(files, running.config.id, 'turns', 'turn-001.md');
    const typed = delivery.delivered[0];
    const stopped = await subject.stop(running.config.id, 'work complete');

    // Assert — the agent was told to read the file that exists and holds its assignment.
    should(running.config.id).equal('ms8ru4g0-abcdef12');
    should(running.state.status).equal('running');
    should(await readFile(taskFile, 'utf8')).equal('# Assigned task\n\nFinish the lifecycle unit\n');
    should(typed?.text).equal(
      `Read the file ${taskFile} now, then carefully follow every instruction inside it. This is your complete task for this turn.`,
    );
    should(tmux.methods()).containEql('launch');
    should(stopped.state).containDeep({ status: 'stopped', reason: 'work complete' });
    should(tmux.methods().at(-1)).equal('stop');
    should(await journal(storage, running.config.id)).deepEqual([
      'session.created',
      'session.starting',
      'session.running',
      'session.stopped',
    ]);
    await storage.close();
  });

  it('should hand the launched pane its own credential, keeping the plaintext off the session document', async () => {
    // Arrange — the real credential issuer, the real environment file, and the real launcher, so the
    // only doubles in the chain are the tmux ports.
    const storage = await openStorage();
    const files = await temporaryHome('ferretry-lifecycle-files-');
    const cwd = await temporaryHome('ferretry-lifecycle-cwd-');
    const environment = new FileSessionEnvironmentStore(id => join(files, id));
    const { instance, tmux } = launcher(environment);
    const subject = new SessionLifecycleService(
      {
        repository: new StorageSessionLifecycleRepository(storage, sessionEnvelope()),
        launcher: instance,
        tasks: new FileSessionTaskStore(id => join(files, id)),
        effects: new FileSessionEffectLedger(id => join(files, id)),
        directories: new NodeWorkingDirectoryResolver(),
        ids: new TimeSessionIdFactory(
          () => Date.parse(NOW),
          () => 'ABCDEF12-3456-7890-ABCD-EF1234567890',
        ),
        clock: { now: () => NOW },
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
    const env = firstLaunchEnv(tmux);

    // Assert — the pane really was launched carrying the secret, under the name the CLI reads.
    should(capability).be.a.String().and.not.be.empty();
    should(env.FY_SESSION_BOARD_CAPABILITY).equal(capability);
    // The stored secret and the DERIVED identity compose rather than displacing one another: the
    // pane gets both, in the same launch, under the two names the CLI reads.
    should(env.FY_SESSION_ID).equal(id);
    // The id is never written into the environment document. It is on the record already, so storing
    // it would only create a second copy that a merge could contradict.
    should(await environment.read(id)).not.have.property('FY_SESSION_ID');
    // The hash is durable on the record — it is what the task-board domain keys grants on — and the
    // capability itself appears nowhere any reader of the session document can reach.
    should(running.config.capabilityHash).equal(
      createHash('sha256')
        .update(capability ?? '', 'utf8')
        .digest('hex'),
    );
    const document = JSON.stringify(await storage.readConfig(id));
    should(document).not.containEql(capability);
    should(document).containEql(running.config.capabilityHash);
    // Only the owning daemon may read the one copy of the plaintext.
    should((await stat(environment.file(id))).mode & 0o777).equal(0o600);
    await storage.close();
  });
});

describe('TimeSessionIdFactory', () => {
  it('should never delete a colliding environment temporary it did not create', async () => {
    // Arrange: this file is the only place a session's plaintext credential lives, so destroying
    // another writer's in-flight document on the way out of a failure is the worst possible cleanup.
    const home = await temporaryHome('ferretry-environment-store-');
    const id = parseSessionId('collided-environment');
    const directory = join(home, id);
    const subject = new FileSessionEnvironmentStore(
      held => join(home, held),
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
  // Typed to ONE signature rather than inferred `as const`: the two exports are distinct
  // functions, and an inferred union of them would be a union of call signatures rather than the
  // single contract every one of them is required to keep.
  const helpers: ReadonlyArray<{
    readonly owner: string;
    readonly fsyncDirectory: (path: string, openDirectory?: (target: string) => Promise<FileHandle>) => Promise<void>;
  }> = [
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

/**
 * The launch path and an account a profile authenticates.
 *
 * The profile is resolved PER LAUNCH, against the account this session actually runs, so a rotated
 * credential reaches the next pane without an apply and a missing one refuses here rather than
 * letting the harness fail against a remote service minutes later.
 */
describe('TmuxSessionLifecycleLauncher and a profile-authenticated account', () => {
  const profiled = (
    tmux: FakeTmux,
    accountEnvironment: AccountLaunchEnvironment,
    environment?: SessionEnvironmentStore,
  ) =>
    new TmuxSessionLifecycleLauncher(
      tmux,
      new FakePaneDelivery(tmux),
      environment,
      undefined,
      undefined,
      undefined,
      accountEnvironment,
    );

  it('should ask about the executable this session runs, and hand the pane what it answers', async () => {
    // Arrange
    const tmux = new FakeTmux();
    const asked: string[] = [];
    const subject = profiled(tmux, {
      forWrapper: async wrapper => {
        asked.push(wrapper);
        return { ANTHROPIC_API_KEY: 'fixture-value' };
      },
    });

    // Act
    await subject.launch(record('profiled-session'));

    // Assert
    should(asked).deepEqual([AGENT]);
    should(firstLaunchEnv(tmux)).containDeep({ ANTHROPIC_API_KEY: 'fixture-value', FY_SESSION_ID: 'profiled-session' });
  });

  it('should let the session keep its own variable when a profile names the same one', async () => {
    // Arrange
    const tmux = new FakeTmux();
    const stored: SessionEnvironmentStore = {
      write: async () => undefined,
      read: async () => ({ FY_SESSION_BOARD_CAPABILITY: 'this-session-only' }),
    };
    const subject = profiled(tmux, { forWrapper: async () => ({ FY_SESSION_BOARD_CAPABILITY: 'shared' }) }, stored);

    // Act
    await subject.launch(record('contested-session'));

    // Assert
    should(firstLaunchEnv(tmux).FY_SESSION_BOARD_CAPABILITY).equal('this-session-only');
  });

  it('should refuse the launch when the profile cannot be resolved, rather than start without it', async () => {
    // Arrange — an empty credential is a 401 from a remote service with nothing to point at.
    const tmux = new FakeTmux();
    const subject = profiled(tmux, {
      forWrapper: async () => {
        throw new Error('this daemon holds no secret named WORK_KEY');
      },
    });

    // Act & Assert
    await should(subject.launch(record('missing-secret-session'))).be.rejectedWith(/no secret named WORK_KEY/u);
    should(tmux.launches).be.empty();
  });

  it('should launch exactly as it always did when no resolver is wired at all', async () => {
    // Arrange
    const { instance: subject, tmux } = launcher();

    // Act
    await subject.launch(record('plain-session'));

    // Assert — its own id, and the hypermedia default every pane carries (docs/hypermedia.md).
    should(firstLaunchEnv(tmux)).deepEqual({ FY_HYPERMEDIA: '0', FY_SESSION_ID: 'plain-session' });
  });

  it('should hand the pane its media folder and question file when they are wired', async () => {
    // Arrange
    const tmux = new FakeTmux();
    const asked: string[] = [];
    const subject = new TmuxSessionLifecycleLauncher(
      tmux,
      new FakePaneDelivery(tmux),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async id => {
        asked.push(id);
        return {
          media: `/state/sessions/${id}/media`,
          questionAsked: `/state/sessions/${id}/question-asked.json`,
        };
      },
    );

    // Act
    await subject.launch(record('media-session'));

    // Assert — created per launch and handed over as FY_MEDIA_DIR (docs/hypermedia.md), with the file
    // Claude's question hook records an open question in (FY_QUESTION_FILE).
    should(asked).deepEqual(['media-session']);
    should(firstLaunchEnv(tmux)).containDeep({
      FY_MEDIA_DIR: '/state/sessions/media-session/media',
      FY_QUESTION_FILE: '/state/sessions/media-session/question-asked.json',
    });
  });

  it('should launch an interactive ferret with hypermedia on and an auto one with it off', async () => {
    // Arrange
    const hypermediaOf = async (mode: 'auto' | 'interactive') => {
      const { instance: subject, tmux } = launcher();
      await subject.launch(record(`mode-${mode}`, { mode, ...(mode === 'interactive' ? { prompt: undefined } : {}) }));
      return firstLaunchEnv(tmux).FY_HYPERMEDIA;
    };

    // Act
    const interactive = await hypermediaOf('interactive');
    const auto = await hypermediaOf('auto');

    // Assert
    should(interactive).equal('1');
    should(auto).equal('0');
  });
});

/**
 * The launch path and the account's chance to renew before the pane runs it.
 *
 * ATTENDED RENEWAL'S SECOND DOOR: a person started this session, which is the only condition under
 * which this product rotates a credential. What the launcher owes the port is narrow and both halves
 * matter — the renewal must happen BEFORE the pane, and it must never be able to stop the pane.
 */
describe('TmuxSessionLifecycleLauncher and a credential that can renew itself', () => {
  const renewing = (tmux: FakeTmux, accountRenewal: AccountLaunchRenewal) =>
    new TmuxSessionLifecycleLauncher(
      tmux,
      new FakePaneDelivery(tmux),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      accountRenewal,
    );

  it('should give the account its turn before the pane exists, not after', async () => {
    // Ordering is the feature. A renewal that ran after the launch would be racing the harness this
    // launch just started, which is the one thing the whole attended rule exists to avoid.
    // Arrange
    const order: string[] = [];
    class OrderedTmux extends FakeTmux {
      override async launch(launch: TmuxLaunch): Promise<void> {
        order.push('launch');
        await super.launch(launch);
      }
    }
    const subject = renewing(new OrderedTmux(), {
      beforeLaunch: async wrapper => {
        order.push(`renew ${wrapper}`);
      },
    });

    // Act
    await subject.launch(record('renewed-session'));

    // Assert
    should(order).deepEqual([`renew ${AGENT}`, 'launch']);
  });

  it('should start the session anyway when the renewal takes its time and answers nothing', async () => {
    // The port answers nothing a launch could branch on, and this pins that there is no branch: a
    // renewal that could not happen is not a reason not to start a session.
    // Arrange
    const tmux = new FakeTmux();
    const subject = renewing(tmux, { beforeLaunch: async () => await Promise.resolve() });

    // Act
    await subject.launch(record('undecided-session'));

    // Assert
    should(tmux.launches).have.length(1);
  });

  it('should launch exactly as it always did when no renewal is wired at all', async () => {
    // Arrange
    const { instance: subject, tmux } = launcher();

    // Act
    await subject.launch(record('unrenewed-session'));

    // Assert
    should(tmux.launches).have.length(1);
  });
});

/**
 * What a launch says its pane was told: read off the environment the pane was actually given — the
 * stored switches, the mode-derived hypermedia default — and never the text itself. Which sections that
 * environment turns into is the runtimes plugin's `launchInstructions`, injected here as `describe`.
 */
describe('TmuxSessionLifecycleLauncher launch instructions', () => {
  const TOLD: SessionLaunchInstructions = {
    sections: [{ id: 'tools', chars: 12 }],
    mode: 'interactive',
    questions: true,
  };

  const named = (tmux: FakeTmux, stored: Readonly<Record<string, string>>) => {
    const asked: { readonly fy: string; readonly env: Readonly<Record<string, string>> }[] = [];
    const environment: SessionEnvironmentStore = { write: async () => undefined, read: async () => stored };
    const subject = new TmuxSessionLifecycleLauncher(
      tmux,
      new FakePaneDelivery(tmux),
      environment,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'zz',
      (fy, env) => {
        asked.push({ fy, env });
        return TOLD;
      },
    );
    return { subject, asked };
  };

  it('should answer what the environment it launched the pane with describes', async () => {
    // Arrange
    const tmux = new FakeTmux();
    const { subject, asked } = named(tmux, { FY_SESSION_MODE: 'interactive', FY_PACK: '1', FY_LEARNING_PASSIVE: '0' });

    // Act
    const launched = await subject.launch(record('told-session', { mode: 'interactive' }));

    // Assert — described from the very environment the pane received, under the binary name it was told.
    should(launched).deepEqual(TOLD);
    should(asked).deepEqual([{ fy: 'zz', env: firstLaunchEnv(tmux) }]);
    should(asked[0]?.env).containDeep({ FY_SESSION_MODE: 'interactive', FY_PACK: '1', FY_HYPERMEDIA: '1' });
  });

  it('should describe a stored switch that wins over the mode default', async () => {
    // Arrange
    const tmux = new FakeTmux();
    const { subject, asked } = named(tmux, { FY_SESSION_MODE: 'auto', FY_HYPERMEDIA: '1' });

    // Act
    await subject.launch(record('worker-session'));

    // Assert
    should(asked[0]?.env).containDeep({ FY_SESSION_MODE: 'auto', FY_HYPERMEDIA: '1' });
  });

  it('should answer nothing when it was not told the binary name', async () => {
    // Arrange
    const tmux = new FakeTmux();
    const asked: string[] = [];
    const subject = new TmuxSessionLifecycleLauncher(
      tmux,
      new FakePaneDelivery(tmux),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fy => {
        asked.push(fy);
        return TOLD;
      },
    );

    // Act
    const launched = await subject.launch(record('unnamed-session'));

    // Assert
    should(launched).be.undefined();
    should(asked).deepEqual([]);
  });
});
