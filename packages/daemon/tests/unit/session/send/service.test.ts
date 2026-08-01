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
  type SendRecord,
  SendRefused,
  type SendRepository,
  type SendReviver,
  type SendTarget,
  type SendTerminal,
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

  only(): SendRecord {
    const [record] = [...this.records.values()];
    if (record === undefined) throw new Error('no send was accepted');
    return record;
  }
}

class FakeTerminal implements SendTerminal {
  readonly calls: string[] = [];
  readonly typed: string[] = [];
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

  async queue(_id: SessionId, text: string): Promise<void> {
    this.calls.push('queue');
    this.typed.push(text);
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
  const service = new SessionSendService(
    { repository, ledger, terminal, turns, channel, gate, reviver, peerWaits, serial, clock },
    defaultSessionSendSettings,
  );
  return { service, repository, ledger, terminal, turns, channel, gate, reviver, peerWaits, serial };
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
    should(ledger.only()).match({ path: 'native-inline', fate: 'accepted' });
    should(ledger.only().turn).be.undefined();
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
