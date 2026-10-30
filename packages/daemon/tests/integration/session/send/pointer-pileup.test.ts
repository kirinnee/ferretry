import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileSendLedger, TmuxPaneDelivery, TmuxPaneQueue, TmuxSendTerminal } from '../../../../src/adapters/index.ts';
import { type ClockPort, parseSessionId, type SerialExecutor, TmuxController } from '../../../../src/lib/index.ts';
import {
  AgentSendFailureNotifier,
  defaultSendTrackerSettings,
  defaultSessionSendSettings,
  type SendRecord,
  type SendRepository,
  type SendTarget,
  SendTracker,
  SessionSendService,
} from '../../../../src/lib/session/send/index.ts';
import { ClaudeObservedInputObserver } from '../../../../src/lib/transcript/observed-input.ts';
import { ClaudePane } from '../../support/claude-pane.ts';

/**
 * SIX copies of one turn pointer typed onto a person's half-written question, glued together and
 * never submitted — the owner's screenshot of ferret "David", whose session title sits in the rule
 * above its composer.
 *
 * The whole chain runs here for real — the send service, the tracker over the file ledger, the tmux
 * send terminal, delivery and queue adapters and the controller — against a pane drawn like Claude
 * Code 2.1.281. Each scenario sends once and then lets the tracker reach a dozen deadlines, and asks
 * one question: how many times did the daemon type into that composer?
 */

const ID = parseSessionId('mvgf1elu-2a90237a');
const T0 = Date.parse('2026-10-22T09:14:00.000Z');
const TURN_FILE = '/Users/erng/.ferretry/state/sessions/mvgf1elu-2a90237a/turns/turn-026.md';
const DRAFT =
  "before contiuing, i need to know -- for OCI's warpstream agent -- say they need to talk to OOS " +
  "(OCI's s3), where do i get the permission?";
/** Two lines and over a thousand characters: a turn-file pointer when idle, a queued-file one when busy. */
const MESSAGE = `Here are the Grafana links you asked for.\n${'The dashboards are under OCI / WarpStream. '.repeat(30)}`;
/**
 * When the tracker looks: at its first check, at each Enter nudge (4 s, 12 s, 30 s after typing), when a
 * held pointer becomes "typed, not sent", and then at a dozen minute-apart deadlines.
 */
const LOOKS_MS = [
  2_000,
  5_000,
  13_000,
  31_000,
  35_000,
  ...Array.from({ length: 12 }, (_, look) => 61_000 * (look + 1)),
];
const DEADLINES = 12;

type SessionStatus = SendTarget['status'];

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map(async home => await rm(home, { recursive: true, force: true })));
});

const inline: SerialExecutor = { run: async (_key, work) => await work(), runExclusive: async work => await work() };

class World {
  nowMs = T0;
  readonly clock: ClockPort = { now: () => new Date(this.nowMs).toISOString() };
  readonly pane: ClaudePane;
  readonly service: SessionSendService;
  readonly tracker: SendTracker;
  private readonly ledger: FileSendLedger;
  private target: SendTarget;

  constructor(home: string, status: SessionStatus, width?: number) {
    this.pane = new ClaudePane(() => this.clock.now(), width);
    this.target = { id: ID, status, mode: 'interactive', turn: 25 };
    this.ledger = new FileSendLedger(id => join(home, id), this.clock);
    const sleep = async (): Promise<void> => undefined;
    const tmux = new TmuxController(this.pane);
    const terminal = new TmuxSendTerminal(
      tmux,
      async () => 'fy-mvgf1elu-2a90237a',
      new TmuxPaneDelivery(tmux, sleep, { readinessAttempts: 4 }),
      new TmuxPaneQueue(tmux, sleep),
      sleep,
    );
    const repository: SendRepository = {
      read: async () => this.target,
      resolveSender: async () => undefined,
      journal: async () => undefined,
      transition: async (_id, change) => {
        this.target = {
          ...this.target,
          ...(change.status === undefined ? {} : { status: change.status }),
          ...(change.turn === undefined ? {} : { turn: change.turn }),
        };
        return this.target;
      },
    };
    let service: SessionSendService | undefined;
    const observer = new ClaudeObservedInputObserver();
    this.tracker = new SendTracker(
      {
        ledger: this.ledger,
        evidence: {
          read: async id => ({
            readable: true,
            inputs: this.pane.transcript.flatMap((record, index) =>
              observer.observe(record, { source: `/${id}.jsonl`, byteOffset: index, byteLength: 1 }),
            ),
          }),
        },
        terminal,
        repository,
        attempts: {
          reattempt: async (id, sendId) =>
            await (service as SessionSendService).reattempt(id, sendId, { by: 'daemon' }),
          resubmit: async (id, sendId) => await (service as SessionSendService).resubmit(id, sendId),
        },
        notifier: new AgentSendFailureNotifier({ send: async () => undefined as never }, repository, 'fy'),
        scheduler: { schedule: () => undefined, cancelAll: () => undefined },
        roster: { sessions: () => [ID] },
        serial: inline,
        clock: this.clock,
      },
      defaultSendTrackerSettings,
    );
    service = new SessionSendService(
      {
        repository,
        ledger: this.ledger,
        terminal,
        turns: {
          writeTurn: async () => TURN_FILE,
          writeQueuedPayload: async (_id, sendId) =>
            `/Users/erng/.ferretry/state/sessions/mvgf1elu-2a90237a/channel/queued-${sendId}.md`,
          clearMarkers: async () => undefined,
        },
        channel: { recordInbound: async () => undefined, recordOutbound: async () => undefined },
        gate: { launching: () => false, awaitSettled: async () => true },
        reviver: { revive: async () => undefined },
        peerWaits: { endPeerWait: async () => undefined },
        serial: inline,
        clock: this.clock,
        tracking: this.tracker,
      },
      defaultSessionSendSettings,
    );
    this.service = service;
  }

  /** One send, as a person's app makes it; a refusal is an answer, not a test failure. */
  async send(): Promise<string> {
    return await this.service.send({ id: ID, sendId: 'send-1', message: MESSAGE }).then(
      outcome => outcome.disposition,
      (error: unknown) => `refused: ${(error as Error).message}`,
    );
  }

  /** The tracker's looks across a dozen deadlines — every retype, nudge and expiry it would make. */
  async deadlines(): Promise<SendRecord | undefined> {
    for (const at of LOOKS_MS) {
      this.nowMs = Math.max(this.nowMs, T0 + at);
      await this.tracker.check(ID).catch(() => undefined);
    }
    return (await this.ledger.list(ID)).find(record => record.sendId === 'send-1');
  }
}

async function world(status: SessionStatus, width?: number): Promise<World> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-pointer-pileup-'));
  homes.push(home);
  return new World(home, status, width);
}

/** How many copies of a pointer — a turn file's or a queued message file's — a composer holds. */
function pointers(composer: string): number {
  return composer.split(/Read the (?:file|queued message file)/u).length - 1;
}

describe("a send to a Claude ferret whose composer holds a person's question", () => {
  for (const status of ['awaiting_user', 'running'] as const)
    it(`is refused with the draft quoted, and nothing is typed (session ${status})`, async () => {
      const subject = await world(status);
      subject.pane.composer = DRAFT;

      const answer = await subject.send();
      const record = await subject.deadlines();

      should(answer).match(/refused: the agent's composer already holds unsent text \("before contiuing/u);
      should(record).be.undefined();
      should(subject.pane.fills()).be.empty();
      should(subject.pane.enters()).equal(0);
      should(subject.pane.composer).equal(DRAFT);
    });

  for (const status of ['awaiting_user', 'running'] as const)
    it(`types nothing when the cursor cannot place the composer (session ${status})`, async () => {
      // The frame that let the first pointer through: a draft the cursor did not prove was typed read
      // as an empty composer. It is now "unreadable", and an unreadable composer is never typed into.
      const subject = await world(status);
      subject.pane.composer = DRAFT;
      subject.pane.cursor = 'lost';

      const answer = await subject.send();
      const record = await subject.deadlines();

      // Idle, the draft refuses the send outright. Busy, the person's send is kept open and untyped
      // for the tracker, which looked at every deadline and still typed nothing.
      if (status === 'running') should(record).containEql({ fate: 'accepted', untyped: true });
      else should(answer).startWith('refused');
      should(subject.pane.fills()).be.empty();
      should(subject.pane.enters()).equal(0);
      should(subject.pane.composer).equal(DRAFT);
    });

  it('stops after one fill, presses no Enter, and never retypes when the person typed during the fill', async () => {
    // The composer read empty, and the person's keys arrived with the pointer's: the screenshot's
    // order, draft first. The fill cannot prove its own landing, so it used to `C-u` — one wrapped row
    // — and type again, and the tracker, finding no EXACT pointer, typed it again at each deadline.
    const subject = await world('awaiting_user');
    subject.pane.typesAfterNextFill = DRAFT;

    await subject.send();
    const record = await subject.deadlines();

    should(subject.pane.fills()).have.length(1);
    should(subject.pane.enters()).equal(0, "Enter on the composer would submit the person's draft with it");
    should(subject.pane.calls.some(call => call.at(-1) === 'C-u')).be.false();
    should(pointers(subject.pane.composer)).equal(1);
    should(subject.pane.composer.startsWith(DRAFT)).be.true();
    should(record?.fate).not.equal('delivered');
  });
});

describe('a send to a Claude ferret whose Enter does not submit', () => {
  for (const cursor of ['caret', 'lost'] as const)
    it(`types the pointer once, ever, across ${DEADLINES} deadlines (cursor ${cursor})`, async () => {
      const subject = await world('running');
      subject.pane.enterSubmits = false;
      subject.pane.cursor = cursor;

      await subject.send();
      await subject.deadlines();

      should(subject.pane.fills()).have.length(1);
      should(pointers(subject.pane.composer)).equal(1);
      should(subject.pane.calls.some(call => call.at(-1) === 'C-u')).be.false();
    });

  it('presses Enter on its own pointer a bounded number of times, then leaves it for the person', async () => {
    const subject = await world('awaiting_user');
    subject.pane.enterSubmits = false;

    await subject.send();
    const record = await subject.deadlines();

    should(subject.pane.fills()).deepEqual([
      `Read the file ${TURN_FILE} now, then carefully follow every instruction inside it. This is your complete task for this turn.`,
    ]);
    // Three Enters by the delivery itself, three nudges by the tracker (#705) — and no retype.
    should(subject.pane.enters()).equal(6);
    should(record).match({ typedNotSent: true });
  });

  it('is delivered, typed once, once an Enter finally takes', async () => {
    const subject = await world('awaiting_user');
    subject.pane.enterSubmits = false;

    await subject.send();
    subject.nowMs = T0 + 1_000;
    subject.pane.enterSubmits = true;
    const record = await subject.deadlines();

    should(record?.fate).equal('delivered');
    should(subject.pane.fills()).have.length(1);
    should(subject.pane.submitted).have.length(1);
  });
});

describe('cancelling a pointer left typed in a narrow Claude composer', () => {
  it('erases every wrapped row, one C-u each, and leaves the composer empty', async () => {
    // Claude's `C-u` takes one wrapped row. A budget counted in the payload's LINES — one, for a
    // pointer — stopped after four keys and left the pointer cut in half in a pane this narrow.
    const subject = await world('awaiting_user', 40);
    subject.pane.enterSubmits = false;
    await subject.send();

    const cancelled = await subject.service.cancel(ID, 'send-1');

    should(cancelled).match({ fate: 'cancelled', cancelEffect: 'cleared' });
    should(subject.pane.composer).equal('');
    should(subject.pane.fills()).have.length(1);
  });
});
