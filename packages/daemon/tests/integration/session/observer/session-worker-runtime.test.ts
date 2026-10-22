/**
 * A SESSION WORKER'S PROGRAM, without its thread: what it hosts, what a look reads and answers, and
 * that a message for a generation it does not hold changes nothing.
 *
 * The pane is a scripted tmux port (the real one is held to its allowlist in
 * `tests/integration/tmux/session-control-client.test.ts`, and the whole thread to the pre-3a path in
 * `parity.test.ts`); the transcript is a real file read by the daemon's own parser.
 */
import { afterEach, describe, it } from 'bun:test';
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { SessionWorkerRuntime, type WorkerTmuxClient } from '../../../../src/adapters/index.ts';
import { NodeTranscriptSource } from '../../../../src/adapters/transcript/index.ts';
import {
  ClaudeTranscriptParser,
  CodexTranscriptParser,
  type FromSessionWorker,
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
const claudeUser = (text: string) =>
  `${JSON.stringify({ type: 'user', sessionId: 's', uuid: `u-${text}`, parentUuid: null, timestamp: NOW, message: { role: 'user', content: text } })}\n`;

/** One pane, scripted: what it shows, when it last drew, and every command asked of it. */
class ScriptedPane {
  screen = IDLE;
  drawnAt = 1;
  alive = true;
  readonly asked: string[] = [];
  closed = 0;

  client(): WorkerTmuxClient {
    return {
      port: {
        execute: async (arguments_: readonly string[]): Promise<TmuxCommandResult> => {
          this.asked.push(arguments_[0] ?? '');
          if (!this.alive) return { code: 1, stdout: '', stderr: "can't find session" };
          if (arguments_[0] === 'display-message')
            return { code: 0, stdout: `0||2|2|40|100|${String(this.drawnAt)}|0|%1 123\n`, stderr: '' };
          if (arguments_[0] === 'capture-pane') return { code: 0, stdout: `${this.screen}\n`, stderr: '' };
          return { code: 1, stdout: '', stderr: 'refused' };
        },
      },
      close: () => {
        this.closed += 1;
      },
    };
  }
}

async function rig() {
  const root = await mkdtemp(join(tmpdir(), 'fy-worker-runtime-'));
  cleanups.push(async () => await rm(root, { recursive: true, force: true }));
  const transcript = join(root, 'transcript.jsonl');
  await writeFile(transcript, '');
  const pane = new ScriptedPane();
  const posted: FromSessionWorker[] = [];
  const stats: string[] = [];
  const children = [{ argv: ['tmux', 'capture-pane'], wallMs: 1 }];
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
    nowMs: () => 0,
    children: () => children.splice(0),
    observer: new SessionObserver(text => `digest(${text})`),
  });
  const binding: SessionBinding = {
    tmux: { executable: '/usr/bin/tmux', socket: '/tmp/s', target: 'fy-a' },
    transcript: { file: transcript, harness: 'claude' },
  };
  let request = 0;
  const look = async (generation = 1, session = 'a'): Promise<Extract<FromSessionWorker, { kind: 'looked' }>> => {
    request += 1;
    await subject.handle({ kind: 'look', session, generation, request });
    const answer = posted.at(-1);
    if (answer === undefined || !('kind' in answer) || answer.kind !== 'looked')
      throw new Error('no look was answered');
    return answer;
  };
  const send = async (message: ToSessionWorker) => await subject.handle(message);
  return { subject, pane, posted, stats, transcript, binding, look, send, root };
}

describe('SessionWorkerRuntime', () => {
  it('should answer the probe the way every bundled worker does', async () => {
    // Arrange
    const { send, posted } = await rig();

    // Act
    await send({ probe: true });

    // Assert
    should(posted).deepEqual([{ probe: true }]);
  });

  it('should look at an attached session and answer the turn its pane and transcript show', async () => {
    // Arrange
    const { send, look, pane, transcript, binding } = await rig();
    await appendFile(transcript, claudeUser('go'));
    pane.screen = WORKING;
    await send({ kind: 'attach', session: 'a', generation: 1, facts: { status: 'running', turn: 1 }, binding });

    // Act
    const started = await look();
    await send({
      kind: 'facts',
      session: 'a',
      generation: 1,
      facts: { status: 'running', turn: 1, turnState: 'working' },
    });
    const steady = await look();

    // Assert — the change once, then nothing while nothing changes; the children ride the first answer.
    should(started.patch).deepEqual({ kind: 'turn', change: { from: undefined, to: 'working' } });
    should(started.metrics.children).deepEqual([{ argv: ['tmux', 'capture-pane'], wallMs: 1 }]);
    should(steady.patch).be.undefined();
    should(steady.failure).be.undefined();
  });

  it('should re-parse the transcript only when it changed, and confirm an idle end on the second look', async () => {
    // Arrange
    const { send, look, pane, transcript, binding } = await rig();
    await appendFile(transcript, claudeUser('go'));
    pane.screen = IDLE;
    await send({
      kind: 'attach',
      session: 'a',
      generation: 1,
      facts: { status: 'running', turn: 1, turnState: 'working' },
      binding,
    });

    // Act — an idle prompt over a transcript still saying working: the end needs two looks.
    const first = await look();
    const second = await look();

    // Assert
    should(first.patch).be.undefined();
    should(second.patch).deepEqual({ kind: 'turn', change: { from: 'working', to: 'your-turn' } });
  });

  it('should not read a session that is not running, and clear the turn it still records', async () => {
    // Arrange
    const { send, look, pane, binding } = await rig();
    await send({
      kind: 'attach',
      session: 'a',
      generation: 1,
      facts: { status: 'stopped', turn: 1, turnState: 'working' },
      binding,
    });

    // Act
    const actual = await look();

    // Assert
    should(actual.patch).deepEqual({ kind: 'turn', change: { from: 'working', to: undefined } });
    should(pane.asked).deepEqual([]);
  });

  it('should ignore every message for a generation it does not hold, and say so for a look', async () => {
    // Arrange
    const { send, look, pane, binding } = await rig();
    await send({ kind: 'attach', session: 'a', generation: 2, facts: { status: 'running', turn: 1 }, binding });

    // Act
    await send({ kind: 'facts', session: 'a', generation: 1, facts: { status: 'stopped', turn: 1 } });
    await send({ kind: 'detach', session: 'a', generation: 1 });
    await send({ kind: 'answers', session: 'a', generation: 2, rows: [] });
    const stale = await look(1);
    const unknown = await look(1, 'b');
    const current = await look(2);

    // Assert
    should(stale.failure).match(/does not host a at generation 1/);
    should(unknown.failure).match(/does not host b/);
    should(current.failure).be.undefined();
    should(pane.closed).equal(0);
  });

  it('should rebind a moved pane to a new client, forget a replaced transcript, and close on detach', async () => {
    // Arrange
    const { send, look, pane, binding, root, stats } = await rig();
    await send({ kind: 'attach', session: 'a', generation: 1, facts: { status: 'running', turn: 1 }, binding });
    await look();
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
    await look();
    await send({ kind: 'bind', session: 'b', generation: 1, binding });
    await send({ kind: 'detach', session: 'a', generation: 1 });
    await send({ kind: 'detach', session: 'a', generation: 1 });

    // Assert
    should(closedBySameBinding).equal(0);
    should(pane.closed).equal(2);
    should(stats.at(-1)).equal(other);
  });

  it('should answer a look with no transcript yet, one whose file is gone, and one whose pane died', async () => {
    // Arrange
    const { send, look, pane, binding, transcript } = await rig();
    await send({
      kind: 'attach',
      session: 'a',
      generation: 1,
      facts: { status: 'running', turn: 1 },
      binding: { tmux: binding.tmux },
    });

    // Act
    const unbound = await look();
    await send({ kind: 'bind', session: 'a', generation: 1, binding });
    await rm(transcript);
    const gone = await look();
    pane.alive = false;
    const dead = await look();

    // Assert — no evidence is not a failure: the fold simply decides from what there is.
    should(unbound.failure).be.undefined();
    should(gone.failure).be.undefined();
    should(dead.failure).be.undefined();
  });

  it('should answer a look that threw as a failure, and drop a session detached while it looked', async () => {
    // Arrange
    const { send, look, subject, pane, binding } = await rig();
    await send({ kind: 'attach', session: 'a', generation: 1, facts: { status: 'running', turn: 1 }, binding });
    pane.client = () => {
      throw new Error('unreachable');
    };

    // Act — a re-attach while a look is in flight: the in-flight answer belongs to nobody.
    const inFlight = subject.handle({ kind: 'look', session: 'a', generation: 1, request: 99 });
    await send({ kind: 'detach', session: 'a', generation: 1 });
    await inFlight;
    await send({ kind: 'attach', session: 'a', generation: 3, facts: { status: 'running', turn: 1 }, binding }).catch(
      (error: unknown) => error,
    );
    const afterThrow = await look(3);

    // Assert
    should(afterThrow.failure).match(/does not host a/);
    should(subject.size).equal(0);
    subject.close();
  });
});
