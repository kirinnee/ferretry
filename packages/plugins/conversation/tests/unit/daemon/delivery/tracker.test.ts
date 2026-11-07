import type { Instant } from '@ferretry/std';
import { describe, it } from 'bun:test';
import { turnFileInstruction } from '../../../../daemon/seams/protocol.ts';
import should from 'should';
import { type ClockPort, parseSessionId, type SerialExecutor, type SessionId } from '../../../../daemon/seams/index.ts';
import {
  defaultSendTrackerSettings,
  lookBeforeReading,
  OWED_NOTICE_RETRY_LIMIT,
  SEND_READ_LOOK_BUDGET_MS,
  type SendEvidenceReading,
  type SendHeldAt,
  type SendPaneObservation,
  type SendRecord,
  SendRetypeWithheld,
  type SendRetypeWithholding,
  type SendSettlement,
  type SendTarget,
  SendTracker,
} from '../../../../daemon/delivery/lib/index.ts';
import { ClaudeObservedInputObserver, CodexObservedInputObserver } from '../../../../daemon/seams/observed-input.ts';
import type { ObservedHumanInput, TranscriptInputObserver } from '../../../../daemon/seams/transcript-types.ts';

/**
 * Where a send WENT, decided only from proof.
 *
 * Every case feeds REAL harness record shapes — Claude's `user`, `queue-operation` and
 * `queued_command` records, Codex's `response_item` — through the daemon's own observers, so what is
 * under test is the whole chain from a transcript line to a ledger fate.
 */

const ID = parseSessionId('session-1');
const SENDER = 'session-2';
const T0 = Date.parse('2026-08-01T12:00:00.000Z');
const at = (ms: number): Instant => new Date(T0 + ms).toISOString() as Instant as Instant;

/** Real record shapes, as each harness writes them. */
const claude = {
  user: (text: string, ms: number, uuid = `u-${ms}`) => ({
    type: 'user',
    uuid,
    timestamp: at(ms),
    message: { role: 'user', content: text },
  }),
  enqueue: (text: string, ms: number) => ({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: at(ms),
    content: text,
  }),
  dequeue: (text: string, ms: number) => ({
    type: 'queue-operation',
    operation: 'dequeue',
    timestamp: at(ms),
    content: text,
  }),
  remove: (text: string, ms: number) => ({
    type: 'queue-operation',
    operation: 'remove',
    timestamp: at(ms),
    content: text,
  }),
  drained: (text: string, ms: number) => ({
    type: 'attachment',
    uuid: `q-${ms}`,
    timestamp: at(ms),
    attachment: { type: 'queued_command', prompt: text, commandMode: 'prompt', origin: { kind: 'human' } },
  }),
};

const codex = {
  user: (text: string, ms: number, id = `c-${ms}`) => ({
    type: 'response_item',
    timestamp: at(ms),
    payload: { type: 'message', id, role: 'user', content: [{ type: 'input_text', text }] },
  }),
};

function observe(observer: TranscriptInputObserver, records: readonly unknown[]): ObservedHumanInput[] {
  return records.flatMap((record, index) =>
    observer.observe(record, { source: '/t.jsonl', byteOffset: index * 100, byteLength: 100 }),
  );
}

function record(overrides: Partial<SendRecord> = {}): SendRecord {
  return {
    sendId: 'send-1',
    acceptedAt: at(0),
    acceptedTurn: 3,
    path: 'direct',
    message: 'ship it now please',
    matchText: 'ship it now please',
    turn: 4,
    fate: 'accepted',
    attempt: 1,
    attemptAt: at(0),
    senderKind: 'human',
    ...overrides,
  };
}

function pane(overrides: Partial<SendPaneObservation> = {}): SendPaneObservation {
  return { alive: true, dead: false, promptReady: true, activeWork: false, ...overrides };
}

class World {
  readonly records = new Map<string, SendRecord>();
  readonly journal: Array<{ event: string; data: Readonly<Record<string, unknown>> }> = [];
  readonly scheduled: Array<{ id: SessionId; delayMs: number; run: () => void }> = [];
  readonly retyped: string[] = [];
  /** Sends the tracker asked to press Enter for again, and whether that Enter takes. */
  readonly resubmitted: string[] = [];
  enterTakes = false;
  resubmitDeclines = false;
  readonly notices: Array<{ sender: string; recipient: string; record: SendRecord }> = [];
  /** What reached a sender, keyed as the real notifier keys it — a repeated attempt lands once, as in the send service. */
  readonly told = new Set<string>();
  /** The notifier throws, so a notice is attempted and not sent. */
  noticeFails = false;
  /** The daemon dies on this write of a notice crossed off a record (1 = the first), before the line is written. */
  crashOnCrossOff: number | undefined;
  private crossOffs = 0;
  reading: SendEvidenceReading = { readable: true, inputs: [] };
  readFails = false;
  readonly sinces: string[] = [];
  target: SendTarget | undefined = { id: ID, status: 'running', mode: 'auto', turn: 4 };
  pane: SendPaneObservation | undefined = pane();
  inPane: SendHeldAt | false | undefined = false;
  retypeFails = false;
  /** The service, re-reading the pane under its lock, refuses to type — and why. */
  withhold: SendRetypeWithholding | undefined;
  /** The service's re-read finds the send held, and proves it queued instead of typing it. */
  retypeFindsHeld = false;
  targetFails = false;
  cancelled = 0;
  nowMs = T0;
  /** The sessions the boot walk covers, and which of them a look has started on, in order. */
  roster: readonly SessionId[] = [ID];
  readonly looked: SessionId[] = [];
  /** When set, each look waits here until the test releases it. */
  readonly holds: Array<() => void> = [];
  holdLooks = false;
  /** The ledger cannot be read at all, so a look and the debt behind it both fail. */
  listFails = false;
  readonly tracker: SendTracker;

  constructor(...initial: SendRecord[]) {
    for (const entry of initial) this.records.set(entry.sendId, entry);
    const serial: SerialExecutor = {
      run: async (_key, work) => await work(),
      runExclusive: async work => await work(),
    };
    const clock: ClockPort = { now: () => new Date(this.nowMs).toISOString() as Instant };
    this.tracker = new SendTracker(
      {
        ledger: {
          list: async id => {
            this.looked.push(id);
            if (this.listFails) throw new Error('ledger unreadable');
            if (this.holdLooks) await new Promise<void>(resolve => this.holds.push(resolve));
            return [...this.records.values()];
          },
          settle: async (_id, sendId, patch: SendSettlement) => {
            if (Object.keys(patch).join() === 'noticesOwed' && ++this.crossOffs === this.crashOnCrossOff)
              throw new Error('daemon died');
            const current = this.records.get(sendId);
            if (current === undefined) return undefined;
            const merged: Record<string, unknown> = { ...current, ...patch };
            for (const [key, value] of Object.entries(patch)) if (value === undefined) delete merged[key];
            const next = merged as unknown as SendRecord;
            this.records.set(sendId, next);
            return next;
          },
        },
        evidence: {
          read: async (_id, since) => {
            this.sinces.push(since);
            if (this.readFails) throw new Error('transcript gone');
            return this.reading;
          },
        },
        terminal: {
          observe: async () => {
            if (this.pane === undefined) throw new Error('no pane');
            return this.pane;
          },
          heldAt: async () => {
            if (this.inPane === undefined) throw new Error('capture failed');
            return this.inPane === false ? undefined : this.inPane;
          },
        },
        repository: {
          read: async () => {
            if (this.targetFails) throw new Error('session file unreadable');
            return this.target;
          },
          journal: async (_id, event, data) => void this.journal.push({ event, data }),
        },
        attempts: {
          reattempt: async (_id, sendId) => {
            if (this.retypeFails) throw new Error('pane went away');
            if (this.withhold !== undefined) throw new SendRetypeWithheld('the pane said no', this.withhold);
            const current = this.records.get(sendId) as SendRecord;
            if (this.retypeFindsHeld) {
              const queued = {
                ...current,
                fate: 'queued' as const,
                queuedAt: clock.now(),
                queueProof: 'pane' as const,
              };
              this.records.set(sendId, queued);
              return queued;
            }
            this.retyped.push(sendId);
            // As the service does: a send nothing was typed for keeps its attempt — this is its first typing.
            const next = {
              ...current,
              fate: 'accepted' as const,
              attempt: current.untyped === true ? (current.attempt ?? 1) : (current.attempt ?? 1) + 1,
              attemptAt: clock.now(),
            };
            delete (next as { deadlineAt?: string }).deadlineAt;
            delete (next as { untyped?: boolean }).untyped;
            this.records.set(sendId, next);
            return next;
          },
          // The service's own re-checks are its to test; here an Enter either takes or it does not.
          resubmit: async (_id, sendId) => {
            const current = this.records.get(sendId) as SendRecord;
            if (this.resubmitDeclines) return current;
            this.resubmitted.push(sendId);
            const counted = { ...current, submitNudges: (current.submitNudges ?? 0) + 1 };
            // An Enter that takes re-opens an unconfirmed send, as the service's `entered` does.
            const entered = { ...counted, attemptAt: clock.now() };
            if (entered.fate === 'unaccounted') {
              entered.fate = 'accepted';
              delete (entered as { unaccountedReason?: string }).unaccountedReason;
            }
            this.records.set(sendId, this.enterTakes ? entered : counted);
            if (this.enterTakes) this.inPane = false;
            return this.records.get(sendId);
          },
        },
        notifier: {
          notify: async (sender, recipient, entry) => {
            this.notices.push({ sender, recipient, record: entry });
            if (this.noticeFails) throw new Error('sender unreachable');
            this.told.add(`send-failed:${recipient}:${entry.sendId}`);
          },
        },
        scheduler: {
          schedule: (id, delayMs, run) => void this.scheduled.push({ id, delayMs, run }),
          cancelAll: () => {
            this.cancelled += 1;
          },
        },
        roster: { sessions: () => this.roster },
        serial,
        clock,
      },
      defaultSendTrackerSettings,
    );
  }

  evidence(observer: TranscriptInputObserver, records: readonly unknown[]): void {
    this.reading = { readable: true, inputs: observe(observer, records) };
  }

  get only(): SendRecord {
    return this.records.get('send-1') as SendRecord;
  }

  get events(): string[] {
    return this.journal.map(entry => entry.event);
  }

  /** Runs the look the tracker last asked the scheduler for — what the daemon's timer would do — and lets it finish. */
  async fireScheduled(): Promise<void> {
    const next = this.scheduled.pop();
    if (next === undefined) throw new Error('nothing was scheduled');
    this.scheduled.length = 0;
    next.run();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }

  async checkAt(ms: number): Promise<void> {
    this.nowMs = T0 + ms;
    await this.tracker.check(ID);
  }
}

describe('proving a send delivered', () => {
  it('cites the Claude user record that carries it, and never claims a record twice', async () => {
    const world = new World(record(), record({ sendId: 'send-2', acceptedAt: at(500), attemptAt: at(500) }));
    world.evidence(new ClaudeObservedInputObserver(), [
      claude.user('ship it now please', -60_000, 'older'),
      claude.user('ship it now please', 400, 'first'),
      claude.user('ship it now please', 900, 'second'),
    ]);

    await world.checkAt(1_000);

    should(world.only).match({
      fate: 'delivered',
      fateAt: at(1_000),
      evidence: { key: 'first', kind: 'chat.user', proof: 'normal-user-record', tier: 'exact-text', matchedTurn: 4 },
    });
    should(world.records.get('send-2')?.evidence?.key).equal('second');
    should(world.events).eql(['control.send_delivered', 'control.send_delivered']);
    should(world.scheduled).be.empty();
  });

  it('proves a Codex send from its response_item, a drained Claude queue, and a turn-file instruction', async () => {
    const codexWorld = new World(record());
    codexWorld.evidence(new CodexObservedInputObserver(), [codex.user('ship it now please', 300, 'item-1')]);
    await codexWorld.checkAt(1_000);
    const drained = new World(record({ path: 'native-inline' }));
    drained.evidence(new ClaudeObservedInputObserver(), [
      claude.remove('ship it now please', 700),
      claude.drained('ship it now please', 800),
    ]);
    await drained.checkAt(1_000);
    const turnFile = new World(record({ path: 'turn-file', matchText: 'Read /state/turns/turn-004.md and do it' }));
    turnFile.evidence(new ClaudeObservedInputObserver(), [
      claude.user('<ide_context/>\nRead /state/turns/turn-004.md and do it', 300),
    ]);
    await turnFile.checkAt(1_000);

    should(codexWorld.only.evidence).match({ key: 'item-1', kind: 'response_item', harness: 'codex' });
    should(drained.only.evidence).match({ kind: 'queued_command', proof: 'native-queue-drain' });
    should(turnFile.only.evidence?.tier).equal('turn-instruction');
  });

  it('does not let a short message be proven by a longer record that merely contains it', async () => {
    const world = new World(record({ message: 'ok', matchText: 'ok' }));
    world.evidence(new ClaudeObservedInputObserver(), [claude.user('ok, but first explain why', 300)]);
    await world.checkAt(1_000);

    should(world.only.fate).equal('accepted');
    should(world.scheduled.at(-1)?.delayMs).equal(59_000);
  });
});

describe('proving a send queued', () => {
  it('moves to queued on Claude’s own enqueue record, then delivered once dequeued into a user turn', async () => {
    const world = new World(record({ path: 'native-inline' }));
    world.evidence(new ClaudeObservedInputObserver(), [claude.enqueue('ship it now please', 200)]);
    await world.checkAt(1_000);
    const queued = world.only;
    world.evidence(new ClaudeObservedInputObserver(), [
      claude.enqueue('ship it now please', 200),
      claude.dequeue('ship it now please', 5_000),
      claude.user('ship it now please', 5_001, 'later'),
    ]);
    await world.checkAt(6_000);

    should(queued).match({ fate: 'queued', queueProof: 'transcript', queuedAt: at(200) });
    should(world.only).match({ fate: 'delivered', evidence: { key: 'later' } });
    should(world.events).eql(['control.send_queued', 'control.send_delivered']);
  });

  it('never calls a send queued on a busy pane alone', async () => {
    const world = new World(record({ path: 'native-inline' }));
    world.pane = pane({ activeWork: true, promptReady: false });
    await world.checkAt(1_000);

    should(world.only.fate).equal('accepted');
  });
});

describe('a send past its deadline', () => {
  it('waits, without spending an attempt, while Claude is still holding it behind a busy turn', async () => {
    const world = new World(record({ path: 'native-inline' }));
    world.pane = pane({ activeWork: true, promptReady: false });
    world.evidence(new ClaudeObservedInputObserver(), [claude.enqueue('ship it now please', 200)]);

    await world.checkAt(61_000);

    should(world.only).match({ fate: 'queued', attempt: 1, deadlineAt: at(121_000) });
    should(world.retyped).be.empty();
    should(world.scheduled.at(-1)?.delayMs).equal(60_000);
  });

  it('waits while a Codex pane still shows the message held in its queue', async () => {
    const world = new World(record({ path: 'native-inline', fate: 'queued', queueProof: 'pane' }));
    world.pane = pane({ activeWork: true, promptReady: false });
    world.inPane = 'queue';
    world.evidence(new CodexObservedInputObserver(), []);

    await world.checkAt(61_000);

    should(world.only).match({ fate: 'queued', deadlineAt: at(121_000) });
  });

  it('reports a message held past the ceiling as unconfirmed, never as lost', async () => {
    const world = new World(record({ fate: 'queued', deadlineAt: at(7_200_000) }));
    world.inPane = 'queue';

    await world.checkAt(7_200_000);

    should(world.only).match({ fate: 'unaccounted', unaccountedReason: 'timeout', retryable: false });
  });

  it('re-attempts a human send ONCE when proven absent, then times it out with a retry offered', async () => {
    const world = new World(record());
    world.evidence(new ClaudeObservedInputObserver(), []);

    await world.checkAt(60_000);
    const retried = world.only;
    await world.checkAt(120_000);

    should(retried).match({ fate: 'accepted', attempt: 2 });
    should(world.retyped).eql(['send-1']);
    should(world.only).match({ fate: 'timed_out', unaccountedReason: 'not_delivered', retryable: true, attempt: 2 });
    should(world.events).eql(['control.send_timed_out']);
    should(world.notices).be.empty();
  });

  it('names a Claude queue entry let go of without a user turn as discarded', async () => {
    const world = new World(record({ path: 'native-inline', attempt: 2 }));
    world.evidence(new ClaudeObservedInputObserver(), [
      claude.enqueue('ship it now please', 200),
      claude.remove('ship it now please', 400),
    ]);

    await world.checkAt(120_000);

    should(world.only).match({ fate: 'timed_out', unaccountedReason: 'composer_discarded' });
  });

  it('times out at once when the retype itself could not be made', async () => {
    const world = new World(record());
    world.retypeFails = true;

    await world.checkAt(60_000);

    should(world.only).match({ fate: 'timed_out', attempt: 1 });
  });

  it('waits — never settles — while a long transcript is still being read, then proves the send', async () => {
    const world = new World(record());
    world.reading = { readable: false, catchingUp: true, inputs: [] };

    await world.checkAt(60_000);
    should(world.only).match({ fate: 'accepted', attempt: 1 });
    should(world.events).not.containEql('control.send_unaccounted');
    should(world.retyped).be.empty();

    world.evidence(new ClaudeObservedInputObserver(), [claude.user('ship it now please', 30_000)]);
    await world.checkAt(130_000);
    should(world.only.fate).equal('delivered');
  });

  it('cannot prove absence from an unreadable transcript, a failed pane read, or a failed capture', async () => {
    const unreadable = new World(record());
    unreadable.reading = { readable: false, inputs: [] };
    await unreadable.checkAt(60_000);
    const thrown = new World(record());
    thrown.readFails = true;
    await thrown.checkAt(60_000);
    const noPane = new World(record());
    noPane.pane = undefined;
    await noPane.checkAt(60_000);
    const noCapture = new World(record());
    noCapture.inPane = undefined;
    await noCapture.checkAt(60_000);

    should(unreadable.only).match({
      fate: 'unaccounted',
      unaccountedReason: 'transcript_unreadable',
      retryable: false,
    });
    should(thrown.only.unaccountedReason).equal('transcript_unreadable');
    should(noPane.only.unaccountedReason).equal('pane_unreadable');
    should(noCapture.only.unaccountedReason).equal('pane_unreadable');
    should(unreadable.events).eql(['control.send_unaccounted']);
  });

  it('says a dialog on screen blocked the send, rather than that the transcript was unreadable', async () => {
    // A harness parked on a one-shot dialog writes no transcript at all: "unreadable" was true and useless.
    const NUDGE = 'Make auto mode your default permission mode?';
    const noTranscript = new World(record());
    noTranscript.reading = { readable: false, inputs: [] };
    noTranscript.pane = pane({ promptReady: false, blockingPrompt: NUDGE });
    await noTranscript.checkAt(60_000);
    // With a transcript, the dialog still means nothing will land — and a retype would type into it.
    const readable = new World(record());
    readable.pane = pane({ promptReady: false, blockingPrompt: NUDGE });
    await readable.checkAt(60_000);
    // An unreadable transcript whose pane cannot be read either stays what it was.
    const blind = new World(record());
    blind.reading = { readable: false, inputs: [] };
    blind.pane = undefined;
    await blind.checkAt(60_000);

    should(noTranscript.only).match({ fate: 'unaccounted', unaccountedReason: 'blocked_by_prompt', retryable: false });
    should(readable.only).match({ fate: 'unaccounted', unaccountedReason: 'blocked_by_prompt', attempt: 1 });
    should(blind.only.unaccountedReason).equal('transcript_unreadable');
  });

  it('says the transcript was never proven, which a restart fixes and a re-send does not', async () => {
    // The owner's Codex session: typed into the pane, answered there, and no rollout it could prove.
    const unbound = new World(record());
    unbound.reading = { readable: false, unbound: true, inputs: [] };
    await unbound.checkAt(60_000);
    // A dialog on screen is still the more useful thing to say.
    const blocked = new World(record());
    blocked.reading = { readable: false, unbound: true, inputs: [] };
    blocked.pane = pane({ promptReady: false, blockingPrompt: 'Trust this folder?' });
    await blocked.checkAt(60_000);

    should(unbound.only).match({ fate: 'unaccounted', unaccountedReason: 'transcript_unbound', retryable: false });
    should(blocked.only.unaccountedReason).equal('blocked_by_prompt');
  });

  it('calls a typed send whose session ended or whose pane is gone unconfirmed, never not delivered', async () => {
    // A harness queue holding it at a restart delivers it all the same: the lead read tremaine's
    // message on 2026-10-30, and the owner's phone said "not delivered".
    const ended = new World(record());
    ended.target = { id: ID, status: 'stopped', mode: 'auto', turn: 4 };
    await ended.checkAt(60_000);
    const vanished = new World(record());
    vanished.target = undefined;
    await vanished.checkAt(60_000);
    const dead = new World(record());
    dead.pane = pane({ dead: true });
    await dead.checkAt(60_000);

    for (const world of [ended, vanished, dead])
      should(world.only).match({ fate: 'unaccounted', unaccountedReason: 'ferret_ended', retryable: false });
  });

  it('times out a send nothing was ever typed for when its session ends: that one is proven absent', async () => {
    const world = new World(record({ untyped: true }));
    world.target = { id: ID, status: 'stopped', mode: 'auto', turn: 4 };

    await world.checkAt(60_000);

    should(world.only).match({ fate: 'timed_out', unaccountedReason: 'ferret_ended', retryable: false });
  });
});

describe('an agent-to-agent send', () => {
  const agentSend = () => record({ senderKind: 'agent', from: SENDER, fromName: 'hadi' });

  it('re-attempts at about 15 s, 30 s and 60 s, only while proven absent, then tells the sender', async () => {
    const world = new World(agentSend());
    world.evidence(new CodexObservedInputObserver(), []);

    await world.checkAt(15_000);
    should(world.scheduled.at(-1)?.delayMs).equal(2_000);
    await world.checkAt(30_000);
    await world.checkAt(60_000);
    await world.checkAt(75_000);

    should(world.retyped).eql(['send-1', 'send-1', 'send-1']);
    should(world.only).match({ fate: 'timed_out', attempt: 4, unaccountedReason: 'not_delivered' });
    should(world.notices).have.length(1);
    should(world.notices[0]).match({ sender: SENDER, recipient: ID, record: { fate: 'timed_out' } });
  });

  it('stops re-attempting the moment the transcript proves it arrived', async () => {
    const world = new World(agentSend());
    world.evidence(new CodexObservedInputObserver(), []);
    await world.checkAt(15_000);
    world.evidence(new CodexObservedInputObserver(), [codex.user('ship it now please', 16_000)]);
    await world.checkAt(30_000);

    should(world.retyped).eql(['send-1']);
    should(world.only.fate).equal('delivered');
    should(world.notices).be.empty();
  });

  it('tells the sender when its message could be proven neither way', async () => {
    const world = new World(agentSend());
    world.reading = { readable: false, inputs: [] };

    await world.checkAt(15_000);

    should(world.notices[0]?.record).match({ fate: 'unaccounted', unaccountedReason: 'transcript_unreadable' });
  });
});

describe('a combined send that fails', () => {
  const combined = () =>
    record({
      senderKind: 'agent',
      from: SENDER,
      batch: [
        { queueId: 'send-1', from: SENDER },
        { queueId: 'q-2', from: 'session-3' },
        { queueId: 'q-3', from: SENDER },
      ],
    });

  it('tells every sender whose message was in it, each under its own message id', async () => {
    const world = new World(combined());
    world.reading = { readable: false, inputs: [] };

    await world.checkAt(15_000);

    should(world.notices.map(notice => [notice.sender, notice.record.sendId])).eql([
      [SENDER, 'send-1'],
      ['session-3', 'q-2'],
      [SENDER, 'q-3'],
    ]);
    should(world.notices.every(notice => notice.record.fate === 'unaccounted')).be.true();
  });

  it('tells them once more after a restart re-derives the failure, under the same ids so the notice dedupes', async () => {
    const world = new World(combined());
    world.reading = { readable: false, inputs: [] };
    await world.checkAt(15_000);
    const first = world.notices.map(notice => notice.record.sendId);
    world.notices.length = 0;
    world.records.set('send-1', combined());

    await world.checkAt(15_000);

    should(world.notices.map(notice => notice.record.sendId)).eql(first);
  });

  it('still tells the one sender of an ordinary send', async () => {
    const world = new World(record({ senderKind: 'agent', from: SENDER }));
    world.reading = { readable: false, inputs: [] };

    await world.checkAt(15_000);

    should(world.notices.map(notice => [notice.sender, notice.record.sendId])).eql([[SENDER, 'send-1']]);
  });
});

describe('a failure notice a crash interrupted', () => {
  const owedAll = [
    { from: SENDER, sendId: 'send-1' },
    { from: 'session-3', sendId: 'q-2' },
    { from: SENDER, sendId: 'q-3' },
  ];
  const combined = () =>
    record({
      senderKind: 'agent',
      from: SENDER,
      batch: [
        { queueId: 'send-1', from: SENDER },
        { queueId: 'q-2', from: 'session-3' },
        { queueId: 'q-3', from: SENDER },
      ],
    });
  // A revive-carried send has no composer to look in, so the only look it asks for is the debt's own.
  const quiet = () => ({ ...combined(), path: 'revive' as const });
  const keys = (...sendIds: string[]) => sendIds.map(sendId => `send-failed:${ID}:${sendId}`);
  const reboot = async (world: World) => {
    world.notices.length = 0;
    world.crashOnCrossOff = undefined;
    world.noticeFails = false;
    await world.tracker.check(ID);
  };

  it('writes the debt with the fate, so a notice that cannot be sent is still owed afterwards', async () => {
    const world = new World(combined());
    world.reading = { readable: false, inputs: [] };
    world.noticeFails = true;

    await world.checkAt(15_000);

    should(world.only).match({ fate: 'unaccounted' });
    should(world.only.noticesOwed).eql(owedAll);
    should(world.told.size).equal(0);
  });

  it('crash after the fate, before any notice: a reboot tells every member once and clears the debt', async () => {
    const world = new World(combined());
    world.reading = { readable: false, inputs: [] };
    world.noticeFails = true;
    await world.checkAt(15_000);
    world.notices.length = 0;
    world.noticeFails = false;

    await world.tracker.check(ID);

    should(world.notices.map(notice => [notice.sender, notice.record.sendId])).eql([
      [SENDER, 'send-1'],
      ['session-3', 'q-2'],
      [SENDER, 'q-3'],
    ]);
    should(world.notices.every(notice => notice.record.fate === 'unaccounted')).be.true();
    should([...world.told]).eql(keys('send-1', 'q-2', 'q-3'));
    should(world.only.noticesOwed).be.undefined();
  });

  it('crash mid-loop: a reboot tells only the members not yet crossed off, and nobody twice', async () => {
    const world = new World(combined());
    world.reading = { readable: false, inputs: [] };
    world.crashOnCrossOff = 2;
    await world.checkAt(15_000).catch(() => undefined);
    // send-1 was told and crossed off; q-2 was told but the daemon died before it was crossed off.
    should(world.only.noticesOwed).eql(owedAll.slice(1));
    should([...world.told]).eql(keys('send-1', 'q-2'));

    await reboot(world);

    should(world.notices.map(notice => notice.record.sendId)).eql(['q-2', 'q-3']);
    should([...world.told]).eql(keys('send-1', 'q-2', 'q-3'));
    should(world.only.noticesOwed).be.undefined();
  });

  it('a boot that finds nothing owed stays quiet, however many times it looks', async () => {
    const world = new World(combined());
    world.reading = { readable: false, inputs: [] };
    await world.checkAt(15_000);
    world.notices.length = 0;

    await world.tracker.check(ID);
    await world.tracker.check(ID);

    should(world.notices).be.empty();
  });

  it('keeps quiet for final records that owe nothing, and for one delivered after the failure was written', async () => {
    const settled = record({ sendId: 'a', senderKind: 'agent', from: SENDER, fate: 'timed_out', fateAt: at(10_000) });
    const delivered = record({
      sendId: 'b',
      senderKind: 'agent',
      from: SENDER,
      fate: 'delivered',
      noticesOwed: [{ from: SENDER, sendId: 'b' }],
    });
    const world = new World(settled, delivered);

    await world.tracker.check(ID);

    should(world.notices).be.empty();
  });

  it('crosses a debt off when the send turns out to have been delivered', async () => {
    const world = new World(combined());
    world.reading = { readable: false, inputs: [] };
    world.noticeFails = true;
    await world.checkAt(15_000);
    world.evidence(new ClaudeObservedInputObserver(), [claude.user('ship it now please', 400, 'late')]);
    world.notices.length = 0;
    world.noticeFails = false;

    await world.checkAt(16_000);

    should(world.only.fate).equal('delivered');
    should(world.only.noticesOwed).be.undefined();
    should(world.notices).be.empty();
  });

  it('keeps a look scheduled while a notice is unsent, and pays each member once when the scheduled look runs', async () => {
    const world = new World(quiet());
    world.reading = { readable: false, inputs: [] };
    world.noticeFails = true;

    await world.checkAt(15_000);

    should(world.only.noticesOwed).eql(owedAll);
    should(world.scheduled.map(entry => [entry.id, entry.delayMs])).eql([[ID, 60_000]]);

    world.noticeFails = false;
    world.notices.length = 0;
    await world.fireScheduled();

    should(world.notices.map(notice => notice.record.sendId)).eql(['send-1', 'q-2', 'q-3']);
    should([...world.told]).eql(keys('send-1', 'q-2', 'q-3'));
    should(world.only.noticesOwed).be.undefined();
    should(world.scheduled).be.empty();
  });

  it('retries a partly paid debt without telling anyone twice, and stops once it is cleared', async () => {
    const world = new World(quiet());
    world.reading = { readable: false, inputs: [] };
    world.crashOnCrossOff = 2;
    await world.checkAt(15_000).catch(() => undefined);
    world.crashOnCrossOff = undefined;
    world.notices.length = 0;
    world.scheduled.length = 0;
    world.noticeFails = true;

    await world.tracker.check(ID).catch(() => undefined);
    world.scheduled.splice(0, world.scheduled.length - 1);
    world.noticeFails = false;
    world.notices.length = 0;
    await world.fireScheduled();

    should(world.notices.map(notice => notice.record.sendId)).eql(['q-2', 'q-3']);
    should([...world.told]).eql(keys('send-1', 'q-2', 'q-3'));
    should(world.only.noticesOwed).be.undefined();
    should(world.scheduled).be.empty();
  });

  it('backs off between retries, gives up scheduling after a bounded number, and a later look still pays', async () => {
    const world = new World(quiet());
    world.reading = { readable: false, inputs: [] };
    world.noticeFails = true;
    await world.checkAt(15_000);
    const delays = [world.scheduled.at(-1)?.delayMs];

    for (let retry = 0; retry < OWED_NOTICE_RETRY_LIMIT; retry += 1) {
      await world.fireScheduled().catch(() => undefined);
      delays.push(world.scheduled.at(-1)?.delayMs);
    }

    should(delays).eql([60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, undefined]);
    should(world.scheduled).be.empty();
    should(world.only.noticesOwed).eql(owedAll);
    should(await world.tracker.watching(ID)).be.true();

    world.noticeFails = false;
    world.notices.length = 0;
    await world.tracker.check(ID);

    should([...world.told]).eql(keys('send-1', 'q-2', 'q-3'));
    should(world.only.noticesOwed).be.undefined();
    should(world.scheduled).be.empty();
  });

  it('pays an old debt found at boot from the scheduled look once the notifier recovers, however old the send', async () => {
    const world = new World({ ...quiet(), fate: 'unaccounted', fateAt: at(15_000), noticesOwed: owedAll });
    world.nowMs = T0 + 4 * 24 * 60 * 60_000;
    world.noticeFails = true;

    should(await world.tracker.watching(ID)).be.true();
    await world.tracker.check(ID);

    should(world.notices).have.length(3);
    should(world.only.noticesOwed).eql(owedAll);
    should(world.scheduled.map(entry => entry.delayMs)).eql([60_000]);

    world.noticeFails = false;
    world.notices.length = 0;
    await world.fireScheduled();

    should(world.notices.map(notice => notice.record.sendId)).eql(['send-1', 'q-2', 'q-3']);
    should([...world.told]).eql(keys('send-1', 'q-2', 'q-3'));
    should(world.only.noticesOwed).be.undefined();
    should(world.scheduled).be.empty();
    should(await world.tracker.watching(ID)).be.false();
  });

  it('keeps a debt it cannot read owed, and looks again once the ledger is readable', async () => {
    const world = new World({ ...quiet(), fate: 'unaccounted', fateAt: at(15_000), noticesOwed: owedAll });
    world.nowMs = T0 + 15_000;
    world.listFails = true;

    await world.tracker.check(ID).catch(() => undefined);

    should(world.notices).be.empty();
    should(world.scheduled.length).be.above(0);
    should(world.scheduled.every(entry => entry.delayMs === 60_000)).be.true();

    world.listFails = false;
    await world.fireScheduled();

    should(world.only.noticesOwed).be.undefined();
    should(world.scheduled).be.empty();
  });

  it('schedules nothing for a debt that is paid on the first look', async () => {
    const world = new World(quiet());
    world.reading = { readable: false, inputs: [] };

    await world.checkAt(15_000);

    should(world.only.noticesOwed).be.undefined();
    should(world.scheduled).be.empty();
  });

  it('schedules nothing from a look still in flight when it is disarmed, and schedules again once re-armed', async () => {
    const world = new World({ ...quiet(), fate: 'unaccounted', fateAt: at(15_000), noticesOwed: owedAll });
    world.nowMs = T0 + 15_000;
    world.noticeFails = true;
    world.holdLooks = true;

    const disarm = world.tracker.arm();
    await Bun.sleep(0);
    disarm();
    while (world.holds.length > 0) {
      world.holds.shift()?.();
      await Bun.sleep(0);
    }

    should(world.notices).have.length(3);
    should(world.scheduled).be.empty();
    world.tracker.track(ID);
    should(world.scheduled).be.empty();

    world.holdLooks = false;
    world.tracker.arm();
    await Bun.sleep(0);
    should(world.scheduled.map(entry => entry.delayMs)).eql([60_000]);
    should(world.scheduled).have.length(1);
    world.tracker.track(ID);
    should(world.scheduled.at(-1)?.delayMs).equal(2_000);
  });
});

describe('a message a revive carried', () => {
  const pointer = turnFileInstruction('/state/sessions/session-1/turns/turn-004.md');
  const revived = (overrides: Partial<SendRecord> = {}) =>
    record({ path: 'revive', senderKind: 'agent', from: SENDER, matchText: pointer, ...overrides });

  it('is proven by the pointer the relaunch typed, at the turn-instruction tier', async () => {
    const world = new World(revived());
    world.evidence(new ClaudeObservedInputObserver(), [claude.user(pointer, 2_300)]);

    await world.checkAt(2_000);

    should(world.only).match({
      fate: 'delivered',
      evidence: { tier: 'turn-instruction', proof: 'normal-user-record' },
    });
  });

  it('is not judged before the relaunch window ends while the relaunch has not said what it typed', async () => {
    const world = new World(revived({ matchText: undefined }));
    world.evidence(new ClaudeObservedInputObserver(), []);

    await world.checkAt(60_000);

    should(world.only.fate).equal('accepted');
    should(world.scheduled.at(-1)?.delayMs).equal(defaultSendTrackerSettings.reviveLaunchMs - 60_000);
  });

  it('is unconfirmed — never re-typed, never "not delivered" — once its window passes unproven', async () => {
    const world = new World(revived());
    world.evidence(new ClaudeObservedInputObserver(), []);

    await world.checkAt(15_000);

    should(world.retyped).be.empty();
    should(world.only).match({ fate: 'unaccounted', unaccountedReason: 'revive_unconfirmed', retryable: false });
    should(world.notices[0]?.record).match({ fate: 'unaccounted', unaccountedReason: 'revive_unconfirmed' });
  });

  it('is unconfirmed even when the relaunched session has already finished', async () => {
    // The agent read the turn and wrote its done marker before the look: not "session ended".
    const world = new World(revived());
    world.evidence(new ClaudeObservedInputObserver(), []);
    world.target = { id: ID, status: 'completed', mode: 'auto', turn: 4 };
    world.pane = pane({ alive: false, dead: true });

    await world.checkAt(15_000);

    should(world.only).match({ fate: 'unaccounted', unaccountedReason: 'revive_unconfirmed' });
  });

  it('waits while its pointer is still visibly typed in the composer', async () => {
    const world = new World(revived());
    world.evidence(new ClaudeObservedInputObserver(), []);
    world.inPane = 'composer';

    await world.checkAt(15_000);

    should(world.only.fate).equal('accepted');
    should(world.only.deadlineAt).equal(at(15_000 + defaultSendTrackerSettings.busyExtensionMs));
  });

  it('says a dialog is in the way when one is', async () => {
    const world = new World(revived());
    world.evidence(new ClaudeObservedInputObserver(), []);
    world.pane = pane({ blockingPrompt: 'Do you trust the files in this folder?' });

    await world.checkAt(15_000);

    should(world.only).match({ fate: 'unaccounted', unaccountedReason: 'blocked_by_prompt' });
  });
});

describe('the tracker as the daemon runs it', () => {
  it('looks soon after a transport, and re-derives every session at boot without re-typing', async () => {
    const world = new World(record({ fate: 'queued', queueProof: 'pane' }));
    world.evidence(new ClaudeObservedInputObserver(), [claude.user('ship it now please', 300)]);

    world.tracker.track(ID);
    const disarm = world.tracker.arm();
    await Bun.sleep(0);
    world.scheduled[0]?.run();
    disarm();

    should(world.scheduled[0]).match({ id: ID, delayMs: 2_000 });
    should(world.only.fate).equal('delivered');
    should(world.retyped).be.empty();
    should(world.cancelled).equal(1);
  });

  it('re-derives the sessions at boot one at a time, and stops the walk once disarmed', async () => {
    // Every session's look used to start at once, and a look can parse a window hundreds of megabytes
    // back: a restart over long conversations parsed all of them together on the event loop.
    const world = new World();
    const second = parseSessionId('session-2');
    const third = parseSessionId('session-3');
    world.roster = [ID, second, third];
    world.holdLooks = true;

    const disarm = world.tracker.arm();
    await Bun.sleep(0);
    const whileFirstRuns = [...world.looked];
    world.holds.shift()?.();
    await Bun.sleep(0);
    const afterFirst = [...world.looked];
    disarm();
    world.holds.shift()?.();
    await Bun.sleep(0);

    should(whileFirstRuns).eql([ID]);
    should(afterFirst).eql([ID, second]);
    should(world.looked).eql([ID, second]);
    should(world.cancelled).equal(1);
  });

  it('keeps watching an unconfirmed send for a late proof, and stops after the hold ceiling', async () => {
    const world = new World(record({ fate: 'unaccounted', unaccountedReason: 'transcript_unreadable' }));
    should(await world.tracker.watching(ID)).be.true();
    world.evidence(new ClaudeObservedInputObserver(), [claude.user('ship it now please', 90_000)]);
    await world.checkAt(100_000);
    should(world.only.fate).equal('delivered');

    const stale = new World(
      record({ fate: 'unaccounted', unaccountedReason: 'timeout' }),
      record({ sendId: 'held', held: true }),
    );
    stale.nowMs = T0 + 7_200_000;
    should(await stale.tracker.watching(ID)).be.false();
    await stale.checkAt(7_200_000);
    should(stale.only.fate).equal('unaccounted');
  });

  it('corrects a timed-out send the transcript proves the agent had, for as long as a repair is looked for', async () => {
    // The reader once missed Claude's drained prompts, so a message the lead had read was called absent.
    const world = new World(record({ fate: 'timed_out', unaccountedReason: 'not_delivered', retryable: true }));
    world.nowMs = T0 + 7_200_000;
    should(await world.tracker.watching(ID)).be.true();
    world.evidence(new ClaudeObservedInputObserver(), [claude.user('ship it now please', 30_000)]);

    await world.checkAt(7_200_000);

    should(world.only.fate).equal('delivered');
    should(world.only).not.have.property('retryable');

    const old = new World(record({ fate: 'timed_out', unaccountedReason: 'not_delivered' }));
    old.nowMs = T0 + defaultSendTrackerSettings.repairLimitMs;
    should(await old.tracker.watching(ID)).be.false();
  });

  it('settles nothing it could not record, and leaves a settled send alone', async () => {
    const world = new World(record({ fate: 'timed_out', unaccountedReason: 'not_delivered' }));
    await world.checkAt(60_000);
    should(world.only.fate).equal('timed_out');
    should(world.journal).be.empty();
  });
});

describe('what the pane shows, on every look', () => {
  it('says a message left typed in the composer once it has sat there a few seconds, and keeps waiting rather than retyping', async () => {
    const world = new World(record({ message: 'hi', matchText: 'hi' }));
    world.inPane = 'composer';
    world.evidence(new CodexObservedInputObserver(), []);

    await world.checkAt(2_000);
    const early = world.only;
    await world.checkAt(4_000);
    const settled = world.only;
    await world.checkAt(61_000);

    should(early.typedNotSent).be.undefined();
    should(settled).match({ fate: 'accepted', typedNotSent: true });
    should(world.only).match({ fate: 'accepted', typedNotSent: true, deadlineAt: at(121_000) });
    should(world.retyped).be.empty();
    should(world.events.filter(event => event === 'control.send_typed_not_sent')).have.length(1);
  });

  it('never says typed-not-sent for a message the harness submits within the first seconds', async () => {
    const world = new World(record({ message: 'hi', matchText: 'hi' }));
    world.inPane = 'composer';
    world.evidence(new CodexObservedInputObserver(), []);

    await world.checkAt(2_000);
    const typing = world.only;
    world.inPane = false;
    world.evidence(new CodexObservedInputObserver(), [codex.user('hi', 3_000)]);
    await world.checkAt(4_000);

    should(typing.typedNotSent).be.undefined();
    should(world.only).match({ fate: 'delivered' });
    should(Object.hasOwn(world.only, 'typedNotSent')).be.false();
    should(world.events).not.containEql('control.send_typed_not_sent');
  });

  it('looks again exactly when the text has been stable long enough, not at the far deadline', async () => {
    const world = new World(record({ message: 'hi', matchText: 'hi' }));
    world.inPane = 'composer';
    world.evidence(new CodexObservedInputObserver(), []);

    await world.checkAt(2_000);

    should(world.scheduled.at(-1)?.delayMs).equal(2_000);
  });

  it('drops the typed flag once the composer no longer holds it, and ignores a pane it cannot read', async () => {
    const world = new World(record({ typedNotSent: true }));
    world.inPane = undefined;
    world.evidence(new CodexObservedInputObserver(), []);

    await world.checkAt(2_000);
    const unread = world.only;
    world.inPane = false;
    await world.checkAt(3_000);

    should(unread.typedNotSent).be.true();
    should(world.only.typedNotSent).be.undefined();
  });

  it('calls a send queued when the pane shows it in the harness queue, with the pane as proof', async () => {
    const world = new World(record({ path: 'native-inline' }));
    world.inPane = 'queue';
    world.evidence(new CodexObservedInputObserver(), []);

    await world.checkAt(2_000);

    should(world.only).match({ fate: 'queued', queueProof: 'pane', queuedAt: at(2_000) });
  });
});

describe('a pointer of ours left typed in the composer', () => {
  const POINTER = turnFileInstruction('/state/sessions/session-1/turns/turn-004.md');
  const pointer = (overrides: Partial<SendRecord> = {}) =>
    record({ path: 'turn-file', message: 'the long message', matchText: POINTER, ...overrides });

  it('presses Enter again on a backoff, a bounded number of times, before calling it typed and not sent', async () => {
    const world = new World(pointer());
    world.inPane = 'composer';
    world.evidence(new ClaudeObservedInputObserver(), []);

    for (const ms of [2_000, 4_000, 6_000, 12_000, 30_000, 33_000]) await world.checkAt(ms);
    const beforeTyped = world.only;
    await world.checkAt(34_000);
    await world.checkAt(90_000);

    should(world.resubmitted).eql(['send-1', 'send-1', 'send-1']);
    should(beforeTyped.typedNotSent).be.undefined();
    should(world.only).match({ submitNudges: 3, typedNotSent: true });
    should(world.retyped).be.empty();
  });

  it('stops nudging the moment one takes, and the send is then proven from the transcript as usual', async () => {
    const world = new World(pointer());
    world.inPane = 'composer';
    world.enterTakes = true;
    world.evidence(new ClaudeObservedInputObserver(), []);

    await world.checkAt(4_000);
    world.evidence(new ClaudeObservedInputObserver(), [claude.user(POINTER, 4_500)]);
    await world.checkAt(6_000);

    should(world.resubmitted).eql(['send-1']);
    should(world.only).match({ fate: 'delivered', submitNudges: 1 });
    should(world.events).not.containEql('control.send_typed_not_sent');
  });

  it('looks again when the next nudge is due, and only after the deferral once one is overdue and was not pressed', async () => {
    const due = new World(pointer());
    due.inPane = 'composer';
    due.evidence(new ClaudeObservedInputObserver(), []);
    const overdue = new World(pointer({ submitNudges: 1 }));
    overdue.inPane = 'composer';
    overdue.evidence(new ClaudeObservedInputObserver(), []);
    // The service declined the press — a pane gone busy — so the nudge is still owed.
    overdue.resubmitDeclines = true;

    await due.checkAt(2_000);
    await overdue.checkAt(20_000);

    should(due.scheduled.at(-1)?.delayMs).equal(2_000);
    should(overdue.scheduled.at(-1)?.delayMs).equal(defaultSendTrackerSettings.deferredNudgeMs);
  });

  it('keeps an owed nudge after the row says typed-not-sent, so a long turn ending still gets its Enter', async () => {
    // braelynn, 2026-11-02: a message typed into her busy pane kept its swallowed Enter in the box. Every
    // nudge fell due mid-turn and was deferred; once the row said "typed, not sent" none was ever pressed,
    // and she sat idle with it there for fourteen hours after the turn ended.
    const world = new World(pointer());
    world.inPane = 'composer';
    world.resubmitDeclines = true;
    world.evidence(new ClaudeObservedInputObserver(), []);

    for (const ms of [2_000, 4_000, 12_000, 34_000, 40_000]) await world.checkAt(ms);
    should(world.only.typedNotSent).be.true();
    world.resubmitDeclines = false;
    await world.checkAt(45_000);

    should(world.resubmitted).eql(['send-1']);
  });

  it('never nudges a message typed as itself too short to tell from a word a person might have typed', async () => {
    const world = new World(record({ message: 'hi', matchText: 'hi' }));
    world.inPane = 'composer';
    world.evidence(new CodexObservedInputObserver(), []);

    for (const ms of [2_000, 4_000, 12_000, 30_000]) await world.checkAt(ms);

    should(world.resubmitted).be.empty();
    should(world.only.typedNotSent).be.true();
  });
});

describe('B144: text of ours left unsubmitted, the ferret idle', () => {
  const POINTER = turnFileInstruction('/state/sessions/session-1/turns/turn-063.md');
  const unconfirmed = (overrides: Partial<SendRecord> = {}) =>
    record({
      path: 'turn-file',
      message: 'the long message',
      matchText: POINTER,
      senderKind: 'agent',
      from: SENDER,
      fate: 'unaccounted',
      unaccountedReason: 'landing_unconfirmed',
      fateAt: at(25_000),
      ...overrides,
    });

  it('presses Enter on an unconfirmed pointer that turns up in the composer after the fill gave up', async () => {
    // annabeth, 2026-11-02 15:00: the fill typed her turn pointer into a stalled pane, saw nothing within its
    // window, and settled it unconfirmed. The pointer was drawn later; nothing ever pressed Enter on it.
    const world = new World(unconfirmed());
    world.evidence(new ClaudeObservedInputObserver(), []);
    world.inPane = false;
    await world.checkAt(27_000);
    should(world.resubmitted).be.empty();
    should(world.scheduled.at(-1)?.delayMs).equal(defaultSendTrackerSettings.busyExtensionMs);

    world.inPane = 'composer';
    world.enterTakes = true;
    await world.checkAt(87_000);

    should(world.resubmitted).eql(['send-1']);
    should(world.only).match({ fate: 'accepted', submitNudges: 1 });
    should(world.retyped).be.empty();
  });

  it('presses at most the bounded number of times while the Enter does not take, then leaves it to the Warden', async () => {
    const world = new World(unconfirmed());
    world.inPane = 'composer';
    world.evidence(new ClaudeObservedInputObserver(), []);

    for (const ms of [27_000, 29_000, 31_000, 33_000, 35_000, 60_000]) await world.checkAt(ms);

    should(world.resubmitted).eql(['send-1', 'send-1', 'send-1']);
    should(world.only).match({ fate: 'unaccounted', submitNudges: 3 });
    should(world.retyped).be.empty();
  });

  it('stops looking once its keys could no longer plausibly be arriving', async () => {
    const world = new World(unconfirmed());
    world.inPane = false;
    world.evidence(new ClaudeObservedInputObserver(), []);

    await world.checkAt(defaultSendTrackerSettings.strandedWatchMs + 1_000);

    should(world.scheduled).be.empty();
    should(world.resubmitted).be.empty();
  });

  it('keeps looking at a send settled unconfirmed at the hold ceiling with its text still in the box (review)', async () => {
    const world = new World(
      record({ path: 'native-inline', message: 'please re-run the suite', matchText: 'please re-run the suite' }),
    );
    world.inPane = 'composer';
    world.resubmitDeclines = true;
    world.pane = pane({ activeWork: true });
    world.target = { id: ID, status: 'running', mode: 'auto', turn: 4, turnState: 'working', turnStateAt: at(0) };
    world.evidence(new ClaudeObservedInputObserver(), []);

    await world.checkAt(defaultSendTrackerSettings.holdLimitMs + 1_000);

    should(world.only).match({ fate: 'unaccounted', typedNotSent: true });
    should(world.scheduled.at(-1)?.delayMs).equal(defaultSendTrackerSettings.busyExtensionMs);
  });

  it('presses Enter on a long message typed as itself once its nudge is due', async () => {
    const world = new World(
      record({ path: 'native-inline', message: 'please re-run the suite', matchText: 'please re-run the suite' }),
    );
    world.inPane = 'composer';
    world.enterTakes = true;
    world.evidence(new ClaudeObservedInputObserver(), []);

    await world.checkAt(2_000);
    should(world.resubmitted).be.empty();
    await world.checkAt(4_000);

    should(world.resubmitted).eql(['send-1']);
  });

  it('never presses for a send that was never typed, or one settled for good', async () => {
    const world = new World(
      unconfirmed({ sendId: 'untyped', fate: 'accepted', untyped: true, senderKind: 'human' }),
      unconfirmed({ sendId: 'gone', fate: 'cancelled' }),
    );
    world.inPane = 'composer';
    world.evidence(new ClaudeObservedInputObserver(), []);

    await world.checkAt(30_000);

    should(world.resubmitted).be.empty();
  });
});

describe('a message the harness received joined to its neighbour', () => {
  it('proves each half of `hihello` by the one record, in order, and never a part on its own', async () => {
    const hi = record({ sendId: 'send-1', message: 'hi', matchText: 'hi' });
    const hello = record({ sendId: 'send-2', message: 'hello', matchText: 'hello', acceptedAt: at(1_000) });
    const world = new World(hi, hello);
    world.evidence(new CodexObservedInputObserver(), [codex.user('hihello', 1_500)]);

    await world.checkAt(2_000);

    should(world.records.get('send-1')).match({ fate: 'delivered', evidence: { tier: 'merged-text' } });
    should(world.records.get('send-2')).match({ fate: 'delivered', evidence: { tier: 'merged-text' } });
  });

  it('refuses a join that is not exactly consecutive sends, or that predates one of them', async () => {
    const hi = record({ sendId: 'send-1', message: 'hi', matchText: 'hi' });
    const hello = record({ sendId: 'send-2', message: 'hello', matchText: 'hello', acceptedAt: at(60_000) });
    const world = new World(hi, hello);
    world.evidence(new CodexObservedInputObserver(), [codex.user('hihello', 1_000), codex.user('hixyz', 1_200)]);

    await world.checkAt(2_000);

    should(world.records.get('send-1')?.fate).equal('accepted');
    should(world.records.get('send-2')?.fate).equal('accepted');
  });
});

describe('a look that fails', () => {
  it('still schedules the next look, so an open send is never left with nobody coming back to it', async () => {
    // Arrange — the deadline has passed and the session file cannot be read.
    const world = new World(record());
    world.targetFails = true;

    // Act
    const failed = await world.checkAt(61_000).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    const retry = world.scheduled.at(-1);
    world.targetFails = false;
    world.target = undefined;
    retry?.run();
    await new Promise(resolve => setTimeout(resolve, 0));

    // Assert
    should((failed as Error).message).equal('session file unreadable');
    should(retry?.delayMs).equal(defaultSendTrackerSettings.busyExtensionMs);
    should(world.only.fate).equal('unaccounted');
    should(world.only.unaccountedReason).equal('ferret_ended');
  });
});

describe('a ledger read that asks for a look first', () => {
  const tracker = (watching: boolean, look: () => Promise<void>) => {
    const looked: string[] = [];
    return {
      looked,
      port: {
        watching: async () => watching,
        check: async (id: SessionId) => {
          looked.push(id);
          await look();
        },
      },
    };
  };

  it('looks first and waits for a look that finishes inside the budget', async () => {
    // Arrange
    let settled = false;
    const { port, looked } = tracker(true, async () => {
      settled = true;
    });

    // Act
    await lookBeforeReading(port, ID, () => new Promise(() => undefined));

    // Assert
    should(looked).eql([ID]);
    should(settled).be.true();
  });

  it('answers once the budget is spent, leaving a slow look to finish by itself', async () => {
    // Arrange
    const waited: number[] = [];
    const { port } = tracker(true, () => new Promise(() => undefined));

    // Act
    await lookBeforeReading(port, ID, async milliseconds => void waited.push(milliseconds));

    // Assert
    should(waited).eql([SEND_READ_LOOK_BUDGET_MS]);
  });

  it('answers at once for a look that throws, and takes none when nothing is open', async () => {
    // Arrange
    const failing = tracker(true, async () => {
      throw new Error('pane gone');
    });
    const idle = tracker(false, async () => undefined);
    const never = () => new Promise<void>(() => undefined);

    // Act
    await lookBeforeReading(failing.port, ID, never, 10);
    await lookBeforeReading(idle.port, ID, never);

    // Assert
    should(failing.looked).eql([ID]);
    should(idle.looked).eql([]);
  });
});

describe('a send the harness recorded with a placeholder in it', () => {
  const PATH = '/state/attachments/a1/shot.png';
  const typed = `[from hadi] please look at the failing layout test\n\nAttached files — open them from these paths:\n- ${PATH} (image/png)`;
  const sent = () => record({ message: typed, matchText: typed });

  it('is proven by a record where Claude turned the attached image path into [Image #5]', async () => {
    const world = new World(sent());
    world.evidence(new ClaudeObservedInputObserver(), [
      claude.user(typed.replace(PATH, '[Image #5]'), 400, 'with-image'),
    ]);

    await world.checkAt(1_000);

    should(world.only).match({ fate: 'delivered', evidence: { key: 'with-image' } });
  });

  it('is proven when the image is its own text block and the typed text arrives whole after it', async () => {
    const world = new World(sent());
    world.evidence(new ClaudeObservedInputObserver(), [
      {
        type: 'user',
        uuid: 'blocks',
        timestamp: at(400),
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '[Image #5]' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            { type: 'text', text: typed },
          ],
        },
      },
    ]);

    await world.checkAt(1_000);

    should(world.only).match({ fate: 'delivered', evidence: { key: 'blocks' } });
  });

  it('is proven when the placeholder leads and the record is wrapped across lines', async () => {
    const world = new World(sent());
    world.evidence(new ClaudeObservedInputObserver(), [
      claude.user(`[Image #5]\n${typed.replace(PATH, '[Image #5]').replaceAll(' ', '\n')}`, 400, 'wrapped'),
    ]);

    await world.checkAt(1_000);

    should(world.only.fate).equal('delivered');
  });

  it('is proven through a drained queue entry carrying the placeholder, and seen as held by its enqueue', async () => {
    const world = new World(record({ ...sent(), path: 'native-inline' }));
    world.evidence(new ClaudeObservedInputObserver(), [claude.enqueue(typed.replace(PATH, '[Image #5]'), 200)]);
    await world.checkAt(1_000);
    const held = world.only;
    world.evidence(new ClaudeObservedInputObserver(), [
      claude.enqueue(typed.replace(PATH, '[Image #5]'), 200),
      claude.remove(typed.replace(PATH, '[Image #5]'), 4_900),
      claude.drained(typed.replace(PATH, '[Image #5]'), 5_000),
    ]);
    await world.checkAt(6_000);

    should(held).match({ fate: 'queued', queueProof: 'transcript' });
    should(world.only).match({ fate: 'delivered', evidence: { kind: 'queued_command' } });
  });

  it('is proven when a long paste is recorded with its middle elided', async () => {
    const body = `${'line of a long report that the harness elides '.repeat(30)}the end of the report`;
    const world = new World(
      record({ message: `start of the report ${body}`, matchText: `start of the report ${body}` }),
    );
    world.evidence(new ClaudeObservedInputObserver(), [
      claude.user('start of the report [...Truncated text #1 +40 lines...] the end of the report', 400, 'elided'),
    ]);

    await world.checkAt(1_000);

    should(world.only).match({ fate: 'delivered', evidence: { key: 'elided' } });
  });

  it('is NOT proven by a different message that merely shares the start and an image', async () => {
    const world = new World(sent());
    world.evidence(new ClaudeObservedInputObserver(), [
      claude.user(
        '[from hadi] please look at the failing layout test [Image #5] and then also fix everything else',
        400,
      ),
      claude.user('[Image #5] [from hadi] please look', 500),
      claude.user('[from hadi] please look at the failing layout test and nothing was attached [Image #5]', 600),
    ]);

    await world.checkAt(1_000);

    should(world.only.fate).equal('accepted');
  });
});

/**
 * The shape Claude Code 2.1.281 recorded on 2026-10-30 for a ferret's message the lead read four times: the
 * typed text wrapped in `<pasted_content>`, re-wrapped across lines, the one path that named a real file
 * lifted out as an image with its `[Image #N]` in FRONT, and the templated paths that named no file left in.
 */
describe('a send the harness recorded as a paste it lifted an image out of', () => {
  const SHOT = '/tmp/claude-1000/mobile-inbox-after-390-neo-dark-end.png';
  const typed = [
    '[message from ferret kenton (session mvuq4mdo-e8151ebb) — not from the owner]',
    'No reply needed. To reply: fy send kenton "<reply>"',
    '',
    'Bug B23 fix is up: https://github.com/kirinnee/ferretry/pull/967',
    '',
    'Screenshots (390 and 412 wide; top and end of the list):',
    '  before: /tmp/claude-1000/mobile-inbox-before-<390|412>-<theme>-<top|end>.png',
    '  owner original: /tmp/claude-1000/owner-mobile-inbox.png',
    `Example: ${SHOT}`,
  ].join('\n');
  const recorded = (body: string, n = 7) =>
    [`[Image #${n}]`, '', '<pasted_content id="703a">', body, '</pasted_content id="703a">'].join('\n');
  const lifted = recorded(
    typed
      .replace(`Example: ${SHOT}`, 'Example:')
      .replace('  before: /tmp/', '  before:\n/tmp/')
      .replace('  owner original: /tmp/', '  owner original:\n/tmp/'),
  );
  const sent = () => record({ message: typed, matchText: typed, path: 'native-inline' });

  it('is proven by the record, wrapper, moved placeholder and re-wrapped lines and all', async () => {
    const world = new World(sent());
    world.evidence(new ClaudeObservedInputObserver(), [claude.user(lifted, 400, 'pasted')]);

    await world.checkAt(1_000);

    should(world.only).match({ fate: 'delivered', evidence: { key: 'pasted' } });
  });

  it('is proven through a drained queue entry of that shape', async () => {
    const world = new World(sent());
    world.evidence(new ClaudeObservedInputObserver(), [
      claude.enqueue(lifted, 200),
      claude.remove(lifted, 4_900),
      claude.drained(lifted, 5_000),
    ]);

    await world.checkAt(6_000);

    should(world.only).match({ fate: 'delivered', evidence: { kind: 'queued_command' } });
  });

  it('is NOT proven by a paste with an image whose words differ, or by one with no image lifted', async () => {
    const world = new World(sent());
    world.evidence(new ClaudeObservedInputObserver(), [
      claude.user(recorded(typed.replace('Bug B23 fix is up', 'Bug B24 fix is up').replace(` ${SHOT}`, '')), 400),
      claude.user(
        ['<pasted_content id="9">', typed.replace(` ${SHOT}`, ''), '</pasted_content id="9">'].join('\n'),
        500,
      ),
    ]);

    await world.checkAt(1_000);

    should(world.only.fate).not.equal('delivered');
  });
});

describe('a send the agent already started working on', () => {
  const agentSend = (overrides: Partial<SendRecord> = {}) =>
    record({ senderKind: 'agent', from: SENDER, fromName: 'kenton', path: 'native-inline', ...overrides });

  it('is never typed again once a turn began after the harness queued it, even if the transcript cannot match it', async () => {
    const world = new World(agentSend());
    world.evidence(new ClaudeObservedInputObserver(), [claude.enqueue('ship it now please', 200)]);
    await world.checkAt(1_000);
    // The queue drained into a turn the matcher could not read, and the pane is idle again.
    world.target = { id: ID, status: 'running', mode: 'auto', turn: 5, turnState: 'idle', turnStateAt: at(20_000) };
    world.evidence(new ClaudeObservedInputObserver(), [
      claude.enqueue('ship it now please', 200),
      claude.dequeue('ship it now please', 19_000),
    ]);
    world.inPane = false;

    await world.checkAt(75_000);
    await world.checkAt(90_000);
    await world.checkAt(120_000);

    should(world.retyped).be.empty();
    should(world.events).not.containEql('control.send_retried');
    should(world.only.fate).equal('queued');
    should(world.only.attempt).equal(1);
  });

  it('is not typed again while the turn that began after it was typed is still working', async () => {
    const world = new World(agentSend({ path: 'direct' }));
    world.evidence(new ClaudeObservedInputObserver(), []);
    world.target = { id: ID, status: 'running', mode: 'auto', turn: 5, turnState: 'working', turnStateAt: at(8_000) };

    await world.checkAt(16_000);
    await world.checkAt(40_000);

    should(world.retyped).be.empty();
    should(world.only).match({ fate: 'accepted', attempt: 1 });
  });

  it('is still ended as unconfirmed, not lost, once the hold ceiling passes', async () => {
    const world = new World(agentSend({ path: 'direct' }));
    world.evidence(new ClaudeObservedInputObserver(), []);
    world.target = { id: ID, status: 'running', mode: 'auto', turn: 5, turnState: 'working', turnStateAt: at(8_000) };

    await world.checkAt(16_000);
    await world.checkAt(7_200_000);

    should(world.retyped).be.empty();
    should(world.only).match({ fate: 'unaccounted', unaccountedReason: 'timeout' });
  });

  it('is still typed again when no turn began after it, or the turn clock cannot be read', async () => {
    const stale = new World(agentSend({ path: 'direct' }));
    stale.evidence(new ClaudeObservedInputObserver(), []);
    stale.target = { id: ID, status: 'running', mode: 'auto', turn: 4, turnState: 'working', turnStateAt: at(-5_000) };
    const unread = new World(agentSend({ path: 'direct' }));
    unread.evidence(new ClaudeObservedInputObserver(), []);
    const idleAfter = new World(agentSend({ path: 'direct' }));
    idleAfter.evidence(new ClaudeObservedInputObserver(), []);
    idleAfter.target = { id: ID, status: 'running', mode: 'auto', turn: 4, turnState: 'idle', turnStateAt: at(8_000) };

    await stale.checkAt(16_000);
    await unread.checkAt(16_000);
    await idleAfter.checkAt(16_000);

    should(stale.retyped).eql(['send-1']);
    should(unread.retyped).eql(['send-1']);
    should(idleAfter.retyped).eql(['send-1']);
  });
});

describe('a conversation too large to read whole', () => {
  it('reads evidence only from the oldest watched send on, less the clock slack', async () => {
    const world = new World(
      record({ sendId: 'send-1', acceptedAt: at(30_000) }),
      record({ sendId: 'send-2', acceptedAt: at(10_000), message: 'and the docs', matchText: 'and the docs' }),
      record({ sendId: 'send-3', acceptedAt: at(0), fate: 'delivered' }),
    );

    await world.checkAt(31_000);

    should(world.sinces).eql([at(10_000 - defaultSendTrackerSettings.matchSlackMs)]);
  });

  it('settles a send delivered on the record it saw, even when absence could not be proven', async () => {
    const world = new World(record());
    world.reading = {
      readable: false,
      inputs: observe(new ClaudeObservedInputObserver(), [claude.user('ship it now please', 1_000)]),
    };

    await world.checkAt(2_000);

    should(world.only).match({ fate: 'delivered' });
    should(world.journal).eql([{ event: 'control.send_delivered', data: { sendId: 'send-1', attempt: 1 } }]);
  });

  it('repairs a send settled unconfirmed by an unreadable transcript, and says what it corrected', async () => {
    const day = 24 * 60 * 60_000;
    const world = new World(
      record({ fate: 'unaccounted', unaccountedReason: 'transcript_unreadable', retryable: false }),
      record({ sendId: 'send-2', fate: 'unaccounted', unaccountedReason: 'pane_unreadable' }),
    );
    world.evidence(new ClaudeObservedInputObserver(), [claude.user('ship it now please', 1_000)]);

    const watching = await world.tracker.watching(ID);
    await world.checkAt(day);
    world.nowMs = T0 + 4 * day;
    const stale = await new World(
      record({ fate: 'unaccounted', unaccountedReason: 'transcript_unreadable' }),
    ).tracker.watching(ID);

    should(watching).be.true();
    should(world.only).match({ fate: 'delivered' });
    should(world.only.unaccountedReason).be.undefined();
    should(world.only.retryable).be.undefined();
    should(world.journal).eql([
      { event: 'control.send_delivered', data: { sendId: 'send-1', attempt: 1, corrected: 'unaccounted' } },
    ]);
    // Any other unconfirmed send is still watched only for the ordinary two hours.
    should(world.records.get('send-2')?.fate).equal('unaccounted');
    should(world.sinces).eql([at(-defaultSendTrackerSettings.matchSlackMs)]);
    should(stale).be.true();
  });

  it('lets a repairable send go after the repair window', async () => {
    const world = new World(record({ fate: 'cancelled', fateAt: at(1_000), cancelEffect: 'not_in_pane' }));
    world.nowMs = T0 + defaultSendTrackerSettings.repairLimitMs;

    should(await world.tracker.watching(ID)).be.false();
  });

  it('judges a cancelled send only by records written before the cancel, after every live send', async () => {
    const world = new World(
      record({ sendId: 'send-1', fate: 'cancelled', fateAt: at(1_000), cancelEffect: 'not_in_pane' }),
      record({ sendId: 'send-2', acceptedAt: at(20_000), attemptAt: at(20_000) }),
      record({ sendId: 'send-3', acceptedAt: at(500), fate: 'cancelled', fateAt: at(30_000) }),
    );
    world.evidence(new ClaudeObservedInputObserver(), [
      claude.user('ship it now please', 21_000, 'later'),
      claude.user('ship it now please', 8_000, 'earlier'),
    ]);

    await world.checkAt(22_000);

    // send-2 is live and takes the record written after it; send-1 was cancelled before either record
    // and proves nothing; send-3 was cancelled after the earlier one, so the agent had it.
    should(world.records.get('send-2')).match({ fate: 'delivered', evidence: { key: 'later' } });
    should(world.records.get('send-1')?.fate).equal('cancelled');
    should(world.records.get('send-3')).match({ fate: 'delivered', evidence: { key: 'earlier' } });
  });
});

/**
 * The incident: one `fy send` to a mid-turn Claude ferret, held in Claude Code 2.1.281's queue in a
 * rendering the daemon did not recognise and with no transcript record for it — so it was called lost
 * and typed again at 15 s, 30 s and 60 s, four copies in one queue, and the sender told it never came.
 */
describe('a message held in a queue the daemon cannot see', () => {
  const busyPane = () => pane({ activeWork: true, promptReady: false });
  const queuedSend = () =>
    record({ path: 'native-inline', senderKind: 'agent', from: SENDER, fromName: 'lizzette', turn: undefined });

  it('is never typed into the mid-turn pane again, however many deadlines pass, and is queued once seen', async () => {
    // Arrange — typed into a busy pane, unrecognised in its queue, absent from the transcript.
    const world = new World(queuedSend());
    world.pane = busyPane();
    world.evidence(new ClaudeObservedInputObserver(), []);

    // Act — every deadline of the agent schedule, then the pane's queue recognised.
    for (const ms of [15_000, 30_000, 60_000, 75_000, 600_000]) await world.checkAt(ms);
    const waiting = world.only;
    world.inPane = 'queue';
    await world.checkAt(601_000);
    const queued = world.only;
    world.pane = pane();
    world.inPane = false;
    world.evidence(new ClaudeObservedInputObserver(), [claude.user('ship it now please', 602_000)]);
    await world.checkAt(603_000);

    // Assert
    should(world.retyped).be.empty();
    should(waiting).match({ fate: 'accepted', attempt: 1, deadlineAt: at(660_000) });
    should(queued).match({ fate: 'queued', queueProof: 'pane', attempt: 1 });
    should(world.only).match({ fate: 'delivered', attempt: 1 });
    should(world.notices).be.empty();
  });

  it('waits, with no notice, when the busy pane cannot be read — and is delivered once the turn ends', async () => {
    // The incident: a queue that runs past the top of a short pane makes the capture unreadable, and the
    // send used to be settled "unconfirmed" at its first deadline although the queue held it.
    const world = new World(queuedSend());
    world.pane = busyPane();
    world.inPane = undefined;
    world.evidence(new ClaudeObservedInputObserver(), []);

    for (const ms of [15_000, 30_000, 60_000, 75_000]) await world.checkAt(ms);
    const waiting = world.only;
    world.pane = pane();
    world.evidence(new ClaudeObservedInputObserver(), [claude.user('ship it now please', 80_000)]);
    await world.checkAt(81_000);

    should(waiting).match({ fate: 'accepted', attempt: 1 });
    should(world.retyped).be.empty();
    should(world.only).match({ fate: 'delivered', attempt: 1 });
    should(world.events).eql(['control.send_delivered']);
    should(world.notices).be.empty();
  });

  it('is unconfirmed, and told so, when the pane is unreadable and no turn is running to wait for', async () => {
    const world = new World(queuedSend());
    world.inPane = undefined;
    world.evidence(new ClaudeObservedInputObserver(), []);
    await world.checkAt(15_000);

    should(world.only).match({ fate: 'unaccounted', unaccountedReason: 'pane_unreadable' });
    should(world.notices).have.length(1);
  });

  it('still reports a dialog it cannot type past, even from a busy unreadable pane', async () => {
    const world = new World(queuedSend());
    world.pane = pane({ activeWork: true, promptReady: false, blockingPrompt: 'permission' });
    world.inPane = undefined;
    world.evidence(new ClaudeObservedInputObserver(), []);
    await world.checkAt(15_000);

    should(world.only).match({ fate: 'unaccounted', unaccountedReason: 'blocked_by_prompt' });
  });

  it('is typed again once the turn has ended and it is proven absent — into an idle pane', async () => {
    const world = new World(queuedSend());
    world.pane = busyPane();
    world.evidence(new ClaudeObservedInputObserver(), []);
    await world.checkAt(15_000);
    world.pane = pane();
    await world.checkAt(75_000);

    should(world.retyped).eql(['send-1']);
    should(world.only).match({ fate: 'accepted', attempt: 2 });
  });

  it('is typed again once into a mid-turn pane when no copy of it was ever typed into one', async () => {
    // Its first copy went into an idle pane, which leaves no queue a copy could be hiding in.
    const world = new World(record({ senderKind: 'agent', from: SENDER }));
    world.pane = busyPane();
    world.evidence(new CodexObservedInputObserver(), []);
    await world.checkAt(15_000);

    should(world.retyped).eql(['send-1']);
  });

  it('waits when the pane, re-read under the send lock, shows it held or mid-turn — and never says lost', async () => {
    const held = new World(record());
    held.withhold = 'held';
    await held.checkAt(60_000);
    const midTurn = new World(record());
    midTurn.withhold = 'busy';
    await midTurn.checkAt(60_000);

    for (const world of [held, midTurn]) {
      should(world.only).match({ fate: 'accepted', attempt: 1, deadlineAt: at(120_000) });
      should(world.events).be.empty();
    }
  });

  it('is unconfirmed, not "not delivered", when the re-read could not rule a held copy out', async () => {
    const world = new World(record({ senderKind: 'agent', from: SENDER }));
    world.withhold = 'unreadable';
    await world.checkAt(15_000);

    should(world.only).match({ fate: 'unaccounted', unaccountedReason: 'pane_unreadable', retryable: false });
    should(world.notices[0]?.record).match({ fate: 'unaccounted', unaccountedReason: 'pane_unreadable' });
  });

  it('is proven queued, and waits like a queued send, when the retry finds it held instead of typing it', async () => {
    const world = new World(record());
    world.retypeFindsHeld = true;
    await world.checkAt(60_000);

    should(world.only).match({ fate: 'queued', queueProof: 'pane', attempt: 1, deadlineAt: at(120_000) });
    should(world.retyped).be.empty();
  });
});

/**
 * A person's send the screen refused before any key is kept open as `untyped`, and this tracker types
 * it. The owner's message used to be withdrawn instead, and nothing ever tried it again.
 */
describe("typing a person's send that nothing was typed for yet", () => {
  it('looks again within seconds, not at the minute-long deadline a typed send waits for', async () => {
    const world = new World(record({ untyped: true }));
    world.withhold = 'unreadable';

    await world.checkAt(defaultSendTrackerSettings.untypedLookMs);

    should(world.only.fate).equal('accepted');
    should(world.only.untyped).be.true();
    should(world.only.deadlineAt).equal(at(2 * defaultSendTrackerSettings.untypedLookMs));
    should(world.events).not.containEql('control.send_unaccounted');
  });

  it('waits out a draft in the way or a failed retype rather than settling it', async () => {
    const world = new World(record({ untyped: true }));
    world.retypeFails = true;

    await world.checkAt(defaultSendTrackerSettings.untypedLookMs);

    should(world.only).containEql({ fate: 'accepted', untyped: true });
  });

  it('types it even when no transcript can be read and the agent took a turn since: nothing typed can be a copy', async () => {
    const world = new World(record({ path: 'native-file', untyped: true }));
    world.readFails = true;
    world.target = { id: ID, status: 'running', mode: 'auto', turn: 6, turnState: 'working', turnStateAt: at(1_000) };
    world.pane = pane({ activeWork: true, promptReady: false });

    await world.checkAt(defaultSendTrackerSettings.untypedLookMs);

    should(world.retyped).eql(['send-1']);
    should(world.only.attempt).equal(1);
    should(world.only.untyped).be.undefined();
  });

  it("types the person's send before any other in the same look", async () => {
    const world = new World(
      record({ sendId: 'agent-1', senderKind: 'agent', from: SENDER, acceptedAt: at(0), attemptAt: at(0) }),
      record({ sendId: 'owner-1', untyped: true, acceptedAt: at(1_000), attemptAt: at(1_000) }),
    );

    await world.checkAt(defaultSendTrackerSettings.deadlinesMs.agent[0] as number);

    should(world.retyped).eql(['owner-1', 'agent-1']);
  });

  it('says a send never typed by the hold ceiling was not delivered, and lets the person retry it', async () => {
    const world = new World(record({ untyped: true }));
    world.withhold = 'unreadable';

    await world.checkAt(defaultSendTrackerSettings.holdLimitMs);

    should(world.only).containEql({ fate: 'timed_out', unaccountedReason: 'not_delivered', retryable: true });
  });

  it('settles it as ended when its session has ended', async () => {
    const world = new World(record({ untyped: true }));
    world.target = { id: ID, status: 'completed', mode: 'auto', turn: 4 };

    await world.checkAt(defaultSendTrackerSettings.untypedLookMs);

    should(world.only).containEql({ fate: 'timed_out', unaccountedReason: 'ferret_ended' });
    should(world.retyped).be.empty();
  });
});
