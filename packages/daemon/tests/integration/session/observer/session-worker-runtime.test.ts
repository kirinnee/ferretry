/**
 * A SESSION WORKER'S PROGRAM, without its thread: when it looks, what a look reads and posts, and what it
 * answers when asked.
 *
 * The pane is a scripted tmux client — it can say the pane drew or died, or lose its connection — and the
 * clock is a manual one, so the pacing (settle, throttle, confirmation, backstop, polling) is measured
 * exactly. The transcript is a real file read by the daemon's own parser. The real client is held to its
 * allowlist in `tests/integration/tmux/session-control-client.test.ts`, the whole thread to the pre-3a path
 * in `parity.test.ts`.
 */
import { afterEach, describe, it } from 'bun:test';
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { SessionWorkerRuntime, type WorkerTmuxClient } from '../../../../src/adapters/index.ts';
import { NodeTranscriptSource } from '../../../../src/adapters/transcript/index.ts';
import {
  type AnswerOperationRecord,
  ClaudeTranscriptParser,
  CodexTranscriptParser,
  type FromSessionWorker,
  type ObserverFacts,
  type SessionBinding,
  SessionObserver,
  type TmuxCommandResult,
  type ToSessionWorker,
} from '../../../../src/lib/index.ts';

const NOW = '2026-10-22T08:00:00.000Z';
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const WORKING = '⏺ Reading.\n✽ Pontificating… (3s · ↓ 1.2k tokens · esc to interrupt)\n\n│ > ';
const IDLE = '  ? for shortcuts · ✻ Welcome back\n╭────────────────────╮\n│ > ';
const line = (record: object) => `${JSON.stringify(record)}\n`;
const claudeUser = (text: string) =>
  line({
    type: 'user',
    sessionId: 's',
    uuid: `u-${text}`,
    parentUuid: null,
    timestamp: NOW,
    message: { role: 'user', content: text },
  });
const ASK = line({
  type: 'assistant',
  sessionId: 's',
  uuid: 'a-ask',
  parentUuid: null,
  timestamp: NOW,
  message: {
    id: 'm-ask',
    role: 'assistant',
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_ship',
        name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Ship?',
              header: 'Ship',
              multiSelect: false,
              options: [
                { label: 'Yes', description: 'y' },
                { label: 'No', description: 'n' },
              ],
            },
          ],
        },
      },
    ],
  },
});

/** One pane, scripted: what it shows, whether its client is connected, and every command asked of it. */
class ScriptedClient {
  screen = IDLE;
  drawnAt = 1;
  alive = true;
  connected = true;
  watchTakes = true;
  readonly asked: string[] = [];
  watches = 0;
  closed = 0;
  private listener: ((value: string) => void) | undefined;

  client(): WorkerTmuxClient {
    const script = this;
    return {
      port: {
        execute: async (arguments_: readonly string[]): Promise<TmuxCommandResult> => {
          script.asked.push(arguments_[0] ?? '');
          if (!script.alive) return { code: 1, stdout: '', stderr: "can't find session" };
          if (arguments_[0] === 'display-message')
            return { code: 0, stdout: `0||2|2|40|100|${String(script.drawnAt)}|0|%1 123\n`, stderr: '' };
          if (arguments_[0] === 'capture-pane') return { code: 0, stdout: `${script.screen}\n`, stderr: '' };
          return { code: 1, stdout: '', stderr: 'refused' };
        },
      },
      get connected() {
        return script.connected;
      },
      watch: async () => {
        script.watches += 1;
        return script.watchTakes;
      },
      onPaneWatch: listener => {
        script.listener = listener;
        return () => {
          script.listener = undefined;
        };
      },
      close: () => {
        script.closed += 1;
      },
    };
  }

  /** The pane drew (or died): what tmux's subscription would report. */
  drew(dead = false): void {
    this.drawnAt += 1;
    this.listener?.(`${dead ? '1' : '0'} ${String(this.drawnAt)}`);
  }
}

interface Timer {
  readonly at: number;
  readonly run: () => void;
  cancelled: boolean;
}

async function rig() {
  const root = await mkdtemp(join(tmpdir(), 'fy-worker-runtime-'));
  cleanups.push(async () => await rm(root, { recursive: true, force: true }));
  const transcript = join(root, 'transcript.jsonl');
  await writeFile(transcript, '');
  const pane = new ScriptedClient();
  const posted: FromSessionWorker[] = [];
  const stats: string[] = [];
  let now = 1_000;
  let timers: Timer[] = [];
  const subject = new SessionWorkerRuntime({
    post: message => posted.push(message),
    tmux: () => pane.client(),
    transcripts: {
      claude: new NodeTranscriptSource(new ClaudeTranscriptParser()),
      codex: new NodeTranscriptSource(new CodexTranscriptParser()),
    },
    stat: async file => {
      stats.push(file);
      const info = await stat(file);
      return { size: info.size, mtimeMs: info.mtimeMs };
    },
    clock: { now: () => new Date().toISOString() },
    nowMs: () => now,
    schedule: (delayMs, run) => {
      const timer: Timer = { at: now + delayMs, run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    children: () => [],
    observer: new SessionObserver(text => `digest(${text})`),
  });
  const binding: SessionBinding = {
    tmux: { executable: '/usr/bin/tmux', socket: '/tmp/s', target: 'fy-a' },
    transcript: { file: transcript, harness: 'claude' },
  };
  /** Lets every look the runtime started finish: they read a real file. */
  const settle = async () => {
    for (let round = 0; round < 20; round += 1) await Bun.sleep(1);
  };
  /** Moves the clock, running every timer that comes due, in order. */
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter(timer => !timer.cancelled && timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      timers = timers.filter(timer => timer !== due);
      now = due.at;
      due.run();
      await settle();
    }
    now = until;
  };
  const looks = () =>
    posted.filter(
      (message): message is Extract<FromSessionWorker, { kind: 'observed' }> =>
        'kind' in message && message.kind === 'observed',
    );
  const send = async (message: ToSessionWorker) => {
    await subject.handle(message);
    await settle();
  };
  const attach = async (facts: ObserverFacts = { status: 'running', turn: 1 }, bound: SessionBinding = binding) =>
    await send({ kind: 'attach', session: 'a', generation: 1, facts, binding: bound });
  let request = 0;
  const ask = async (askFor: Extract<ToSessionWorker, { kind: 'request' }>['ask'], generation = 1) => {
    request += 1;
    await subject.handle({ kind: 'request', session: 'a', generation, request, ask: askFor });
    const answer = posted.at(-1);
    if (answer === undefined || !('kind' in answer) || answer.kind !== 'answered') throw new Error('not answered');
    return answer;
  };
  return {
    subject,
    pane,
    posted,
    stats,
    transcript,
    binding,
    send,
    attach,
    ask,
    advance,
    looks,
    settle,
    root,
    now: () => now,
  };
}

describe('SessionWorkerRuntime — when it looks', () => {
  it('should answer the probe the way every bundled worker does', async () => {
    // Arrange
    const { send, posted } = await rig();

    // Act
    await send({ probe: true });

    // Assert
    should(posted).deepEqual([{ probe: true }]);
  });

  it('should look once at attach, subscribe to the pane, and then nothing while nothing happens', async () => {
    // Arrange
    const { attach, advance, looks, pane, transcript } = await rig();
    await appendFile(transcript, claudeUser('go'));
    pane.screen = WORKING;

    // Act
    await attach();
    await advance(0);
    const atAttach = looks().length;
    await advance(29_000);

    // Assert
    should(pane.watches).equal(1);
    should(atAttach).equal(1);
    should(looks()[0]?.patches).deepEqual([{ kind: 'turn', change: { from: undefined, to: 'working' } }]);
    should(looks().length).equal(1);
  });

  it('should look after the pane drew, settled and throttled, and once on the backstop', async () => {
    // Arrange
    const { attach, advance, looks, pane, stats } = await rig();
    await attach();
    await advance(0);
    stats.length = 0;

    // Act — draws soon after the first look: the next one waits out the throttle, not just the settle.
    pane.drew();
    await advance(1_999);
    const beforeThrottle = looks().length;
    await advance(1);
    const afterThrottle = looks().length;
    // Then quiet: the backstop looks 30 s after the last look, and re-checks the transcript.
    await advance(29_999);
    const beforeBackstop = looks().length;
    await advance(1);

    // Assert
    should([beforeThrottle, afterThrottle, beforeBackstop, looks().length]).deepEqual([1, 2, 2, 3]);
    should(stats.length).equal(1);
  });

  it('should look 150 ms after a draw once the throttle is long past, and coalesce a burst into one look', async () => {
    // Arrange
    const { attach, advance, looks, pane } = await rig();
    await attach();
    await advance(10_000);

    // Act
    pane.drew();
    pane.drew();
    pane.drew();
    await advance(149);
    const settling = looks().length;
    await advance(1);

    // Assert
    should(settling).equal(1);
    should(looks().length).equal(2);
  });

  it('should look again 2 s after an unconfirmed turn end, and record it on that second frame', async () => {
    // Arrange — the transcript still says working; the pane is idle: one frame is not enough.
    const { attach, advance, looks, transcript } = await rig();
    await appendFile(transcript, claudeUser('go'));
    await attach({ status: 'running', turn: 1, turnState: 'working' });

    // Act
    await advance(0);
    const first = looks().at(-1)?.patches;
    await advance(2_000);

    // Assert
    should(first).deepEqual([]);
    should(looks().at(-1)?.patches).deepEqual([{ kind: 'turn', change: { from: 'working', to: 'your-turn' } }]);
  });

  it('should re-read the transcript only after the hub said it changed', async () => {
    // Arrange
    const { attach, advance, send, stats, transcript, looks } = await rig();
    await attach();
    await advance(0);
    stats.length = 0;

    // Act
    await appendFile(transcript, ASK);
    await send({ kind: 'file', session: 'a', generation: 1 });
    await advance(2_000);

    // Assert — the question part saw the new tool call, before the turn part.
    should(stats.length).equal(1);
    should(
      looks()
        .at(-1)
        ?.patches.map(patch => patch.kind),
    ).deepEqual(['question', 'turn']);
  });

  it('should say a dead pane once, and look on the old 2 s cadence while its client is down', async () => {
    // Arrange
    const { attach, advance, looks, pane, posted } = await rig();
    pane.connected = false;
    pane.watchTakes = false;
    await attach();

    // Act
    await advance(0);
    await advance(4_000);
    const polled = looks().length;
    pane.drew(true);
    pane.drew(true);
    await advance(0);

    // Assert
    should(polled).equal(3);
    should(pane.watches).be.aboveOrEqual(3);
    should(posted.filter(message => 'kind' in message && message.kind === 'exited')).deepEqual([
      { kind: 'exited', session: 'a', generation: 1 },
    ]);
  });
});

describe('SessionWorkerRuntime — the question part', () => {
  it('should decide the question again, without a read, when the facts or the receipts change, and not repeat itself', async () => {
    // Arrange
    const { attach, advance, send, looks, transcript, stats } = await rig();
    await appendFile(transcript, ASK);
    await attach();
    await advance(0);
    const projected = looks()
      .at(-1)
      ?.patches.find(patch => patch.kind === 'question');
    stats.length = 0;
    const accepted = {
      requestId: 'request-1',
      toolUseId: 'toolu_ship',
      fingerprint: 'f',
      acceptedAt: NOW,
      outcome: 'accepted',
    } as AnswerOperationRecord;

    // Act — the same facts again change nothing; new receipts and new facts are decided again.
    await send({ kind: 'answers', session: 'a', generation: 1, rows: [] });
    const repeated = looks().length;
    await send({ kind: 'answers', session: 'a', generation: 1, rows: [accepted] });
    const afterReceipt = looks().length;
    await send({ kind: 'facts', session: 'a', generation: 1, facts: { status: 'awaiting_question', turn: 1 } });

    // Assert
    should(projected).not.be.undefined();
    should(repeated).equal(1);
    should(afterReceipt).equal(2);
    should(looks().length).equal(3);
    should(stats).deepEqual([]);
  });

  it('should say nothing about a question while no transcript is bound', async () => {
    // Arrange
    const { attach, advance, looks, binding, send } = await rig();
    await attach({ status: 'running', turn: 1 }, { tmux: binding.tmux });

    // Act
    await advance(0);
    await send({ kind: 'facts', session: 'a', generation: 1, facts: { status: 'running', turn: 2 } });

    // Assert
    should(looks().length).equal(1);
    should(looks()[0]?.patches.every(patch => patch.kind === 'turn')).be.true();
  });
});

describe('SessionWorkerRuntime — what it answers', () => {
  it('should look now for a barrier, and answer the pane, the liveness look and the send evidence', async () => {
    // Arrange
    const { attach, advance, ask, looks, transcript, pane, stats } = await rig();
    await appendFile(transcript, claudeUser('go'));
    await attach();
    await advance(0);
    stats.length = 0;
    pane.screen = WORKING;
    pane.drawnAt += 1;

    // Act
    const barrier = await ask({ kind: 'observe' });
    const frame = await ask({ kind: 'pane' });
    const liveness = await ask({ kind: 'liveness' });
    const evidence = await ask({ kind: 'send-evidence', since: '2026-10-22T07:59:00.000Z' });

    // Assert
    should(barrier.value).be.null();
    should(looks().length).equal(2);
    should(stats.length).equal(1);
    should((frame.value as { visible: string }).visible).containEql('Pontificating');
    should(liveness.value).have.properties(['screen', 'transcript']);
    should((evidence.value as { readable: boolean; inputs: unknown[] }).readable).be.true();
    should((evidence.value as { inputs: unknown[] }).inputs.length).equal(1);
  });

  it('should answer a dead pane with nothing, a request for another generation with a failure, and say why a request failed', async () => {
    // Arrange
    const { attach, advance, ask, pane, binding, send } = await rig();
    await attach();
    await advance(0);

    // Act
    pane.alive = false;
    const dead = await ask({ kind: 'pane' });
    const liveness = await ask({ kind: 'liveness' });
    const stale = await ask({ kind: 'pane' }, 7);
    await send({ kind: 'bind', session: 'a', generation: 1, binding: { tmux: binding.tmux } });
    const unbound = await ask({ kind: 'send-evidence', since: NOW });

    // Assert
    should(dead.value).be.null();
    should(liveness.value).not.have.property('screen');
    should(stale.failure).match(/does not host a at generation 7/);
    should(unbound.value).deepEqual({ readable: false, inputs: [] });
  });

  it('should answer a request whose work threw with that failure', async () => {
    // Arrange
    const { attach, advance, ask, pane } = await rig();
    await attach();
    await advance(0);
    pane.client = () => {
      throw new Error('unused');
    };
    const evidence = await ask({ kind: 'send-evidence', since: 'not an instant' });

    // Act + Assert — an unparseable instant reads from the beginning; nothing throws.
    should(evidence.failure).be.undefined();
  });
});

describe('SessionWorkerRuntime — hosting', () => {
  it('should rebind a moved pane to a new client, forget a replaced transcript, and stop everything on detach', async () => {
    // Arrange
    const { attach, advance, send, pane, binding, root, stats, looks } = await rig();
    await attach();
    await advance(0);
    const other = join(root, 'other.jsonl');
    await writeFile(other, '');

    // Act
    await send({ kind: 'bind', session: 'a', generation: 1, binding });
    const closedBySameBinding = pane.closed;
    await send({
      kind: 'bind',
      session: 'a',
      generation: 1,
      binding: { tmux: { ...binding.tmux, target: 'fy-a-2' }, transcript: { file: other, harness: 'claude' } },
    });
    await advance(2_000);
    const lookedAfterBind = looks().length;
    await send({ kind: 'bind', session: 'b', generation: 1, binding });
    await send({ kind: 'detach', session: 'a', generation: 1 });
    await send({ kind: 'detach', session: 'a', generation: 1 });
    await advance(60_000);

    // Assert
    should(closedBySameBinding).equal(0);
    should(pane.closed).equal(2);
    should(stats.at(-1)).equal(other);
    should(looks().length).equal(lookedAfterBind);
  });

  it('should ignore every message for a generation it does not hold, and drop a look that a detach overtook', async () => {
    // Arrange
    const { attach, send, subject, advance, looks } = await rig();
    await attach();

    // Act — the first look is armed; a detach lands before it runs, and stale messages change nothing.
    await send({ kind: 'facts', session: 'a', generation: 9, facts: { status: 'stopped', turn: 1 } });
    await send({ kind: 'answers', session: 'a', generation: 9, rows: [] });
    await send({ kind: 'file', session: 'a', generation: 9 });
    await send({
      kind: 'bind',
      session: 'a',
      generation: 9,
      binding: { tmux: { executable: '/x', socket: '/y', target: 'z' } },
    });
    const inFlight = subject.handle({
      kind: 'request',
      session: 'a',
      generation: 1,
      request: 1,
      ask: { kind: 'observe' },
    });
    await send({ kind: 'detach', session: 'a', generation: 1 });
    await inFlight;
    await advance(1_000);

    // Assert
    should(subject.size).equal(0);
    should(looks().length).be.belowOrEqual(1);
    subject.close();
  });

  it('should run a look asked for while one runs once more after it', async () => {
    // Arrange
    const { attach, advance, looks, pane, ask } = await rig();
    await attach();

    // Act — the barrier and the attach look race; a draw during them is not lost.
    const barrier = ask({ kind: 'observe' });
    pane.drew();
    await barrier;
    await advance(2_000);

    // Assert
    should(looks().length).be.aboveOrEqual(2);
  });
});
