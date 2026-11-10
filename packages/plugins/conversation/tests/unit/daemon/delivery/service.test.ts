import { describe, it } from 'bun:test';
import { queuedMessageInstruction, turnFileInstruction } from '../../../../daemon/seams/protocol.ts';
import should from 'should';
import type { ClockPort, SerialExecutor } from '../../../../daemon/seams/ports.ts';
import { parseSessionId, type SessionId } from '../../../../daemon/seams/ferret-id.ts';
import {
  type ComposerClearOutcome,
  type ComposerSubmitOutcome,
  defaultSessionSendSettings,
  type InboundMessage,
  nextTurnNumber,
  type OutboundMessage,
  type PeerWaitEnder,
  ReviveRefusedForSend,
  type SendChannel,
  SendComposerOccupied,
  SendComposerUnreadable,
  SendDraftRefused,
  type SendHeldAt,
  SendLandingUnconfirmed,
  type SendLaunchGate,
  type SendLedger,
  SendNotReady,
  SendPaneNotReady,
  type SendPaneObservation,
  SendPending,
  type SendQueueOutcome,
  type SendRecord,
  SendRefused,
  type SendRepository,
  SendRetypeWithheld,
  type SendReviver,
  type SendSettlement,
  type SendTarget,
  type SendTerminal,
  type SendRetractionProof,
  type SendTracking,
  type SendTransition,
  type SendTurnStore,
  SendUnavailable,
  SendUnconfirmed,
  SessionSendService,
  STRANDED_ENTER_LIMIT,
  sendRecordFor,
  sendRecordView,
} from '../../../../daemon/delivery/lib/index.ts';
import { at } from '../../../support/instant.ts';

/**
 * What the daemon does with a message addressed to a running session.
 *
 * The ORDER is most of what is under test, and none of it is visible in the state document
 * afterwards — only in the sequence of calls the ports saw. The ledger is written before the
 * transport; the transport never withdraws it; the pane is read again after a busy verdict; and the
 * turn advances only once the prompt has demonstrably landed.
 */

const ID = parseSessionId('session-1');
const PEER = parseSessionId('session-2');
const NOW = at('2026-08-01T12:00:00.000Z');

function target(overrides: Partial<SendTarget> = {}): SendTarget {
  return { id: ID, status: 'running', mode: 'auto', turn: 3, ...overrides };
}

function pane(overrides: Partial<SendPaneObservation> = {}): SendPaneObservation {
  return { alive: true, dead: false, promptReady: false, activeWork: false, ...overrides };
}

class FakeRepository implements SendRepository {
  readonly transitions: SendTransition[] = [];
  readonly journal_: Array<{ event: string; data: Readonly<Record<string, unknown>> }> = [];
  journalFailure: Error | undefined;

  constructor(
    private current: SendTarget | undefined,
    private readonly senders: Readonly<Record<string, SendTarget>> = {},
  ) {}

  async read(): Promise<SendTarget | undefined> {
    return this.current;
  }

  async resolveSender(reference: string): Promise<SendTarget | undefined> {
    return this.senders[reference];
  }

  async journal(_id: SessionId, event: string, data: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.journalFailure !== undefined && event === 'control.send_accepted') throw this.journalFailure;
    this.journal_.push({ event, data });
  }

  async transition(_id: SessionId, change: SendTransition): Promise<SendTarget> {
    this.transitions.push(change);
    const base = this.current ?? target();
    this.current = {
      ...base,
      ...(change.status === undefined ? {} : { status: change.status }),
      ...(change.turn === undefined ? {} : { turn: change.turn }),
      ...(change.promptReady === undefined ? {} : { promptReady: change.promptReady }),
    };
    return this.current;
  }

  get events(): readonly string[] {
    return this.journal_.map(entry => entry.event);
  }
}

class FakeLedger implements SendLedger {
  readonly records = new Map<string, SendRecord>();
  readonly withdrawn: string[] = [];
  reviseTo: SendRecord | undefined = undefined;
  reviseRefuses = false;
  settleRefuses = false;

  async accept(_id: SessionId, record: SendRecord): Promise<{ record: SendRecord; created: boolean }> {
    const existing = this.records.get(record.sendId);
    if (existing !== undefined) return { record: existing, created: false };
    this.records.set(record.sendId, record);
    return { record, created: true };
  }

  async revise(
    _id: SessionId,
    sendId: string,
    patch: Partial<Pick<SendRecord, 'path' | 'matchText' | 'payloadFile' | 'held' | 'turn'>>,
  ): Promise<SendRecord | undefined> {
    if (this.reviseRefuses) return undefined;
    const current = this.records.get(sendId);
    if (current === undefined) return undefined;
    const next = { ...current, ...patch };
    this.records.set(sendId, next);
    this.reviseTo = next;
    return next;
  }

  async withdraw(_id: SessionId, sendId: string): Promise<SendRecord | undefined> {
    this.withdrawn.push(sendId);
    const record = this.records.get(sendId);
    this.records.delete(sendId);
    return record;
  }

  async list(): Promise<readonly SendRecord[]> {
    return [...this.records.values()];
  }

  async settle(_id: SessionId, sendId: string, patch: SendSettlement): Promise<SendRecord | undefined> {
    if (this.settleRefuses) return undefined;
    const current = this.records.get(sendId);
    if (current === undefined) return undefined;
    const next = { ...current, ...patch };
    this.records.set(sendId, next);
    return next;
  }

  only(): SendRecord {
    const [record] = [...this.records.values()];
    if (record === undefined) throw new Error('no send was accepted');
    return record;
  }
}

class FakeTerminal implements SendTerminal {
  readonly calls: string[] = [];
  readonly typed: string[] = [];
  queueOutcome: SendQueueOutcome = 'held';
  deliverFailure: Error | undefined;
  queueFailure: Error | undefined;
  observeFailure: Error | undefined;
  /** Which observe call starts failing, so a test can fail the SECOND look at a pane. */
  observeFailFrom = 0;
  private observed = 0;
  /** When set, every look answers this, whatever the scripted frames say. */
  frozen: SendPaneObservation | undefined;

  constructor(private readonly frames: SendPaneObservation[]) {}

  async observe(): Promise<SendPaneObservation> {
    this.calls.push('observe');
    if (this.frozen !== undefined) return this.frozen;
    if (this.observeFailure !== undefined && this.observed++ >= this.observeFailFrom) throw this.observeFailure;
    return this.frames.length > 1
      ? (this.frames.shift() as SendPaneObservation)
      : (this.frames[0] as SendPaneObservation);
  }

  async deliver(_id: SessionId, text: string): Promise<void> {
    if (this.occupied !== undefined) throw new SendComposerOccupied(this.occupied);
    if (this.unreadable) throw new SendComposerUnreadable();
    if (this.notReady !== undefined) throw this.notReady;
    this.calls.push('deliver');
    this.typed.push(text);
    if (this.deliverFailure !== undefined) throw this.deliverFailure;
  }

  async queue(_id: SessionId, text: string): Promise<SendQueueOutcome> {
    if (this.occupied !== undefined) throw new SendComposerOccupied(this.occupied);
    if (this.unreadable) throw new SendComposerUnreadable();
    this.calls.push('queue');
    this.typed.push(text);
    if (this.queueFailure !== undefined) throw this.queueFailure;
    return this.queueOutcome;
  }

  /** Where the pane holds a payload, keyed by its text. */
  readonly held = new Map<string, SendHeldAt>();
  heldFailure: Error | undefined;
  clearOutcome: ComposerClearOutcome = 'cleared';
  submitOutcome: ComposerSubmitOutcome = 'submitted';
  /** Thrown by a transport before any key, as the terminal does at an occupied composer. */
  occupied: string | undefined;
  /** Thrown by a transport before any key, as the terminal does at a composer it cannot read. */
  unreadable = false;
  /** Thrown by the idle transport before any key, as the terminal does at a pane that never comes to a prompt. */
  notReady: SendPaneNotReady | undefined;

  async heldAt(_id: SessionId, text: string): Promise<SendHeldAt | undefined> {
    this.calls.push('heldAt');
    if (this.heldFailure !== undefined) throw this.heldFailure;
    return this.held.get(text);
  }

  async clearComposer(): Promise<ComposerClearOutcome> {
    this.calls.push('clearComposer');
    return this.clearOutcome;
  }

  /** Whether each Enter asked for the strict whole-text check (&B153). */
  readonly submitStrict: boolean[] = [];

  async submitComposer(_id?: SessionId, _text?: string, strict = false): Promise<ComposerSubmitOutcome> {
    this.calls.push('submitComposer');
    this.submitStrict.push(strict);
    return this.submitOutcome;
  }

  async stopActiveTurn(): Promise<SendPaneObservation> {
    this.calls.push('stopActiveTurn');
    return this.frames.length > 1
      ? (this.frames.shift() as SendPaneObservation)
      : (this.frames[0] as SendPaneObservation);
  }
}

class FakeTurnStore implements SendTurnStore {
  readonly calls: string[] = [];
  readonly documents: string[] = [];
  writeFailure: Error | undefined;

  async writeTurn(_id: SessionId, turn: number, document: string): Promise<string> {
    this.calls.push('writeTurn');
    if (this.writeFailure !== undefined) throw this.writeFailure;
    this.documents.push(document);
    return `/state/turns/turn-${String(turn).padStart(3, '0')}.md`;
  }

  async writeQueuedPayload(_id: SessionId, sendId: string, payload: string): Promise<string> {
    this.calls.push('writeQueuedPayload');
    this.documents.push(payload);
    return `/state/channel/queued-${sendId}.md`;
  }

  async clearMarkers(): Promise<void> {
    this.calls.push('clearMarkers');
  }
}

class FakeChannel implements SendChannel {
  readonly inbound: InboundMessage[] = [];
  readonly outbound: OutboundMessage[] = [];
  outboundFailure: Error | undefined;

  async recordInbound(_id: SessionId, entry: InboundMessage): Promise<void> {
    this.inbound.push(entry);
  }

  async recordOutbound(_id: SessionId, entry: OutboundMessage): Promise<void> {
    if (this.outboundFailure !== undefined) throw this.outboundFailure;
    this.outbound.push(entry);
  }
}

class FakeGate implements SendLaunchGate {
  inFlight = false;
  settles = true;

  launching(): boolean {
    return this.inFlight;
  }

  async awaitSettled(): Promise<boolean> {
    return this.settles;
  }
}

class FakeReviver implements SendReviver {
  readonly messages: string[] = [];
  failure: Error | undefined;
  /** What the relaunch reports having typed into the replacement pane. */
  typed: string | undefined;

  async revive(_id: SessionId, message: string): Promise<string | undefined> {
    this.messages.push(message);
    if (this.failure !== undefined) throw this.failure;
    return this.typed;
  }
}

class FakePeerWaits implements PeerWaitEnder {
  readonly ended: Array<{ recipient: string; sender: string }> = [];
  failure: Error | undefined;

  async endPeerWait(recipient: SessionId, sender: SessionId): Promise<void> {
    this.ended.push({ recipient, sender });
    if (this.failure !== undefined) throw this.failure;
  }
}

/** Records that every mutation went through a keyed lock, and runs the work inline. */
class RecordingSerial implements SerialExecutor {
  readonly keys: string[] = [];

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    this.keys.push(key);
    return await work();
  }

  async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    return await work();
  }
}

const clock: ClockPort = { now: () => NOW };

interface Parts {
  readonly service: SessionSendService;
  readonly repository: FakeRepository;
  readonly ledger: FakeLedger;
  readonly terminal: FakeTerminal;
  readonly turns: FakeTurnStore;
  readonly channel: FakeChannel;
  readonly gate: FakeGate;
  readonly reviver: FakeReviver;
  readonly peerWaits: FakePeerWaits;
  readonly serial: RecordingSerial;
  readonly tracked: string[];
}

function parts(
  current: SendTarget | null = target(),
  frames: SendPaneObservation[] = [pane({ promptReady: true })],
  senders: Readonly<Record<string, SendTarget>> = {},
  pause?: (ms: number) => Promise<void>,
  retraction?: SendRetractionProof,
): Parts {
  const repository = new FakeRepository(current ?? undefined, senders);
  const ledger = new FakeLedger();
  const terminal = new FakeTerminal(frames);
  const turns = new FakeTurnStore();
  const channel = new FakeChannel();
  const gate = new FakeGate();
  const reviver = new FakeReviver();
  const peerWaits = new FakePeerWaits();
  const serial = new RecordingSerial();
  const tracked: string[] = [];
  const tracking: SendTracking = { track: id => void tracked.push(id) };
  const service = new SessionSendService(
    {
      repository,
      ledger,
      terminal,
      turns,
      channel,
      gate,
      reviver,
      peerWaits,
      serial,
      clock,
      tracking,
      pause,
      retraction,
    },
    defaultSessionSendSettings,
  );
  return { service, repository, ledger, terminal, turns, channel, gate, reviver, peerWaits, serial, tracked };
}

function request(overrides: Partial<Parameters<SessionSendService['send']>[0]> = {}) {
  return { id: ID, sendId: 'send-1', message: 'ship it', ...overrides };
}

describe('send to an idle prompt', () => {
  it('writes the turn document, accepts the send, types it, and only then advances the turn', async () => {
    const { service, repository, ledger, terminal, turns } = parts();
    const outcome = await service.send(request());

    should(outcome.disposition).equal('delivered');
    // The turn document exists before anything is typed; the markers are cleared after the prompt
    // landed, never before.
    should(turns.calls).eql(['writeTurn', 'clearMarkers']);
    should(terminal.calls).eql(['observe', 'deliver']);
    should(repository.events).eql(['control.send_accepted', 'control.send']);
    should(repository.transitions).have.length(1);
    should(repository.transitions[0]).match({
      event: 'turn.started',
      status: 'running',
      turn: 4,
      promptReady: false,
      restartTurnClock: true,
    });
    should(ledger.only()).match({ path: 'direct', turn: 4, acceptedTurn: 3, fate: 'accepted' });
  });

  it('types a short single-line message verbatim, and a long one as a pointer to its turn file', async () => {
    const short = parts();
    await short.service.send(request());
    should(short.terminal.typed).eql(['ship it']);

    const long = parts();
    const message = 'x'.repeat(600);
    await long.service.send(request({ message }));
    should(long.terminal.typed[0]).containEql('/state/turns/turn-004.md');
    should(long.ledger.only().path).equal('turn-file');
    // The document is written on BOTH transports: it is what a later revive reads back.
    should(long.turns.documents[0]).equal(`${message}\n`);
  });

  describe('a multi-line message to an idle Claude composer', () => {
    const claude = (overrides: Partial<SendTarget> = {}): SendTarget =>
      target({ harness: 'claude', directSendMaxChars: 4_096, ...overrides });
    const multiline = 'first line\nsecond line\n\nthird line';

    it('is pasted as it is, keeps the turn document, and starts the turn like any direct send', async () => {
      const { service, ledger, terminal, turns, repository } = parts(claude());
      const outcome = await service.send(request({ message: multiline }));

      should(outcome.disposition).equal('delivered');
      should(terminal.typed).eql([multiline]);
      should(ledger.only()).match({ path: 'direct', turn: 4, fate: 'accepted' });
      // Revive and the logs read the turn document, so the direct path still writes it.
      should(turns.documents).eql([`${multiline}\n`]);
      should(repository.transitions[0]).match({ event: 'turn.started', turn: 4 });
    });

    it('carries a peer banner on one line and the body after it, with no pointer to a file', async () => {
      const sender = { id: PEER, status: 'waiting', mode: 'auto', turn: 2, teammate: 'loge' } as SendTarget;
      const { service, terminal, ledger } = parts(claude(), [pane({ promptReady: true })], { [PEER]: sender });
      await service.send(request({ senderReference: PEER, message: multiline }));

      const [typed] = terminal.typed;
      should(typed?.split('\n')[0]).equal(
        '[message from ferret loge (session session-2) — not from the owner] To reply: fy send loge "<reply>"',
      );
      should(typed).endWith(multiline);
      should(typed).not.containEql('turn-004.md');
      should(ledger.only().path).equal('direct');
    });

    it('stays a turn file for Codex and for a harness nobody named', async () => {
      for (const harness of ['codex', undefined]) {
        const { service, terminal, ledger } = parts(claude({ harness }));
        await service.send(request({ message: multiline }));
        should(terminal.typed[0]).containEql('/state/turns/turn-004.md');
        should(ledger.only().path).equal('turn-file');
      }
    });

    it('stays a turn file past 2,000 characters, and goes direct at exactly 2,000', async () => {
      const exactly = `${'x'.repeat(1_998)}\ny`;
      const at = parts(claude());
      await at.service.send(request({ message: exactly }));
      should(at.ledger.only().path).equal('direct');

      const over = parts(claude());
      await over.service.send(request({ message: `${exactly}z` }));
      should(over.ledger.only().path).equal('turn-file');
      should(over.terminal.typed[0]).containEql('/state/turns/turn-004.md');
      // The long message is still whole in its turn document.
      should(over.turns.documents[0]).equal(`${exactly}z\n`);
    });

    it('stays a turn file for a session that opted out of direct sends', async () => {
      const { service, terminal, ledger } = parts(claude({ directSendMaxChars: 0 }));
      await service.send(request({ message: multiline }));
      should(ledger.only().path).equal('turn-file');
      should(terminal.typed[0]).containEql('/state/turns/turn-004.md');
    });

    it('stays a turn file when the message holds a tab', async () => {
      const { service, ledger } = parts(claude());
      await service.send(request({ message: 'col1\tcol2\nrow2' }));
      should(ledger.only().path).equal('turn-file');
    });

    it('settles a paste the pane never showed as unconfirmed, keeping the accepted record', async () => {
      const { service, terminal, ledger } = parts(claude());
      terminal.deliverFailure = new SendLandingUnconfirmed('typed, and the composer never showed it');
      await service.send(request({ message: multiline })).catch(() => undefined);
      should(terminal.typed).eql([multiline]);
      should(ledger.only().fate).not.equal('delivered');
    });

    it('rides the harness queue, not the paste, when the pane is busy', async () => {
      const { service, terminal, ledger } = parts(claude({ status: 'running' }), [pane(), pane()]);
      await service.send(request({ message: multiline }));
      should(ledger.only().path).equal('native-inline');
      should(terminal.calls).containEql('queue');
      should(terminal.calls).not.containEql('deliver');
    });
  });

  it('records the message in the session inbox against the turn it started', async () => {
    const { service, channel } = parts();
    await service.send(request());
    should(channel.inbound).eql([{ at: NOW, message: 'ship it', turn: 4 }]);
  });

  it('keeps the accepted record when the transport fails after keys may have landed', async () => {
    const { service, ledger, terminal, repository } = parts();
    terminal.deliverFailure = new Error('tmux went away mid-Enter');
    await service.send(request()).should.be.rejectedWith(/tmux went away/u);
    // Never withdrawn: the fate is uncertain, and a tombstone would invite a duplicate retry into a
    // composer that may already hold the message.
    should(ledger.withdrawn).be.empty();
    should(ledger.only().fate).equal('accepted');
    should(repository.transitions).be.empty();
  });

  it('never accepts a send whose turn document could not be written', async () => {
    const { service, ledger, terminal, turns } = parts();
    turns.writeFailure = new Error('disk full');
    await service.send(request()).should.be.rejectedWith(/disk full/u);
    should(ledger.records.size).equal(0);
    should(terminal.calls).eql(['observe']);
  });

  it('withdraws only from the phase where nothing has been typed at all', async () => {
    const { service, ledger, terminal, repository } = parts();
    repository.journalFailure = new Error('journal is read-only');
    await service.send(request()).should.be.rejectedWith(/journal is read-only/u);
    should(ledger.withdrawn).eql(['send-1']);
    should(terminal.calls).eql(['observe']);
  });
});

describe('idempotency', () => {
  it('answers a retried request from the first send, and types nothing a second time', async () => {
    const { service, terminal, repository, ledger } = parts();
    const first = await service.send(request());
    const second = await service.send(request());

    should(second.disposition).equal(first.disposition);
    should(ledger.records.size).equal(1);
    // One delivery, one journalled send, one turn: the retry changed nothing.
    should(terminal.calls.filter(call => call === 'deliver')).have.length(1);
    should(repository.transitions).have.length(1);
    should(repository.events.filter(event => event === 'control.send')).have.length(1);
  });

  it('does not re-run a peer retry through the outbox or wake the waiter twice', async () => {
    const sender = { id: PEER, status: 'waiting', mode: 'auto', turn: 2 } as SendTarget;
    const { service, channel, peerWaits } = parts(target({ waiting: { peer: PEER } }), [pane({ promptReady: true })], {
      [PEER]: sender,
    });
    await service.send(request({ senderReference: PEER }));
    await service.send(request({ senderReference: PEER }));
    should(channel.outbound).have.length(1);
    should(peerWaits.ended).have.length(1);
  });
});

describe('send to a busy pane', () => {
  it('rides the harness queue and claims no turn', async () => {
    const { service, repository, ledger, terminal, turns } = parts(target({ status: 'thinking' }), [
      pane({ activeWork: true }),
      pane({ activeWork: true }),
    ]);
    const outcome = await service.send(request());

    should(outcome.disposition).equal('queued');
    should(terminal.calls).eql(['observe', 'observe', 'queue']);
    should(turns.calls).be.empty();
    should(repository.transitions).be.empty();
    should(ledger.only()).match({ path: 'native-inline', fate: 'queued', queueProof: 'pane', queuedAt: NOW });
    should(ledger.only().turn).be.undefined();
  });

  it('says sent, never queued, when the pane took the keys without proving the harness holds them', async () => {
    const { service, ledger, terminal, repository, tracked } = parts(target({ status: 'thinking' }), [
      pane({ activeWork: true }),
    ]);
    terminal.queueOutcome = 'unproven';
    const outcome = await service.send(request());

    should(outcome.disposition).equal('sent');
    should(outcome.record.fate).equal('accepted');
    should(ledger.only().fate).equal('accepted');
    should(repository.journal_.find(entry => entry.event === 'control.send_queued')?.data).match({ held: false });
    should(tracked).eql([ID]);
  });

  it('takes the tracked path when the pane went idle between the probe and the lock', async () => {
    const { service, terminal, repository } = parts(target({ status: 'thinking' }), [
      pane({ activeWork: true }),
      pane({ promptReady: true }),
    ]);
    const outcome = await service.send(request());
    should(outcome.disposition).equal('delivered');
    should(terminal.calls).eql(['observe', 'observe', 'deliver']);
    should(repository.transitions).have.length(1);
  });

  it('ends the active turn first when the caller said `now`', async () => {
    const { service, terminal } = parts(target({ status: 'thinking' }), [
      pane({ activeWork: true }),
      pane({ promptReady: true }),
    ]);
    const outcome = await service.send(request({ now: true }));
    should(terminal.calls).eql(['observe', 'stopActiveTurn', 'deliver']);
    should(outcome.disposition).equal('delivered');
  });

  it('ends a declared wait mid-turn when the caller said `now` (&B153)', async () => {
    // A `waiting` record over a pane at work routes busy now, so `--now` interrupts the turn as it does for
    // any busy agent — a ferret parked in a blocking `fy wait` call has that call cut short. Before, the idle
    // path waited for a prompt that never came.
    const { service, terminal } = parts(target({ status: 'waiting' }), [
      pane({ activeWork: true }),
      pane({ promptReady: true }),
    ]);
    const outcome = await service.send(request({ now: true }));
    should(terminal.calls).eql(['observe', 'stopActiveTurn', 'deliver']);
    should(outcome.disposition).equal('delivered');
  });

  it('does not press the stop key at a pane that is not visibly working', async () => {
    const { service, terminal } = parts(target({ status: 'thinking' }), [pane(), pane()]);
    await service.send(request({ now: true }));
    should(terminal.calls).eql(['observe', 'observe', 'queue']);
  });

  it('revives instead of typing when the pane died between the probe and the lock', async () => {
    const { service, terminal, reviver } = parts(target({ status: 'thinking' }), [
      pane({ activeWork: true }),
      pane({ alive: false, dead: true }),
    ]);
    const outcome = await service.send(request());
    should(outcome.disposition).equal('revived');
    should(terminal.calls).eql(['observe', 'observe']);
    should(reviver.messages).eql(['ship it']);
  });

  it('writes a long payload to a file and types a pointer to it', async () => {
    const message = 'x'.repeat(1_500);
    const { service, ledger, terminal, turns } = parts(target({ status: 'thinking' }), [
      pane({ activeWork: true }),
      pane({ activeWork: true }),
    ]);
    await service.send(request({ message }));
    should(turns.calls).eql(['writeQueuedPayload']);
    should(terminal.typed[0]).containEql('/state/channel/queued-send-1.md');
    should(ledger.only()).match({ path: 'native-file', payloadFile: '/state/channel/queued-send-1.md' });
  });
});

describe('send to a terminal or dead session', () => {
  it('becomes the first turn of a revive', async () => {
    const { service, ledger, reviver, channel } = parts(target({ status: 'completed' }));
    const outcome = await service.send(request());
    should(outcome.disposition).equal('revived');
    should(reviver.messages).eql(['ship it']);
    should(ledger.only()).match({ path: 'revive', turn: 4 });
    should(channel.inbound).eql([{ at: NOW, message: 'ship it', turn: 4 }]);
  });

  it('records the pointer the relaunch typed as what the transcript will carry', async () => {
    // Arrange — a relaunch types a pointer at the turn file, never the message itself.
    const pointer = 'Read the file /state/turns/turn-004.md now, then follow it.';
    const { service, ledger, reviver } = parts(target({ status: 'completed' }));
    reviver.typed = pointer;

    // Act
    const outcome = await service.send(request());

    // Assert
    should(ledger.only()).match({ path: 'revive', message: 'ship it', matchText: pointer, attemptAt: NOW });
    should(outcome.record).match({ matchText: pointer });
  });

  it('leaves the match text unset when the relaunch cannot say what it typed', async () => {
    const { service, ledger } = parts(target({ status: 'completed' }));
    await service.send(request());
    should(ledger.only().matchText).be.undefined();
  });

  it('holds the message durably when the reviver refuses, rather than losing it', async () => {
    const { service, ledger, reviver, channel, repository } = parts(target({ status: 'stopped' }));
    reviver.failure = new ReviveRefusedForSend('another session shares this checkout', 'session-9');
    const outcome = await service.send(request());

    should(outcome.disposition).equal('queued-for-revive');
    should(ledger.only()).match({ path: 'revive-queue', held: true });
    should(ledger.only().turn).be.undefined();
    should(channel.inbound[0]).match({ queuedForRevive: true, reason: /shares this checkout/u });
    should(repository.journal_.at(-1)?.data).match({ queuedForRevive: true, conflictSessionId: 'session-9' });
  });

  it('reports a reviver that failed for any other reason, keeping the accepted record', async () => {
    const { service, ledger, reviver } = parts(target({ status: 'stopped' }));
    reviver.failure = new Error('tmux refused to launch');
    await service.send(request()).should.be.rejectedWith(/tmux refused/u);
    should(ledger.only().path).equal('revive');
  });

  it('refuses when an accepted send cannot be retained for an explicit revive', async () => {
    const { service, ledger, reviver } = parts(target({ status: 'stopped' }));
    reviver.failure = new ReviveRefusedForSend('refused');
    ledger.reviseRefuses = true;
    await service.send(request()).should.be.rejectedWith(/could not retain accepted send send-1/u);
  });
});

describe('refusals', () => {
  it('reports a session that is still launching as pending rather than failed', async () => {
    const { service, gate } = parts();
    gate.inFlight = true;
    gate.settles = false;
    await should(service.send(request())).be.rejectedWith(SendPending);
    await should(service.send(request())).be.rejectedWith(/pending, not failed/u);
  });

  it('proceeds once an in-flight launch settles', async () => {
    const { service, gate } = parts();
    gate.inFlight = true;
    should((await service.send(request())).disposition).equal('delivered');
  });

  it('refuses a session it cannot read', async () => {
    const { service } = parts(null);
    await should(service.send(request())).be.rejectedWith(SendRefused);
    await should(service.send(request())).be.rejectedWith(/session not found/u);
  });

  it('refuses an empty message before it looks at anything', async () => {
    const { service, terminal } = parts();
    await should(service.send(request({ message: '   ' }))).be.rejectedWith(SendRefused);
    await should(service.send(request({ message: '   ' }))).be.rejectedWith(/requires a message/u);
    should(terminal.calls).be.empty();
  });

  it('refuses a quarantined session before capturing a frame', async () => {
    const { service, terminal } = parts(target({ needsHumanKind: 'codex-picker-unconfirmed' }));
    await service.send(request()).should.be.rejectedWith(SendUnavailable);
    should(terminal.calls).be.empty();
  });
});

describe('peer messaging', () => {
  const sender = { id: PEER, status: 'waiting', mode: 'auto', turn: 2, teammate: 'loge' } as SendTarget;

  it('prepends attribution the receiver can act on, and records the undecorated message in the outbox', async () => {
    const { service, terminal, channel } = parts(target({ waiting: { peer: PEER } }), [pane({ promptReady: true })], {
      [PEER]: sender,
    });
    await service.send(request({ senderReference: PEER, replyExpected: true }));

    should(terminal.typed[0]).containEql('/state/turns/turn-004.md');
    // The banner travels in the TURN DOCUMENT, which is what the agent reads.
    should(channel.outbound).eql([
      { at: NOW, to: ID, from: PEER, fromName: 'loge', disposition: 'delivered', message: 'ship it' },
    ]);
    should(channel.inbound[0]).match({ from: PEER, fromName: 'loge' });
  });

  it('tells the receiver a message it is parked on is the reply, and anything else what it is', async () => {
    const reply = parts(target({ waiting: { peer: PEER } }), [pane({ promptReady: true })], { [PEER]: sender });
    await reply.service.send(request({ senderReference: PEER }));
    const question = parts(target(), [pane({ promptReady: true })], { [PEER]: sender });
    await question.service.send(request({ senderReference: PEER, replyExpected: true }));
    const note = parts(target(), [pane({ promptReady: true })], { [PEER]: sender });
    await note.service.send(request({ senderReference: PEER }));

    should(reply.ledger.only().message).startWith('[reply from ferret loge (session ');
    should(question.ledger.only().message).startWith('[question from ferret loge (session ');
    should(note.ledger.only().message).startWith('[message from ferret loge (session ');
    should(note.ledger.only().message).endWith('ship it');
  });

  it('calls a send a plain message when the recipient cannot be read yet, rather than failing it', async () => {
    const built = parts(target(), [pane({ promptReady: true })], { [PEER]: sender });
    const read = built.repository.read.bind(built.repository);
    let first = true;
    built.repository.read = async () => {
      if (!first) return await read();
      first = false;
      throw new Error('record mid-write');
    };
    await built.service.send(request({ senderReference: PEER }));
    should(built.ledger.only().message).startWith('[message from ferret loge');
  });

  it("ends the recipient's declared wait, because this send IS the reply it was parked on", async () => {
    const { service, peerWaits } = parts(target({ waiting: { peer: PEER } }), [pane({ promptReady: true })], {
      [PEER]: sender,
    });
    await service.send(request({ senderReference: PEER }));
    should(peerWaits.ended).eql([{ recipient: ID, sender: PEER }]);
  });

  it('leaves a wait on somebody else alone', async () => {
    const { service, peerWaits } = parts(target({ waiting: { peer: 'session-9' } }), [pane({ promptReady: true })], {
      [PEER]: sender,
    });
    await service.send(request({ senderReference: PEER }));
    should(peerWaits.ended).be.empty();
  });

  it('never wakes a waiter for a message that only reached the hold queue', async () => {
    const { service, peerWaits, reviver, channel } = parts(
      target({ status: 'stopped', waiting: { peer: PEER } }),
      [pane()],
      { [PEER]: sender },
    );
    reviver.failure = new ReviveRefusedForSend('refused');
    await service.send(request({ senderReference: PEER }));
    should(peerWaits.ended).be.empty();
    // The sender still gets its audit row: the message IS durably held for the recipient.
    should(channel.outbound).have.length(1);
  });

  it('degrades to an unattributed send when the sender reference resolves to nobody', async () => {
    const { service, channel, terminal } = parts();
    await service.send(request({ senderReference: 'ghost' }));
    should(channel.outbound).be.empty();
    should(terminal.typed[0]).equal('ship it');
  });

  it('does not attribute a session to itself', async () => {
    const { service, channel } = parts(target(), [pane({ promptReady: true })], { [ID]: target() });
    await service.send(request({ senderReference: ID }));
    should(channel.outbound).be.empty();
  });

  it('keeps the delivery when the outbox row cannot be written, and says so loudly', async () => {
    const { service, channel, repository } = parts(target(), [pane({ promptReady: true })], { [PEER]: sender });
    channel.outboundFailure = new Error('outbox is read-only');
    const outcome = await service.send(request({ senderReference: PEER }));
    should(outcome.disposition).equal('delivered');
    should(repository.events).containEql('control.outbox_write_failed');
  });

  it('does not fail a delivered send because ending the wait failed', async () => {
    const { service, peerWaits } = parts(target({ waiting: { peer: PEER } }), [pane({ promptReady: true })], {
      [PEER]: sender,
    });
    peerWaits.failure = new Error('signal service is busy');
    should((await service.send(request({ senderReference: PEER }))).disposition).equal('delivered');
    should(peerWaits.ended).have.length(1);
  });
});

describe('serialization', () => {
  it('makes every mutation of one session pass through that one lock', async () => {
    const { service, serial } = parts();
    await service.send(request());
    should(serial.keys).eql([ID]);
  });
});

describe('who a send is from', () => {
  it('records a person, an agent, or the daemon, and the attachments it named', async () => {
    const sender = target({ id: PEER, teammate: 'hadi' });
    const human = parts();
    await human.service.send(request({ attachmentIds: ['att_1'] }));
    const agent = parts(target(), [pane({ promptReady: true })], { [PEER]: sender });
    await agent.service.send(request({ senderReference: PEER }));
    const daemon = parts();
    await daemon.service.send(request({ origin: 'daemon' }));

    should(human.ledger.only()).match({ senderKind: 'human', attachmentIds: ['att_1'], attempt: 1, attemptAt: NOW });
    should(agent.ledger.only()).match({ senderKind: 'agent', from: PEER, fromName: 'hadi' });
    should(daemon.ledger.only().senderKind).equal('daemon');
  });

  it('records the feature a direct daemon send names as its sender, and shows it on the wire', async () => {
    const { service, ledger } = parts();
    await service.send(request({ origin: 'daemon', by: { kind: 'ferretry', feature: 'Board' } }));

    should(ledger.only()).match({ senderKind: 'daemon', by: { kind: 'ferretry', feature: 'Board' } });
    should(sendRecordView(ledger.only())).match({ by: { kind: 'ferretry', feature: 'Board' } });
  });

  it('does not track a duplicate request, which found a send already being watched', async () => {
    const { service, tracked } = parts();
    await service.send(request());
    const again = await service.send(request());

    should(again.record.sendId).equal('send-1');
    should(tracked).eql([ID]);
  });
});

describe('re-attempting a send under its original id', () => {
  async function settled(
    fate: SendRecord['fate'],
    extra: Partial<SendRecord> = {},
    frames: SendPaneObservation[] = [pane({ promptReady: true })],
  ) {
    const built = parts(target(), frames);
    await built.service.send(request());
    built.ledger.records.set('send-1', { ...built.ledger.only(), fate, ...extra });
    built.terminal.typed.length = 0;
    built.tracked.length = 0;
    return built;
  }

  it('retypes a send proven absent into an idle prompt as attempt two, ledgered first', async () => {
    const { service, ledger, terminal, repository, tracked } = await settled('timed_out', {
      retryable: true,
      unaccountedReason: 'not_delivered',
      deadlineAt: NOW,
    });
    const record = await service.reattempt(ID, 'send-1', { by: 'person' });

    should(record).match({ fate: 'accepted', attempt: 2, attemptAt: NOW });
    should(ledger.only().unaccountedReason).be.undefined();
    should(ledger.only().deadlineAt).be.undefined();
    should(terminal.typed).eql(['ship it']);
    should(repository.journal_.at(-1)).match({ event: 'control.send_retried', data: { attempt: 2, by: 'person' } });
    should(tracked).eql([ID]);
  });

  it('rides the queue when the pane is busy, and records the proof when the harness holds it', async () => {
    const { service, terminal } = await settled('accepted', {}, [
      pane({ promptReady: true }),
      pane({ activeWork: true }),
    ]);
    const record = await service.reattempt(ID, 'send-1', { by: 'daemon' });

    should(terminal.calls.at(-1)).equal('queue');
    should(record).match({ fate: 'queued', attempt: 2 });
  });

  it('stays accepted when the busy pane did not prove it is holding the retype', async () => {
    const { service, terminal } = await settled('queued', {}, [
      pane({ promptReady: true }),
      pane({ activeWork: true }),
    ]);
    terminal.queueOutcome = 'unproven';
    const record = await service.reattempt(ID, 'send-1', { by: 'daemon' });

    should(record).match({ fate: 'accepted', attempt: 2 });
  });

  it('needs "send again anyway" for an unconfirmed send, and refuses everything else a person may not retry', async () => {
    const unconfirmed = await settled('unaccounted', { unaccountedReason: 'transcript_unreadable' });
    const refusedUnconfirmed = await unconfirmed.service
      .reattempt(ID, 'send-1', { by: 'person' })
      .catch((error: unknown) => error);
    const forced = await unconfirmed.service.reattempt(ID, 'send-1', { by: 'person', force: true });
    const open = await settled('accepted');
    const refusedOpen = await open.service.reattempt(ID, 'send-1', { by: 'person' }).catch((error: unknown) => error);
    const delivered = await settled('delivered');
    const refusedDelivered = await delivered.service
      .reattempt(ID, 'send-1', { by: 'daemon' })
      .catch((error: unknown) => error);
    const ended = await settled('timed_out', { retryable: false, unaccountedReason: 'ferret_ended' });
    const refusedEnded = await ended.service.reattempt(ID, 'send-1', { by: 'person' }).catch((error: unknown) => error);
    const missing = await open.service.reattempt(ID, 'nope', { by: 'daemon' }).catch((error: unknown) => error);

    should(refusedUnconfirmed).be.instanceof(SendRefused);
    should((refusedUnconfirmed as Error).message).match(/send it again anyway/);
    should(forced.attempt).equal(2);
    should(refusedOpen).be.instanceof(SendRefused);
    should((refusedOpen as Error).message).match(/accepted and cannot be retried/);
    should((refusedDelivered as Error).message).match(/already delivered/);
    should(refusedEnded).be.instanceof(SendRefused);
    should((missing as Error).message).match(/has no send nope/);
  });

  it('refuses a revive-borne send and a session with no live agent, typing nothing', async () => {
    const held = await settled('timed_out', { retryable: true, path: 'revive-queue', held: true });
    const heldRefusal = await held.service.reattempt(ID, 'send-1', { by: 'person' }).catch((error: unknown) => error);
    const dead = await settled('timed_out', { retryable: true }, [pane({ promptReady: true }), pane({ alive: false })]);
    const deadRefusal = await dead.service.reattempt(ID, 'send-1', { by: 'person' }).catch((error: unknown) => error);
    const lost = await settled('timed_out', { retryable: true });
    lost.ledger.settleRefuses = true;
    const lostRefusal = await lost.service.reattempt(ID, 'send-1', { by: 'person' }).catch((error: unknown) => error);

    should((heldRefusal as Error).message).match(/rides a revive/);
    should((deadRefusal as Error).message).match(/no live agent/);
    should((lostRefusal as Error).message).match(/could not be re-attempted/);
    should([...held.terminal.typed, ...dead.terminal.typed, ...lost.terminal.typed]).be.empty();
  });
});

describe('a composer that already holds unsent text', () => {
  it('refuses a send before accepting anything, quoting the draft and the remedy', async () => {
    const { service, ledger, terminal } = parts(target(), [pane({ promptReady: false, draft: 'hi' })]);

    const refused = await service.send(request({ message: 'hello' })).catch((error: unknown) => error);

    should(refused).be.instanceof(SendRefused);
    should((refused as Error).message).match(
      /already holds unsent text \("hi"\).*Press Enter on it or clear it first/u,
    );
    should(ledger.records.size).equal(0);
    should(terminal.typed).be.empty();
  });

  it('refuses on the second look too, after a busy pane stopped being busy, and clips a long draft', async () => {
    const long = 'x'.repeat(60);
    const { service } = parts(target(), [pane({ activeWork: true }), pane({ draft: long })]);

    const refused = await service.send(request()).catch((error: unknown) => error);

    should((refused as Error).message).containEql(`"${'x'.repeat(40)}…"`);
  });

  it('withdraws a fresh send the terminal refused before typing, on both transports', async () => {
    const idle = parts(target(), [pane({ promptReady: true })]);
    idle.terminal.occupied = 'hi';
    const busy = parts(target(), [pane({ activeWork: true })]);
    busy.terminal.occupied = 'hi';

    const idleRefusal = await idle.service.send(request()).catch((error: unknown) => error);
    const busyRefusal = await busy.service.send(request()).catch((error: unknown) => error);

    should(idleRefusal).be.instanceof(SendRefused);
    should(busyRefusal).be.instanceof(SendRefused);
    should([...idle.ledger.withdrawn, ...busy.ledger.withdrawn]).eql(['send-1', 'send-1']);
  });

  it("keeps a person's send open and untyped when the composer could not be read, on both transports", async () => {
    // The owner's message was withdrawn a second after it was accepted, behind a composer the reader
    // could not place, and nothing ever tried it again. It is the tracker's to type now.
    const idle = parts(target(), [pane({ promptReady: true })]);
    idle.terminal.unreadable = true;
    const busy = parts(target(), [pane({ activeWork: true })]);
    busy.terminal.unreadable = true;

    const answers = [await idle.service.send(request()), await busy.service.send(request())];

    for (const [built, answer] of [
      [idle, answers[0]],
      [busy, answers[1]],
    ] as const) {
      should(answer?.record.fate).equal('accepted');
      should(built.ledger.records.get('send-1')).containEql({ fate: 'accepted', untyped: true, senderKind: 'human' });
      should(built.ledger.withdrawn).be.empty();
      should(built.terminal.typed).be.empty();
      should(built.tracked).eql([ID]);
      should(built.repository.events).containEql('control.send_deferred');
      // Nothing landed, so no turn started and nothing was said to be queued.
      should(built.repository.transitions).be.empty();
      should(built.repository.events).not.containEql('control.send_queued');
    }
  });

  it("withdraws a ferret's send the terminal could not read the composer for, typing nothing, on both transports", async () => {
    const sender = { id: PEER, status: 'running', mode: 'auto', turn: 2 } as SendTarget;
    const idle = parts(target(), [pane({ promptReady: true })], { [PEER]: sender });
    idle.terminal.unreadable = true;
    const busy = parts(target(), [pane({ activeWork: true })], { [PEER]: sender });
    busy.terminal.unreadable = true;

    const idleRefusal = await idle.service.send(request({ senderReference: PEER })).catch((error: unknown) => error);
    const busyRefusal = await busy.service.send(request({ senderReference: PEER })).catch((error: unknown) => error);

    should(idleRefusal).be.instanceof(SendRefused);
    should((busyRefusal as Error).message).match(
      /could not be read to prove its composer empty, so nothing was typed/u,
    );
    should([...idle.ledger.withdrawn, ...busy.ledger.withdrawn]).eql(['send-1', 'send-1']);
    should([...idle.terminal.typed, ...busy.terminal.typed]).be.empty();
  });

  it('settles a send typed but never shown as unconfirmed, still watched, and names it — on both transports', async () => {
    const idle = parts(target(), [pane({ promptReady: true })]);
    idle.terminal.deliverFailure = new SendLandingUnconfirmed('typed into tmux session fy-x; it drew nothing for 12 s');
    const busy = parts(target(), [pane({ activeWork: true })]);
    busy.terminal.queueFailure = new SendLandingUnconfirmed('typed into tmux session fy-x; it drew nothing for 12 s');

    const answers = [
      await idle.service.send(request()).catch((error: unknown) => error),
      await busy.service.send(request()).catch((error: unknown) => error),
    ];

    for (const [built, answer] of [
      [idle, answers[0]],
      [busy, answers[1]],
    ] as const) {
      // Typed exactly once, never withdrawn: the message may be in the agent's box right now.
      should(answer).be.instanceof(SendUnconfirmed);
      should((answer as SendUnconfirmed).sendId).equal('send-1');
      should((answer as SendUnconfirmed).message).not.match(
        /tmux|fy-x/u,
        'a person is never handed a tmux session name',
      );
      should(built.terminal.typed).have.length(1);
      should(built.ledger.withdrawn).be.empty();
      should(built.ledger.only()).match({ fate: 'unaccounted', unaccountedReason: 'landing_unconfirmed', fateAt: NOW });
      should(built.tracked).eql([ID], 'still watched, so a transcript record that turns up later proves it delivered');
      should(built.repository.journal_.at(-1)).match({
        event: 'control.send_unaccounted',
        data: { sendId: 'send-1', reason: 'landing_unconfirmed', attempt: 1 },
      });
    }
    // No turn is STARTED for a prompt that never proved it landed — but its number is reserved (B144), so no
    // later turn file overwrites the one the typed pointer names.
    should(idle.repository.transitions).eql([{ event: 'control.turn_reserved', turn: 4, keepReason: true }]);
    should(busy.repository.transitions).be.empty();
  });

  it('settles a forced retry that was typed but never shown as unconfirmed again, under the same id', async () => {
    const built = parts(target(), [pane({ promptReady: true })]);
    await built.service.send(request());
    built.ledger.records.set('send-1', {
      ...built.ledger.only(),
      fate: 'unaccounted',
      unaccountedReason: 'landing_unconfirmed',
    });
    built.terminal.deliverFailure = new SendLandingUnconfirmed('typed; drew nothing');

    const answer = await built.service.reattempt(ID, 'send-1', { by: 'person', force: true }).catch((e: unknown) => e);

    should(answer).be.instanceof(SendUnconfirmed);
    should(built.ledger.only()).match({ fate: 'unaccounted', unaccountedReason: 'landing_unconfirmed', attempt: 2 });
  });

  it('passes a transport failure that is not a refusal straight through', async () => {
    const built = parts(target(), [pane({ promptReady: true })]);
    built.terminal.deliverFailure = new Error('tmux went away');

    should((await built.service.send(request()).catch((error: unknown) => error)) as Error).match({
      message: 'tmux went away',
    });
    should(built.ledger.withdrawn).be.empty();
  });
});

describe('&B153: a pane that never comes to a prompt', () => {
  // ryu, 2026-11-02 → 11-04: the record said `waiting` while the agent was mid-turn, so the send took the idle
  // path, the wait for a prompt gave up before a single key, and the throw left an `accepted` row that no
  // tracker look was ever scheduled for. Eleven queues sat behind it for 38 min to 5 h 49 min.
  const notReady = (why: SendPaneNotReady['why'] = 'busy') =>
    new SendPaneNotReady('tmux session fy-ryu did not become ready to accept a turn', why);
  const sender = { id: PEER, status: 'running', mode: 'auto', turn: 2 } as SendTarget;

  it("refuses a ferret's send before any key, withdraws its row and names the wait", async () => {
    const built = parts(target({ status: 'waiting' }), [pane()], { [PEER]: sender });
    built.terminal.notReady = notReady();

    const refusal = await built.service.send(request({ senderReference: PEER })).catch((error: unknown) => error);

    should(refusal).be.instanceof(SendNotReady);
    should((refusal as SendNotReady).reason).equal('busy');
    should((refusal as SendNotReady).message).match(/never came to a prompt/u);
    should(built.ledger.withdrawn).eql(['send-1']);
    should(built.ledger.records.size).equal(0);
    should(built.terminal.typed).be.empty();
    should(built.repository.transitions).be.empty();
    // Nothing is open, so nothing is left for the tracker; the queue holds the message instead.
    should(built.tracked).be.empty();
  });

  it('names a dialog and a pane that went away as what the queue waits on', async () => {
    const reasons: string[] = [];
    for (const why of ['dialog', 'exited'] as const) {
      const built = parts(target(), [pane({ promptReady: true })], { [PEER]: sender });
      built.terminal.notReady = notReady(why);
      const refusal = await built.service.send(request({ senderReference: PEER })).catch((error: unknown) => error);
      reasons.push((refusal as SendNotReady).reason);
    }

    should(reasons).eql(['dialog', 'stopped']);
  });

  it("keeps a person's send open and untyped for the tracker, saying why", async () => {
    const built = parts(target({ status: 'waiting' }), [pane()]);
    built.terminal.notReady = notReady();

    const answer = await built.service.send(request());

    should(built.ledger.only()).containEql({ fate: 'accepted', untyped: true, senderKind: 'human' });
    should(answer.record.untyped).be.true();
    should(built.terminal.typed).be.empty();
    should(built.tracked).eql([ID]);
    should(built.repository.journal_).containEql({
      event: 'control.send_deferred',
      data: { sendId: 'send-1', reason: 'the agent never came to a prompt' },
    });
  });

  const heldRelease = (why: SendPaneNotReady['why']) => {
    const built = parts(target(), [pane({ promptReady: true })]);
    built.ledger.records.set('held-1', {
      sendId: 'held-1',
      acceptedAt: NOW,
      acceptedTurn: 3,
      path: 'revive-queue',
      message: 'when you are back',
      held: true,
      fate: 'accepted',
    });
    built.terminal.notReady = notReady(why);
    return built;
  };

  it('keeps a released held message open for the tracker when the live pane never comes to a prompt', async () => {
    // Back on hold it would wait for a revive this live session never gets.
    const built = heldRelease('busy');

    should(await built.service.releaseHeld(ID)).equal(1);

    should(built.ledger.records.get('held-1')).containEql({ fate: 'accepted', held: false, untyped: true });
    should(built.terminal.typed).be.empty();
    should(built.tracked).eql([ID]);
  });

  it('puts a released held message back on hold when its pane went away during the wait', async () => {
    const built = heldRelease('exited');

    await built.service.releaseHeld(ID).should.be.rejectedWith(SendNotReady);

    should(built.ledger.records.get('held-1')).containEql({ fate: 'accepted', held: true });
    should(built.terminal.typed).be.empty();
  });

  it("withdraws a person's send whose pane went away during the wait, so the next one revives it", async () => {
    const built = parts(target(), [pane({ promptReady: true })]);
    built.terminal.notReady = notReady('exited');

    const refusal = await built.service.send(request()).catch((error: unknown) => error);

    should((refusal as SendNotReady).reason).equal('stopped');
    should(built.ledger.withdrawn).eql(['send-1']);
    should(built.tracked).be.empty();
  });

  it('tells the tracker about a send whose transport threw after its row was accepted', async () => {
    const built = parts(target(), [pane({ promptReady: true })], { [PEER]: sender });
    built.terminal.deliverFailure = new Error('tmux went away mid-Enter');

    await built.service.send(request({ senderReference: PEER })).should.be.rejectedWith(/tmux went away/u);

    // The row stays `accepted` — keys may have gone — and a look is now scheduled to settle it.
    should(built.ledger.only().fate).equal('accepted');
    should(built.tracked).eql([ID]);
  });

  it('tells the tracker when the ledger cannot be read to rule an open row out', async () => {
    const built = parts(target(), [pane({ promptReady: true })], { [PEER]: sender });
    built.terminal.deliverFailure = new Error('tmux went away mid-Enter');
    const list = built.ledger.list.bind(built.ledger);
    built.ledger.list = async () => {
      // The send's own reads succeed; the one after the keys went does not.
      if (built.terminal.typed.length > 0) throw new Error('ledger is unreadable');
      return await list();
    };

    await built.service.send(request({ senderReference: PEER })).should.be.rejectedWith(/tmux went away/u);

    should(built.tracked).eql([ID]);
  });

  it('schedules no look for a send refused before its row was written', async () => {
    const built = parts(target({ needsHumanKind: 'codex-picker-unconfirmed' }));

    await built.service.send(request()).should.be.rejectedWith(SendUnavailable);

    should(built.tracked).be.empty();
  });

  it('withholds a daemon retype at a pane that never comes to a prompt, as busy, and puts the record back', async () => {
    const built = parts(target(), [pane({ promptReady: true })]);
    await built.service.send(request());
    built.ledger.records.set('send-1', { ...built.ledger.only(), fate: 'accepted', attempt: 1 });
    built.terminal.typed.length = 0;
    built.tracked.length = 0;
    built.terminal.notReady = notReady();

    const withheld = await built.service.reattempt(ID, 'send-1', { by: 'daemon' }).catch((e: unknown) => e);

    should(withheld).be.instanceof(SendRetypeWithheld);
    should((withheld as SendRetypeWithheld).reason).equal('busy');
    should(built.ledger.only()).match({ fate: 'accepted', attempt: 1 });
    should(built.terminal.typed).be.empty();
  });

  it('tells the tracker about a retype whose transport threw after its attempt was ledgered', async () => {
    const built = parts(target(), [pane({ promptReady: true })]);
    await built.service.send(request());
    built.ledger.records.set('send-1', { ...built.ledger.only(), fate: 'queued', attempt: 1 });
    built.tracked.length = 0;
    built.terminal.deliverFailure = new Error('tmux went away');

    await built.service.reattempt(ID, 'send-1', { by: 'daemon' }).should.be.rejectedWith(/tmux went away/u);

    should(built.ledger.only()).match({ fate: 'accepted', attempt: 2 });
    should(built.tracked).eql([ID]);
  });
});

describe('cancelling a send', () => {
  async function sent(fate: SendRecord['fate'], extra: Partial<SendRecord> = {}) {
    const built = parts(target(), [pane({ promptReady: true })]);
    await built.service.send(request());
    built.ledger.records.set('send-1', { ...built.ledger.only(), fate, ...extra });
    return built;
  }

  it('erases a message typed in the composer and settles it cancelled, journalled with its effect', async () => {
    const { service, terminal, repository } = await sent('accepted', { typedNotSent: true });
    terminal.held.set('ship it', 'composer');

    const record = await service.cancel(ID, 'send-1');

    should(record).match({ fate: 'cancelled', fateAt: NOW, cancelEffect: 'cleared' });
    should(record.typedNotSent).be.undefined();
    should(terminal.calls).containEql('clearComposer');
    should(repository.journal_.at(-1)).match({
      event: 'control.send_cancelled',
      data: { sendId: 'send-1', from: 'accepted', effect: 'cleared' },
    });
  });

  it('leaves the composer alone when it holds more than the message, and says so', async () => {
    const { service, terminal } = await sent('accepted');
    terminal.held.set('ship it', 'composer');
    terminal.clearOutcome = 'foreign';

    should(await service.cancel(ID, 'send-1')).match({ cancelEffect: 'left_in_composer' });
  });

  it('says a queued message is left with the agent, and one in neither place never reached it', async () => {
    const queued = await sent('queued');
    queued.terminal.held.set('ship it', 'queue');
    const gone = await sent('timed_out');
    const unreadable = await sent('unaccounted');
    unreadable.terminal.heldFailure = new Error('no pane');
    const forRevive = await sent('accepted', { held: true });

    should(await queued.service.cancel(ID, 'send-1')).match({ cancelEffect: 'left_in_queue' });
    should(await gone.service.cancel(ID, 'send-1')).match({ cancelEffect: 'not_in_pane' });
    should(await unreadable.service.cancel(ID, 'send-1')).match({ cancelEffect: 'not_in_pane' });
    should(await forRevive.service.cancel(ID, 'send-1')).match({ cancelEffect: 'not_in_pane' });
    should(forRevive.terminal.calls).not.containEql('heldAt');
  });

  it('is idempotent, refuses a delivered or unknown send, and reports a ledger that would not move', async () => {
    const cancelled = await sent('cancelled', { cancelEffect: 'cleared' });
    const delivered = await sent('delivered');
    const withdrawn = await sent('withdrawn');
    const stuck = await sent('accepted');
    stuck.ledger.settleRefuses = true;

    should(await cancelled.service.cancel(ID, 'send-1')).match({ fate: 'cancelled', cancelEffect: 'cleared' });
    should(((await delivered.service.cancel(ID, 'send-1').catch((error: unknown) => error)) as Error).message).match(
      /already delivered/u,
    );
    should(((await withdrawn.service.cancel(ID, 'send-1').catch((error: unknown) => error)) as Error).message).match(
      /has no send send-1/u,
    );
    should(((await stuck.service.cancel(ID, 'send-1').catch((error: unknown) => error)) as Error).message).match(
      /could not be cancelled/u,
    );
  });
});

describe('pressing Enter for a message typed and not sent', () => {
  async function typed(extra: Partial<SendRecord> = {}) {
    const built = parts(target(), [pane({ promptReady: true })]);
    await built.service.send(request());
    built.ledger.records.set('send-1', { ...built.ledger.only(), fate: 'accepted', typedNotSent: true, ...extra });
    built.tracked.length = 0;
    return built;
  }

  it('presses once, clears the typed flag, journals it, and asks the tracker to look', async () => {
    const { service, terminal, repository, tracked } = await typed();

    const record = await service.submit(ID, 'send-1');

    should(record.typedNotSent).be.undefined();
    should(terminal.calls.filter(call => call === 'submitComposer')).have.length(1);
    should(repository.journal_.at(-1)).match({ event: 'control.send_submitted', data: { outcome: 'submitted' } });
    should(tracked).eql([ID]);
  });

  it('keeps the flag when the message stayed, and refuses when it is not in the composer', async () => {
    const holding = await typed();
    holding.terminal.submitOutcome = 'holding';
    const absent = await typed();
    absent.terminal.submitOutcome = 'absent';
    const lost = await typed();
    lost.ledger.settleRefuses = true;

    should(await holding.service.submit(ID, 'send-1')).match({ typedNotSent: true });
    should(((await absent.service.submit(ID, 'send-1').catch((error: unknown) => error)) as Error).message).match(
      /not sitting in the agent's composer/u,
    );
    should(await lost.service.submit(ID, 'send-1')).match({ typedNotSent: true });
  });

  it('refuses a send that is finished or unknown', async () => {
    const cancelled = await typed({ fate: 'cancelled' });
    const withdrawn = await typed({ fate: 'withdrawn' });

    should(((await cancelled.service.submit(ID, 'send-1').catch((error: unknown) => error)) as Error).message).match(
      /is cancelled; there is nothing to submit/u,
    );
    should(((await withdrawn.service.submit(ID, 'send-9').catch((error: unknown) => error)) as Error).message).match(
      /has no send send-9/u,
    );
    should(((await withdrawn.service.submit(ID, 'send-1').catch((error: unknown) => error)) as Error).message).match(
      /has no send send-1/u,
    );
  });
});

describe('a person retrying a send that is still open', () => {
  async function open(fate: SendRecord['fate']) {
    const built = parts(target(), [pane({ promptReady: true })]);
    await built.service.send(request());
    built.ledger.records.set('send-1', { ...built.ledger.only(), fate, attempt: 1 });
    built.terminal.typed.length = 0;
    return built;
  }

  it('retypes a forced open send the pane does not hold', async () => {
    const { service, terminal } = await open('queued');

    should(await service.reattempt(ID, 'send-1', { by: 'person', force: true })).match({
      fate: 'accepted',
      attempt: 2,
    });
    should(terminal.typed).eql(['ship it']);
  });

  it('refuses one still typed in the composer or held in the queue, typing nothing', async () => {
    const composer = await open('accepted');
    composer.terminal.held.set('ship it', 'composer');
    const queue = await open('queued');
    queue.terminal.held.set('ship it', 'queue');
    const unreadable = await open('accepted');
    unreadable.terminal.heldFailure = new Error('no pane');

    const typed = await composer.service
      .reattempt(ID, 'send-1', { by: 'person', force: true })
      .catch((e: unknown) => e);
    const held = await queue.service.reattempt(ID, 'send-1', { by: 'person', force: true }).catch((e: unknown) => e);

    should((typed as Error).message).match(/typed in the agent's composer and not sent; press Enter instead/u);
    should((held as Error).message).match(/held in the agent's own queue/u);
    should(await unreadable.service.reattempt(ID, 'send-1', { by: 'person', force: true })).match({ attempt: 2 });
    should([...composer.terminal.typed, ...queue.terminal.typed]).be.empty();
  });

  it('refuses at an occupied composer, before or during the retype, and puts the record back', async () => {
    const before = await open('timed_out');
    before.ledger.records.set('send-1', { ...before.ledger.only(), retryable: true });
    (before.terminal as unknown as { frames: SendPaneObservation[] }).frames.splice(0, 1, pane({ draft: 'hi' }));
    const during = await open('queued');
    during.terminal.occupied = 'hi';
    const busy = parts(target(), [pane({ promptReady: true })]);
    await busy.service.send(request());
    busy.ledger.records.set('send-1', { ...busy.ledger.only(), fate: 'queued', attempt: 1 });
    (busy.terminal as unknown as { frames: SendPaneObservation[] }).frames.splice(0, 1, pane({ activeWork: true }));
    busy.terminal.occupied = 'hi';

    const refusedBefore = await before.service.reattempt(ID, 'send-1', { by: 'person' }).catch((e: unknown) => e);
    const refusedDuring = await during.service
      .reattempt(ID, 'send-1', { by: 'person', force: true })
      .catch((e: unknown) => e);
    const refusedBusy = await busy.service.reattempt(ID, 'send-1', { by: 'daemon' }).catch((e: unknown) => e);
    const failing = await open('queued');
    failing.terminal.deliverFailure = new Error('tmux went away');
    const failed = await failing.service.reattempt(ID, 'send-1', { by: 'daemon' }).catch((e: unknown) => e);

    should((refusedBefore as Error).message).match(/already holds unsent text/u);
    should(before.ledger.only()).match({ fate: 'timed_out', attempt: 1 });
    should((refusedDuring as Error).message).match(/already holds unsent text/u);
    should(during.ledger.only()).match({ fate: 'queued', attempt: 1 });
    should((refusedBusy as Error).message).match(/already holds unsent text/u);
    should(busy.ledger.only()).match({ fate: 'queued', attempt: 1 });
    should((failed as Error).message).equal('tmux went away');
  });

  it('withholds a retype at a composer it cannot read, as unreadable, and puts the record back', async () => {
    const during = await open('queued');
    during.terminal.unreadable = true;

    const withheld = await during.service.reattempt(ID, 'send-1', { by: 'daemon' }).catch((e: unknown) => e);

    should(withheld).be.instanceof(SendRetypeWithheld);
    should((withheld as SendRetypeWithheld).reason).equal('unreadable');
    should(during.ledger.only()).match({ fate: 'queued', attempt: 1 });
    should(during.terminal.typed).be.empty();
  });
});

describe('delivering held messages after a revive', () => {
  async function heldParts(frames: SendPaneObservation[], pause?: (ms: number) => Promise<void>) {
    const built = parts(target(), frames, {}, pause);
    built.ledger.records.set('held-1', {
      sendId: 'held-1',
      acceptedAt: NOW,
      acceptedTurn: 3,
      path: 'revive-queue',
      message: 'when you are back',
      held: true,
      fate: 'accepted',
      replyExpected: true,
    });
    return built;
  }

  it('types each held message once, as a tracked turn, and clears the hold in the same step', async () => {
    const { service, ledger, terminal, repository, tracked } = await heldParts([pane({ promptReady: true })]);

    const first = await service.releaseHeld(ID);
    const second = await service.releaseHeld(ID);

    should(first).equal(1);
    should(second).equal(0);
    should(terminal.typed).eql(['when you are back']);
    should(ledger.only()).match({
      held: false,
      path: 'direct',
      matchText: 'when you are back',
      turn: 4,
      fate: 'accepted',
    });
    should(repository.events).containEql('control.send_released');
    should(tracked).eql([ID]);
  });

  it('queues a held message behind a busy agent, and waits out a launch first', async () => {
    const { service, ledger, gate } = await heldParts([pane({ activeWork: true })]);
    gate.inFlight = true;

    should(await service.releaseHeld(ID)).equal(1);
    should(ledger.only()).match({ held: false, path: 'native-inline', fate: 'queued' });
  });

  it('keeps holding a released message the terminal could not read the composer for', async () => {
    const { service, ledger, terminal } = await heldParts([pane({ promptReady: true })]);
    terminal.unreadable = true;

    const refused = await service.releaseHeld(ID).catch((error: unknown) => error);

    should(refused).be.instanceof(SendRefused);
    should(ledger.only()).match({ held: true, fate: 'accepted' });
    should(ledger.withdrawn).be.empty();
  });

  it('keeps holding when there is still no live agent, and when the record moved under it', async () => {
    const { service, ledger } = await heldParts([pane({ alive: false })]);
    should(await service.releaseHeld(ID)).equal(0);
    should(ledger.only().held).be.true();

    const raced = await heldParts([pane({ promptReady: true })]);
    const list = raced.ledger.list.bind(raced.ledger);
    let calls = 0;
    raced.ledger.list = async () => {
      calls += 1;
      const records = await list();
      return calls === 1 ? records : records.map(record => ({ ...record, held: false }));
    };
    should(await raced.service.releaseHeld(ID)).equal(0);
  });
});

describe('a Codex startup park while held sends are released (B170)', () => {
  const parked = (overrides: Partial<SendPaneObservation> = {}) => pane({ startupParked: true, ...overrides });
  const held = (built: Awaited<ReturnType<typeof heldRecord>>) => built.ledger.only();

  async function heldRecord(frames: SendPaneObservation[], pause?: (ms: number) => Promise<void>) {
    const built = parts(target(), frames, {}, pause);
    built.ledger.records.set('held-1', {
      sendId: 'held-1',
      acceptedAt: NOW,
      acceptedTurn: 3,
      path: 'revive-queue',
      message: 'when you are back',
      held: true,
      fate: 'accepted',
    });
    return built;
  }

  it('waits for the park to clear, then types the held message once — never into the parked composer', async () => {
    const pauses: number[] = [];
    const built = await heldRecord(
      [parked({ draft: 'resume turn' }), parked(), parked(), pane({ promptReady: true })],
      async ms => void pauses.push(ms),
    );

    should(await built.service.releaseHeld(ID)).equal(1);

    should(pauses).eql([2_000, 2_000, 2_000]);
    should(built.terminal.typed).eql(['when you are back']);
    should(held(built)).match({ held: false, fate: 'accepted' });
  });

  it('gives up at the bound with the sends still held, nothing typed, and the deferral journalled', async () => {
    let pauses = 0;
    const built = await heldRecord([parked()], async () => {
      pauses += 1;
    });

    should(await built.service.releaseHeld(ID)).equal(0);

    should(pauses).equal(300);
    should(built.terminal.typed).be.empty();
    should(held(built)).match({ held: true, fate: 'accepted' });
    should(built.repository.journal_.at(-1)).match({ event: 'control.send_release_deferred', data: { held: 1 } });
  });

  it('looks once and leaves the sends held when nothing can wait', async () => {
    const built = await heldRecord([parked()]);

    should(await built.service.releaseHeld(ID)).equal(0);

    should(built.terminal.typed).be.empty();
    should(held(built).held).be.true();
  });

  it('leaves a send held when the park returns between the wait and the lock', async () => {
    const built = await heldRecord([pane({ promptReady: true }), parked()], async () => undefined);

    should(await built.service.releaseHeld(ID)).equal(0);

    should(built.terminal.typed).be.empty();
    should(held(built).held).be.true();
    should(built.repository.journal_.at(-1)).match({ event: 'control.send_release_deferred', data: { held: 1 } });
  });

  it('withholds a re-attempt as busy at a parked pane, quoting no draft and typing nothing', async () => {
    const built = parts(target(), [pane({ promptReady: true })]);
    await built.service.send(request());
    built.ledger.records.set('send-1', { ...built.ledger.only(), fate: 'queued', attempt: 1 });
    built.terminal.typed.length = 0;
    built.terminal.frozen = parked({ draft: 'ship it' });
    built.terminal.held.set('ship it', 'composer');

    const withheld = await built.service.reattempt(ID, 'send-1', { by: 'daemon' }).catch((error: unknown) => error);

    should(withheld).be.instanceof(SendRetypeWithheld);
    should((withheld as SendRetypeWithheld).reason).equal('busy');
    should((withheld as Error).message).not.match(/composer|draft/u);
    should(built.terminal.typed).be.empty();
    should(built.ledger.only()).match({ fate: 'queued', attempt: 1 });
  });

  it('presses no Enter for a person asking to submit a send at a parked pane', async () => {
    const built = parts(target(), [pane({ promptReady: true })]);
    await built.service.send(request());
    built.ledger.records.set('send-1', { ...built.ledger.only(), fate: 'accepted', typedNotSent: true });
    built.terminal.frozen = parked();

    const refused = await built.service.submit(ID, 'send-1').catch((error: unknown) => error);

    should(refused).be.instanceof(SendPending);
    should(built.terminal.calls).not.containEql('submitComposer');
  });
});

describe('a pointer of ours left typed in the composer — the owner’s stuck turn', () => {
  /** The pointer an earlier send typed for turn 4, whose Enter the harness never took. */
  const POINTER = turnFileInstruction('/state/turns/turn-004.md');

  function stranded(overrides: Partial<SendRecord> = {}): SendRecord {
    return {
      sendId: 'send-0',
      acceptedAt: at('2026-08-01T11:00:00.000Z'),
      acceptedTurn: 3,
      path: 'turn-file',
      message: 'the long message from before',
      matchText: POINTER,
      turn: 4,
      fate: 'unaccounted',
      unaccountedReason: 'timeout',
      typedNotSent: true,
      attempt: 1,
      attemptAt: at('2026-08-01T11:00:00.000Z'),
      senderKind: 'human',
      ...overrides,
    };
  }

  function stuck(frames: SendPaneObservation[], record: SendRecord = stranded()): Parts {
    const built = parts(target({ status: 'awaiting_user' }), frames);
    built.ledger.records.set(record.sendId, record);
    return built;
  }

  it('finishes it, starts the turn it carried, and sends the new message behind it', async () => {
    const built = stuck([
      pane({
        promptReady: false,
        draft: `Read the file /state/turns/\n  turn-004.md${POINTER.slice(POINTER.indexOf('.md') + 3)}`,
      }),
      pane({ activeWork: true }),
    ]);

    const outcome = await built.service.send(request({ message: 'and one more thing' }));

    should(built.terminal.calls).eql(['observe', 'submitComposer', 'observe', 'observe', 'queue']);
    should(built.terminal.typed).eql(['and one more thing']);
    should(outcome.disposition).equal('queued');
    should(built.ledger.records.get('send-0')).match({ fate: 'accepted', attemptAt: NOW, typedNotSent: undefined });
    should(built.ledger.records.get('send-0')?.unaccountedReason).be.undefined();
    should(built.repository.journal_.find(entry => entry.event === 'control.send_resubmitted')?.data).eql({
      sendId: 'send-0',
      outcome: 'submitted',
      by: 'send',
      reason: 'pointer typed but not submitted',
    });
    // The turn the pointer carried starts now, so the new send does not claim turn 4 a second time.
    should(built.repository.transitions).match([{ event: 'turn.started', turn: 4 }]);
    should(built.channel.inbound[0]).match({ message: 'the long message from before', turn: 4 });
    should(built.turns.calls).eql(['clearMarkers']);
    should(built.ledger.records.get('send-1')).match({ path: 'native-inline' });
    should(built.tracked).containEql(ID);
  });

  it('delivers the new message as the next turn when the pane comes straight back to a prompt', async () => {
    const built = stuck([pane({ draft: POINTER }), pane({ promptReady: true })], stranded({ fate: 'accepted' }));

    await built.service.send(request());

    should(built.terminal.typed).eql(['ship it']);
    should(built.repository.transitions.map(change => change.turn)).eql([4, 5]);
  });

  it('starts no turn of its own for a queued pointer, or one the session has already moved past', async () => {
    const queuedPointer = queuedMessageInstruction('/state/channel/queued-send-0.md');
    const queued = stuck(
      [pane({ draft: queuedPointer }), pane({ activeWork: true })],
      stranded({ path: 'native-file', matchText: queuedPointer, turn: undefined, fate: 'accepted' }),
    );
    const past = parts(target({ status: 'awaiting_user', turn: 6 }), [
      pane({ draft: POINTER }),
      pane({ activeWork: true }),
    ]);
    past.ledger.records.set('send-0', stranded());

    await queued.service.send(request());
    await past.service.send(request());

    should(queued.repository.transitions.map(change => change.turn)).eql([4]);
    should(queued.channel.inbound.map(entry => entry.message)).eql(['ship it']);
    should(past.repository.transitions.map(change => change.turn)).eql([7]);
    should(queued.ledger.records.get('send-0')?.fate).equal('accepted');
  });

  it('refuses as before, pressing nothing, when the draft is a person’s or an edited pointer', async () => {
    for (const draft of ['hi there', `${POINTER} also fix the tests`]) {
      const built = stuck([pane({ draft })]);

      const refused = await built.service.send(request()).catch((error: unknown) => error);

      should(refused).be.instanceof(SendDraftRefused);
      should((refused as SendDraftRefused).draft).equal(draft);
      should(built.terminal.calls).not.containEql('submitComposer');
      should(built.ledger.records.has('send-1')).be.false();
    }
  });

  it('refuses, pressing nothing, at a pane mid-turn or behind a dialog, where Enter means something else', async () => {
    const busy = stuck([pane({ draft: POINTER, activeWork: true })]);
    const dialog = stuck([pane({ draft: POINTER, blockingPrompt: 'Trust this folder?' })]);

    should(await busy.service.send(request()).catch((error: unknown) => error)).be.instanceof(SendDraftRefused);
    should(await dialog.service.send(request()).catch((error: unknown) => error)).be.instanceof(SendDraftRefused);
    should([...busy.terminal.calls, ...dialog.terminal.calls]).not.containEql('submitComposer');
  });

  it('refuses when the Enter does not take, leaving the earlier send as it was', async () => {
    const built = stuck([pane({ draft: POINTER })]);
    built.terminal.submitOutcome = 'holding';

    const refused = await built.service.send(request()).catch((error: unknown) => error);

    should(refused).be.instanceof(SendDraftRefused);
    should(built.ledger.records.get('send-0')).match({ fate: 'unaccounted', typedNotSent: true });
    should(built.repository.journal_.at(-1)).match({ event: 'control.send_resubmitted', data: { outcome: 'holding' } });
    should(built.repository.transitions).be.empty();
  });

  it('finishes another send’s pointer before a retry, but never the retried send’s own', async () => {
    const other = stuck([pane({ draft: POINTER }), pane({ promptReady: true })]);
    other.ledger.records.set('send-1', {
      ...stranded({ sendId: 'send-1', fate: 'timed_out', retryable: true }),
      path: 'direct',
      matchText: 'ship it',
      message: 'ship it',
    });
    const own = stuck([pane({ draft: POINTER })], stranded({ fate: 'accepted' }));

    await other.service.reattempt(ID, 'send-1', { by: 'person' });
    const refused = await own.service.reattempt(ID, 'send-0', { by: 'daemon' }).catch((error: unknown) => error);

    should(other.terminal.calls.filter(call => call === 'submitComposer')).have.length(1);
    should(other.terminal.typed).eql(['ship it']);
    should(refused).be.instanceof(SendDraftRefused);
    should(own.terminal.calls).not.containEql('submitComposer');
  });

  it('refuses a retry, typing nothing, when finishing another send’s pointer shows the agent has gone', async () => {
    const built = stuck([pane({ draft: POINTER }), pane({ alive: false })]);
    built.ledger.records.set('send-1', {
      ...stranded({ sendId: 'send-1', fate: 'timed_out', retryable: true }),
      path: 'direct',
      matchText: 'ship it',
      message: 'ship it',
    });

    const refused = await built.service.reattempt(ID, 'send-1', { by: 'person' }).catch((error: unknown) => error);

    should(refused).be.instanceof(SendRefused);
    should((refused as Error).message).match(/session .* has no live agent to retype send-1 into; revive it first/);
    should(built.terminal.calls.filter(call => call === 'submitComposer')).have.length(1);
    should(built.terminal.typed).be.empty();
  });
});

describe('the tracker nudging a pointer of ours with one more Enter', () => {
  const POINTER = turnFileInstruction('/state/turns/turn-004.md');

  function typed(overrides: Partial<SendRecord> = {}, frames: SendPaneObservation[] = [pane({ draft: POINTER })]) {
    const built = parts(target({ status: 'awaiting_user' }), frames);
    built.ledger.records.set('send-0', {
      sendId: 'send-0',
      acceptedAt: at('2026-08-01T11:59:50.000Z'),
      acceptedTurn: 3,
      path: 'turn-file',
      message: 'the long message',
      matchText: POINTER,
      turn: 4,
      fate: 'accepted',
      attempt: 1,
      attemptAt: at('2026-08-01T11:59:50.000Z'),
      ...overrides,
    });
    return built;
  }

  it('counts the nudge before the key, presses once, and starts the turn when it takes', async () => {
    const built = typed();

    const record = await built.service.resubmit(ID, 'send-0');

    should(record).match({ submitNudges: 1, attemptAt: NOW, fate: 'accepted' });
    should(built.terminal.calls).eql(['observe', 'submitComposer']);
    should(built.repository.journal_.at(0)).match({ event: 'control.send_resubmitted', data: { by: 'daemon' } });
    should(built.repository.transitions).match([{ turn: 4 }]);
    should(built.tracked).eql([ID]);
  });

  it('keeps counting when the Enter does not take, and starts nothing', async () => {
    const built = typed({ submitNudges: 1 });
    built.terminal.submitOutcome = 'holding';

    should(await built.service.resubmit(ID, 'send-0')).match({
      submitNudges: 2,
      attemptAt: at('2026-08-01T11:59:50.000Z'),
    });
    should(built.repository.transitions).be.empty();
  });

  it('presses nothing for a send that is not a stranded pointer, or a pane that does not show it idle', async () => {
    const cases = [
      typed({ fate: 'delivered' }),
      typed({ path: 'direct', matchText: 'ship it' }),
      typed({}, [pane({ draft: 'a person’s words' })]),
      typed({}, [pane({})]),
      typed({}, [pane({ draft: POINTER, activeWork: true })]),
      typed({}, [pane({ alive: false, draft: POINTER })]),
    ];

    for (const built of cases) {
      const before = built.ledger.records.get('send-0');
      should(await built.service.resubmit(ID, 'send-0')).equal(before);
      should(built.terminal.calls).not.containEql('submitComposer');
    }
    should(await typed().service.resubmit(ID, 'send-9')).be.undefined();
  });
});

describe('a person’s own draft in the composer', () => {
  it('presses Enter on exactly that draft, however the TUI wrapped it, and journals no text', async () => {
    const built = parts(target(), [pane({ draft: 'fix the\n  login bug' })]);

    should(await built.service.resolveDraft(ID, 'submit', 'fix the login bug')).equal('submitted');
    should(built.terminal.calls).eql(['observe', 'submitComposer']);
    should(built.repository.journal_).eql([{ event: 'control.composer_submitted', data: { outcome: 'submitted' } }]);
    should(built.tracked).eql([ID]);
  });

  it('erases exactly that draft, and says when the erase stopped', async () => {
    const cleared = parts(target(), [pane({ draft: 'fix the login bug' })]);
    const stalled = parts(target(), [pane({ draft: 'fix the login bug' })]);
    stalled.terminal.clearOutcome = 'stuck';

    should(await cleared.service.resolveDraft(ID, 'clear', 'fix the login bug')).equal('cleared');
    should(await stalled.service.resolveDraft(ID, 'clear', 'fix the login bug')).equal('stuck');
    should(cleared.repository.journal_).eql([{ event: 'control.composer_cleared', data: { outcome: 'cleared' } }]);
    should(cleared.tracked).be.empty();
  });

  it('touches nothing once the draft has changed or gone, and says which', async () => {
    const changed = parts(target(), [pane({ draft: 'fix the login bug please' })]);
    const empty = parts(target(), [pane({})]);
    const foreign = parts(target(), [pane({ draft: 'fix the login bug' })]);
    foreign.terminal.clearOutcome = 'foreign';
    const vanished = parts(target(), [pane({ draft: 'fix the login bug' })]);
    vanished.terminal.submitOutcome = 'absent';

    should(await changed.service.resolveDraft(ID, 'submit', 'fix the login bug')).equal('changed');
    should(await empty.service.resolveDraft(ID, 'clear', 'fix the login bug')).equal('absent');
    should(await foreign.service.resolveDraft(ID, 'clear', 'fix the login bug')).equal('changed');
    should(await vanished.service.resolveDraft(ID, 'submit', 'fix the login bug')).equal('changed');
    should([...changed.terminal.calls, ...empty.terminal.calls]).eql(['observe', 'observe']);
  });

  it('refuses a session that cannot take keys: gone, behind a dialog, or not its agent’s', async () => {
    const gone = parts(target(), [pane({ alive: false, draft: 'x' })]);
    const dialog = parts(target(), [pane({ draft: 'x', blockingPrompt: 'Allow this tool?' })]);
    const killed = parts(target({ status: 'kill_failed' }), [pane({ draft: 'x' })]);

    should(
      ((await gone.service.resolveDraft(ID, 'submit', 'x').catch((error: unknown) => error)) as Error).message,
    ).match(/is gone/u);
    should(
      ((await dialog.service.resolveDraft(ID, 'clear', 'x').catch((error: unknown) => error)) as Error).message,
    ).match(/answer it first/u);
    should(await killed.service.resolveDraft(ID, 'submit', 'x').catch((error: unknown) => error)).be.instanceof(
      SendRefused,
    );
  });
});

/**
 * A retry is checked against the pane UNDER THE SEND LOCK, whoever asks — the daemon's tracker
 * included. Its earlier look was not holding the lock, and a queue it did not recognise is how one
 * message became four copies in Claude Code's queue.
 */
describe('a retry while the pane may still be holding the send', () => {
  /** A send whose first copy was typed into a mid-turn pane, and rode the harness's queue. */
  async function typedMidTurn(fate: SendRecord['fate'] = 'accepted', extra: Partial<SendRecord> = {}) {
    const built = parts(target(), [pane({ activeWork: true })]);
    await built.service.send(request());
    built.ledger.records.set('send-1', { ...built.ledger.only(), fate, attempt: 1, ...extra });
    built.terminal.typed.length = 0;
    return built;
  }
  const textOf = (record: SendRecord): string => record.matchText ?? record.message;

  it('proves the daemon’s retry queued, typing nothing, when the pane shows the send held', async () => {
    const { service, ledger, terminal, repository } = await typedMidTurn();
    terminal.held.set(textOf(ledger.only()), 'queue');

    const record = await service.reattempt(ID, 'send-1', { by: 'daemon' });

    should(record).match({ fate: 'queued', queueProof: 'pane', attempt: 1 });
    should(terminal.typed).be.empty();
    should(repository.journal_.at(-1)).match({ event: 'control.send_queued', data: { proof: 'pane' } });
  });

  it('withholds the daemon’s retry of one typed in the composer, or one it cannot check, typing nothing', async () => {
    const composer = await typedMidTurn();
    composer.terminal.held.set(textOf(composer.ledger.only()), 'composer');
    const blind = await typedMidTurn();
    blind.terminal.heldFailure = new Error('the queue runs past the top of the pane');

    const typed = await composer.service.reattempt(ID, 'send-1', { by: 'daemon' }).catch((e: unknown) => e);
    const unreadable = await blind.service.reattempt(ID, 'send-1', { by: 'daemon' }).catch((e: unknown) => e);

    should(typed).be.instanceof(SendRetypeWithheld);
    should((typed as SendRetypeWithheld).reason).equal('held');
    should(unreadable).be.instanceof(SendRetypeWithheld);
    should((unreadable as SendRetypeWithheld).reason).equal('unreadable');
    should([...composer.terminal.typed, ...blind.terminal.typed]).be.empty();
    should(composer.ledger.only()).match({ fate: 'accepted', attempt: 1 });
  });

  it('never types a send into a mid-turn pane twice unless a person forces it', async () => {
    const daemon = await typedMidTurn();
    const person = await typedMidTurn('timed_out', { retryable: true, unaccountedReason: 'not_delivered' });

    const refusedDaemon = await daemon.service.reattempt(ID, 'send-1', { by: 'daemon' }).catch((e: unknown) => e);
    const refusedPerson = await person.service.reattempt(ID, 'send-1', { by: 'person' }).catch((e: unknown) => e);
    const forced = await person.service.reattempt(ID, 'send-1', { by: 'person', force: true });

    should(refusedDaemon).be.instanceof(SendRetypeWithheld);
    should((refusedDaemon as SendRetypeWithheld).reason).equal('busy');
    should(daemon.terminal.typed).be.empty();
    should(daemon.ledger.only()).match({ fate: 'accepted', attempt: 1 });
    should((refusedPerson as Error).message).match(/already typed into this agent mid-turn.*send it again anyway/u);
    should(forced).match({ fate: 'queued', attempt: 2, busyTyped: true });
    should(person.terminal.typed).have.length(1);
  });

  it('marks a retry typed behind a running turn, so the next one waits for the turn to end', async () => {
    // Its first copy went into an idle prompt: one copy behind the turn is allowed, a second is not.
    const { service, ledger, terminal } = parts(target(), [pane({ promptReady: true }), pane({ activeWork: true })]);
    await service.send(request());
    ledger.records.set('send-1', { ...ledger.only(), fate: 'accepted', attempt: 1 });
    terminal.typed.length = 0;

    const first = await service.reattempt(ID, 'send-1', { by: 'daemon' });
    ledger.records.set('send-1', { ...ledger.only(), fate: 'accepted' });
    const second = await service.reattempt(ID, 'send-1', { by: 'daemon' }).catch((e: unknown) => e);

    should(first).match({ attempt: 2, busyTyped: true });
    should((second as SendRetypeWithheld).reason).equal('busy');
    should(terminal.typed).eql(['ship it']);
  });

  it('refuses a person’s unforced retry it cannot check against the pane, and says how to send anyway', async () => {
    const { service, terminal, ledger } = parts();
    await service.send(request());
    terminal.heldFailure = new Error('no pane');
    ledger.records.set('send-1', { ...ledger.only(), fate: 'timed_out', retryable: true, attempt: 1 });
    terminal.typed.length = 0;

    const refused = await service.reattempt(ID, 'send-1', { by: 'person' }).catch((e: unknown) => e);

    should((refused as SendRetypeWithheld).reason).equal('unreadable');
    should((refused as Error).message).match(/could not be read.*send it again anyway/u);
    should(terminal.typed).be.empty();
  });
});

describe('the refusals a queue asks before it accepts a message', () => {
  it('should refuse an open structured question, and pass a session that can take input', async () => {
    const asking = parts(target({ pendingQuestion: { toolUseId: 'tool-1' } }));
    const ready = parts(target());

    const refused = await asking.service.authorize(ID, []).catch((error: unknown) => error);
    await ready.service.authorize(ID, []);

    should(refused).be.instanceof(SendUnavailable);
    should(asking.terminal.typed).be.empty();
  });
});

describe('B144: a ferret idle with text of ours unsubmitted in its box', () => {
  const POINTER = turnFileInstruction('/state/turns/turn-005.md');
  const ENVELOPE =
    '[message from ferret lizzette (session mvgt2oz9-04e28935) — not from the owner]\nTo reply: fy send lizzette "<reply>"\n\nre-verify: CHANGES, one small fix.';

  function unconfirmed(overrides: Partial<SendRecord> = {}): SendRecord {
    return {
      sendId: 'send-0',
      acceptedAt: at('2026-08-01T11:59:00.000Z'),
      acceptedTurn: 4,
      path: 'turn-file',
      message: 'the long message',
      matchText: POINTER,
      turn: 5,
      fate: 'unaccounted',
      unaccountedReason: 'landing_unconfirmed',
      attempt: 1,
      attemptAt: at('2026-08-01T11:59:00.000Z'),
      senderKind: 'agent',
      ...overrides,
    };
  }

  function idle(frames: SendPaneObservation[], ...records: SendRecord[]): Parts {
    const built = parts(target({ status: 'running', turn: 4 }), frames);
    for (const record of records) built.ledger.records.set(record.sendId, record);
    return built;
  }

  it('reserves the turn a revive carries past one an unconfirmed pointer names, so the relaunch agrees (review)', async () => {
    const built = idle([pane({ alive: false })], unconfirmed());
    built.repository.transitions.length = 0;

    await built.service.send(request()).catch(() => undefined);

    should(built.ledger.records.get('send-1')).match({ path: 'revive', turn: 6 });
    should(built.repository.transitions).match([{ event: 'control.turn_reserved', turn: 5, keepReason: true }]);
  });

  it('reserves nothing again for a replayed revive request, answering from its first record (review)', async () => {
    const built = idle([pane({ alive: false })], unconfirmed());
    await built.service.send(request()).catch(() => undefined);
    const reservations = built.repository.transitions.filter(change => change.event === 'control.turn_reserved');

    await built.service.send(request()).catch(() => undefined);

    should(built.repository.transitions.filter(change => change.event === 'control.turn_reserved')).eql(reservations);
    should(built.ledger.records.get('send-1')).match({ turn: 6 });
  });

  it('starts the turn an unconfirmed typing reserved, once an Enter takes its pointer', async () => {
    const built = idle([pane({ draft: POINTER })], unconfirmed());
    await built.repository.transition(ID, { event: 'control.turn_reserved', turn: 5, keepReason: true });

    await built.service.finishOwnDraft(ID);

    should(built.repository.transitions.at(-1)).match({ event: 'turn.started', turn: 5 });
  });

  for (const reason of ['landing_unconfirmed', 'typed_not_submitted'] as const) {
    it(`B187 starts the reserved turn when an Enter takes a send unconfirmed as ${reason}, the session already on that turn`, async () => {
      // `reserved` only matters when the session's counter already equals the send's turn (target.turn === turn).
      const built = parts(target({ status: 'running', turn: 5 }), [pane({ draft: POINTER })]);
      built.ledger.records.set('send-0', unconfirmed({ unaccountedReason: reason, typedNotSent: true }));

      await built.service.finishOwnDraft(ID);

      should(built.repository.transitions.at(-1)).match({ event: 'turn.started', turn: 5 });
    });
  }

  it('presses nothing when another unsettled send could equally be what the box holds (review)', async () => {
    const paste = (sendId: string, message: string) =>
      unconfirmed({ sendId, path: 'native-inline', message, matchText: message, turn: undefined });
    const built = idle(
      [pane({ draft: '[Pasted text #3 +2 lines]' })],
      paste('a', 'first message\nlong enough to claim'),
      paste('b', 'second message\nlong enough to claim'),
    );

    should(await built.service.resubmit(ID, 'a')).match({ sendId: 'a' });
    should(await built.service.resubmitStuck(ID, 'a')).equal('refused');
    should(built.terminal.calls).not.containEql('submitComposer');
  });

  it("answers absent to the Warden when an idle pane's box is empty", async () => {
    const built = idle([pane({})], unconfirmed());
    should(await built.service.resubmitStuck(ID, 'send-0')).equal('absent');
  });

  it('never gives a new turn file the number an unconfirmed pointer still names', async () => {
    // annabeth's turn 63: the unconfirmed pointer never started its turn, and the next send overwrote its file.
    const built = idle([pane({ promptReady: true })], unconfirmed());

    await built.service.send(request());

    should(built.ledger.records.get('send-1')).match({ turn: 6 });
    should(built.repository.transitions).match([{ event: 'turn.started', turn: 6 }]);
  });

  it('numbers past the session and every claimed turn, ignoring a withdrawn send that typed nothing', () => {
    should(nextTurnNumber({ turn: 4 }, [])).equal(5);
    should(nextTurnNumber({ turn: 4 }, [unconfirmed({ turn: 7 })])).equal(8);
    should(nextTurnNumber({ turn: 4 }, [unconfirmed({ turn: 7, fate: 'withdrawn' })])).equal(5);
    should(nextTurnNumber({ turn: 9 }, [unconfirmed({ turn: 7 })])).equal(10);
  });

  it('lets the queue finish an unconfirmed pointer of ours, re-opening it and starting its turn', async () => {
    const built = idle([pane({ draft: POINTER })], unconfirmed());

    should(await built.service.finishOwnDraft(ID)).eql({ kind: 'clear' });

    should(built.terminal.calls).eql(['observe', 'submitComposer']);
    should(built.ledger.records.get('send-0')).match({ fate: 'accepted', submitNudges: 1, attemptAt: NOW });
    should(built.repository.journal_.at(0)).match({
      event: 'control.send_resubmitted',
      data: { by: 'queue', reason: 'pointer typed but not submitted' },
    });
    should(built.repository.transitions).match([{ event: 'turn.started', turn: 5 }]);
    should(built.tracked).eql([ID]);
  });

  it('finishes a long message typed as itself, drawn as a lone paste placeholder', async () => {
    const built = idle(
      [pane({ draft: '[Pasted text #40 +3 lines]' })],
      unconfirmed({ path: 'native-inline', message: ENVELOPE, matchText: ENVELOPE, turn: undefined, fate: 'accepted' }),
    );

    should(await built.service.finishOwnDraft(ID)).eql({ kind: 'clear' });
    should(built.repository.journal_.at(0)).match({ data: { reason: 'typed but not submitted' } });
  });

  it("says a person's draft is theirs, and presses nothing", async () => {
    const built = idle([pane({ draft: 'half a question' })], unconfirmed());

    should(await built.service.finishOwnDraft(ID)).eql({ kind: 'foreign' });
    should(built.terminal.calls).not.containEql('submitComposer');
    should(built.tracked).be.empty();
  });

  it('names the send that will not leave, and stops pressing at the limit', async () => {
    const holding = idle([pane({ draft: POINTER })], unconfirmed());
    holding.terminal.submitOutcome = 'holding';
    const spent = idle([pane({ draft: POINTER })], unconfirmed({ submitNudges: STRANDED_ENTER_LIMIT }));

    should(await holding.service.finishOwnDraft(ID)).eql({ kind: 'stuck', sendId: 'send-0', tried: true });
    should(await spent.service.finishOwnDraft(ID)).eql({ kind: 'stuck', sendId: 'send-0', tried: false });
    should(spent.terminal.calls).not.containEql('submitComposer');
  });

  it('presses nothing while the agent works or a dialog is up — its own queue takes it at the turn end', async () => {
    for (const frame of [
      pane({ draft: POINTER, activeWork: true }),
      pane({ draft: POINTER, blockingPrompt: 'Do you trust this folder?' }),
    ]) {
      const built = idle([frame], unconfirmed());
      should(await built.service.finishOwnDraft(ID)).eql({ kind: 'stuck', sendId: 'send-0', tried: false });
      should(built.terminal.calls).not.containEql('submitComposer');
    }
  });

  it("gives the Warden one press past the daemon's own limit, and no more", async () => {
    const once = idle([pane({ draft: POINTER })], unconfirmed({ submitNudges: STRANDED_ENTER_LIMIT }));
    const twice = idle([pane({ draft: POINTER })], unconfirmed({ submitNudges: STRANDED_ENTER_LIMIT + 1 }));

    should(await once.service.resubmitStuck(ID, 'send-0')).equal('submitted');
    should(once.repository.journal_.at(0)).match({ data: { by: 'warden' } });
    should(await twice.service.resubmitStuck(ID, 'send-0')).equal('refused');
    should(await once.service.resubmitStuck(ID, 'send-9')).equal('refused');
  });

  it('finishes a stranded message typed as itself before a new send, as it does a pointer', async () => {
    const built = idle(
      [pane({ draft: ENVELOPE }), pane({ promptReady: true })],
      unconfirmed({ path: 'direct', message: ENVELOPE, matchText: ENVELOPE, turn: 5 }),
    );

    await built.service.send(request());

    should(built.terminal.calls.filter(call => call === 'submitComposer')).have.length(1);
    should(built.terminal.typed).eql(['ship it']);
    should(built.repository.transitions.map(change => change.turn)).eql([5, 6]);
  });

  describe('a submission Codex parked until its startup ends (B170)', () => {
    // What the real terminal reports for the codex-0.166.0-startup-queued-message pane: the text is drawn in
    // the composer, but it is the harness's, not a draft — `draftBlockingReadiness` answers undefined for it.
    const parked = (overrides: Partial<SendPaneObservation> = {}) => pane({ startupParked: true, ...overrides });

    it('presses no Enter into it for the queue, the Warden or a tracker nudge — it is not a draft', async () => {
      const built = idle([parked()], unconfirmed());

      should(await built.service.finishOwnDraft(ID)).eql({ kind: 'clear' });
      should(await built.service.resubmitStuck(ID, 'send-0')).equal('refused');
      should(await built.service.resubmit(ID, 'send-0')).not.have.property('submitNudges');
      should(built.terminal.calls).not.containEql('submitComposer');
      should(built.terminal.calls).not.containEql('clearComposer');
    });

    it('is never finishable even when its text is read as a stranded pointer of ours', async () => {
      // Defence in depth: whatever put the pointer in `draft`, a parked pane is not a pane Enter may key.
      const built = idle([parked({ draft: POINTER })], unconfirmed());

      should(await built.service.finishOwnDraft(ID)).eql({ kind: 'stuck', sendId: 'send-0', tried: false });
      should(await built.service.resubmitStuck(ID, 'send-0')).equal('refused');
      should(built.terminal.calls).not.containEql('submitComposer');
    });

    it('makes a send that arrives meanwhile pending, not refused, and types and records nothing', async () => {
      for (const status of ['running', 'awaiting_user'] as const) {
        const built = parts(target({ status }), [parked()]);

        const refusal = await built.service.send(request()).catch((error: unknown) => error);

        should(refusal).be.instanceof(SendPending);
        should(built.terminal.typed).be.empty();
        should(built.terminal.calls).not.containEql('submitComposer');
        should(built.ledger.records.has('send-1')).be.false();
      }
    });

    it('refuses the main path as pending at a parked pane holding the harness’s own text, typing nothing', async () => {
      const built = parts(target(), [parked({ draft: 'resume' })]);

      const refusal = await built.service.send(request()).catch((error: unknown) => error);

      should(refusal).be.instanceof(SendPending);
      should(built.terminal.typed).be.empty();
      should(built.terminal.calls).not.containEql('stopActiveTurn');
      should(built.ledger.records.size).equal(0);
    });

    it('refuses `now` as pending when the stop leaves the pane parked, typing nothing', async () => {
      const built = parts(target({ status: 'thinking' }), [pane({ activeWork: true }), parked()]);

      const refusal = await built.service.send(request({ now: true })).catch((error: unknown) => error);

      should(refusal).be.instanceof(SendPending);
      should(built.terminal.calls).containEql('stopActiveTurn');
      should(built.terminal.typed).be.empty();
      should(built.ledger.records.size).equal(0);
    });

    it('sends normally once startup has ended and the pane is an ordinary idle prompt', async () => {
      const built = parts(target(), [parked(), pane({ promptReady: true })]);
      should(await built.service.send(request()).catch((error: unknown) => error)).be.instanceof(SendPending);

      const again = await built.service.send(request());

      should(again.record.sendId).equal('send-1');
      should(built.terminal.typed).have.length(1);
    });
  });

  describe('&B153: a delivered pointer the harness took back', () => {
    const delivered = (overrides: Partial<SendRecord> = {}): SendRecord =>
      unconfirmed({
        fate: 'delivered',
        unaccountedReason: undefined,
        fateAt: at('2026-08-01T11:59:03.000Z'),
        evidence: {
          key: 'aeeeefa4-973d-452a-aff6-c7cde97456e8',
          harness: 'claude',
          kind: 'chat.user',
          proof: 'normal-user-record',
          observedAt: at('2026-08-01T11:59:01.000Z'),
          shapeVersion: 1,
          matchedTurn: 5,
          tier: 'turn-instruction',
        },
        ...overrides,
      });
    /** The transcript's answer, recorded: `true` is "its user record was never answered". */
    class FakeRetraction implements SendRetractionProof {
      readonly asked: string[] = [];
      constructor(private readonly unansweredAnswer: boolean | Error) {}
      async unanswered(_id: SessionId, record: SendRecord): Promise<boolean> {
        this.asked.push(record.sendId);
        if (this.unansweredAnswer instanceof Error) throw this.unansweredAnswer;
        return this.unansweredAnswer;
      }
    }
    function taken(
      frames: SendPaneObservation[],
      proof: SendRetractionProof | undefined,
      ...records: SendRecord[]
    ): Parts {
      const built = parts(target({ status: 'running', turn: 5 }), frames, {}, undefined, proof);
      for (const record of records) built.ledger.records.set(record.sendId, record);
      return built;
    }

    it('tells the Warden which delivered pointer an idle box holds once the transcript proves it unanswered', async () => {
      const proof = new FakeRetraction(true);
      const built = taken([pane({ draft: POINTER })], proof, delivered());

      should(await built.service.retractedDraft(ID)).equal('send-0');
      should(proof.asked).eql(['send-0']);
      should(built.terminal.calls).not.containEql('submitComposer');
    });

    it('never claims a delivered pointer the transcript shows answered: a person recalled it (review blocker)', async () => {
      for (const proof of [new FakeRetraction(false), new FakeRetraction(new Error('unreadable')), undefined]) {
        const built = taken([pane({ draft: POINTER })], proof, delivered());

        should(await built.service.retractedDraft(ID)).be.undefined();
        should(await built.service.resubmitStuck(ID, 'send-0')).equal('refused');
        should(await built.service.finishOwnDraft(ID)).eql({ kind: 'foreign' });
        should(built.terminal.calls).not.containEql('submitComposer');
      }
    });

    it('refuses a new send behind a recalled pointer as a person’s draft, pressing nothing', async () => {
      const built = taken([pane({ draft: POINTER })], new FakeRetraction(false), delivered());

      const refusal = await built.service.send(request()).catch((error: unknown) => error);

      should(refusal).be.instanceof(SendRefused);
      should(built.terminal.calls).not.containEql('submitComposer');
      should(built.terminal.typed).be.empty();
    });

    it('tells the Warden nothing for a busy or dialogued pane, a person’s draft, or a pointer something followed', async () => {
      const later = unconfirmed({
        sendId: 'send-1',
        path: 'direct',
        acceptedAt: at('2026-08-01T12:00:00.000Z'),
        attemptAt: at('2026-08-01T12:00:00.000Z'),
        message: 'a later message typed as itself',
        matchText: 'a later message typed as itself',
        fate: 'delivered',
      });
      const proof = new FakeRetraction(true);
      const cases = [
        taken([pane({ draft: POINTER, activeWork: true })], proof, delivered()),
        taken([pane({ draft: POINTER, blockingPrompt: 'Do you want to proceed?' })], proof, delivered()),
        taken([pane({ draft: 'my own half-written words' })], proof, delivered()),
        taken([pane({ draft: POINTER })], proof, delivered(), later),
        taken([pane({})], proof, delivered()),
      ];

      for (const built of cases) should(await built.service.retractedDraft(ID)).be.undefined();
    });

    it('lets the Warden press a proven one once, re-opening it on its old evidence and starting no second turn', async () => {
      const built = taken([pane({ draft: POINTER })], new FakeRetraction(true), delivered());

      should(await built.service.resubmitStuck(ID, 'send-0')).equal('submitted');

      should(built.terminal.calls.filter(call => call === 'submitComposer')).have.length(1);
      // Open again, so only the user record this Enter writes can settle it; the rewound one stays claimed.
      should(built.ledger.records.get('send-0')).match({
        fate: 'accepted',
        submitNudges: 1,
        attemptAt: NOW,
        evidence: { key: 'aeeeefa4-973d-452a-aff6-c7cde97456e8' },
      });
      should(built.ledger.records.get('send-0')?.fateAt).be.undefined();
      should(built.repository.journal_.at(0)).match({
        event: 'control.send_resubmitted',
        data: { by: 'warden', reason: 'pointer taken back into the composer by the harness' },
      });
      should(built.repository.transitions).be.empty();
      should(built.tracked).eql([ID]);
      // Open, it is no longer a delivered pointer: a person's later recall of it cannot qualify on the old record.
      should(await built.service.retractedDraft(ID)).be.undefined();
    });

    it('lets the queue finish a proven one rather than wait behind it as a draft', async () => {
      const built = taken([pane({ draft: POINTER })], new FakeRetraction(true), delivered());

      should(await built.service.finishOwnDraft(ID)).eql({ kind: 'clear' });
      should(built.ledger.records.get('send-0')).match({ fate: 'accepted', submitNudges: 1 });
    });

    it('presses nothing past the limit, so a harness that keeps taking it back is escalated', async () => {
      const built = taken(
        [pane({ draft: POINTER })],
        new FakeRetraction(true),
        delivered({ submitNudges: STRANDED_ENTER_LIMIT + 1 }),
      );

      should(await built.service.resubmitStuck(ID, 'send-0')).equal('refused');
      should(built.terminal.calls).not.containEql('submitComposer');
    });

    it('repairs a send ONCE: taken back again, it is flagged and escalated but never pressed (review round 3)', async () => {
      // Repair 1 re-opened it and the tracker settled it on its NEW user record; that one was taken back too.
      const again = delivered({
        submitNudges: 1,
        evidence: { ...delivered().evidence!, key: 'e7d3ded4-47ac-4b92-ac07-c5ebc422f393' },
      });
      const built = taken([pane({ draft: POINTER })], new FakeRetraction(true), again);

      should(await built.service.retractedDraft(ID)).equal('send-0');
      should(await built.service.resubmitStuck(ID, 'send-0')).equal('refused');
      should(await built.service.finishOwnDraft(ID)).eql({ kind: 'stuck', sendId: 'send-0', tried: false });
      should(built.terminal.calls).not.containEql('submitComposer');
    });

    it('reports nothing once a repaired send was answered: a later recall of it is a person’s', async () => {
      const answered = delivered({ submitNudges: 1 });
      const built = taken([pane({ draft: POINTER })], new FakeRetraction(false), answered);

      should(await built.service.retractedDraft(ID)).be.undefined();
      should(await built.service.finishOwnDraft(ID)).eql({ kind: 'foreign' });
      should(built.terminal.calls).not.containEql('submitComposer');
    });

    it('presses nothing for a repaired send before the tracker re-binds it, on any path (review round 4)', async () => {
      const proof = new FakeRetraction(true);
      const built = taken([pane({ draft: POINTER })], proof, delivered());
      should(await built.service.resubmitStuck(ID, 'send-0')).equal('submitted');
      should(built.terminal.submitStrict).eql([true]);
      // Open with its old evidence; the box shows the pointer again — a second rewind, or a person's recall.
      should(built.ledger.records.get('send-0')).match({ fate: 'accepted', submitNudges: 1 });

      should(await built.service.finishOwnDraft(ID)).eql({ kind: 'stuck', sendId: 'send-0', tried: false });
      should(await built.service.resubmitStuck(ID, 'send-0')).equal('refused');
      should(await built.service.resubmit(ID, 'send-0')).match({ submitNudges: 1 });
      const refusal = await built.service.send(request()).catch((error: unknown) => error);
      should(refusal).be.instanceof(SendRefused);
      should(built.terminal.calls.filter(call => call === 'submitComposer')).have.length(1);
    });

    it('claims and presses a taken-back pointer only whole, never a clipped drawing of it (review round 4)', async () => {
      const clipped = `${POINTER.slice(0, POINTER.indexOf('.md') + 12)}…`;
      const built = taken([pane({ draft: clipped })], new FakeRetraction(true), delivered());

      should(await built.service.retractedDraft(ID)).be.undefined();
      should(await built.service.resubmitStuck(ID, 'send-0')).equal('refused');
      should(await built.service.finishOwnDraft(ID)).eql({ kind: 'foreign' });
      should(built.terminal.calls).not.containEql('submitComposer');
    });

    it('keeps the repair count when the tracker retypes a repaired send, so it never earns a second (review round 5)', async () => {
      const reopened = delivered({ fate: 'accepted', fateAt: undefined, submitNudges: 1 });
      const built = taken([pane({ promptReady: true })], new FakeRetraction(true), reopened);

      await built.service.reattempt(ID, 'send-0', { by: 'daemon' });

      should(built.ledger.records.get('send-0')).match({ attempt: 2, submitNudges: 1 });
      should(built.terminal.typed).have.length(1);
    });

    it('never lets the tracker’s nudge press a delivered send', async () => {
      const built = taken([pane({ draft: POINTER })], new FakeRetraction(true), delivered());

      should(await built.service.resubmit(ID, 'send-0')).match({ fate: 'delivered' });
      should(built.terminal.calls).not.containEql('submitComposer');
    });

    it('never claims a countless paste chip after the fact: it could be a person’s replacement paste', async () => {
      const ONE_LINE = `approve — ${'every review thread is answered and CI is green. '.repeat(30)}`;
      const built = idle(
        [pane({ draft: '[Pasted text #30]' })],
        unconfirmed({ path: 'direct', message: ONE_LINE, matchText: ONE_LINE, turn: 5, senderKind: 'human' }),
      );

      should(await built.service.finishOwnDraft(ID)).eql({ kind: 'foreign' });
      should(built.terminal.calls).not.containEql('submitComposer');
    });
  });
});

describe('labels and combined deliveries', () => {
  const OTHER = parseSessionId('session-3');
  const loge = { id: PEER, status: 'waiting', mode: 'auto', turn: 2, teammate: 'loge' } as SendTarget;
  const avary = { id: OTHER, status: 'waiting', mode: 'auto', turn: 2, teammate: 'avary' } as SendTarget;
  const both = { [PEER]: loge, [OTHER]: avary };
  const claudeTarget = (overrides: Partial<SendTarget> = {}) =>
    target({ harness: 'claude', directSendMaxChars: 4_096, ...overrides });
  const batch = (overrides: Partial<Parameters<SessionSendService['send']>[0]> = {}) =>
    request({
      sendId: 'q-1',
      message: 'first\n\nsecond',
      senderReference: PEER,
      parts: [
        { queueId: 'q-1', senderReference: PEER, text: 'first', replyExpected: false, label: 'action' },
        { queueId: 'q-2', senderReference: OTHER, text: 'second', replyExpected: true, label: 'blocker' },
      ],
      ...overrides,
    });

  it('puts the label in a single message’s banner, and none when the sender gave none', async () => {
    const labelled = parts(target(), [pane({ promptReady: true })], both);
    await labelled.service.send(request({ senderReference: PEER, label: 'fyi' }));
    const plain = parts(target(), [pane({ promptReady: true })], both);
    await plain.service.send(request({ senderReference: PEER }));

    should(labelled.ledger.only().message).startWith('[message · fyi from ferret loge (session session-2)');
    should(plain.ledger.only().message).startWith('[message from ferret loge (session session-2)');
  });

  it('delivers several messages as one turn, each part with its own sender, kind and label', async () => {
    const { service, ledger, terminal } = parts(claudeTarget(), [pane({ promptReady: true })], both);
    await service.send(batch());

    const text = ledger.only().message;
    should(text).startWith('[2 messages from ferrets, oldest first — not from the owner]\n\n');
    should(text).containEql('[1/2 · message · action from ferret loge (session session-2) — not from the owner]');
    should(text).containEql('[2/2 · question · blocker from ferret avary (session session-3) — not from the owner]');
    should(text.indexOf('first')).be.below(text.indexOf('second'));
    should(ledger.records.size).equal(1);
    should(ledger.only().sendId).equal('q-1');
    // Every sender is remembered, so a failure of the turn can be handed back to each of them.
    should(ledger.only().batch).eql([
      { queueId: 'q-1', from: PEER },
      { queueId: 'q-2', from: OTHER },
    ]);
    // Short enough to paste whole into an idle Claude composer.
    should(ledger.only().path).equal('direct');
    should(terminal.typed).have.length(1);
  });

  it('hands a combined delivery over as a turn file once it is longer than a paste may be', async () => {
    const long = 'x'.repeat(1_200);
    const { service, ledger } = parts(claudeTarget(), [pane({ promptReady: true })], both);
    await service.send(
      batch({
        parts: [
          { queueId: 'q-1', senderReference: PEER, text: long, replyExpected: false, label: 'action' },
          { queueId: 'q-2', senderReference: OTHER, text: long, replyExpected: false, label: 'action' },
        ],
      }),
    );
    should(ledger.only().path).equal('turn-file');
  });

  it('writes one outbox entry per part, each with its own text and sender', async () => {
    const { service, channel } = parts(claudeTarget(), [pane({ promptReady: true })], both);
    await service.send(batch());

    should(channel.outbound.map(entry => [entry.from, entry.fromName, entry.message])).eql([
      [PEER, 'loge', 'first'],
      [OTHER, 'avary', 'second'],
    ]);
  });

  it('ends the wait on the one part whose sender the receiver is parked on, and reads that part as the reply', async () => {
    const { service, peerWaits, ledger } = parts(
      claudeTarget({ waiting: { peer: OTHER } }),
      [pane({ promptReady: true })],
      both,
    );
    await service.send(batch());

    should(peerWaits.ended).eql([{ recipient: ID, sender: OTHER }]);
    should(ledger.only().message).containEql('[2/2 · reply · blocker from ferret avary');
    should(ledger.only().message).containEql('[1/2 · message · action from ferret loge');
  });

  it('treats a one-part delivery as a plain send', async () => {
    const { service, ledger } = parts(claudeTarget(), [pane({ promptReady: true })], both);
    await service.send(
      request({
        senderReference: PEER,
        parts: [{ queueId: 'send-1', senderReference: PEER, text: 'ship it', replyExpected: false }],
      }),
    );
    should(ledger.only().message).startWith('[message from ferret loge');
    should(ledger.only()).not.have.property('batch');
  });
});

describe('the ledger row a send id is answered from', () => {
  const record = (sendId: string): SendRecord => ({
    sendId,
    acceptedAt: NOW,
    acceptedTurn: 3,
    path: 'direct',
    message: 'combined turn',
    attachmentIds: [],
    fate: 'accepted',
  });

  it('answers a send with a row of its own from that row', () => {
    should(sendRecordFor([record('q-1')], [], 'q-1')?.sendId).equal('q-1');
  });

  it('answers a later member of a combined turn with the turn’s row, as the id asked about', () => {
    const found = sendRecordFor([record('q-1')], [{ id: 'q-2', deliveredAs: 'q-1' }], 'q-2');
    should(found).match({ sendId: 'q-2', message: 'combined turn', fate: 'accepted' });
  });

  it('answers nobody’s id, and a member whose turn has no row, with nothing', () => {
    should(sendRecordFor([record('q-1')], [{ id: 'q-2', deliveredAs: 'q-1' }], 'q-9')).be.undefined();
    should(sendRecordFor([], [{ id: 'q-2', deliveredAs: 'q-1' }], 'q-2')).be.undefined();
    should(sendRecordFor([record('q-1')], [{ id: 'q-2' }], 'q-2')).be.undefined();
  });
});
