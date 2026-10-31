import { afterEach, describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  ComposerOccupiedError,
  ComposerUnconfirmedError,
  DaemonStorageFactory,
  FileResumeTurnStore,
  FileSendChannel,
  FileSendLedger,
  FileSendTurnStore,
  KeyedSerialExecutor,
  ResumeSendReviver,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  StorageSendRepository,
  SystemClock,
  TimerSendScheduler,
  TmuxSendTerminal,
} from '../../../../src/adapters/index.ts';
import {
  parseSessionId,
  ResumeRefused,
  type ResumeTarget,
  ReviveDedupeConflict,
  ReviveRefusedForSend,
  SendComposerOccupied,
  SendLandingUnconfirmed,
  type SendRecord,
  type SessionId,
  TmuxController,
} from '../../../../src/lib/index.ts';
import { waitFor } from '../../support/wait-for.ts';

/**
 * The durable and terminal sides of a send: the record it reads, the ledger it appends to, the logs
 * it leaves, and the pane it types into.
 *
 * Everything runs against a temp `FY_HOME` and a tmux command port the test owns. Nothing here starts
 * a daemon, binds a port, or reaches a real tmux server.
 */

const homes = new Set<string>();
const NOW = '2026-08-01T12:00:00.000Z';
const ID = parseSessionId('session-1');
const PEER = parseSessionId('session-2');
const clock = { now: () => NOW };

async function openStorage() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-send-test-'));
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

async function directory(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  homes.add(home);
  return home;
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    name: 'Send it a turn',
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

function record(overrides: Partial<SendRecord> = {}): SendRecord {
  return {
    sendId: 'send-1',
    acceptedAt: NOW,
    acceptedTurn: 3,
    path: 'direct',
    message: 'ship it',
    fate: 'accepted',
    ...overrides,
  };
}

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('the storage send repository', () => {
  it('should read a durable session as a send target, taking the turn that moves', async () => {
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeConfig(ID, config({ teammate: 'hayden', directSendMaxChars: 120 }));
    await opened.storage.writeState(ID, {
      id: 'session-1',
      status: 'running',
      turn: 7,
      promptReady: true,
      needsHumanKind: 'codex-picker-unconfirmed',
      pendingQuestion: { toolUseId: 'tool-7', questions: [] },
      waiting: { since: NOW, peer: 'session-2', peerName: 'iris' },
    });

    // Act
    const actual = await new StorageSendRepository(opened.storage, clock).read(ID);

    // Assert
    should(actual).deepEqual({
      id: ID,
      status: 'running',
      mode: 'auto',
      // The STATE's turn, not the configuration's: only the state's moves, and planning `turn + 1`
      // from a frozen configuration would overwrite a turn document the agent may not have read.
      turn: 7,
      teammate: 'hayden',
      promptReady: true,
      needsHumanKind: 'codex-picker-unconfirmed',
      pendingQuestion: { toolUseId: 'tool-7' },
      directSendMaxChars: 120,
      waiting: { peer: 'session-2', peerName: 'iris' },
    });
    await opened.storage.close();
  });

  it('should yield no target for a record it cannot read, rather than a guessed one', async () => {
    // A send TYPES into a terminal. Acting on a document whose status will not parse is how a message
    // lands in a pane nobody is watching.
    // Arrange
    const { opened } = await openStorage();
    const subject = new StorageSendRepository(opened.storage, clock);
    await opened.storage.writeConfig(PEER, config({ id: 'session-2', mode: 'batch' }));
    await opened.storage.writeState(PEER, { id: 'session-2', status: 'running', turn: 1 });

    // Act / Assert
    should(await subject.read(ID)).be.undefined();
    should(await subject.read(PEER)).be.undefined();
    await opened.storage.close();
  });

  it('should start a turn, restart the turn clock, and drop the previous turn nudge', async () => {
    // A new turn is a new liveness episode: waking into a stale activity ledger would have the very
    // next supervision tick cold-kill a turn that has only just begun.
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeConfig(ID, config());
    await opened.storage.writeState(ID, {
      id: 'session-1',
      status: 'awaiting_user',
      turn: 3,
      reason: 'idle since yesterday',
      nudgedAt: '2026-07-31T00:00:00.000Z',
      turnCompleted: true,
      lastActivityAt: '2026-07-31T00:00:00.000Z',
    });

    // Act
    const actual = await new StorageSendRepository(opened.storage, clock).transition(ID, {
      event: 'turn.started',
      status: 'running',
      health: 'healthy',
      turn: 4,
      promptReady: false,
      restartTurnClock: true,
      data: { direct: true },
    });

    // Assert
    should(actual).match({ status: 'running', turn: 4, promptReady: false });
    const state = (await opened.storage.readState(ID)) as Record<string, unknown>;
    should(state).match({ status: 'running', turn: 4, health: 'healthy', turnCompleted: false });
    // The turn is the agent's now, stamped with the instant it started.
    should(state).match({ turnState: 'working', turnStateAt: NOW });
    should(state.startedAt).equal(NOW);
    should(state.lastActivityAt).equal(NOW);
    // CLEARED MEANS ABSENT: a `null` in an optional field makes the document stop satisfying the
    // protocol, and every surface that parses before serving then drops the session it just saw.
    should(state).not.have.property('nudgedAt');
    should(state).not.have.property('reason');
    await opened.storage.close();
  });

  it('should leave a turn already recorded as working with the instant it started', async () => {
    // Arrange — a send queued behind a turn that is still running restarts the clock, not the turn.
    const { opened } = await openStorage();
    await opened.storage.writeConfig(ID, config());
    await opened.storage.writeState(ID, {
      id: 'session-1',
      status: 'running',
      turn: 3,
      turnState: 'working',
      turnStateAt: '2026-07-31T00:00:00.000Z',
    });

    // Act
    await new StorageSendRepository(opened.storage, clock).transition(ID, {
      event: 'turn.started',
      status: 'running',
      turn: 4,
      restartTurnClock: true,
    });

    // Assert
    should((await opened.storage.readState(ID)) as Record<string, unknown>).match({
      turnState: 'working',
      turnStateAt: '2026-07-31T00:00:00.000Z',
    });
    await opened.storage.close();
  });

  it('should journal an event with no state change of its own', async () => {
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeConfig(ID, config());
    await opened.storage.writeState(ID, { id: 'session-1', status: 'running', turn: 3 });
    const subject = new StorageSendRepository(opened.storage, clock);

    // Act
    await subject.journal(ID, 'control.send_accepted', { sendId: 'send-1', path: 'direct', ignored: { deep: true } });

    // Assert
    const { events } = await opened.storage.replay(ID);
    should(events.map(event => event.type)).containEql('control.send_accepted');
    const accepted = events.find(event => event.type === 'control.send_accepted');
    should(accepted?.data).match({ sendId: 'send-1', path: 'direct' });
    // A nested object is dropped rather than stringified into something a reader would mistake for a
    // value the daemon meant to record.
    should(accepted?.data).not.have.property('ignored');
    // The state document is untouched: this is an audit row, not a transition.
    should((await opened.storage.readState(ID)) as Record<string, unknown>).match({ status: 'running', turn: 3 });
    await opened.storage.close();
  });

  it('should resolve a sender by id and by the callsign the daemon knows it under', async () => {
    // The SAME resolution the signal domain's peer lookup uses: a park declared on a callsign must be
    // ended by a send from that same callsign, and two resolutions would eventually disagree.
    // Arrange
    const { opened } = await openStorage();
    await opened.storage.writeConfig(PEER, config({ id: 'session-2', teammate: 'iris' }));
    await opened.storage.writeState(PEER, { id: 'session-2', status: 'running', turn: 1 });
    const subject = new StorageSendRepository(opened.storage, clock);

    // Act
    const byId = await subject.resolveSender(PEER);
    const byCallsign = await subject.resolveSender('iris');
    const unknown = await subject.resolveSender('nobody');

    // Assert
    should(byId?.id).equal(PEER);
    should(byCallsign?.id).equal(PEER);
    should(unknown).be.undefined();
    await opened.storage.close();
  });
});

describe('the file send ledger', () => {
  it('should accept a send once, and answer a retry from the record it already holds', async () => {
    // This IS idempotency: a retried request whose first answer was lost must not become a second
    // message the agent reads and acts on twice.
    // Arrange
    const home = await directory('ferretry-send-ledger-');
    const subject = new FileSendLedger(() => home, clock);

    // Act
    const first = await subject.accept(ID, record());
    const second = await subject.accept(ID, record({ message: 'a different message entirely' }));

    // Assert
    should(first.created).be.true();
    should(second.created).be.false();
    // The FIRST record wins: the second call is a retry of the same logical send, not a new one.
    should(second.record.message).equal('ship it');
    await stat(join(home, 'channel', 'sends.jsonl'));
  });

  it('should revise transport facts on a live record without creating a second send', async () => {
    // Arrange
    const home = await directory('ferretry-send-ledger-');
    const subject = new FileSendLedger(() => home, clock);
    await subject.accept(ID, record({ path: 'revive', turn: 4 }));

    // Act
    const revised = await subject.revise(ID, 'send-1', { path: 'revive-queue', held: true, turn: undefined });

    // Assert
    should(revised).match({ path: 'revive-queue', held: true, sendId: 'send-1' });
    should(revised?.turn).be.undefined();
    // Last write wins on read-back, and the history stays legible to a human reading the file.
    should((await subject.all(ID)).get('send-1')).match({ path: 'revive-queue' });
    should((await readFile(join(home, 'channel', 'sends.jsonl'), 'utf8')).trim().split('\n')).have.length(2);
  });

  it('should refuse to revise or withdraw a send that is no longer live', async () => {
    // Revising a settled fate would rewrite a send that has already been accounted for as though it
    // were still in flight.
    // Arrange
    const home = await directory('ferretry-send-ledger-');
    const subject = new FileSendLedger(() => home, clock);
    await subject.accept(ID, record());
    await subject.withdraw(ID, 'send-1', 'nothing was typed');

    // Act / Assert
    should(await subject.revise(ID, 'send-1', { held: true })).be.undefined();
    should(await subject.withdraw(ID, 'send-1', 'again')).be.undefined();
    should(await subject.revise(ID, 'send-unknown', { held: true })).be.undefined();
    should((await subject.all(ID)).get('send-1')?.fate).equal('withdrawn');
  });

  it('should read an empty ledger for a session that has never been sent to', async () => {
    // Arrange
    const home = await directory('ferretry-send-ledger-');

    // Act / Assert
    should((await new FileSendLedger(() => home, clock).all(ID)).size).equal(0);
  });

  it('should skip a truncated or unrecognisable line rather than losing the whole ledger', async () => {
    // A half-written final line is the signature of a crash during the append — which is exactly the
    // moment the ledger matters most, because a send was accepted and may already have been typed.
    // Arrange
    const home = await directory('ferretry-send-ledger-');
    const subject = new FileSendLedger(() => home, clock);
    await subject.accept(ID, record());
    const file = join(home, 'channel', 'sends.jsonl');
    await appendFile(file, `${JSON.stringify({ notASend: true })}\n[]\n"text"\n{"sendId":"send-2","pa`);

    // Act
    const all = await subject.all(ID);

    // Assert
    should([...all.keys()]).deepEqual(['send-1']);
  });

  it('should read only what was appended since its last read, the last line for a send still winning', async () => {
    // Arrange
    const home = await directory('ferretry-send-ledger-');
    const subject = new FileSendLedger(() => home, clock);
    await subject.accept(ID, record());
    should((await subject.all(ID)).get('send-1')?.fate).equal('accepted');

    // Act — another writer appends a settlement and a new send behind the reader's back.
    const file = join(home, 'channel', 'sends.jsonl');
    await appendFile(
      file,
      `${JSON.stringify(record({ fate: 'delivered' }))}\n${JSON.stringify(record({ sendId: 'send-2' }))}\n`,
    );
    const all = await subject.all(ID);

    // Assert
    should(all.get('send-1')?.fate).equal('delivered');
    should([...all.keys()]).deepEqual(['send-1', 'send-2']);
  });

  it('should read the whole file again once it was replaced, shortened or rewritten in place', async () => {
    // Arrange
    const home = await directory('ferretry-send-ledger-');
    const subject = new FileSendLedger(() => home, clock);
    await subject.accept(ID, record());
    await subject.accept(ID, record({ sendId: 'send-2' }));
    await subject.all(ID);
    const file = join(home, 'channel', 'sends.jsonl');

    // Act — a person rewrites it shorter, then in place at the same size.
    await writeFile(file, `${JSON.stringify(record({ sendId: 'send-3' }))}\n`);
    const shortened = await subject.all(ID);
    const sameSize = `${JSON.stringify(record({ sendId: 'send-4' }))}\n`;
    await new Promise(resolve => setTimeout(resolve, 5));
    await writeFile(file, sameSize);
    const rewritten = await subject.all(ID);

    // Assert
    should([...shortened.keys()]).deepEqual(['send-3']);
    should([...rewritten.keys()]).deepEqual(['send-4']);
  });

  it('should answer a complete last line that has no newline yet, and still read the line its newline completes', async () => {
    // Arrange
    const home = await directory('ferretry-send-ledger-');
    const subject = new FileSendLedger(() => home, clock);
    await subject.accept(ID, record());
    const file = join(home, 'channel', 'sends.jsonl');
    await appendFile(file, JSON.stringify(record({ sendId: 'send-2' })));

    // Act
    const before = await subject.all(ID);
    await appendFile(file, `\n${JSON.stringify(record({ sendId: 'send-3' }))}\n`);
    const after = await subject.all(ID);

    // Assert
    should([...before.keys()]).deepEqual(['send-1', 'send-2']);
    should([...after.keys()]).deepEqual(['send-1', 'send-2', 'send-3']);
  });

  it('should hand out frozen records and a map of its own, so no reader changes what another reads', async () => {
    // Arrange
    const home = await directory('ferretry-send-ledger-');
    const subject = new FileSendLedger(() => home, clock);
    await subject.accept(ID, record());

    // Act
    const first = await subject.all(ID);
    first.delete('send-1');
    const second = await subject.all(ID);

    // Assert
    should(second.has('send-1')).be.true();
    should(Object.isFrozen(second.get('send-1'))).be.true();
  });
});

describe('the file send channel', () => {
  it('should record what a session was told and what it asked to say, in two files', async () => {
    // A sender's own log full of preambles addressed to somebody else is unreadable, so the outbox
    // holds the LOGICAL message and the inbox holds what actually arrived.
    // Arrange
    const home = await directory('ferretry-send-channel-');
    const subject = new FileSendChannel(() => home);

    // Act
    await subject.recordInbound(ID, { at: NOW, message: 'ship it', turn: 4, from: PEER, fromName: 'iris' });
    await subject.recordInbound(ID, { at: NOW, message: 'and this', queued: true, queueId: 'send-2' });
    await subject.recordOutbound(PEER, { at: NOW, to: ID, from: PEER, disposition: 'delivered', message: 'ship it' });

    // Assert
    const inbox = (await readFile(join(home, 'channel', 'inbox.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    should(inbox).deepEqual([
      { at: NOW, type: 'message', message: 'ship it', turn: 4, from: PEER, fromName: 'iris' },
      { at: NOW, type: 'message', message: 'and this', queued: true, queueId: 'send-2' },
    ]);
    const outbox = JSON.parse((await readFile(join(home, 'channel', 'outbox.jsonl'), 'utf8')).trim());
    should(outbox).deepEqual({
      at: NOW,
      type: 'message',
      from: PEER,
      to: ID,
      disposition: 'delivered',
      message: 'ship it',
    });
  });

  it('should omit an absent field rather than writing a null a reader has no meaning for', async () => {
    // These lines are read back by tools that treat a missing `from` as "a human sent this". A `null`
    // there is a third state nothing was written to understand.
    // Arrange
    const home = await directory('ferretry-send-channel-');

    // Act
    await new FileSendChannel(() => home).recordInbound(ID, {
      at: NOW,
      message: 'held for later',
      queuedForRevive: true,
      reason: 'another session shares this checkout',
    });

    // Assert
    const entry = JSON.parse((await readFile(join(home, 'channel', 'inbox.jsonl'), 'utf8')).trim());
    should(entry).deepEqual({
      at: NOW,
      type: 'message',
      message: 'held for later',
      queuedForRevive: true,
      reason: 'another session shares this checkout',
    });
  });
});

describe('the file send turn store', () => {
  it('should delegate the turn document and the markers to the store the revive already owns', async () => {
    // A second implementation of the marker contract is how the two paths drift until a marker one
    // writes is one the other does not clear.
    // Arrange
    const home = await directory('ferretry-send-turns-');
    const resumeTurns = new FileResumeTurnStore(() => home);
    const subject = new FileSendTurnStore(resumeTurns, () => home);
    await Bun.write(join(home, 'done.marker'), '{}');

    // Act
    const file = await subject.writeTurn(ID, 4, 'ship it\n');
    await subject.clearMarkers(ID);

    // Assert
    should(file).equal(join(home, 'turns', 'turn-004.md'));
    should(await readFile(file, 'utf8')).equal('ship it\n');
    should(await stat(join(home, 'done.marker')).catch(() => undefined)).be.undefined();
  });

  it('should write a queued payload named by the send, so a retry rewrites one file', async () => {
    // Arrange
    const home = await directory('ferretry-send-turns-');
    const subject = new FileSendTurnStore(new FileResumeTurnStore(() => home), () => home);

    // Act
    const first = await subject.writeQueuedPayload(ID, 'send-1', 'a long payload');
    const again = await subject.writeQueuedPayload(ID, 'send-1', 'a long payload');

    // Assert
    should(first).equal(join(home, 'channel', 'queued-send-1.md'));
    should(again).equal(first);
    should(await readFile(first, 'utf8')).equal('a long payload\n');
  });

  it('should keep who a turn is from beside it, never in it, and read it back for the app', async () => {
    // The owner: "there should not be any append or prepend on any feature".
    const home = await directory('ferretry-send-turns-');
    const subject = new FileSendTurnStore(new FileResumeTurnStore(() => home), () => home);
    await subject.writeTurn(ID, 8, 'carry on\n', { kind: 'ferretry', feature: 'Warden' });
    await subject.writeTurn(ID, 9, 'the person said this\n');
    await writeFile(join(home, 'turns', 'turn-010.by.json'), '{"kind":"nobody"}\n');

    const warden = await subject.readHandoffAuthor(ID, 'turn-008');
    const person = await subject.readHandoffAuthor(ID, 'turn-009');
    const damaged = await subject.readHandoffAuthor(ID, 'turn-010');
    const queued = await subject.readHandoffAuthor(ID, 'queued-send-1');

    should(await readFile(join(home, 'turns', 'turn-008.md'), 'utf8')).equal('carry on\n');
    should(warden).deepEqual({ kind: 'ferretry', feature: 'Warden' });
    should(person).be.undefined();
    should(damaged).be.undefined();
    should(queued).be.undefined();
  });

  it('should read a hand-off back by its stem, from the folder each kind is written to', async () => {
    // Arrange
    const home = await directory('ferretry-send-turns-');
    const subject = new FileSendTurnStore(new FileResumeTurnStore(() => home), () => home);
    await subject.writeTurn(ID, 8, 'the turn\n');
    await subject.writeQueuedPayload(ID, 'send-1', 'the queued one');

    // Act
    const turn = await subject.readHandoff(ID, 'turn-008');
    const queued = await subject.readHandoff(ID, 'queued-send-1');
    const gone = await subject.readHandoff(ID, 'turn-009');

    // Assert
    should(turn).equal('the turn\n');
    should(queued).equal('the queued one\n');
    should(gone).be.undefined();
  });
});

describe('the resume-backed reviver', () => {
  const target = (): ResumeTarget => ({ id: ID, status: 'stopped', mode: 'auto', cwd: '/workspace', turn: 3 });

  it('should ask the resume service for a peer revive carrying the message', async () => {
    // `peer` rather than `warden`: a send names this specific session, so it must not be suppressed by
    // the duplicate-work heuristic that exists for automatic recovery.
    // Arrange
    const asked: unknown[] = [];
    const subject = new ResumeSendReviver({
      resume: async (request: unknown) => {
        asked.push(request);
        return { target: target(), disposition: 'revived', delivered: 'Read the file /s/turns/turn-002.md now' };
      },
    } as never);

    // Act
    const typed = await subject.revive(ID, 'ship it');

    // Assert — what the relaunch typed is handed back, because it is what the transcript will carry.
    should(asked).deepEqual([{ id: ID, message: 'ship it', actor: 'peer' }]);
    should(typed).equal('Read the file /s/turns/turn-002.md now');
  });

  it('should restate a policy refusal in the send domain, naming the conflicting session', async () => {
    // A refusal is a decision about the RELAUNCH, not about the message: turning it into data loss
    // would make a safety check destroy work.
    // Arrange
    const conflict: ResumeTarget = { ...target(), id: PEER, status: 'running' };
    const refuser = (error: Error) =>
      new ResumeSendReviver({
        resume: async () => {
          throw error;
        },
      } as never);

    // Act
    const dedupe = await refuser(new ReviveDedupeConflict(target(), conflict))
      .revive(ID, 'x')
      .catch((error: unknown) => error);
    const plain = await refuser(new ResumeRefused('already running'))
      .revive(ID, 'x')
      .catch((error: unknown) => error);
    const broken = await refuser(new Error('tmux refused the pane'))
      .revive(ID, 'x')
      .catch((error: unknown) => error);

    // Assert
    should(dedupe).be.instanceof(ReviveRefusedForSend);
    should((dedupe as ReviveRefusedForSend).conflictSessionId).equal(PEER);
    should(plain).be.instanceof(ReviveRefusedForSend);
    // A genuine failure is not a refusal and must not be turned into one: the message is not held,
    // the caller is told the revive broke.
    should(broken).not.be.instanceof(ReviveRefusedForSend);
    should((broken as Error).message).equal('tmux refused the pane');
  });
});

describe('the tmux send terminal', () => {
  /** A tmux command port that answers from a script instead of a server. */
  class ScriptedTmux {
    readonly commands: string[][] = [];

    constructor(private readonly frames: string[] = ['❯ ']) {}

    async execute(arguments_: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
      this.commands.push([...arguments_]);
      const verb = arguments_[0] ?? '';
      if (verb === 'has-session') return { code: 0, stdout: '', stderr: '' };
      if (verb === 'display-message') return { code: 0, stdout: '0|0|1|80|24|', stderr: '' };
      if (verb === 'capture-pane')
        return {
          code: 0,
          stdout: this.frames.length > 1 ? (this.frames.shift() as string) : (this.frames[0] as string),
          stderr: '',
        };
      return { code: 0, stdout: '', stderr: '' };
    }

    keysSent(): string[] {
      return this.commands.filter(command => command[0] === 'send-keys').map(command => command.at(-1) as string);
    }
  }

  function terminal(tmux: ScriptedTmux): TmuxSendTerminal {
    const controller = new TmuxController(tmux);
    return new TmuxSendTerminal(
      controller,
      async () => 'fy-session-1',
      { deliver: async () => undefined, waitReady: async () => undefined } as never,
      { queue: async () => undefined } as never,
      async () => undefined,
    );
  }

  it('should report the pane as the send domain reads it', async () => {
    // Arrange
    const tmux = new ScriptedTmux(['❯ ']);

    // Act
    const actual = await terminal(tmux).observe(ID);

    // Assert
    should(actual).match({ alive: true, dead: false });
    should(actual.activeWork).be.false();
  });

  it('should name the harness dialog a pane is parked on, and never call that pane ready', async () => {
    // Arrange — Claude's one-shot auto-mode dialog, whose cursor row reads as a prompt line.
    const tmux = new ScriptedTmux([
      ' Make auto mode your default permission mode?\n\n   ❯ Yes, set auto mode as my default permission mode\n     No, keep bypass permissions',
    ]);

    // Act
    const actual = await terminal(tmux).observe(ID);

    // Assert
    should(actual.blockingPrompt).equal('Make auto mode your default permission mode?');
    should(actual.promptReady).be.false();
    should((await terminal(new ScriptedTmux(['❯ '])).observe(ID)).blockingPrompt).be.undefined();
  });

  it("should name Codex's hooks-review dialog as what blocks a send, since its row reads as a composer line", async () => {
    // Arrange — the pane Codex 0.156.1 really drew: `› 1. Review hooks` is shaped like a prompt.
    const frame = await readFile(
      join(import.meta.dir, '../../../fixtures/harness-dialogs/codex-0.156.1-hooks-review.txt'),
      'utf8',
    );

    // Act
    const actual = await terminal(new ScriptedTmux([frame])).observe(ID);

    // Assert
    should(actual.blockingPrompt).equal('Harness dialog — Hooks need review');
    should(actual.promptReady).be.false();
  });

  it('should name a tool-permission prompt as what blocks a send, so nothing is typed into its choices', async () => {
    // Arrange — a permission prompt, whose rows a typed message starting with a digit would pick.
    const tmux = new ScriptedTmux([
      ' Read file\n  Read(/etc/hostname)\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, allow reading from /etc during this session\n   3. No',
    ]);

    // Act
    const actual = await terminal(tmux).observe(ID);

    // Assert
    should(actual.blockingPrompt).equal('Permission prompt — Read /etc/hostname: Do you want to proceed?');
  });

  it('should press Escape and re-read the pane when a caller ends the active turn', async () => {
    // Escape is the safe stop-the-turn key in both harness TUIs; `C-c` is the QUIT path. Exactly one
    // keystroke per call, with no internal retries.
    // Arrange
    const tmux = new ScriptedTmux(['esc… working', '❯ ']);

    // Act
    const after = await terminal(tmux).stopActiveTurn(ID);

    // Assert
    should(tmux.keysSent()).deepEqual(['Escape']);
    should(after.alive).be.true();
  });

  it('should send exactly one stop key and nothing else when asked to press it', async () => {
    // Arrange
    const tmux = new ScriptedTmux();

    // Act
    await terminal(tmux).pressStopKey(ID);

    // Assert
    should(tmux.keysSent()).deepEqual(['Escape']);
  });

  it('should address the pane through the injected delivery adapters, never a shell', async () => {
    // Arrange
    const typed: string[] = [];
    const queued: string[] = [];
    const subject = new TmuxSendTerminal(
      new TmuxController(new ScriptedTmux()),
      async (id: SessionId) => `fy-${id}`,
      { deliver: async (_session: string, text: string) => void typed.push(text) } as never,
      { queue: async (_session: string, text: string) => void queued.push(text) } as never,
      async () => undefined,
    );

    // Act
    await subject.deliver(ID, 'ship it');
    await subject.queue(ID, 'and this');

    // Assert
    should(typed).deepEqual(['ship it']);
    should(queued).deepEqual(['and this']);
  });
});

describe('the file send ledger, as the tracker moves it', () => {
  it('should list every send, settle a proven fate, and clear a field a patch sets to undefined', async () => {
    // Arrange
    const home = await directory('ferretry-send-ledger-');
    const subject = new FileSendLedger(() => home, clock);
    await subject.accept(ID, record({ deadlineAt: '2026-08-01T12:01:00.000Z' }));

    // Act
    const settled = await subject.settle(ID, 'send-1', { fate: 'delivered', deadlineAt: undefined });
    const listed = await subject.list(ID);

    // Assert
    should(settled).match({ fate: 'delivered' });
    should(Object.hasOwn(settled ?? {}, 'deadlineAt')).be.false();
    should(listed.map(entry => entry.fate)).deepEqual(['delivered']);
    should(await subject.settle(ID, 'send-unknown', { fate: 'delivered' })).be.undefined();
  });

  it('should let a withdrawn id start over, and never settle the tombstone itself', async () => {
    // Nothing was typed for a withdrawn send, which is what the withdrawal promised its caller: the
    // same id may honestly be accepted again.
    // Arrange
    const home = await directory('ferretry-send-ledger-');
    const subject = new FileSendLedger(() => home, clock);
    await subject.accept(ID, record());
    await subject.withdraw(ID, 'send-1', 'acceptance could not be journalled');

    // Act
    const tombstone = await subject.settle(ID, 'send-1', { fate: 'delivered' });
    const again = await subject.accept(ID, record({ message: 'second try' }));

    // Assert
    should(tombstone).be.undefined();
    should(again.created).be.true();
    should((await subject.list(ID))[0]).match({ fate: 'accepted', message: 'second try' });
  });
});

describe('the tmux send terminal, as the tracker reads it', () => {
  /**
   * A pane whose frame advances on each erase (`C-u`) or submit (`Enter`) key, with the cursor tmux
   * reports beside it; the last frame repeats. Every key sent
   * is recorded, so a test can prove which keys a composer action pressed, and that none were pressed
   * at a composer it did not match.
   */
  class FrameTmux {
    readonly keys: string[] = [];

    constructor(
      private readonly frames: readonly (readonly [string, string])[],
      private index = 0,
    ) {}

    async execute(arguments_: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
      const verb = arguments_[0] ?? '';
      const [frame, cursor] = this.frames[Math.min(this.index, this.frames.length - 1)] as readonly [string, string];
      if (verb === 'display-message') return { code: 0, stdout: `0||${cursor}|24|80`, stderr: '' };
      if (verb === 'capture-pane') return { code: 0, stdout: frame, stderr: '' };
      if (verb === 'send-keys') {
        const key = arguments_.at(-1) as string;
        this.keys.push(key);
        if ((key === 'C-u' || key === 'Enter') && this.index < this.frames.length - 1) this.index += 1;
      }
      return { code: 0, stdout: '', stderr: '' };
    }
  }

  const subject = (
    frames: readonly (readonly [string, string])[],
    queued: 'held' | 'typed' | 'left' = 'held',
    tmux = new FrameTmux(frames),
  ) =>
    new TmuxSendTerminal(
      new TmuxController(tmux),
      async () => 'fy-session-1',
      {
        deliver: async () => {
          throw new ComposerOccupiedError('occupied', 'hi');
        },
      } as never,
      { queue: async () => queued } as never,
      async () => undefined,
    );

  const PLACEHOLDER = ['› Ask Codex to do anything\n\n  gpt-5 default', '2|0'] as const;
  const typed = (text: string) => [`› ${text}\n\n  gpt-5 default`, `${2 + text.length}|0`] as const;

  it('should find the payload in the composer or the pending queue, and nowhere else on screen', async () => {
    const pending = [
      '› hihello',
      '• Messages to be submitted after next tool call',
      '  ↳ hello',
      '',
      '› Ask Codex to do anything',
    ].join('\n');

    should(await subject([typed('ship it please')]).heldAt(ID, 'ship it please')).equal('composer');
    should(await subject([[pending, '2|4']]).heldAt(ID, 'hello')).equal('queue');
    // `hi` is inside `anything` and inside `› hihello` — neither is the composer.
    should(await subject([[pending, '2|4']]).heldAt(ID, 'hi')).be.undefined();
    should(await subject([['› [Pasted Content 900 chars]', '28|0']]).heldAt(ID, 'p'.repeat(900))).equal('composer');
  });

  it('should read a real Claude Code 2.1.281 queue, and THROW rather than rule out what runs off the pane', async () => {
    // The incident's own capture: one peer message queued four times above the spinner.
    const capture = (state: string) =>
      [
        readFileSync(
          join(import.meta.dir, `../../../fixtures/composer/claude-2.1.281-busy-queued-${state}.txt`),
          'utf8',
        ),
        '2|77',
      ] as const;
    const resend =
      '[message from ferret lizzette (session mvgt2oz9-04e28935) — not from the owner]\n' +
      'No reply needed. To reply: fy send lizzette "<reply>"\n\n' +
      'lizzette (resend): QoS CONFIRMED as the Mac root cause — ProcessType=Interactive took the ' +
      "owner's 4.67.0 from 381 stalls/lag 3.1s to lag 0.1ms. I told rozanne to ship the plist fix first.";

    const unseen = await subject([capture('clipped')])
      .heldAt(ID, 'a message scrolled off the top')
      .catch((error: unknown) => error);

    should(await subject([capture('copies')]).heldAt(ID, resend)).equal('queue');
    should(unseen).be.instanceof(Error);
    should((unseen as Error).message).match(/runs past what its pane shows/u);
    // `Press up to edit queued messages` is a placeholder, so nothing is in the way of a send…
    should(Object.hasOwn(await subject([capture('copies')]).observe(ID), 'draft')).be.false();
    // …and Enter is never pressed for a payload the composer does not hold, unknown queue or not.
    const tmux = new FrameTmux([capture('clipped')]);
    should(await subject([capture('clipped')], 'held', tmux).submitComposer(ID, 'unseen')).equal('absent');
    should(tmux.keys).be.empty();
  });

  it("should report a typed draft, and only a cursor-proven one, as the pane's draft", async () => {
    should((await subject([typed('hi')]).observe(ID)).draft).equal('hi');
    should(Object.hasOwn(await subject([PLACEHOLDER]).observe(ID), 'draft')).be.false();
  });

  it('should call a busy-pane transport held only when the pane proved it', async () => {
    should(await subject([PLACEHOLDER]).queue(ID, 'x')).equal('held');
    should(await subject([PLACEHOLDER], 'typed').queue(ID, 'x')).equal('unproven');
    should(await subject([PLACEHOLDER], 'left').queue(ID, 'x')).equal('unproven');
  });

  it("should turn a refusal-before-typing into the send domain's own error, and pass others through", async () => {
    const occupied = await subject([PLACEHOLDER])
      .deliver(ID, 'x')
      .catch((error: unknown) => error);
    const broken = await new TmuxSendTerminal(
      new TmuxController(new FrameTmux([PLACEHOLDER])),
      async () => 'fy-session-1',
      {
        deliver: async () => {
          throw new Error('tmux went away');
        },
      } as never,
      {} as never,
      async () => undefined,
    )
      .deliver(ID, 'x')
      .catch((error: unknown) => error);

    should(occupied).be.instanceof(SendComposerOccupied);
    should((occupied as SendComposerOccupied).draft).equal('hi');
    should((broken as Error).message).equal('tmux went away');
  });

  it('should turn a typed-but-unproven fill into SendLandingUnconfirmed, on both transports', async () => {
    const unproven = (): never => {
      throw new ComposerUnconfirmedError('typed into tmux session fy-session-1; it drew nothing for 12 s', 1);
    };
    const terminal = new TmuxSendTerminal(
      new TmuxController(new FrameTmux([PLACEHOLDER])),
      async () => 'fy-session-1',
      { deliver: async () => unproven() } as never,
      { queue: async () => unproven() } as never,
      async () => undefined,
    );

    should(await terminal.deliver(ID, 'x').catch((error: unknown) => error)).be.instanceof(SendLandingUnconfirmed);
    should(await terminal.queue(ID, 'x').catch((error: unknown) => error)).be.instanceof(SendLandingUnconfirmed);
  });

  it('should erase a stranded payload one C-u at a time, verifying before each key', async () => {
    // Arrange — the draft a swallowed Enter leaves (text, then an empty second line): Codex's first
    // C-u joins the empty line back, the second erases the text.
    const tmux = new FrameTmux([['› hi\n\n\n  gpt-5 default', '2|1'], typed('hi'), PLACEHOLDER]);

    // Act
    const actual = await subject([], 'held', tmux).clearComposer(ID, 'hi');

    // Assert
    should(actual).equal('cleared');
    should(tmux.keys).deepEqual(['C-u', 'C-u']);
  });

  it('should erase a multi-line draft line by line, as long as what remains is the start of it', async () => {
    const text = 'line1\nline2';
    const tmux = new FrameTmux([
      ['› line1\n  line2\n\n  gpt-5 default', '7|1'],
      ['› line1\n\n\n  gpt-5 default', '2|1'],
      ['› line1\n\n  gpt-5 default', '7|0'],
      PLACEHOLDER,
    ]);

    should(await subject([], 'held', tmux).clearComposer(ID, text)).equal('cleared');
    should(tmux.keys).deepEqual(['C-u', 'C-u', 'C-u']);
  });

  it('should never touch a composer holding anything but exactly the payload', async () => {
    const draft = new FrameTmux([typed('hi and my own words')]);
    const empty = new FrameTmux([PLACEHOLDER]);
    const unreadable = new FrameTmux([['booting…', '0|0']]);

    should(await subject([], 'held', draft).clearComposer(ID, 'hi')).equal('foreign');
    should(await subject([], 'held', empty).clearComposer(ID, 'hi')).equal('absent');
    should(await subject([], 'held', unreadable).clearComposer(ID, 'hi')).equal('stuck');
    should([...draft.keys, ...empty.keys, ...unreadable.keys]).deepEqual([]);
  });

  it('should give up, bounded, on a composer the erase keys do not change', async () => {
    const tmux = new FrameTmux([typed('hi')]);

    should(await subject([], 'held', tmux).clearComposer(ID, 'hi')).equal('stuck');
    // Two keys per line of the payload, plus the margin.
    should(tmux.keys.length).equal(4);
  });

  it('should stop clearing when the composer turns into something else part-way', async () => {
    const tmux = new FrameTmux([typed('hi'), typed('hi there')]);

    should(await subject([], 'held', tmux).clearComposer(ID, 'hi')).equal('stuck');
  });

  it('should press Enter once for the payload and say where it went', async () => {
    const sent = new FrameTmux([typed('hi'), PLACEHOLDER]);
    const stuck = new FrameTmux([typed('hi')]);
    const absent = new FrameTmux([PLACEHOLDER]);

    should(await subject([], 'held', sent).submitComposer(ID, 'hi')).equal('submitted');
    should(await subject([], 'held', stuck).submitComposer(ID, 'hi')).equal('holding');
    should(await subject([], 'held', absent).submitComposer(ID, 'hi')).equal('absent');
    should([sent.keys, stuck.keys, absent.keys]).deepEqual([['Enter'], ['Enter'], []]);
  });
});

/**
 * Waits until a sentinel look, scheduled LAST with the same delay on its own session, has run. Timers of equal delay
 * expire in the order they were set, so every look that was going to run has run by then.
 */
async function afterTheLooks(scheduler: TimerSendScheduler): Promise<void> {
  let reached = false;
  scheduler.schedule(parseSessionId('session-sentinel'), 5, () => {
    reached = true;
  });
  await waitFor(() => reached, 'the sentinel look, scheduled after the others, to run');
}

describe('the timer send scheduler', () => {
  it('should keep one pending look per session, replace it, and cancel them all', async () => {
    // Arrange
    const subject = new TimerSendScheduler();
    const ran: string[] = [];

    // Act
    subject.schedule(ID, 5, () => void ran.push('replaced'));
    subject.schedule(ID, 5, () => void ran.push('kept'));
    subject.schedule(parseSessionId('session-2'), 5, () => void ran.push('other session'));
    await afterTheLooks(subject);
    subject.schedule(ID, 5, () => void ran.push('cancelled'));
    subject.cancelAll();
    await afterTheLooks(subject);

    // Assert
    should(ran.sort()).deepEqual(['kept', 'other session']);
  });
});
