import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionState } from '@ferretry/protocol';
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
  SessionTurnWatcher,
  TmuxController,
  turnPaneEvidenceOf,
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
import type { TranscriptEvent } from '../../../../src/lib/transcript/types.ts';
import { ClaudeObservedInputObserver } from '../../../../src/lib/transcript/observed-input.ts';
import { ClaudePane } from '../../support/claude-pane.ts';

/**
 * B188 — "send while Compacting → lots of stuck messages", on a FAKE Claude Code pane and a fake clock.
 *
 * Two things the real evidence showed, both run here end to end (the send service, tracker, queue and
 * deliverer over file stores, the tmux send terminal, and the turn watcher over the same pane):
 *
 *   1. An IDLE ferret that starts compacting draws `· Compacting conversation…` (a `·` tick, no counter yet)
 *      and `✶ Compacting conversation… (3s)`. The pane readers took the first for a ready prompt and let the
 *      ended transcript overrule the second, so `turnState` flipped to `your-turn` and a send was routed
 *      `idle` — typed straight into the compacting composer by the idle path.
 *   2. A draft of the daemon's own left in the box (an unconfirmed landing), then a compaction: the summary
 *      Claude writes read as turn work and the cursor on the draft read as "not at a prompt", so the turn sat
 *      at `working` on an idle prompt, with the queue growing behind it, until a person pressed Enter.
 *
 * No tmux is started and no real time passes.
 */

const ID = parseSessionId('mwabqc2w-ba8e5fc2');
const T0 = Date.parse('2026-11-10T21:46:00.000Z');
const TICK_MS = 2_000;
const WINDOW_MS = 60_000;
const PEER = 'please rerun the catalog suite against the new share links';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map(async home => await rm(home, { recursive: true, force: true })));
});

const inline: SerialExecutor = { run: async (_key, work) => await work(), runExclusive: async work => await work() };

const ended: TranscriptEvent = { harness: 'claude', role: 'system', kind: 'turn', state: 'completed' };
const boundary: TranscriptEvent = { harness: 'claude', role: 'system', kind: 'compaction', trigger: 'auto' };
const summary: TranscriptEvent = {
  harness: 'claude',
  role: 'user',
  kind: 'message',
  text: 'This session is being continued from a previous conversation…',
  inputSource: 'harness',
  // Claude's own `isCompactSummary` marker, which is what the turn reader keys on.
  compactSummary: true,
};

/** The two frames Claude alternates between, from the first second of an idle compaction. */
const TICKS = ['· Compacting conversation…', '✶ Compacting conversation… (3s)'] as const;

class World {
  nowMs = T0;
  readonly clock: ClockPort = { now: () => new Date(this.nowMs).toISOString() };
  readonly pane: ClaudePane;
  readonly queue: SessionQueueService;
  readonly deliverer: QueueDeliverer;
  readonly ledger: FileSendLedger;
  readonly watcher: SessionTurnWatcher;
  /** The transcript tail the turn watcher reads. */
  readonly events: TranscriptEvent[] = [ended];
  /** `turnState` as the watcher recorded it, at each tick. */
  readonly turnStates: Array<{ readonly atMs: number; readonly state: string | undefined }> = [];
  target: SendTarget;
  private recorded: SessionState['turnState'] = 'your-turn';

  constructor(home: string) {
    this.pane = new ClaudePane(() => this.clock.now());
    // The record of an ended turn: its ready flag is still set when the compaction starts.
    this.target = { id: ID, status: 'running', mode: 'auto', turn: 62, turnState: 'your-turn', promptReady: true };
    const directory = (id: string): string => join(home, 'sessions', id);
    this.ledger = new FileSendLedger(directory, this.clock);
    const sleep = async (): Promise<void> => undefined;
    const tmux = new TmuxController(this.pane);
    const terminal = new TmuxSendTerminal(
      tmux,
      async () => 'fy-mwabqc2w-ba8e5fc2',
      new TmuxPaneDelivery(tmux, sleep, { readinessAttempts: 4 }),
      new TmuxPaneQueue(tmux, sleep),
      sleep,
    );
    const repository: SendRepository = {
      read: async () => ({ ...this.target, turnState: this.recorded }),
      resolveSender: async () => undefined,
      journal: async () => undefined,
      transition: async (_id, change) => {
        this.target = {
          ...this.target,
          ...(change.status === undefined ? {} : { status: change.status }),
          ...(change.turn === undefined ? {} : { turn: change.turn }),
          ...(change.promptReady === undefined ? {} : { promptReady: change.promptReady }),
        };
        return this.target;
      },
    };
    let service: SessionSendService | undefined;
    const observer = new ClaudeObservedInputObserver();
    const tracker = new SendTracker(
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
        tracking: tracker,
      },
      { ...defaultSessionSendSettings, directSendMaxChars: 500 },
    );
    this.tracker = tracker;
    const store = new FileSessionQueueStore(directory);
    this.queue = new SessionQueueService({ store, clock: this.clock, serial: inline });
    this.deliverer = new QueueDeliverer({
      store,
      serial: inline,
      clock: this.clock,
      scheduler: { schedule: () => undefined, cancelAll: () => undefined },
      view: async id => await new SendPathDeliveryView(repository, terminal, { launching: () => false }).view(id),
      transport: new SendPathQueueTransport(service, this.ledger, tracker),
      sessions: () => [ID],
      sleep,
    });
    this.watcher = new SessionTurnWatcher({
      clock: this.clock,
      sessions: async () => [
        { id: ID, state: { status: 'running', turn: this.target.turn, turnState: this.recorded } },
      ],
      transcript: async () => [...this.events],
      pane: async () => turnPaneEvidenceOf(await tmux.state('fy-mwabqc2w-ba8e5fc2')),
      record: async (_id, change) => {
        this.recorded = change.to;
        return true;
      },
    });
  }

  readonly tracker: SendTracker;

  /** One watcher tick at `atMs` after the start, noting what `turnState` reads after it. */
  async tick(atMs: number): Promise<void> {
    this.nowMs = T0 + atMs;
    await this.watcher.tick();
    this.turnStates.push({ atMs, state: this.recorded });
  }

  /** Ticks every 2 s from `fromMs` through `toMs`, drawing `frame(atMs)` first. */
  async run(fromMs: number, toMs: number, frame: (atMs: number) => string | undefined): Promise<void> {
    for (let atMs = fromMs; atMs <= toMs; atMs += TICK_MS) {
      this.nowMs = T0 + atMs;
      this.pane.status = frame(atMs);
      await this.tick(atMs);
    }
  }

  statesFrom(fromMs: number, toMs: number): readonly (string | undefined)[] {
    return this.turnStates.filter(look => look.atMs >= fromMs && look.atMs <= toMs).map(look => look.state);
  }

  async enqueue(id: string, text: string): Promise<void> {
    // A blocker: this harness is about the pane, and an unlabelled ferret message would wait out its action window first.
    await this.queue.enqueue(ID, { id, sender: 'agent', from: 'mvzcf6iu-351e2c8e', text, label: 'blocker' });
    await this.deliverer.enqueued(ID);
  }

  async record(sendId: string): Promise<SendRecord | undefined> {
    return (await this.ledger.list(ID)).find(entry => entry.sendId === sendId);
  }
}

async function world(): Promise<World> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-b188-'));
  homes.push(home);
  return new World(home);
}

describe('B188 an idle ferret starts compacting', () => {
  it('B188 a peer send queued while an idle ferret compacts never takes the idle path, and the turn reads working until the compaction ends', async () => {
    const subject = await world();
    const tick = (atMs: number): string => TICKS[(atMs / TICK_MS) % 2] as string;

    // The compaction starts at +0 s on an ended turn; a peer's message is queued at +4 s.
    await subject.run(0, 4_000, tick);
    subject.nowMs = T0 + 4_000;
    await subject.enqueue('send-1', PEER);
    await subject.run(6_000, WINDOW_MS - TICK_MS, tick);
    const typedInWindow = subject.pane.fills().length;

    // At +60 s Claude writes the boundary and the summary and draws its idle frame again.
    subject.events.push(boundary, summary);
    await subject.run(WINDOW_MS, WINDOW_MS + TICK_MS, () => undefined);

    // Never `your-turn` while the Compacting line is on screen (today: the `·` tick reads as a ready prompt).
    should(subject.statesFrom(0, WINDOW_MS - TICK_MS)).eql(new Array(WINDOW_MS / TICK_MS).fill('working'));
    // The send rode the harness's own queue (busy), never the idle direct path that waits for a prompt.
    const sent = await subject.record('send-1');
    should(sent?.path === 'native-inline' || sent?.path === 'native-file').be.true();
    should(typedInWindow).equal(1);
    should(subject.pane.fills()).have.length(1);
    // And the turn reads `your-turn` within two looks after the summary.
    should(subject.statesFrom(WINDOW_MS + TICK_MS, WINDOW_MS + TICK_MS)).eql(['your-turn']);
  });
});

describe('B188 a draft of our own is left in the box, then an idle compaction', () => {
  it('B188 peers queued behind the draft during the compaction wait, then the first look after the summary settles your-turn and delivers them in order', async () => {
    const subject = await world();
    // A direct send whose fill is never drawn within its window settles unconfirmed, and is drawn later.
    subject.pane.stalled = true;
    await subject.enqueue('send-63', PEER);
    subject.pane.wake();
    await subject.run(0, 6_000, () => undefined);
    const unconfirmed = await subject.record('send-63');
    const tick = (atMs: number): string => TICKS[(atMs / TICK_MS) % 2] as string;

    // An idle compaction starts with that text still in the composer. Two peers arrive while it runs.
    await subject.run(8_000, 20_000, tick);
    const fillsBefore = subject.pane.fills().length;
    subject.nowMs = T0 + 20_000;
    await subject.enqueue('send-a', `${PEER} (a)`);
    await subject.enqueue('send-b', `${PEER} (b)`);
    await subject.run(22_000, WINDOW_MS - TICK_MS, tick);

    // They WAIT behind the draft: queued, nothing typed or submitted, and the turn reads working throughout.
    const waiting = (await subject.queue.list(ID)).filter(message => message.id !== 'send-63');
    should(waiting.map(message => message.state)).eql(['queued', 'queued']);
    should(subject.pane.fills()).have.length(fillsBefore);
    should(subject.pane.submitted).have.length(0);
    should(subject.statesFrom(8_000, WINDOW_MS - TICK_MS).every(state => state === 'working')).be.true();

    // At +60 s Claude writes the boundary and the summary and draws its idle frame, the draft still in the box.
    // The state after a previous turn boundary, boundary, summary needs BOTH: the summary skipped as turn work (the
    // transcript says ended) and the idle prompt read through the draft (the pane agrees), so the FIRST look settles.
    subject.events.push(boundary, summary);
    await subject.run(WINDOW_MS, WINDOW_MS, () => undefined);
    should(subject.statesFrom(WINDOW_MS, WINDOW_MS)).eql(['your-turn']);

    // The next delivery look: the stranded text is finished once, then both peers go, in order.
    subject.nowMs = T0 + WINDOW_MS + TICK_MS;
    await subject.deliverer.look(ID);
    const messages = await subject.queue.list(ID);
    should(unconfirmed).match({ fate: 'unaccounted', unaccountedReason: 'landing_unconfirmed' });
    // Submitted payloads, in order: the stranded text itself, then ONE combined turn pointing at the peers' file.
    should(subject.pane.submitted).have.length(2);
    should(subject.pane.submitted[0]).equal(PEER);
    const pointer = /Read the file (\S+turn-064\.md) now/.exec(subject.pane.submitted[1] ?? '');
    should(pointer).not.be.null();
    const turnFile = await readFile((pointer as RegExpExecArray)[1] as string, 'utf8');
    should(turnFile.indexOf('(a)')).be.greaterThan(-1);
    should(turnFile.indexOf('(b)')).be.greaterThan(turnFile.indexOf('(a)'));
    should(messages.filter(message => message.id !== 'send-63').map(message => message.state)).eql([
      'delivered',
      'delivered',
    ]);
    should(subject.pane.composer).equal('');
  });
});
