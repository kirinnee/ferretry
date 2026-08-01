import { afterEach, describe, it } from 'bun:test';
import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
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
  TmuxSendTerminal,
} from '../../../../src/adapters/index.ts';
import {
  parseSessionId,
  ResumeRefused,
  ReviveDedupeConflict,
  ReviveRefusedForSend,
  TmuxController,
  type ResumeTarget,
  type SendRecord,
  type SessionId,
} from '../../../../src/lib/index.ts';

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
    should(state.startedAt).equal(NOW);
    should(state.lastActivityAt).equal(NOW);
    // CLEARED MEANS ABSENT: a `null` in an optional field makes the document stop satisfying the
    // protocol, and every surface that parses before serving then drops the session it just saw.
    should(state).not.have.property('nudgedAt');
    should(state).not.have.property('reason');
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
        return { target: target(), disposition: 'revived' };
      },
    } as never);

    // Act
    await subject.revive(ID, 'ship it');

    // Assert
    should(asked).deepEqual([{ id: ID, message: 'ship it', actor: 'peer' }]);
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
    );

    // Act
    await subject.deliver(ID, 'ship it');
    await subject.queue(ID, 'and this');

    // Assert
    should(typed).deepEqual(['ship it']);
    should(queued).deepEqual(['and this']);
  });
});
