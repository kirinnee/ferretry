import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  FileSendLedger,
  FileSessionQueueStore,
  SendPathDeliveryView,
  SendPathQueueTransport,
  TmuxPaneDelivery,
  TmuxPaneQueue,
  TmuxSendTerminal,
} from '../../../../src/adapters/index.ts';
import {
  type ClockPort,
  parseSessionId,
  QueueDeliverer,
  type SerialExecutor,
  SessionQueueService,
  TmuxController,
} from '../../../../src/lib/index.ts';
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
 * B144 — a message typed into an idle ferret that never submits, and a ferret stuck forever behind it.
 *
 * annabeth, 2026-11-02 15:00: a peer's turn pointer was typed into her pane while it was too busy to draw
 * it. The fill saw nothing within its window and settled the send unconfirmed; the pane drew the pointer
 * later; nothing ever pressed Enter on it. Every later message waited behind it as a "draft" for five hours,
 * and when a person finally pressed Enter the next send reused turn 63 and overwrote the file the pointer
 * named.
 *
 * The whole chain runs here for real — the send service, the tracker over a file ledger, the queue and its
 * deliverer over a file queue, the tmux send terminal and controller — in a temporary state home, against
 * a FAKE Claude Code pane (`ClaudePane`) that can stall. No tmux is started.
 */

const ID = parseSessionId('mvyfc6pg-7c008d0e');
const T0 = Date.parse('2026-11-02T15:00:32.000Z');
const PEER =
  '[message from ferret tamika (session mvzcf6iu-351e2c8e) — not from the owner]\nTo reply: fy send tamika "<reply>"\n\n' +
  `${'Please re-run the catalog suite against the new share links and report the failures. '.repeat(8)}`;

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
  readonly queue: SessionQueueService;
  readonly deliverer: QueueDeliverer;
  readonly ledger: FileSendLedger;
  /** Every turn file written, by number: a second write to one number is the overwrite of turn 63. */
  readonly turnWrites = new Map<number, number>();
  target: SendTarget;

  constructor(private readonly home: string) {
    this.pane = new ClaudePane(() => this.clock.now());
    this.target = { id: ID, status: 'running', mode: 'auto', turn: 62, turnState: 'your-turn' };
    const directory = (id: string): string => join(home, 'sessions', id);
    this.ledger = new FileSendLedger(directory, this.clock);
    const sleep = async (): Promise<void> => undefined;
    const tmux = new TmuxController(this.pane);
    const terminal = new TmuxSendTerminal(
      tmux,
      async () => 'fy-mvyfc6pg-7c008d0e',
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
          writeTurn: async (id, turn, document) => {
            this.turnWrites.set(turn, (this.turnWrites.get(turn) ?? 0) + 1);
            const file = join(directory(id), 'turns', `turn-${String(turn).padStart(3, '0')}.md`);
            await mkdir(join(directory(id), 'turns'), { recursive: true });
            await writeFile(file, document);
            return file;
          },
          writeQueuedPayload: async (id, sendId, payload) => {
            const file = join(directory(id), 'channel', `queued-${sendId}.md`);
            await mkdir(join(directory(id), 'channel'), { recursive: true });
            await writeFile(file, payload);
            return file;
          },
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
      { ...defaultSessionSendSettings, directSendMaxChars: 500 },
    );
    this.service = service;
    const store = new FileSessionQueueStore(directory);
    this.queue = new SessionQueueService({ store, clock: this.clock, serial: inline });
    this.deliverer = new QueueDeliverer({
      store,
      serial: inline,
      clock: this.clock,
      scheduler: { schedule: () => undefined, cancelAll: () => undefined },
      view: async id => await new SendPathDeliveryView(repository, terminal, { launching: () => false }).view(id),
      transport: new SendPathQueueTransport(service, this.ledger),
      sessions: () => [ID],
      sleep,
    });
  }

  /** A ferret's message, sent the way the queue sends every message: enqueued, then handed over. */
  async enqueue(id: string, text: string): Promise<void> {
    // A blocker: this harness is about the pane, and an unlabelled ferret message would wait out its action window first.
    await this.queue.enqueue(ID, { id, sender: 'agent', from: 'mvzcf6iu-351e2c8e', text, label: 'blocker' });
    await this.deliverer.enqueued(ID);
  }

  async record(sendId: string): Promise<SendRecord | undefined> {
    return (await this.ledger.list(ID)).find(entry => entry.sendId === sendId);
  }

  async look(atMs: number): Promise<void> {
    this.nowMs = Math.max(this.nowMs, T0 + atMs);
    await this.tracker.check(ID).catch(() => undefined);
  }

  turnPath(turn: number): string {
    return join(this.home, 'sessions', ID, 'turns', `turn-${String(turn).padStart(3, '0')}.md`);
  }

  async turnFile(turn: number): Promise<string> {
    return await readFile(this.turnPath(turn), 'utf8');
  }
}

async function world(): Promise<World> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-stuck-input-'));
  homes.push(home);
  return new World(home);
}

const pointerTo = (file: string): string =>
  `Read the file ${file} now, then carefully follow every instruction inside it. This is your complete task for this turn.`;

describe('a turn pointer typed into a stalled idle pane (annabeth, 2026-11-02)', () => {
  it('settles unconfirmed, then presses Enter once the pointer is drawn — typed once, delivered', async () => {
    const subject = await world();
    subject.pane.stalled = true;

    await subject.enqueue('send-63', PEER);
    const unconfirmed = await subject.record('send-63');
    subject.pane.wake();
    await subject.look(27_000);
    await subject.look(30_000);

    should(unconfirmed).match({ fate: 'unaccounted', unaccountedReason: 'landing_unconfirmed', turn: 63 });
    should(subject.pane.fills()).have.length(1);
    should(subject.pane.submitted).eql([pointerTo(subject.turnPath(63))]);
    should(await subject.record('send-63')).match({ fate: 'delivered' });
    should(subject.pane.composer).equal('');
  });

  it('clears its own stranded pointer before the next message, which then gets a turn of its own', async () => {
    const subject = await world();
    subject.pane.stalled = true;
    await subject.enqueue('send-63', PEER);
    // The pointer is drawn after the fill gave up; no look of the tracker's comes before the next message.
    subject.pane.wake();

    subject.nowMs = T0 + 60_000;
    await subject.enqueue('send-next', `${PEER} (and a second message)`);

    // Enter on the stranded pointer first, then the new message as the NEXT turn — never turn 63 again.
    should(subject.pane.submitted).have.length(2);
    should(subject.pane.submitted[0]).match(/turn-063\.md now/);
    should(subject.pane.submitted[1]).match(/turn-064\.md now/);
    should(subject.turnWrites.get(63)).equal(1);
    should(await subject.turnFile(63)).startWith('[message from ferret tamika');
    const next = (await subject.queue.list(ID)).find(message => message.id === 'send-next');
    should(next?.state).equal('delivered');
    should(next).not.have.property('waitReason');
  });

  it('names the stuck send to the next message, waiting, when an Enter will not take it', async () => {
    const subject = await world();
    subject.pane.stalled = true;
    await subject.enqueue('send-63', PEER);
    subject.pane.wake();
    subject.pane.enterSubmits = false;

    subject.nowMs = T0 + 60_000;
    await subject.enqueue('send-next', 'please also check the share-link tests');

    const next = (await subject.queue.list(ID)).find(message => message.id === 'send-next');
    should(next).match({ state: 'queued', waitReason: 'draft', waitBehind: 'send-63' });
    should(subject.pane.fills()).have.length(1);
    should(subject.pane.enters()).be.above(0);
  });
});

describe('a person typing between the fill and the Enter (review finding)', () => {
  it('presses no Enter on our text joined to theirs, and leaves it unconfirmed, typed once', async () => {
    const subject = await world();
    subject.pane.joinsAfterLooks = { looks: 1, text: ' and also delete my draft' };

    await subject.enqueue('send-short', 'please rerun the catalog suite');

    should(subject.pane.enters()).equal(0);
    should(subject.pane.fills()).have.length(1);
    should(subject.pane.composer).equal('please rerun the catalog suite and also delete my draft');
    should(await subject.record('send-short')).match({ fate: 'unaccounted', unaccountedReason: 'landing_unconfirmed' });
  });
});

describe('a long message typed as itself whose Enter was swallowed (braelynn, 2026-11-02)', () => {
  it('presses Enter on the lone paste placeholder once its nudge is due', async () => {
    // braelynn's sat as `[Pasted text #40 +3 lines]` for fourteen hours. A single line this long is typed as
    // itself and travels as a paste, so the pane draws it as the same lone placeholder.
    const subject = await world();
    subject.pane.enterSubmits = false;
    const message =
      'Re-verify: CHANGES, one small fix. Strip the markers in the rejoin step, add short-value tests. '.repeat(3);

    await subject.enqueue('send-lead', message);
    should(subject.pane.composer).match(/^\[Pasted text #1 \+\d+ lines\]$/);
    subject.pane.enterSubmits = true;
    await subject.look(4_000);

    should(subject.pane.submitted).have.length(1);
    should(subject.pane.fills()).have.length(1);
    should(subject.pane.composer).equal('');
  });
});
