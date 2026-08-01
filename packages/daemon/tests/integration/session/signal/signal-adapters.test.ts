import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  FileSignalArtifacts,
  KeyedSerialExecutor,
  LauncherSignalTerminal,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  StorageSignalRepository,
  SystemClock,
} from '../../../../src/adapters/index.ts';
import { parseSessionId, type SessionId } from '../../../../src/lib/index.ts';

/**
 * The durable side of a signal: the record it rewrites, the evidence it leaves, and the pane it stops.
 *
 * Everything runs against a temp `FY_HOME` and a launcher the test owns. Nothing here starts a daemon,
 * binds a port, or addresses a tmux server.
 */

const homes = new Set<string>();
const NOW = '2026-08-01T12:00:00.000Z';
const ID = parseSessionId('session-1');
const PEER = parseSessionId('session-2');

async function openStorage(instant = NOW) {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-signal-test-'));
  homes.add(home);
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(instant)),
    () => new KeyedSerialExecutor(),
  );
  return { home, opened: await factory.open() };
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    name: 'Signal for yourself',
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

const clock = { now: () => NOW };

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('the signal artifact store', () => {
  it('should write the summary the teammate gave, and a default one when it gave none', async () => {
    // Arrange
    const home = await mkdtemp(join(tmpdir(), 'ferretry-signal-files-'));
    homes.add(home);
    const store = new FileSignalArtifacts(() => home, clock);

    // Act
    await store.writeSummary(ID, '  shipped the port  ');
    const given = await readFile(join(home, 'summary.md'), 'utf8');
    await store.writeSummary(ID, '   ');
    const blank = await readFile(join(home, 'summary.md'), 'utf8');
    await store.writeSummary(ID, undefined);
    const absent = await readFile(join(home, 'summary.md'), 'utf8');

    // Assert
    // Trimmed and newline-terminated: it is a file a person opens, not a log line.
    should(given).equal('shipped the port\n');
    // A whitespace-only message is no message at all, so it gets the default rather than a blank file.
    should(blank).equal(absent);
    should(absent).match(/inspect chat and repository diff/u);
    should((await stat(join(home, 'summary.md'))).mode & 0o777).equal(0o600);
  });

  it('should write the done marker under the name the revive already clears, carrying the turn', async () => {
    // THE FILENAME IS A CONTRACT. `FileResumeTurnStore` removes `done.marker` before every relaunch; a
    // completion written under any other name would survive a revive and end the new turn at once.
    // Arrange
    const home = await mkdtemp(join(tmpdir(), 'ferretry-signal-marker-'));
    homes.add(home);
    const store = new FileSignalArtifacts(() => home, clock);

    // Act
    await store.markDone(ID, 4);

    // Assert
    const marker = JSON.parse(await readFile(join(home, 'done.marker'), 'utf8')) as Record<string, unknown>;
    should(marker).deepEqual({ at: NOW, type: 'done', turn: 4 });
    // Nothing but the marker is left behind: the temporary file it was renamed from is gone.
    should((await readdir(home)).toSorted()).deepEqual(['done.marker']);
  });

  it('should append every question to the outbox and keep the latest as the marker', async () => {
    // Two places for two questions: the outbox is the conversation a lead reads in order, and the
    // marker is the current condition a supervisor stats without parsing a log.
    // Arrange
    const home = await mkdtemp(join(tmpdir(), 'ferretry-signal-question-'));
    homes.add(home);
    const store = new FileSignalArtifacts(() => home, clock);

    // Act
    await store.raiseQuestion(ID, 'which branch?');
    await store.raiseQuestion(ID, 'and which base?');

    // Assert
    const lines = (await readFile(join(home, 'channel', 'outbox.jsonl'), 'utf8')).trimEnd().split('\n');
    should(lines).have.length(2);
    should(JSON.parse(lines[0] ?? '')).deepEqual({ at: NOW, type: 'question', message: 'which branch?' });
    should(JSON.parse(await readFile(join(home, 'needs-help.marker'), 'utf8'))).deepEqual({
      at: NOW,
      type: 'question',
      message: 'and which base?',
    });
    should((await stat(join(home, 'channel', 'outbox.jsonl'))).mode & 0o777).equal(0o600);
  });
});

describe('the storage signal repository', () => {
  it('should read a durable session as a signal target, taking the turn that moves', async () => {
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeConfig(ID, config({ teammate: 'hayden' }));
    await opened.storage.writeState(ID, {
      id: 'session-1',
      status: 'running',
      turn: 7,
      waitingCreditSeconds: 45,
      waiting: { since: '2026-08-01T11:00:00.000Z', until: NOW, condition: 'CI', peer: 'session-2', peerName: 'iris' },
    });

    // Act
    const actual = await new StorageSignalRepository(opened.storage, clock).read(ID);

    // Assert
    should(actual).deepEqual({
      id: ID,
      status: 'running',
      mode: 'auto',
      turn: 7,
      teammate: 'hayden',
      waitingCreditSeconds: 45,
      waiting: { since: '2026-08-01T11:00:00.000Z', until: NOW, condition: 'CI', peer: 'session-2', peerName: 'iris' },
    });
    await opened.storage.close();
  });

  it('should fall back to the configuration turn and drop a wait with no start instant', async () => {
    // A wait whose `since` is missing cannot be credited or expired, so it is not a wait at all.
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeConfig(ID, config());
    await opened.storage.writeState(ID, { id: 'session-1', status: 'running', waiting: { condition: 'CI' } });

    // Act
    const actual = await new StorageSignalRepository(opened.storage, clock).read(ID);

    // Assert
    should(actual).deepEqual({ id: ID, status: 'running', mode: 'auto', turn: 3 });
    await opened.storage.close();
  });

  it('should report nothing for an absent session, and refuse to guess an unreadable one', async () => {
    // Arrange
    const { opened } = await openStorage();
    const subject = new StorageSignalRepository(opened.storage, clock);
    await opened.storage.writeConfig(PEER, config({ id: 'session-2', mode: 'batch' }));
    await opened.storage.writeState(PEER, { id: 'session-2', status: 'running' });

    // Act
    const absent = await subject.read(ID);
    const unreadable = await subject.read(PEER);

    // Assert
    should(absent).be.undefined();
    // A signal retires panes and writes terminal verdicts; a mode it cannot read is not a mode to guess.
    should(unreadable).be.undefined();
    await opened.storage.close();
  });

  it('should refuse to guess a session whose status is not one the protocol names', async () => {
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeConfig(ID, config());
    await opened.storage.writeState(ID, { id: 'session-1', status: 'finished' });

    // Act
    const actual = await new StorageSignalRepository(opened.storage, clock).read(ID);

    // Assert
    should(actual).be.undefined();
    await opened.storage.close();
  });

  it('should write a completion onto the document and journal it after the state is durable', async () => {
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeConfig(ID, config());
    await opened.storage.writeState(ID, { id: 'session-1', status: 'running', turn: 3 });
    const subject = new StorageSignalRepository(opened.storage, clock);

    // Act
    const target = await subject.transition(ID, {
      event: 'session.completed',
      status: 'completed',
      health: 'idle',
      reason: 'done marker written',
      finishedAt: NOW,
      promptReady: false,
    });

    // Assert
    should(target.status).equal('completed');
    const state = (await opened.storage.readState(ID)) as Record<string, unknown>;
    should(state.health).equal('idle');
    should(state.finishedAt).equal(NOW);
    should(state.promptReady).equal(false);
    const page = await opened.storage.replay(ID);
    should(page.events.map(event => event.type)).deepEqual(['session.completed']);
    should(page.events[0]?.data).deepEqual({ reason: 'done marker written' });
    await opened.storage.close();
  });

  it('should record a declared wait as an object and clear it by removing the field entirely', async () => {
    // CLEARED MEANS ABSENT, NOT `null`. `SessionStateSchema` declares `waiting` as an optional OBJECT,
    // so a null makes the document stop satisfying the protocol and every surface that parses before
    // serving drops the session it just saw.
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeConfig(ID, config());
    await opened.storage.writeState(ID, { id: 'session-1', status: 'running', nudgedAt: '2026-08-01T09:00:00.000Z' });
    const subject = new StorageSignalRepository(opened.storage, clock);

    // Act
    await subject.transition(ID, {
      event: 'session.waiting',
      status: 'waiting',
      waiting: { since: NOW, until: '2026-08-01T13:00:00.000Z', condition: 'CI', peer: 'session-2', peerName: 'iris' },
    });
    const parked = (await opened.storage.readState(ID)) as Record<string, unknown>;
    await subject.transition(ID, {
      event: 'session.waiting_cleared',
      status: 'running',
      waiting: 'clear',
      waitingCreditSeconds: 90,
      reanchorActivity: true,
    });
    const working = (await opened.storage.readState(ID)) as Record<string, unknown>;

    // Assert
    should(parked.waiting).deepEqual({
      since: NOW,
      until: '2026-08-01T13:00:00.000Z',
      condition: 'CI',
      peer: 'session-2',
      peerName: 'iris',
    });
    should(Object.hasOwn(working, 'waiting')).be.false();
    should(working.waitingCreditSeconds).equal(90);
    // The activity ledger is re-anchored and the nudge mark dropped, or the next supervision tick
    // would nudge — or reap — the teammate the daemon just woke.
    should(Object.hasOwn(working, 'nudgedAt')).be.false();
    should(working.lastActivityAt).equal(NOW);
    should(working.lastTranscriptAt).equal(NOW);
    should(working.lastPaneAt).equal(NOW);
    await opened.storage.close();
  });

  it('should record a wait with only the fields it was given', async () => {
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeConfig(ID, config());
    await opened.storage.writeState(ID, { id: 'session-1', status: 'running' });

    // Act
    await new StorageSignalRepository(opened.storage, clock).transition(ID, {
      event: 'session.waiting',
      waiting: { since: NOW },
    });

    // Assert
    should(((await opened.storage.readState(ID)) as Record<string, unknown>).waiting).deepEqual({ since: NOW });
    await opened.storage.close();
  });

  it('should raise rather than answer with a target it cannot read back', async () => {
    // A transition that leaves the document unreadable is a defect, not a refusal: answering with a
    // guessed target would report a session state nothing on disk supports.
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeConfig(ID, config({ mode: 'batch' }));
    await opened.storage.writeState(ID, { id: 'session-1', status: 'running' });

    // Act
    const failure = await new StorageSignalRepository(opened.storage, clock)
      .transition(ID, { event: 'session.completed', status: 'completed' })
      .catch((error: unknown) => error);

    // Assert
    should(failure).be.an.Error();
    should((failure as Error).message).match(/unreadable after a signal transition/u);
    await opened.storage.close();
  });
});

describe('resolving the peer a wait names', () => {
  it('should resolve an exact session id outright', async () => {
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeConfig(PEER, config({ id: 'session-2', teammate: 'iris' }));
    await opened.storage.writeState(PEER, { id: 'session-2', status: 'running' });

    // Act
    const actual = await new StorageSignalRepository(opened.storage, clock).resolvePeer('session-2');

    // Assert
    should(actual?.id).equal(PEER);
    should(actual?.teammate).equal('iris');
    await opened.storage.close();
  });

  it('should resolve a callsign, case-insensitively, to the session claiming it', async () => {
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeConfig(PEER, config({ id: 'session-2', teammate: 'iris' }));
    await opened.storage.writeState(PEER, { id: 'session-2', status: 'running' });

    // Act
    const actual = await new StorageSignalRepository(opened.storage, clock).resolvePeer('  IRIS ');

    // Assert
    should(actual?.id).equal(PEER);
    await opened.storage.close();
  });

  it('should resolve nothing for a callsign nobody holds, so a typo cannot become a park', async () => {
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeConfig(PEER, config({ id: 'session-2', teammate: 'iris' }));
    await opened.storage.writeState(PEER, { id: 'session-2', status: 'running' });

    // Act
    const typo = await new StorageSignalRepository(opened.storage, clock).resolvePeer('irs');

    // Assert
    should(typo).be.undefined();
    await opened.storage.close();
  });

  it('should resolve nothing for a reference the state-home layout would refuse as a path', async () => {
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeConfig(PEER, config({ id: 'session-2' }));
    await opened.storage.writeState(PEER, { id: 'session-2', status: 'running' });

    // Act
    const traversal = await new StorageSignalRepository(opened.storage, clock).resolvePeer('../etc/passwd');

    // Assert
    should(traversal).be.undefined();
    await opened.storage.close();
  });

  it('should step over a session with no readable configuration rather than failing the lookup', async () => {
    // A journalled session whose configuration is absent holds no callsign, so it cannot be the peer a
    // wait names — and it must not stop the ones that can from being found.
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeState(ID, { id: 'session-1', status: 'running' });
    await opened.storage.writeConfig(PEER, config({ id: 'session-2', teammate: 'iris' }));
    await opened.storage.writeState(PEER, { id: 'session-2', status: 'running' });

    // Act
    const actual = await new StorageSignalRepository(opened.storage, clock).resolvePeer('iris');

    // Assert
    should(actual?.id).equal(PEER);
    await opened.storage.close();
  });

  it('should not resolve a callsign whose claim instant is unreadable, but still resolve its id', async () => {
    // The callsign window is the names domain's own rule: a claim it cannot date is a claim it cannot
    // prove is current, and resolving one would risk pointing a park at a session that recycled the
    // name. The refusal is recoverable — the id always works — and it is honest, which an unwakeable
    // park would not be.
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeConfig(PEER, config({ id: 'session-2', teammate: 'iris', createdAt: 'not an instant' }));
    await opened.storage.writeState(PEER, { id: 'session-2', status: 'running' });
    const subject = new StorageSignalRepository(opened.storage, clock);

    // Act
    const byCallsign = await subject.resolvePeer('iris');
    const byId = await subject.resolvePeer('session-2');

    // Assert
    should(byCallsign).be.undefined();
    should(byId?.id).equal(PEER);
    await opened.storage.close();
  });
});

describe('the signal terminal', () => {
  it('should snapshot and stop through the launcher the revive already holds', async () => {
    // A second tmux adapter would be a second final-frame ledger, so a completion's last screen would
    // be filed where no revive could ever find it.
    // Arrange
    const calls: Array<readonly [string, SessionId, string | undefined]> = [];
    const subject = new LauncherSignalTerminal({
      snapshot: async id => void calls.push(['snapshot', id, undefined]),
      kill: async (id, reason) => void calls.push(['kill', id, reason]),
    });

    // Act
    await subject.snapshot(ID);
    await subject.stop(ID, 'completion');

    // Assert
    should(calls).deepEqual([
      ['snapshot', ID, undefined],
      ['kill', ID, 'completion'],
    ]);
  });
});
