/**
 * PARITY ON REAL EVIDENCE: the inline observer host against the pre-3a path, side by side.
 *
 * Stage 3a (`docs/design/session-workers.md` §4.3) must not change what a person sees. Each scenario
 * here drives ONE real tmux pane — a frame player redrawing what each harness draws — and appends the
 * same transcript lines to two real transcripts, then lets two daemons' worth of storage observe it:
 *
 *   - the PRE-3a PATH: `SessionTurnWatcher` over `StorageTurnPorts` (which re-reads every state
 *     document per tick) and a verbatim copy of the composition root's old `projectSessionEvidence`;
 *   - the INLINE HOST: `InlineObserverHost`, told its facts by storage, writing through
 *     `SessionObservationApplier`.
 *
 * Both must journal the same `turn.*` events in the same order and end on the same `state.json`.
 * (Send evidence parity is the pure fold's and lives in the unit replay suite: the send tracker's
 * ports did not change.)
 */
import { afterEach, describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SessionState, SessionStateSchema } from '@ferretry/protocol';
import should from 'should';
import {
  BunSqliteIndexFactory,
  BunTmuxProcess,
  type DaemonStorage,
  DaemonStorageFactory,
  FileAnswerLedger,
  InlineObserverHost,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SessionObservationApplier,
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
  createSessionPaths,
  observedRuntimeStatePatch,
  parseSessionId,
  projectObservedRuntime,
  projectStructuredQuestion,
  reconcileAnswerEvidence,
  type SessionId,
  SessionObserver,
  type SessionTranscriptTail,
  SessionTurnWatcher,
  structuredQuestionStatePatch,
  TmuxController,
} from '../../../../src/lib/index.ts';

const NOW = '2026-10-22T08:00:00.000Z';
const clock = { now: () => NOW };
const cleanups = new Set<() => Promise<void>>();

afterEach(async () => {
  await Promise.all([...cleanups].map(cleanup => cleanup()));
  cleanups.clear();
});

const CLAUDE_IDLE = '  ? for shortcuts · ✻ Welcome back\n╭────────────────────╮\n│ > ';
const CLAUDE_WORKING = '⏺ Reading.\n✽ Pontificating… (3s · ↓ 1.2k tokens · esc to interrupt)\n\n│ > ';
const CLAUDE_PERMISSION = ' Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently';
const CODEX_IDLE = '  100% context left\n\n› Ask Codex to do anything';
const CODEX_WORKING = '• Working (5s • Esc to interrupt)\n\n› ';

const line = (record: object): string => `${JSON.stringify(record)}\n`;
const claudeUser = (id: string, content: unknown) =>
  line({
    type: 'user',
    sessionId: 's',
    uuid: id,
    parentUuid: null,
    timestamp: NOW,
    message: { role: 'user', content },
  });
const claudeAnswer = (id: string, stop: string | null, content: unknown[]) =>
  line({
    type: 'assistant',
    sessionId: 's',
    uuid: id,
    parentUuid: null,
    timestamp: NOW,
    message: { id: `m-${id}`, role: 'assistant', model: 'claude-opus-5-5', stop_reason: stop, content },
  });
const ASK = claudeAnswer('a-ask', 'tool_use', [
  {
    type: 'tool_use',
    id: 'toolu_ship',
    name: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Ship it?',
          header: 'Ship',
          multiSelect: false,
          options: [
            { label: 'Yes', description: 'ship' },
            { label: 'No', description: 'hold' },
          ],
        },
      ],
    },
  },
]);
const ANSWER = claudeUser('u-answer', [{ type: 'tool_result', tool_use_id: 'toolu_ship', content: 'Yes' }]);
const codexEvent = (type: string) => line({ timestamp: NOW, type: 'event_msg', payload: { type, turn_id: 'turn-1' } });
const CODEX_CONTEXT = line({ timestamp: NOW, type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'high' } });

async function openStorage(home: string): Promise<DaemonStorage> {
  const opened = await new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  ).open();
  return opened.storage;
}

/** One side of the comparison: a storage home with its own transcript, observing the shared pane. */
interface Side {
  readonly storage: DaemonStorage;
  readonly transcript: string;
  readonly tail: SessionTranscriptTail;
  readonly ledger: FileAnswerLedger;
}

interface Pair {
  readonly id: SessionId;
  readonly reference: Side;
  readonly host: Side;
  /** One look by both: the turn tick, then (when asked) the question pass. */
  readonly look: (options?: { readonly questions?: boolean }) => Promise<void>;
  readonly frame: (text: string) => Promise<void>;
  readonly append: (text: string) => Promise<void>;
  readonly write: (fields: Partial<SessionState>) => Promise<void>;
}

async function pair(harness: 'claude' | 'codex', initialFrame: string): Promise<Pair> {
  const tmux = Bun.which('tmux');
  if (tmux === null) throw new Error('tmux is required for observer parity coverage');
  const root = await mkdtemp(join(tmpdir(), 'fy-observer-parity-'));
  const id = parseSessionId(`parity-${harness}`);
  const tmuxSession = `fy-parity-${harness}`;
  const frameFile = join(root, 'frame.txt');
  await writeFile(frameFile, initialFrame);
  const player = join(root, 'player.sh');
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
  const socket = join(root, 'tmux.sock');
  const controller = new TmuxController(new BunTmuxProcess(tmux, socket));
  await controller.launch({ session: tmuxSession, cwd: root, command: ['/bin/sh', player], width: 100, height: 40 });

  const source = new NodeTranscriptSource(
    harness === 'claude' ? new ClaudeTranscriptParser() : new CodexTranscriptParser(),
  );
  const side = async (name: string): Promise<Side> => {
    const storage = await openStorage(join(root, name));
    await storage.writeConfig(id, { id, name: 'Parity', tmuxSession, harness, mode: 'interactive' });
    await storage.writeState(id, { id, status: 'running', turn: 1 });
    const transcript = join(root, `${name}.jsonl`);
    await writeFile(transcript, '');
    return {
      storage,
      transcript,
      tail: {
        tail: async (_id, limit) => ({ kind: 'read', events: (await source.read(transcript)).events.slice(-limit) }),
      },
      ledger: new FileAnswerLedger(session => createSessionPaths(storage.paths, session).directory, clock),
    };
  };
  const reference = await side('reference');
  const host = await side('host');
  cleanups.add(async () => {
    await Bun.spawn([tmux, '-S', socket, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' }).exited;
    await reference.storage.close();
    await host.storage.close();
    await rm(root, { recursive: true, force: true });
  });

  // THE PRE-3a PATH.
  const watcher = new SessionTurnWatcher(
    new StorageTurnPorts(reference.storage, reference.tail, async () => reference.transcript, controller, clock),
  );
  const referenceSerial = new KeyedSerialExecutor();
  const referenceProject = async (session: SessionId): Promise<void> => {
    const storage = reference.storage;
    const answerLedger = reference.ledger;
    await referenceSerial.runIfIdle(session, async () => {
      const transcript = await reference.tail.tail(session, 400);
      if (transcript.kind !== 'read') return;
      const current = SessionStateSchema.safeParse(await storage.readState(session));
      if (!current.success) return;
      const projection = projectStructuredQuestion(transcript.events);
      const answerEvidence = reconcileAnswerEvidence(await answerLedger.all(session), current.data, {
        ...(projection.kind === 'pending' ? { activeToolUseId: projection.question.toolUseId } : {}),
        ...(projection.kind === 'resolved' ? { resolvedToolUseId: projection.toolUseId } : {}),
      });
      for (const settlement of answerEvidence.settlements) await answerLedger.append(session, settlement);
      const answerRecords = [...answerEvidence.records.values()];
      const observedRuntime = projectObservedRuntime(transcript.events);
      const question = structuredQuestionStatePatch(current.data, projection, answerRecords);
      const patch = { ...question, ...observedRuntimeStatePatch(current.data, observedRuntime) };
      if (Object.keys(patch).length === 0) return;
      await storage.updateState(session, raw => {
        const verified = SessionStateSchema.safeParse(raw);
        if (!verified.success) return raw;
        const currentQuestion = structuredQuestionStatePatch(verified.data, projection, answerRecords);
        const currentPatch = { ...currentQuestion, ...observedRuntimeStatePatch(verified.data, observedRuntime) };
        if (Object.keys(currentPatch).length === 0) return raw;
        const next = { ...(raw as Record<string, unknown>), ...currentPatch };
        if (Object.hasOwn(currentQuestion, 'pendingQuestion') && currentQuestion.pendingQuestion === undefined)
          delete next.pendingQuestion;
        if (Object.hasOwn(currentQuestion, 'needsHumanKind') && currentQuestion.needsHumanKind === undefined)
          delete next.needsHumanKind;
        if (Object.hasOwn(currentQuestion, 'needsHuman') && currentQuestion.needsHuman === undefined)
          delete next.needsHuman;
        return next as typeof raw;
      });
    });
  };

  // THE INLINE HOST.
  const hostPanes = new StorageTurnPorts(host.storage, host.tail, async () => host.transcript, controller, clock);
  const observer = new InlineObserverHost(
    {
      storage: host.storage,
      questionRoster: () => host.storage.listSessions().map(session => session.id),
      tail: host.tail,
      pane: async session => await hostPanes.pane(session),
      answers: host.ledger,
      answerSerial: new KeyedSerialExecutor(),
      applier: new SessionObservationApplier(host.storage, host.ledger, new KeyedSerialExecutor()),
      liveness: {
        screen: async () => {
          throw new Error('not looked at here');
        },
        transcript: async () => {
          throw new Error('not looked at here');
        },
        processes: async () => {
          throw new Error('not looked at here');
        },
      },
      clock,
      yieldToLoop: async () => undefined,
    },
    new SessionObserver(text => createHash('sha256').update(text, 'utf8').digest('hex')),
  );

  return {
    id,
    reference,
    host,
    look: async options => {
      // The question pass runs first, as the boot order (#689) and the observer's step both have it.
      if (options?.questions === true) {
        await referenceProject(id);
        await observer.questions();
      }
      await watcher.tick();
      await observer.turns.run();
    },
    frame: async text => {
      await writeFile(frameFile, text);
      // Long enough for the player's 50 ms poll to redraw and tmux to show it.
      await Bun.sleep(400);
    },
    append: async text => {
      await appendFile(reference.transcript, text);
      await appendFile(host.transcript, text);
    },
    write: async fields => {
      for (const storage of [reference.storage, host.storage])
        await storage.updateState(id, raw => ({ ...(raw as Record<string, unknown>), ...fields }));
    },
  };
}

const journal = async (side: Side, id: SessionId) =>
  (await side.storage.replay(id)).events.map(event => ({ type: event.type, data: event.data }));
const state = async (side: Side, id: SessionId) => await side.storage.readState(id);

async function shouldAgree(subject: Pair): Promise<void> {
  should(await journal(subject.host, subject.id)).deepEqual(await journal(subject.reference, subject.id));
  should(await state(subject.host, subject.id)).deepEqual(await state(subject.reference, subject.id));
  should(await subject.host.ledger.all(subject.id)).deepEqual(await subject.reference.ledger.all(subject.id));
}

describe('the inline observer host against the pre-3a path, over real panes and transcripts', () => {
  it('should journal and record the same Claude turn: idle, working, permission, ended', async () => {
    // Arrange
    const subject = await pair('claude', CLAUDE_IDLE);
    await subject.frame(CLAUDE_IDLE);

    // Act
    await subject.look();
    await subject.append(claudeUser('u1', 'go'));
    await subject.frame(CLAUDE_WORKING);
    await subject.look();
    await subject.frame(CLAUDE_PERMISSION);
    await subject.look();
    await subject.look();
    await subject.frame(CLAUDE_WORKING);
    await subject.look();
    await subject.append(claudeAnswer('a1', 'end_turn', [{ type: 'text', text: 'done' }]));
    await subject.frame(CLAUDE_IDLE);
    await subject.look({ questions: true });
    await subject.look({ questions: true });

    // Assert
    const turns = (await journal(subject.host, subject.id)).filter(event => event.type.startsWith('turn.'));
    should(turns.map(event => (event.data as { to: string | null }).to)).deepEqual([
      'your-turn',
      'working',
      'needs-input',
      'working',
      'your-turn',
    ]);
    await shouldAgree(subject);
  });

  it('should journal and record the same Codex turn and its observed runtime', async () => {
    // Arrange
    const subject = await pair('codex', CODEX_IDLE);
    await subject.frame(CODEX_IDLE);

    // Act
    await subject.append(codexEvent('task_started'));
    await subject.append(CODEX_CONTEXT);
    await subject.frame(CODEX_WORKING);
    await subject.look({ questions: true });
    await subject.append(codexEvent('task_complete'));
    await subject.frame(CODEX_IDLE);
    await subject.look();
    await subject.look();

    // Assert
    const ended = (await state(subject.host, subject.id)) as Record<string, unknown>;
    should(ended.observedModel).equal('gpt-5.5');
    should(ended.turnState).equal('your-turn');
    await shouldAgree(subject);
  });

  it('should project the same structured question, its answer, and the stop that ends the turn', async () => {
    // Arrange
    const subject = await pair('claude', CLAUDE_WORKING);
    await subject.frame(CLAUDE_WORKING);

    // Act — asked: the question pass projects it, the turn reads needs-input.
    await subject.append(claudeUser('u1', 'go'));
    await subject.append(ASK);
    await subject.look({ questions: true });
    await subject.look({ questions: true });
    const asked = (await state(subject.host, subject.id)) as Record<string, unknown>;
    // Answered in the harness: the picker clears and the turn goes on.
    await subject.append(ANSWER);
    await subject.look({ questions: true });
    await subject.look({ questions: true });
    // Stopped: the turn record is cleared and never given back.
    await subject.write({ status: 'stopped' });
    await subject.look({ questions: true });
    await subject.look();

    // Assert
    should(asked.status).equal('awaiting_question');
    should(asked.turnState).equal('needs-input');
    should(((await state(subject.host, subject.id)) as Record<string, unknown>).turnState).be.undefined();
    await shouldAgree(subject);
  });
});
