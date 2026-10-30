import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { turnFileInstruction } from '@ferretry/protocol';
import should from 'should';
import { FileSendLedger } from '../../../../src/adapters/index.ts';
import {
  type ClockPort,
  paneHoldOf,
  parseSessionId,
  type SerialExecutor,
  type SessionId,
} from '../../../../src/lib/index.ts';
import {
  AgentSendFailureNotifier,
  type ComposerClearOutcome,
  type ComposerSubmitOutcome,
  defaultSendTrackerSettings,
  defaultSessionSendSettings,
  ReviveRefusedForSend,
  SendComposerOccupied,
  type SendHeldAt,
  type SendPaneObservation,
  type SendQueueOutcome,
  type SendRecord,
  type SendRepository,
  type SendTarget,
  type SendTerminal,
  SendTracker,
  SessionSendService,
} from '../../../../src/lib/session/send/index.ts';
import {
  ClaudeObservedInputObserver,
  CodexObservedInputObserver,
} from '../../../../src/lib/transcript/observed-input.ts';
import { waitFor } from '../../support/wait-for.ts';

/**
 * The whole chain, end to end, against a FAKE HARNESS: the real send service types into a terminal
 * that behaves like Claude or Codex — holding text typed mid-turn, writing the records each harness
 * really writes — and the real tracker, over the real file ledger, decides where every send went.
 */

const ID = parseSessionId('session-1');
const SENDER = parseSessionId('session-2');
const T0 = Date.parse('2026-08-01T12:00:00.000Z');

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map(async home => await rm(home, { recursive: true, force: true })));
});

/** A terminal that behaves like a harness TUI, and writes that harness's transcript records. */
class FakeHarness implements SendTerminal {
  readonly transcript: unknown[] = [];
  readonly typed: string[] = [];
  busy = false;
  alive = true;
  /** The keys go in and nothing happens — the pane repainted, the agent crashed mid-submit. */
  drops = false;
  /** Enter does not submit: the text stays typed in the composer, as a swallowed Enter leaves it. */
  strands = false;
  /** What sits typed in the composer and was never submitted. */
  composer = '';
  /** Claude before 2.1.281 wrote a transcript record for text typed into its queue; 2.1.281 does not. */
  writesQueueRecords = true;
  /**
   * Draw the queue as Claude Code 2.1.281 does and read it with the daemon's real screen reader,
   * rather than answering from the list. `clipped` draws it with its first rows scrolled past the top of
   * the pane and `swallowed` with every row of it scrolled off, leaving only the hint under it.
   */
  drawsQueue: 'no' | 'whole' | 'clipped' | 'swallowed' = 'no';
  /** The pane shows the queue in a rendering the reader does not recognise — the incident. */
  blindToQueue = false;
  /** What the harness is visibly holding in its own queue. */
  private held: string[] = [];

  constructor(
    private readonly harness: 'claude' | 'codex',
    private readonly clock: () => string,
  ) {}

  async observe(): Promise<SendPaneObservation> {
    return {
      alive: this.alive,
      dead: false,
      promptReady: !this.busy && this.composer === '',
      activeWork: this.busy,
      ...(this.composer === '' ? {} : { draft: this.composer }),
    };
  }

  async deliver(_id: SessionId, text: string): Promise<void> {
    if (this.composer !== '') throw new SendComposerOccupied(this.composer);
    this.typed.push(text);
    if (this.strands) {
      this.composer = text;
      throw new Error('the turn landed but stayed in the composer');
    }
    if (!this.drops) this.userTurn(text);
  }

  async queue(_id: SessionId, text: string): Promise<SendQueueOutcome> {
    this.typed.push(text);
    if (this.drops) return 'unproven';
    this.held.push(text);
    if (this.blindToQueue) return 'unproven';
    if (this.harness === 'claude' && this.writesQueueRecords)
      this.transcript.push({ type: 'queue-operation', operation: 'enqueue', timestamp: this.clock(), content: text });
    return 'held';
  }

  async stopActiveTurn(): Promise<SendPaneObservation> {
    return await this.observe();
  }

  async pressStopKey(): Promise<void> {}

  async heldAt(_id: SessionId, text: string): Promise<SendHeldAt | undefined> {
    if (this.composer === text) return 'composer';
    if (this.blindToQueue) return undefined;
    if (this.drawsQueue === 'no') return this.held.includes(text) ? 'queue' : undefined;
    const hold = paneHoldOf(this.claudeFrame(), {}, text, false);
    if (hold === 'unknown') throw new Error('the queue runs past the top of the pane');
    return hold === 'absent' ? undefined : hold;
  }

  /** A busy Claude Code 2.1.281 pane: its queue above the spinner, then the composer's placeholder. */
  private claudeFrame(): string {
    const rule = '─'.repeat(80);
    const entries = this.held.map(text =>
      text
        .split('\n')
        .map((line, index) => (index === 0 ? `❯ ${line}` : line === '' ? '' : `  ${line}`))
        .join('\n'),
    );
    const lines = ['⏺ Working on the auth task.', '', entries.join('\n\n'), '  ctrl+x ctrl+s to send now']
      .join('\n')
      .split('\n');
    const shown =
      this.drawsQueue === 'clipped' ? lines.slice(3) : this.drawsQueue === 'swallowed' ? lines.slice(-1) : lines;
    return [
      ...shown,
      '',
      '✻ Spinning… (4s · ↓ 1.0k tokens)',
      '',
      rule,
      '❯ Press up to edit queued messages',
      rule,
    ].join('\n');
  }

  async clearComposer(_id: SessionId, text: string): Promise<ComposerClearOutcome> {
    if (this.composer === '') return 'absent';
    if (this.composer !== text) return 'foreign';
    this.composer = '';
    return 'cleared';
  }

  async submitComposer(_id: SessionId, text: string): Promise<ComposerSubmitOutcome> {
    if (this.composer !== text) return 'absent';
    this.composer = '';
    this.userTurn(text);
    return 'submitted';
  }

  /** Submits whatever the composer holds — what a person pressing Enter in the terminal does. */
  pressEnter(): void {
    const text = this.composer;
    this.composer = '';
    this.userTurn(text);
  }

  /** The harness records `text` as the user's words late — a transcript write that lagged the deadline. */
  recordsLate(text: string): void {
    this.userTurn(text);
  }

  /** The turn ends: the harness submits everything it was holding, in order. */
  finishTurn(): void {
    this.busy = false;
    for (const text of this.held.splice(0)) {
      if (this.harness === 'claude' && this.writesQueueRecords)
        this.transcript.push({ type: 'queue-operation', operation: 'dequeue', timestamp: this.clock() });
      this.userTurn(text);
    }
  }

  private userTurn(text: string): void {
    const index = this.transcript.length;
    this.transcript.push(
      this.harness === 'claude'
        ? { type: 'user', uuid: `u-${index}`, timestamp: this.clock(), message: { role: 'user', content: text } }
        : {
            type: 'response_item',
            timestamp: this.clock(),
            payload: { type: 'message', id: `c-${index}`, role: 'user', content: [{ type: 'input_text', text }] },
          },
    );
  }
}

const inline: SerialExecutor = { run: async (_key, work) => await work(), runExclusive: async work => await work() };

class Rig {
  nowMs = T0;
  readonly clock: ClockPort = { now: () => new Date(this.nowMs).toISOString() };
  readonly harness: FakeHarness;
  readonly sender = new FakeHarness('claude', () => this.clock.now());
  readonly targets = new Map<SessionId, SendTarget>([
    [ID, { id: ID, status: 'running', mode: 'auto', turn: 1 }],
    [SENDER, { id: SENDER, status: 'running', mode: 'auto', turn: 1, teammate: 'hadi' }],
  ]);
  readable = true;
  /** Whether the reader sees the records at all — false is a read that saw nothing, not a partial one. */
  visible = true;
  refuseRevive = false;
  /** How long a relaunch takes before it types its turn pointer — the incident's took 2.6 s. */
  relaunchMs = 2_600;
  /** Held open to look at the send while the relaunch is still running. */
  relaunching: Promise<void> = Promise.resolve();
  /** Whether the relaunch reports the pointer it typed — a daemon from before the fix did not. */
  reportsPointer = true;
  readonly ledger: FileSendLedger;
  readonly service: SessionSendService;
  readonly tracker: SendTracker;

  constructor(harness: 'claude' | 'codex', home: string) {
    this.harness = new FakeHarness(harness, () => this.clock.now());
    this.ledger = new FileSendLedger(id => join(home, id), this.clock);
    const terminals = new Map<SessionId, FakeHarness>([
      [ID, this.harness],
      [SENDER, this.sender],
    ]);
    const terminal = (id: SessionId): FakeHarness => terminals.get(id) as FakeHarness;
    const routed: SendTerminal = {
      observe: async id => await terminal(id).observe(),
      deliver: async (id, text) => await terminal(id).deliver(id, text),
      queue: async (id, text) => await terminal(id).queue(id, text),
      stopActiveTurn: async id => await terminal(id).stopActiveTurn(),
      pressStopKey: async () => undefined,
      heldAt: async (id, text) => await terminal(id).heldAt(id, text),
      clearComposer: async (id, text) => await terminal(id).clearComposer(id, text),
      submitComposer: async (id, text) => await terminal(id).submitComposer(id, text),
    };
    const repository: SendRepository = {
      read: async id => this.targets.get(id),
      resolveSender: async reference => this.targets.get(reference as SessionId),
      journal: async () => undefined,
      transition: async (id, change) => {
        const next = {
          ...(this.targets.get(id) as SendTarget),
          ...(change.turn === undefined ? {} : { turn: change.turn }),
        };
        this.targets.set(id, next);
        return next;
      },
    };
    let service: SessionSendService | undefined;
    this.tracker = this.trackerOver(repository, routed, () => service as SessionSendService);
    service = new SessionSendService(
      {
        repository,
        ledger: this.ledger,
        terminal: routed,
        turns: {
          writeTurn: async (_id, turn) => `/state/turns/turn-${turn}.md`,
          writeQueuedPayload: async (_id, sendId) => `/state/channel/queued-${sendId}.md`,
          clearMarkers: async () => undefined,
        },
        channel: { recordInbound: async () => undefined, recordOutbound: async () => undefined },
        gate: { launching: () => false, awaitSettled: async () => true },
        reviver: {
          revive: async id => {
            if (this.refuseRevive) throw new ReviveRefusedForSend('a duplicate session holds this checkout');
            return await this.relaunch(id);
          },
        },
        peerWaits: { endPeerWait: async () => undefined },
        serial: inline,
        clock: this.clock,
        tracking: this.tracker,
      },
      defaultSessionSendSettings,
    );
    this.service = service;
    this.repository = repository;
    this.routed = routed;
  }

  readonly repository: SendRepository;
  readonly routed: SendTerminal;

  /** A tracker over this rig's ledger and harness — a second one is what a restarted daemon builds. */
  trackerOver(repository: SendRepository, terminal: SendTerminal, service: () => SessionSendService): SendTracker {
    return new SendTracker(
      {
        ledger: this.ledger,
        evidence: {
          read: async id => {
            const harness = id === ID ? this.harness : this.sender;
            const observer =
              harness === this.harness && this.harnessKind() === 'codex'
                ? new CodexObservedInputObserver()
                : new ClaudeObservedInputObserver();
            return {
              readable: this.readable,
              inputs: (this.visible ? harness.transcript : []).flatMap((record, index) =>
                observer.observe(record, { source: `/${id}.jsonl`, byteOffset: index, byteLength: 1 }),
              ),
            };
          },
        },
        terminal,
        repository,
        attempts: {
          reattempt: async (id, sendId) => await service().reattempt(id, sendId, { by: 'daemon' }),
          resubmit: async (id, sendId) => await service().resubmit(id, sendId),
        },
        notifier: new AgentSendFailureNotifier(
          { send: async request => await service().send(request) },
          repository,
          'fy',
        ),
        scheduler: { schedule: () => undefined, cancelAll: () => undefined },
        roster: { sessions: () => [ID, SENDER] },
        serial: inline,
        clock: this.clock,
      },
      defaultSendTrackerSettings,
    );
  }

  /**
   * What `SessionResumeService` does for a send: the session comes back, and once its harness is ready
   * the replacement pane is typed a POINTER at the turn file — never the message — which the harness
   * records as the user's words.
   */
  private async relaunch(id: SessionId): Promise<string | undefined> {
    await this.relaunching;
    const target = this.targets.get(id) as SendTarget;
    const turn = target.turn + 1;
    this.targets.set(id, { ...target, status: 'running', turn });
    this.nowMs += this.relaunchMs;
    const pointer = turnFileInstruction(`/state/sessions/${id}/turns/turn-${String(turn).padStart(3, '0')}.md`);
    await this.harness.deliver(id, pointer);
    return this.reportsPointer ? pointer : undefined;
  }

  private harnessKind(): 'claude' | 'codex' {
    return (this.harness as unknown as { harness: 'claude' | 'codex' }).harness;
  }

  async at(ms: number, id: SessionId = ID): Promise<SendRecord> {
    this.nowMs = T0 + ms;
    await this.tracker.check(id);
    return await this.record('send-1', id);
  }

  async record(sendId: string, id: SessionId = ID): Promise<SendRecord> {
    return (await this.ledger.list(id)).find(entry => entry.sendId === sendId) as SendRecord;
  }
}

async function rig(harness: 'claude' | 'codex'): Promise<Rig> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-send-tracking-'));
  homes.push(home);
  return new Rig(harness, home);
}

describe('a send to a busy agent', () => {
  for (const harness of ['claude', 'codex'] as const) {
    it(`is queued only on proof, then delivered when ${harness} submits it at the turn boundary`, async () => {
      const subject = await rig(harness);
      subject.harness.busy = true;

      const outcome = await subject.service.send({ id: ID, sendId: 'send-1', message: 'also update the docs' });
      const queued = await subject.at(1_000);
      const waiting = await subject.at(61_000);
      subject.harness.finishTurn();
      const delivered = await subject.at(62_000);

      should(outcome.disposition).equal('queued');
      should(queued.fate).equal('queued');
      should(waiting).match({ fate: 'queued', attempt: 1 });
      should(delivered).match({ fate: 'delivered', attempt: 1 });
      should(subject.harness.typed).eql(['also update the docs']);
    });
  }
});

describe('a send to an idle agent', () => {
  for (const harness of ['claude', 'codex'] as const)
    it(`is delivered once ${harness} records the user turn`, async () => {
      const subject = await rig(harness);

      const outcome = await subject.service.send({ id: ID, sendId: 'send-1', message: 'run the tests' });
      const record = await subject.at(2_000);

      should(outcome.disposition).equal('delivered');
      should(record).match({ fate: 'delivered', evidence: { tier: 'exact-text' } });
    });
});

describe('a send that never arrived', () => {
  it('is retyped once when proven absent, then timed out, and a person’s Retry under the same id lands it', async () => {
    const subject = await rig('claude');
    subject.harness.drops = true;

    await subject.service.send({ id: ID, sendId: 'send-1', message: 'run the tests' });
    const retried = await subject.at(60_000);
    const timedOut = await subject.at(120_000);
    subject.harness.drops = false;
    await subject.service.reattempt(ID, 'send-1', { by: 'person' });
    const delivered = await subject.at(121_000);

    should(retried).match({ fate: 'accepted', attempt: 2 });
    should(timedOut).match({ fate: 'timed_out', unaccountedReason: 'not_delivered', retryable: true });
    should(delivered).match({ fate: 'delivered', attempt: 3 });
    should(subject.harness.typed).eql(['run the tests', 'run the tests', 'run the tests']);
  });

  it('is unconfirmed, with its reason, when the transcript cannot be read — and never silently retyped', async () => {
    const subject = await rig('codex');
    subject.readable = false;
    subject.visible = false;

    await subject.service.send({ id: ID, sendId: 'send-1', message: 'run the tests' });
    const record = await subject.at(60_000);
    const refused = await subject.service
      .reattempt(ID, 'send-1', { by: 'person' })
      .catch((error: unknown) => (error as Error).message);

    should(record).match({ fate: 'unaccounted', unaccountedReason: 'transcript_unreadable' });
    should(refused).match(/send it again anyway/);
    should(subject.harness.typed).have.length(1);
  });
});

describe('a send to a conversation too large to read whole — an adopted one', () => {
  it('is confirmed by the record it landed as, though absence could not be proven', async () => {
    const subject = await rig('claude');
    // What a capped read of a 200 MB transcript was: unable to prove absence, and blind to the end.
    // A window from the send sees the end, so the record the send became is in hand.
    subject.readable = false;

    await subject.service.send({ id: ID, sendId: 'send-1', message: 'hi' });
    const record = await subject.at(2_000);

    should(record).match({ fate: 'delivered', evidence: { tier: 'exact-text' } });
    should(subject.harness.typed).eql(['hi']);
  });

  it('corrects a send it settled unconfirmed once the transcript can be read, for days but not for ever', async () => {
    const subject = await rig('claude');
    subject.readable = false;
    subject.visible = false;
    await subject.service.send({ id: ID, sendId: 'send-1', message: 'run the tests' });
    const unconfirmed = await subject.at(60_000);
    subject.readable = true;
    subject.visible = true;
    // Past the ordinary two-hour watch on unconfirmed sends: this one failed only because of the read.
    const repaired = await subject.at(3 * 60 * 60_000);

    const late = await rig('claude');
    late.readable = false;
    late.visible = false;
    await late.service.send({ id: ID, sendId: 'send-1', message: 'run the tests' });
    await late.at(60_000);
    late.visible = true;
    const abandoned = await late.at(4 * 24 * 60 * 60_000);

    should(unconfirmed).match({ fate: 'unaccounted', unaccountedReason: 'transcript_unreadable' });
    should(repaired).match({ fate: 'delivered', evidence: { tier: 'exact-text' } });
    should(repaired.unaccountedReason).be.undefined();
    should(abandoned.fate).equal('unaccounted');
  });

  it('says a send a person cancelled was delivered when the agent had it before the cancel', async () => {
    const subject = await rig('claude');
    subject.readable = false;
    subject.visible = false;
    await subject.service.send({ id: ID, sendId: 'send-1', message: 'hi' });
    await subject.at(60_000);
    const cancelled = await subject.service.cancel(ID, 'send-1');
    subject.visible = true;
    const corrected = await subject.at(120_000);

    should(cancelled).match({ fate: 'cancelled', cancelEffect: 'not_in_pane' });
    should(corrected).match({ fate: 'delivered' });
    should(corrected.cancelEffect).be.undefined();
  });

  it('never lets a cancelled send take the record of the message sent after it', async () => {
    const subject = await rig('claude');
    subject.readable = false;
    subject.visible = false;
    subject.harness.drops = true;
    await subject.service.send({ id: ID, sendId: 'send-1', message: 'run the tests' });
    await subject.at(60_000);
    await subject.service.cancel(ID, 'send-1');
    subject.readable = true;
    subject.visible = true;
    subject.harness.drops = false;
    subject.nowMs = T0 + 70_000;
    await subject.service.send({ id: ID, sendId: 'send-2', message: 'run the tests' });
    await subject.at(80_000);

    should(await subject.record('send-1')).match({ fate: 'cancelled' });
    should(await subject.record('send-2')).match({ fate: 'delivered' });
  });
});

describe('a message held for a revive', () => {
  it('is delivered exactly once when the session comes back', async () => {
    const subject = await rig('claude');
    subject.targets.set(ID, { id: ID, status: 'stopped', mode: 'auto', turn: 1 });
    subject.refuseRevive = true;

    const outcome = await subject.service.send({ id: ID, sendId: 'send-1', message: 'pick this up when back' });
    subject.targets.set(ID, { id: ID, status: 'running', mode: 'auto', turn: 1 });
    const released = [await subject.service.releaseHeld(ID), await subject.service.releaseHeld(ID)];
    const record = await subject.at(2_000);

    should(outcome.disposition).equal('queued-for-revive');
    should(released).eql([1, 0]);
    should(subject.harness.typed).eql(['pick this up when back']);
    should(record).match({ fate: 'delivered', held: false });
  });
});

describe('a message carried by a revive — a finished sub-ferret sent a peer message', () => {
  /** The incident: an agent's message to an auto session whose harness exited after its task. */
  async function finished(): Promise<Rig> {
    const subject = await rig('claude');
    subject.targets.set(ID, { id: ID, status: 'completed', mode: 'auto', turn: 1 });
    subject.harness.alive = false;
    return subject;
  }
  const message = 'PR #734 now CONFLICTS with main. Please rebase on origin/main, resolve, re-run the gates, push.';

  it('is delivered by the pointer the relaunch typed, where it used to be "not delivered" at 15 s', async () => {
    // Arrange
    const subject = await finished();

    // Act — accepted at T0, the relaunch types its pointer 2.6 s later, then the looks it always got.
    const outcome = await subject.service.send({ id: ID, sendId: 'send-1', message, senderReference: SENDER });
    subject.harness.alive = true;
    const first = await subject.at(4_600);
    const deadline = await subject.at(15_039);

    // Assert
    should(outcome.disposition).equal('revived');
    should(subject.harness.typed).eql([turnFileInstruction('/state/sessions/session-1/turns/turn-002.md')]);
    should(first).match({ fate: 'delivered', evidence: { tier: 'turn-instruction' }, attempt: 1 });
    should(deadline.fate).equal('delivered');
    should(subject.sender.typed).be.empty();
  });

  it('is never judged while the relaunch is still starting the harness', async () => {
    // Arrange — a relaunch slower than an agent send's whole first window.
    const subject = await finished();
    let release = (): void => undefined;
    subject.relaunching = new Promise(resolve => (release = resolve));

    // Act — somebody reads the ledger at 16 s and 60 s, mid-relaunch.
    const sent = subject.service.send({ id: ID, sendId: 'send-1', message, senderReference: SENDER });
    await waitFor(async () => (await subject.ledger.list(ID)).length > 0, 'the send to be written to the ledger');
    const early = await subject.at(16_000);
    const later = await subject.at(60_000);
    subject.harness.alive = true;
    release();
    await sent;
    const proven = await subject.at(subject.nowMs - T0 + 2_000);

    // Assert
    should(early).match({ fate: 'accepted', path: 'revive' });
    should(later.fate).equal('accepted');
    should(proven.fate).equal('delivered');
    should(subject.sender.typed).be.empty();
  });

  it('is unconfirmed — never "not delivered" — when the record cannot name what the relaunch typed', async () => {
    // Arrange — the record keeps only the message, as every revive's did before the fix.
    const subject = await finished();
    subject.reportsPointer = false;

    // Act
    await subject.service.send({ id: ID, sendId: 'send-1', message, senderReference: SENDER });
    subject.harness.alive = true;
    const relaunching = await subject.at(15_039);
    const settled = await subject.at(90_000);
    await subject.at(92_000, SENDER);
    const notice = subject.sender.typed[0] ?? '';

    // Assert
    should(relaunching.fate).equal('accepted');
    should(settled).match({ fate: 'unaccounted', unaccountedReason: 'revive_unconfirmed', retryable: false });
    should(subject.harness.typed).have.length(1);
    should(notice).match(/was handed to session-1 as the first turn of its relaunch/u);
    should(notice).match(/do not send it again/u);
    should(notice).not.match(/did not reach it/u);
  });

  it('is unconfirmed after its window when the pointer never reached the transcript, and corrected when it does', async () => {
    // Arrange — the pointer was typed, but the transcript has not shown it by the deadline.
    const subject = await finished();
    subject.harness.drops = true;

    // Act
    await subject.service.send({ id: ID, sendId: 'send-1', message, senderReference: SENDER });
    subject.harness.alive = true;
    const settled = await subject.at(17_700);
    subject.harness.drops = false;
    subject.harness.recordsLate(turnFileInstruction('/state/sessions/session-1/turns/turn-002.md'));
    const repaired = await subject.at(30_000);

    // Assert — never re-typed: the relaunch is not the tracker's to repeat.
    should(settled).match({ fate: 'unaccounted', unaccountedReason: 'revive_unconfirmed' });
    should(subject.harness.typed).have.length(1);
    should(repaired.fate).equal('delivered');
  });
});

describe('a daemon restart', () => {
  it('re-derives an in-flight send from the transcript and re-types nothing', async () => {
    const subject = await rig('claude');
    subject.harness.busy = true;
    await subject.service.send({ id: ID, sendId: 'send-1', message: 'also update the docs' });
    subject.harness.finishTurn();

    // A fresh tracker over the same ledger file is exactly what a restarted daemon builds.
    const restarted = subject.trackerOver(subject.repository, subject.routed, () => subject.service);
    subject.nowMs = T0 + 600_000;
    restarted.arm();
    await waitFor(
      async () => (await subject.record('send-1'))?.fate === 'delivered',
      'the restarted tracker to settle the send as delivered',
    );

    should(await subject.record('send-1')).match({ fate: 'delivered', attempt: 1 });
    should(subject.harness.typed).have.length(1);
  });
});

describe('an agent-to-agent send', () => {
  it('is retried briefly, then the sending agent is told in its own session', async () => {
    const subject = await rig('codex');
    subject.harness.drops = true;

    await subject.service.send({ id: ID, sendId: 'send-1', message: 'take the auth task', senderReference: SENDER });
    for (const ms of [15_000, 30_000, 60_000]) should((await subject.at(ms)).fate).equal('accepted');
    const final = await subject.at(75_000);
    await subject.at(77_000, SENDER);
    const notice = await subject.record(`send-failed:${ID}:send-1`, SENDER);

    should(final).match({ fate: 'timed_out', attempt: 4, senderKind: 'agent', from: SENDER });
    should(subject.harness.typed).have.length(4);
    should(notice).match({ senderKind: 'daemon', fate: 'delivered' });
    should(subject.sender.typed[0]).match(/Your message to session-1 \(send send-1\) did not reach it/);
  });
});

describe('a Codex message left typed and not sent — the owner’s stuck "hi" and "hello"', () => {
  it('is said as typed-not-sent within one look, refuses to type a second message onto it, and cancels cleanly', async () => {
    // Arrange — Enter never takes, so `hi` stays typed in Codex's composer.
    const subject = await rig('codex');
    subject.harness.strands = true;

    // Act
    const first = await subject.service
      .send({ id: ID, sendId: 'send-1', message: 'hi' })
      .catch((error: unknown) => error);
    const early = await subject.at(2_000);
    const looked = await subject.at(4_000);
    const second = await subject.service
      .send({ id: ID, sendId: 'send-2', message: 'hello' })
      .catch((error: unknown) => error);
    const cancelled = await subject.service.cancel(ID, 'send-1');
    const later = await subject.at(70_000);

    // Assert — the stranded row says so instead of "Sending", and `hello` was never typed onto it,
    // which is what reached Codex as `hihello` before.
    should((first as Error).message).match(/stayed in the composer/u);
    should(early.typedNotSent).be.undefined();
    should(looked).match({ fate: 'accepted', typedNotSent: true });
    should((second as Error).message).match(/already holds unsent text \("hi"\).*Press Enter on it or clear it/u);
    should(await subject.record('send-2')).be.undefined();
    should(subject.harness.typed).eql(['hi']);
    should(cancelled).match({ fate: 'cancelled', cancelEffect: 'cleared' });
    should(Object.hasOwn(cancelled, 'typedNotSent')).be.false();
    should(subject.harness.composer).equal('');
    // Cancelled is final: a later look neither re-opens it nor retypes it.
    should(later).match({ fate: 'cancelled' });
    should(subject.harness.typed).eql(['hi']);
  });

  it('is sent by one Press Enter and then proven delivered from the transcript', async () => {
    const subject = await rig('codex');
    subject.harness.strands = true;
    await subject.service.send({ id: ID, sendId: 'send-1', message: 'hi' }).catch(() => undefined);
    await subject.at(4_000);

    const submitted = await subject.service.submit(ID, 'send-1');
    const delivered = await subject.at(4_000);
    const again = await subject.service.submit(ID, 'send-1').catch((error: unknown) => error);

    should(Object.hasOwn(submitted, 'typedNotSent')).be.false();
    should(delivered).match({ fate: 'delivered', evidence: { tier: 'exact-text' } });
    // A second tap finds nothing typed and presses nothing.
    should((again as Error).message).match(/is delivered; there is nothing to submit/u);
  });

  it('proves both halves of a message Codex received joined, so neither row waits forever', async () => {
    // Arrange — the shape the old daemon produced: `hi` stranded, `hello` typed onto it, and Codex
    // submitting `hihello` as one user turn. Both rows are open in the ledger.
    const subject = await rig('codex');
    subject.harness.strands = true;
    await subject.service.send({ id: ID, sendId: 'send-1', message: 'hi' }).catch(() => undefined);
    subject.nowMs = T0 + 1_000;
    await subject.ledger.accept(ID, {
      sendId: 'send-2',
      acceptedAt: subject.clock.now(),
      acceptedTurn: 1,
      path: 'native-inline',
      message: 'hello',
      matchText: 'hello',
      fate: 'queued',
      attempt: 1,
    });
    subject.harness.composer = 'hihello';
    subject.harness.pressEnter();

    // Act
    const hi = await subject.at(3_000);
    const hello = await subject.record('send-2');

    // Assert
    should(hi).match({ fate: 'delivered', evidence: { tier: 'merged-text' } });
    should(hello).match({ fate: 'delivered', evidence: { tier: 'merged-text' } });
    should(hello.evidence?.key).equal(hi.evidence?.key);
  });

  it('refuses to cancel what the agent already read, and says what it left where it cannot reach', async () => {
    const subject = await rig('codex');
    await subject.service.send({ id: ID, sendId: 'send-1', message: 'run the tests' });
    await subject.at(2_000);
    subject.harness.busy = true;
    await subject.service.send({ id: ID, sendId: 'send-2', message: 'and the docs' });

    const delivered = await subject.service.cancel(ID, 'send-1').catch((error: unknown) => error);
    const queued = await subject.service.cancel(ID, 'send-2');
    const twice = await subject.service.cancel(ID, 'send-2');
    const missing = await subject.service.cancel(ID, 'send-9').catch((error: unknown) => error);

    should((delivered as Error).message).match(/already delivered/u);
    should(queued).match({ fate: 'cancelled', cancelEffect: 'left_in_queue' });
    should(twice).eql(queued);
    should((missing as Error).message).match(/has no send send-9/u);
  });
});

/**
 * The incident, end to end: a peer message typed into a mid-turn Claude Code 2.1.281 ferret, which
 * writes no transcript record for its queue and draws it in a shape the daemon did not recognise. The
 * daemon called it lost at 15 s, 30 s and 60 s and typed it again each time — four copies in one queue,
 * and a sender told it never arrived.
 */
describe('a peer message held in Claude Code 2.1.281’s queue', () => {
  async function midTurn(): Promise<Rig> {
    const subject = await rig('claude');
    subject.harness.busy = true;
    subject.harness.writesQueueRecords = false;
    await subject.service.send({ id: ID, sendId: 'send-1', message: 'take the auth task', senderReference: SENDER });
    return subject;
  }

  /** Typed into the busy pane with nothing proving it held, as the rendering that failed was at send time. */
  async function unproven(): Promise<Rig> {
    const subject = await rig('claude');
    subject.harness.busy = true;
    subject.harness.writesQueueRecords = false;
    subject.harness.blindToQueue = true;
    await subject.service.send({ id: ID, sendId: 'send-1', message: 'take the auth task', senderReference: SENDER });
    subject.harness.blindToQueue = false;
    return subject;
  }

  it('is typed ONCE while unrecognised, queued once the pane is read, and delivered at the turn boundary', async () => {
    // Arrange — the rendering the daemon could not read, from the first keystroke on.
    const subject = await rig('claude');
    subject.harness.busy = true;
    subject.harness.writesQueueRecords = false;
    subject.harness.blindToQueue = true;
    await subject.service.send({ id: ID, sendId: 'send-1', message: 'take the auth task', senderReference: SENDER });

    // Act — every deadline the agent schedule has, then the queue recognised, then the turn ending.
    const looks = [];
    for (const ms of [15_000, 30_000, 60_000, 75_000, 140_000]) looks.push(await subject.at(ms));
    subject.harness.blindToQueue = false;
    subject.harness.drawsQueue = 'whole';
    const queued = await subject.at(141_000);
    subject.harness.finishTurn();
    const delivered = await subject.at(142_000);

    // Assert
    should(subject.harness.typed).have.length(1);
    for (const look of looks) should(look).match({ fate: 'accepted', attempt: 1 });
    should(queued).match({ fate: 'queued', queueProof: 'pane', attempt: 1 });
    should(delivered).match({ fate: 'delivered', attempt: 1 });
    should(subject.sender.typed).be.empty();
  });

  it('is proven queued from the real screen reader at the first look', async () => {
    const subject = await midTurn();
    subject.harness.drawsQueue = 'whole';

    should(await subject.at(1_000)).match({ fate: 'queued', queueProof: 'pane' });
    should(await subject.at(75_000)).match({ fate: 'queued', attempt: 1 });
    should(subject.harness.typed).have.length(1);
  });

  it('is proven queued by the tail still on screen when the head of a long message scrolled off', async () => {
    const subject = await unproven();
    subject.harness.drawsQueue = 'clipped';

    const queued = await subject.at(15_000);
    subject.harness.finishTurn();
    const delivered = await subject.at(16_000);

    should(queued).match({ fate: 'queued', queueProof: 'pane', attempt: 1 });
    should(delivered).match({ fate: 'delivered', attempt: 1 });
    should(subject.harness.typed).have.length(1);
  });

  it('waits — no notice, never retyped — when the whole queue ran off the pane, and is delivered at the turn end', async () => {
    // The incident: the capture cannot show the queue at all, and the send used to be told "unconfirmed
    // (pane unreadable)" at its first deadline although the harness delivered it a moment later.
    const subject = await unproven();
    subject.harness.drawsQueue = 'swallowed';

    const waiting = [];
    for (const ms of [15_000, 30_000, 75_000, 140_000]) waiting.push(await subject.at(ms));
    await subject.at(141_000, SENDER);
    subject.harness.finishTurn();
    const delivered = await subject.at(142_000);

    for (const look of waiting) should(look).match({ fate: 'accepted', attempt: 1 });
    should(delivered).match({ fate: 'delivered', attempt: 1 });
    should(subject.harness.typed).have.length(1);
    should(subject.sender.typed).be.empty();
  });

  it('is unconfirmed, and the sender told so, only once no turn is running to wait for', async () => {
    const subject = await unproven();
    subject.harness.drawsQueue = 'swallowed';
    subject.harness.busy = false;

    const settled = await subject.at(15_000);

    should(settled).match({ fate: 'unaccounted', unaccountedReason: 'pane_unreadable' });
    should(subject.harness.typed).have.length(1);
  });
});
