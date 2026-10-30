// Realworld: asserts wall-clock speed; the outcome depends on the machine, not the code.
import { afterEach, describe, it } from 'bun:test';
import { appendFile, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  BunTmuxProcess,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  StorageTurnPorts,
  SystemClock,
} from '../../../../src/adapters/index.ts';
import { NodeTranscriptSource } from '../../../../src/adapters/transcript/index.ts';
import {
  ClaudeTranscriptParser,
  CodexTranscriptParser,
  parseSessionId,
  type SessionTranscriptTail,
  SessionTurnWatcher,
  TmuxController,
} from '../../../../src/lib/index.ts';

const NOW = '2026-10-16T08:00:00.000Z';
const cleanups = new Set<() => Promise<void>>();

afterEach(async () => {
  await Promise.all([...cleanups].map(cleanup => cleanup()));
  cleanups.clear();
});

const CLAUDE_IDLE = '  ? for shortcuts · ✻ Welcome back\n╭────────────────────╮\n│ > ';
const CLAUDE_WORKING = '⏺ Reading.\n✽ Pontificating… (3s · ↓ 1.2k tokens · esc to interrupt)\n\n│ > ';
const CODEX_IDLE = '  100% context left\n\n› Ask Codex to do anything';
const CODEX_WORKING = '• Working (5s • Esc to interrupt)\n\n› ';

const claudeUser = (text: string) =>
  `${JSON.stringify({ type: 'user', sessionId: 's', uuid: `u-${text}`, parentUuid: null, timestamp: NOW, message: { role: 'user', content: text } })}\n`;
const claudeAnswer = (stop: string | null) =>
  `${JSON.stringify({ type: 'assistant', sessionId: 's', uuid: `a-${String(stop)}-${Math.random()}`, parentUuid: null, timestamp: NOW, message: { id: 'm', role: 'assistant', stop_reason: stop, content: [{ type: 'text', text: 'ok' }] } })}\n`;
const codexEvent = (type: string) =>
  `${JSON.stringify({ timestamp: NOW, type: 'event_msg', payload: { type, turn_id: 'turn-1' } })}\n`;

interface Fixture {
  readonly watcher: SessionTurnWatcher;
  readonly frame: (text: string) => Promise<void>;
  readonly transcript: (text: string) => Promise<void>;
  readonly turnState: () => Promise<unknown>;
}

async function fixture(harness: 'claude' | 'codex', initialFrame: string): Promise<Fixture> {
  const tmux = Bun.which('tmux');
  if (tmux === null) throw new Error('tmux is required for turn-state realworld coverage');
  const home = await mkdtemp(join(tmpdir(), 'ferretry-turn-'));
  const opened = await new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  ).open();
  const id = parseSessionId(`turn-${harness}`);
  const tmuxSession = `fy-turn-${harness}`;
  await opened.storage.writeConfig(id, { id, name: 'Turn', tmuxSession, harness, mode: 'interactive' });
  await opened.storage.writeState(id, { id, status: 'running', turn: 1 });

  const frameFile = join(home, 'frame.txt');
  const transcriptFile = join(home, harness === 'claude' ? 'transcript.jsonl' : 'rollout.jsonl');
  await writeFile(frameFile, initialFrame);
  await writeFile(transcriptFile, '');
  // Redraw on change; print the frame, then put the cursor back on its last line, column zero.
  const player = join(home, 'player.sh');
  await writeFile(
    player,
    [
      '#!/bin/sh',
      'last=""',
      'while :; do',
      `  now="$(cat '${frameFile}')"`,
      '  if [ "$now" != "$last" ]; then printf \'\\033[H\\033[2J%s\\n\\033[1A\' "$now"; last="$now"; fi',
      '  sleep 0.05',
      'done',
    ].join('\n'),
  );
  await chmod(player, 0o755);
  const commands = new BunTmuxProcess(tmux, join(home, 'tmux.sock'));
  const controller = new TmuxController(commands);
  await controller.launch({ session: tmuxSession, cwd: home, command: ['/bin/sh', player], width: 100, height: 40 });

  const source = new NodeTranscriptSource(
    harness === 'claude' ? new ClaudeTranscriptParser() : new CodexTranscriptParser(),
  );
  const tail: SessionTranscriptTail = {
    tail: async (_id, limit) => ({ kind: 'read', events: (await source.read(transcriptFile)).events.slice(-limit) }),
  };
  const ports = new StorageTurnPorts(opened.storage, tail, async () => transcriptFile, controller, {
    now: () => NOW,
  });
  cleanups.add(async () => {
    await Bun.spawn([tmux, '-S', join(home, 'tmux.sock'), 'kill-server'], { stdout: 'ignore', stderr: 'ignore' })
      .exited;
    await opened.storage.close();
    await rm(home, { recursive: true, force: true });
  });
  return {
    watcher: new SessionTurnWatcher(ports),
    frame: async text => {
      await writeFile(frameFile, text);
    },
    transcript: async text => {
      await appendFile(transcriptFile, text);
    },
    turnState: async () => ((await opened.storage.readState(id)) as Record<string, unknown>).turnState,
  };
}

/** Ticks until the record reads `expected` or the budget runs out, and answers how long it took. */
async function until(subject: Fixture, expected: unknown, budgetMs = 6_000): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    await subject.watcher.tick();
    if ((await subject.turnState()) === expected) return Date.now() - started;
    await Bun.sleep(200);
  }
  throw new Error(`turnState never became ${String(expected)}; it is ${String(await subject.turnState())}`);
}

describe('the turn watcher over real panes and transcripts', () => {
  it('Claude: idle at the prompt, mid-turn, turn complete, permission prompt, interrupted, crashed', async () => {
    // Arrange
    const subject = await fixture('claude', CLAUDE_IDLE);
    await Bun.sleep(400);
    await until(subject, 'your-turn');
    await subject.transcript(claudeUser('go'));
    await subject.frame(CLAUDE_WORKING);
    await Bun.sleep(400);
    await until(subject, 'working');

    // Act — REGRESSION: the spinner must stop within a few seconds of the turn ending.
    await subject.transcript(claudeAnswer('end_turn'));
    await subject.frame(CLAUDE_IDLE);
    await Bun.sleep(400);
    const tookMs = await until(subject, 'your-turn');

    // Assert
    should(tookMs).be.below(3_000);
  }, 60_000);

  it('Codex: idle at the prompt, mid-turn, turn complete, permission prompt, interrupted, crashed', async () => {
    // Arrange
    const subject = await fixture('codex', CODEX_IDLE);
    await Bun.sleep(400);
    await until(subject, 'your-turn');
    await subject.transcript(codexEvent('task_started'));
    await subject.frame(CODEX_WORKING);
    await Bun.sleep(400);
    await until(subject, 'working');

    // Act
    await subject.transcript(codexEvent('task_complete'));
    await subject.frame(CODEX_IDLE);
    await Bun.sleep(400);
    const tookMs = await until(subject, 'your-turn');

    // Assert
    should(tookMs).be.below(3_000);
  }, 60_000);
});
