import { describe, it } from 'bun:test';
import { turnFileInstruction } from '@ferretry/protocol';
import should from 'should';
import { type ClockPort, parseSessionId, type SerialExecutor, type SessionId } from '../../../../src/lib/index.ts';
import {
  defaultSendTrackerSettings,
  lookBeforeReading,
  SEND_READ_LOOK_BUDGET_MS,
  type SendEvidenceReading,
  type SendHeldAt,
  type SendPaneObservation,
  type SendRecord,
  type SendSettlement,
  type SendTarget,
  SendTracker,
} from '../../../../src/lib/session/send/index.ts';
import {
  ClaudeObservedInputObserver,
  CodexObservedInputObserver,
} from '../../../../src/lib/transcript/observed-input.ts';
import type { ObservedHumanInput, TranscriptInputObserver } from '../../../../src/lib/transcript/types.ts';

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
const at = (ms: number): string => new Date(T0 + ms).toISOString();

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
  reading: SendEvidenceReading = { readable: true, inputs: [] };
  readFails = false;
  readonly sinces: string[] = [];
  target: SendTarget | undefined = { id: ID, status: 'running', mode: 'auto', turn: 4 };
  pane: SendPaneObservation | undefined = pane();
  inPane: SendHeldAt | false | undefined = false;
  retypeFails = false;
  targetFails = false;
  cancelled = 0;
  nowMs = T0;
  /** The sessions the boot walk covers, and which of them a look has started on, in order. */
  roster: readonly SessionId[] = [ID];
  readonly looked: SessionId[] = [];
  /** When set, each look waits here until the test releases it. */
  readonly holds: Array<() => void> = [];
  holdLooks = false;
  readonly tracker: SendTracker;

  constructor(...initial: SendRecord[]) {
    for (const entry of initial) this.records.set(entry.sendId, entry);
    const serial: SerialExecutor = {
      run: async (_key, work) => await work(),
      runExclusive: async work => await work(),
    };
    const clock: ClockPort = { now: () => new Date(this.nowMs).toISOString() };
    this.tracker = new SendTracker(
      {
        ledger: {
          list: async id => {
            this.looked.push(id);
            if (this.holdLooks) await new Promise<void>(resolve => this.holds.push(resolve));
            return [...this.records.values()];
          },
          settle: async (_id, sendId, patch: SendSettlement) => {
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
            const current = this.records.get(sendId) as SendRecord;
            this.retyped.push(sendId);
            const next = {
              ...current,
              fate: 'accepted' as const,
              attempt: (current.attempt ?? 1) + 1,
              attemptAt: clock.now(),
            };
            delete (next as { deadlineAt?: string }).deadlineAt;
            this.records.set(sendId, next);
            return next;
          },
          // The service's own re-checks are its to test; here an Enter either takes or it does not.
          resubmit: async (_id, sendId) => {
            const current = this.records.get(sendId) as SendRecord;
            if (this.resubmitDeclines) return current;
            this.resubmitted.push(sendId);
            const counted = { ...current, submitNudges: (current.submitNudges ?? 0) + 1 };
            this.records.set(sendId, this.enterTakes ? { ...counted, attemptAt: clock.now() } : counted);
            if (this.enterTakes) this.inPane = false;
            return this.records.get(sendId);
          },
        },
        notifier: {
          notify: async (sender, recipient, entry) => void this.notices.push({ sender, recipient, record: entry }),
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

  it('times out a send whose session ended or whose pane is gone, without offering a plain retry', async () => {
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
      should(world.only).match({ fate: 'timed_out', unaccountedReason: 'session_ended', retryable: false });
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

    const stale = new World(record({ fate: 'timed_out' }), record({ sendId: 'held', held: true }));
    stale.nowMs = T0 + 7_200_000;
    should(await stale.tracker.watching(ID)).be.false();
    await stale.checkAt(7_200_000);
    should(stale.only.fate).equal('timed_out');
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

  it('looks again when the next nudge is due, and no sooner than a first check once one is overdue', async () => {
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
    should(overdue.scheduled.at(-1)?.delayMs).equal(defaultSendTrackerSettings.firstCheckMs);
  });

  it('never nudges a message typed as itself, which a person might equally have typed', async () => {
    const world = new World(record({ message: 'hi', matchText: 'hi' }));
    world.inPane = 'composer';
    world.evidence(new CodexObservedInputObserver(), []);

    for (const ms of [2_000, 4_000, 12_000, 30_000]) await world.checkAt(ms);

    should(world.resubmitted).be.empty();
    should(world.only.typedNotSent).be.true();
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
    should(world.only.fate).equal('timed_out');
    should(world.only.unaccountedReason).equal('session_ended');
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
