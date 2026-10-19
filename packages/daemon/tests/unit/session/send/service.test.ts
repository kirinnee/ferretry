import { describe, it } from 'bun:test';
import should from 'should';
import { type ClockPort, parseSessionId, type SerialExecutor, type SessionId } from '../../../../src/lib/index.ts';
import {
  defaultSessionSendSettings,
  type InboundMessage,
  type OutboundMessage,
  type PeerWaitEnder,
  ReviveRefusedForSend,
  type SendChannel,
  type SendLaunchGate,
  type SendLedger,
  type SendPaneObservation,
  SendPending,
  type SendQueueOutcome,
  type SendRecord,
  SendRefused,
  type SendRepository,
  type SendReviver,
  type SendSettlement,
  type SendTarget,
  type SendTerminal,
  type SendTracking,
  type SendTransition,
  type SendTurnStore,
  SendUnavailable,
  SessionSendService,
} from '../../../../src/lib/session/send/index.ts';

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
const NOW = '2026-08-01T12:00:00.000Z';

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
  observeFailure: Error | undefined;
  /** Which observe call starts failing, so a test can fail the SECOND look at a pane. */
  observeFailFrom = 0;
  private observed = 0;

  constructor(private readonly frames: SendPaneObservation[]) {}

  async observe(): Promise<SendPaneObservation> {
    this.calls.push('observe');
    if (this.observeFailure !== undefined && this.observed++ >= this.observeFailFrom) throw this.observeFailure;
    return this.frames.length > 1
      ? (this.frames.shift() as SendPaneObservation)
      : (this.frames[0] as SendPaneObservation);
  }

  async deliver(_id: SessionId, text: string): Promise<void> {
    this.calls.push('deliver');
    this.typed.push(text);
    if (this.deliverFailure !== undefined) throw this.deliverFailure;
  }

  async queue(_id: SessionId, text: string): Promise<SendQueueOutcome> {
    this.calls.push('queue');
    this.typed.push(text);
    return this.queueOutcome;
  }

  async holds(): Promise<boolean> {
    return false;
  }

  async stopActiveTurn(): Promise<SendPaneObservation> {
    this.calls.push('stopActiveTurn');
    return this.frames.length > 1
      ? (this.frames.shift() as SendPaneObservation)
      : (this.frames[0] as SendPaneObservation);
  }

  async pressStopKey(): Promise<void> {
    this.calls.push('pressStopKey');
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

  async revive(_id: SessionId, message: string): Promise<void> {
    this.messages.push(message);
    if (this.failure !== undefined) throw this.failure;
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
    { repository, ledger, terminal, turns, channel, gate, reviver, peerWaits, serial, clock, tracking },
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

describe('interrupt', () => {
  it('stops the turn and marks the session interrupted', async () => {
    const { service, terminal, repository } = parts(target(), [pane({ activeWork: true })]);
    const after = await service.interrupt(ID);
    should(terminal.calls).eql(['observe', 'pressStopKey', 'observe']);
    should(repository.events).eql(['control.interrupt_requested']);
    should(repository.transitions[0]).match({
      event: 'control.interrupted',
      status: 'interrupted',
      promptReady: true,
      reason: 'interrupted by client',
    });
    should(after.status).equal('interrupted');
  });

  it('hands an interactive terminal back to its human rather than marking it interrupted forever', async () => {
    const { service, repository } = parts(target({ mode: 'interactive' }), [pane()]);
    await service.interrupt(ID);
    should(repository.transitions[0]).match({ event: 'control.interrupted', status: 'awaiting_user' });
    should(repository.transitions[0]?.reason).be.undefined();
  });

  it('keeps `interrupted` for an interactive session that is still visibly working', async () => {
    const { service, repository } = parts(target({ mode: 'interactive' }), [pane({ activeWork: true })]);
    await service.interrupt(ID);
    should(repository.transitions[0]?.status).equal('interrupted');
  });

  it('still records the interrupt when the pane could not be read afterwards', async () => {
    const { service, repository, terminal } = parts(target({ mode: 'interactive' }), [pane()]);
    terminal.observeFailure = new Error('tmux is gone');
    terminal.observeFailFrom = 1;
    await service.interrupt(ID);
    should(repository.transitions[0]?.status).equal('interrupted');
  });

  it('refuses to abandon a rendered structured question by accident', async () => {
    const { service, terminal } = parts(target({ pendingQuestion: { toolUseId: 'tool-7' } }));
    await should(service.interrupt(ID)).be.rejectedWith(SendUnavailable);
    await should(service.interrupt(ID)).be.rejectedWith(/tool-7/u);
    should(terminal.calls).be.empty();
  });

  it('refuses a session whose shutdown was never confirmed, and one that is already finished', async () => {
    await should(parts(target({ status: 'kill_failed' })).service.interrupt(ID)).be.rejectedWith(SendUnavailable);
    await should(parts(target({ status: 'completed' })).service.interrupt(ID)).be.rejectedWith(SendRefused);
    await should(parts(target({ status: 'completed' })).service.interrupt(ID)).be.rejectedWith(/no running turn/u);
  });

  it('presses no key at an idle auto pane, and still records the interrupt', async () => {
    const { service, terminal, repository } = parts(target(), [pane()]);
    await service.interrupt(ID);
    should(terminal.calls).eql(['observe', 'observe']);
    should(repository.transitions[0]?.status).equal('interrupted');
  });

  it("sends the stop key at an idle interactive claude pane, which is the human's own stop", async () => {
    const { service, terminal } = parts(target({ mode: 'interactive', harness: 'claude' }), [pane()]);
    await service.interrupt(ID);
    should(terminal.calls).eql(['observe', 'pressStopKey', 'observe']);
  });

  it('refuses a session whose pane is gone, and says to revive it instead', async () => {
    const { service, repository } = parts(target(), [pane({ alive: false, dead: true })]);
    await should(service.interrupt(ID)).be.rejectedWith(/revive it rather than interrupting/u);
    should(repository.journal_).be.empty();
  });

  it('refuses a session it cannot read', async () => {
    await should(parts(null).service.interrupt(ID)).be.rejectedWith(SendRefused);
    await should(parts(null).service.interrupt(ID)).be.rejectedWith(/session not found/u);
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
    const ended = await settled('timed_out', { retryable: false, unaccountedReason: 'session_ended' });
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

describe('delivering held messages after a revive', () => {
  async function heldParts(frames: SendPaneObservation[]) {
    const built = parts(target(), frames);
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
