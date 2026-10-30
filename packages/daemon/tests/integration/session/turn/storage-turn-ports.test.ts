import { afterEach, describe, it } from 'bun:test';
import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  parseHarnessDialog,
  parsePermissionPrompt,
  parseSessionId,
  type SessionId,
  type SessionTranscriptTail,
  SessionTurnWatcher,
  TmuxController,
} from '../../../../src/lib/index.ts';
import { waitFor } from '../../support/wait-for.ts';

/**
 * Whose turn it is, read from REAL evidence: a real tmux server whose panes draw what each harness
 * draws (idle prompt, working line, permission prompt, interrupted banner), real Claude and Codex
 * transcripts parsed by the daemon's own parsers, and the real storage the record is written to.
 *
 * Every pane runs a tiny frame player — it redraws whatever the test writes to its frame file, with
 * the cursor left at the start of its last line — the prompt, where a ready harness leaves it — so a state change is one
 * file write and nothing here can spend a token.
 */

const NOW = '2026-10-16T08:00:00.000Z';
const cleanups = new Set<() => Promise<void>>();

afterEach(async () => {
  await Promise.all([...cleanups].map(cleanup => cleanup()));
  cleanups.clear();
});

const CLAUDE_IDLE = '  ? for shortcuts · ✻ Welcome back\n╭────────────────────╮\n│ > ';
const CLAUDE_WORKING = '⏺ Reading.\n✽ Pontificating… (3s · ↓ 1.2k tokens · esc to interrupt)\n\n│ > ';
const CLAUDE_PERMISSION = ' Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently';
/**
 * A fresh bypass agent parked on Claude 2.1.281's one-shot auto-mode dialog, drawn under its composer
 * the way the owner saw it: the composer's `❯` and the dialog's cursor row both read as a prompt.
 */
const CLAUDE_AUTO_NUDGE = [
  ' ▐▛███▜▌   Claude Code v2.1.281',
  '──────────────────────────────',
  '❯ ',
  '──────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  '',
  ' Make auto mode your default permission mode?',
  '',
  '   Auto mode lets Claude handle permission prompts automatically.',
  '',
  '     Yes, set auto mode as my default permission mode',
  '   ❯ No, keep bypass permissions',
].join('\n');
const CODEX_IDLE = '  100% context left\n\n› Ask Codex to do anything';
const CODEX_WORKING = '• Working (5s • Esc to interrupt)\n\n› ';
const CODEX_INTERRUPTED = '■ Conversation interrupted - tell the model what to do differently\n\n› ';

const claudeUser = (text: string) =>
  `${JSON.stringify({ type: 'user', sessionId: 's', uuid: `u-${text}`, parentUuid: null, timestamp: NOW, message: { role: 'user', content: text } })}\n`;
const claudeAnswer = (stop: string | null) =>
  `${JSON.stringify({ type: 'assistant', sessionId: 's', uuid: `a-${String(stop)}-${Math.random()}`, parentUuid: null, timestamp: NOW, message: { id: 'm', role: 'assistant', stop_reason: stop, content: [{ type: 'text', text: 'ok' }] } })}\n`;
const codexEvent = (type: string) =>
  `${JSON.stringify({ timestamp: NOW, type: 'event_msg', payload: { type, turn_id: 'turn-1' } })}\n`;

interface Fixture {
  readonly watcher: SessionTurnWatcher;
  readonly ports: StorageTurnPorts;
  readonly id: SessionId;
  readonly frame: (text: string) => Promise<void>;
  readonly transcript: (text: string) => Promise<void>;
  readonly status: (status: string) => Promise<void>;
  readonly turnState: () => Promise<unknown>;
  readonly turnPrompt: () => Promise<unknown>;
  readonly permissionRequest: () => Promise<unknown>;
  readonly harnessDialog: () => Promise<unknown>;
  readonly journal: () => Promise<readonly { type: string; data: unknown }[]>;
  readonly events: () => Promise<readonly (string | null)[]>;
  readonly settle: () => Promise<void>;
  readonly tmuxSession: string;
}

async function fixture(harness: 'claude' | 'codex', initialFrame: string, width = 100): Promise<Fixture> {
  const tmux = Bun.which('tmux');
  if (tmux === null) throw new Error('tmux is required for turn-state integration coverage');
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
  let latestFrame = initialFrame;
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
  await controller.launch({ session: tmuxSession, cwd: home, command: ['/bin/sh', player], width, height: 40 });

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
  const state = async () => (await opened.storage.readState(id)) as Record<string, unknown>;
  return {
    watcher: new SessionTurnWatcher(ports),
    ports,
    id,
    tmuxSession,
    frame: async text => {
      latestFrame = text;
      await writeFile(frameFile, text);
    },
    transcript: async text => {
      await appendFile(transcriptFile, text);
    },
    status: async status => {
      await opened.storage.updateState(id, raw => ({ ...(raw as Record<string, unknown>), status }));
    },
    turnState: async () => (await state()).turnState,
    turnPrompt: async () => (await state()).turnPrompt,
    permissionRequest: async () => (await state()).permissionRequest,
    harnessDialog: async () => (await state()).harnessDialog,
    journal: async () =>
      (await opened.storage.replay(id)).events.map(event => ({ type: event.type, data: event.data })),
    events: async () =>
      (await opened.storage.replay(id)).events
        .filter(event => event.type === 'turn.state')
        .map(event => (event.data as { to: string | null }).to),
    // Until the pane shows the latest frame: the player redraws on its own poll, and a terminal paints bytes
    // in order, so the frame's last rows on screen mean the rows above them are too.
    settle: async () => {
      const wanted = lastRows(latestFrame);
      await waitFor(async () => {
        const screen = await controller.visible(tmuxSession);
        const shown = screen === undefined ? undefined : lastRows(screen);
        return shown?.length === wanted.length && shown.every((row, index) => row === wanted[index]);
      }, 'the pane to draw the latest frame');
    },
  };
}

/** The last non-blank rows of a frame or a capture, without trailing spaces, to tell whether a pane has drawn it. */
const lastRows = (text: string, count = 3): readonly string[] =>
  text
    .split('\n')
    .map(row => row.trimEnd())
    .filter(row => row !== '')
    .slice(-count);

/** A real pane captured from a harness, from `tests/fixtures/permission-prompts`. */
const prompt = async (name: string): Promise<string> =>
  await readFile(join(import.meta.dir, '../../../fixtures/permission-prompts', `${name}.txt`), 'utf8');

/** Ticks until the recorded permission request is `id`. */
async function untilRequest(subject: Fixture, id: string | undefined): Promise<void> {
  await waitFor(
    async () => {
      await subject.watcher.tick();
      return ((await subject.permissionRequest()) as { id?: string } | undefined)?.id === id;
    },
    `permissionRequest to become ${String(id)}`,
    { every: 200 },
  );
}

/** A real pane captured from a harness, from `tests/fixtures/harness-dialogs`. */
const dialogPane = async (name: string): Promise<string> =>
  await readFile(join(import.meta.dir, '../../../fixtures/harness-dialogs', `${name}.txt`), 'utf8');

/** Ticks until the record reads `expected`. */
async function until(subject: Fixture, expected: unknown): Promise<void> {
  await waitFor(
    async () => {
      await subject.watcher.tick();
      return (await subject.turnState()) === expected;
    },
    `turnState to become ${String(expected)}`,
    { every: 200 },
  );
}

describe('the turn watcher over real panes and transcripts', () => {
  it('Claude: idle at the prompt, mid-turn, turn complete, permission prompt, interrupted, crashed', async () => {
    const subject = await fixture('claude', CLAUDE_IDLE);
    await subject.settle();

    // Idle at the prompt, nothing in the transcript: the person's turn.
    await until(subject, 'your-turn');

    // Mid-turn: the person spoke and the harness paints its working line.
    await subject.transcript(claudeUser('go'));
    await subject.frame(CLAUDE_WORKING);
    await subject.settle();
    await until(subject, 'working');

    // Permission prompt mid-turn: blocked on a person.
    await subject.frame(CLAUDE_PERMISSION);
    await subject.settle();
    await until(subject, 'needs-input');

    // Turn complete: end_turn in the transcript and the idle prompt on screen. REGRESSION: the spinner
    // must stop within a few seconds of the turn ending.
    await subject.frame(CLAUDE_WORKING);
    await subject.settle();
    await until(subject, 'working');
    await subject.transcript(claudeAnswer('end_turn'));
    await subject.frame(CLAUDE_IDLE);
    await subject.settle();
    await until(subject, 'your-turn');

    // Interrupted: Claude writes NO end, so the idle pane is the only witness — it still ends the turn.
    await subject.transcript(claudeUser('again'));
    await subject.frame(CLAUDE_WORKING);
    await subject.settle();
    await until(subject, 'working');
    await subject.frame(CLAUDE_IDLE);
    await subject.settle();
    await until(subject, 'your-turn');

    // Crashed: the session is no longer live, so it has no turn at all.
    await subject.status('failed');
    await until(subject, undefined);

    // Each boundary was journaled exactly once, in order.
    should(await subject.events()).deepEqual([
      'your-turn',
      'working',
      'needs-input',
      'working',
      'your-turn',
      'working',
      'your-turn',
      null,
    ]);
  }, 60_000);

  it('Codex: idle at the prompt, mid-turn, turn complete, permission prompt, interrupted, crashed', async () => {
    const subject = await fixture('codex', CODEX_IDLE);
    await subject.settle();
    await until(subject, 'your-turn');

    await subject.transcript(codexEvent('task_started'));
    await subject.frame(CODEX_WORKING);
    await subject.settle();
    await until(subject, 'working');

    await subject.frame('Would you like to run the following command?\n  $ git push\n› 1. Yes, proceed\n  2. No');
    await subject.settle();
    await until(subject, 'needs-input');

    await subject.frame(CODEX_WORKING);
    await subject.settle();
    await until(subject, 'working');
    await subject.transcript(codexEvent('task_complete'));
    await subject.frame(CODEX_IDLE);
    await subject.settle();
    await until(subject, 'your-turn');

    await subject.transcript(codexEvent('task_started'));
    await subject.frame(CODEX_WORKING);
    await subject.settle();
    await until(subject, 'working');
    await subject.transcript(codexEvent('turn_aborted'));
    await subject.frame(CODEX_INTERRUPTED);
    await subject.settle();
    await until(subject, 'your-turn');

    await subject.status('stopped');
    await until(subject, undefined);
  }, 60_000);

  it('Claude parked on a one-shot dialog: needs input, saying what is on screen, until it is answered', async () => {
    // A fresh agent with no transcript at all — the case the send path called "transcript unreadable".
    const subject = await fixture('claude', CLAUDE_AUTO_NUDGE);
    await subject.settle();

    await until(subject, 'needs-input');
    should(await subject.turnPrompt()).equal('Make auto mode your default permission mode?');

    // Answered: the dialog closes on the idle composer, and the dialog leaves the record with it.
    await subject.frame(CLAUDE_IDLE);
    await subject.settle();
    await until(subject, 'your-turn');
    should(await subject.turnPrompt()).be.undefined();
    should(await subject.events()).deepEqual(['needs-input', 'your-turn']);
  }, 30_000);

  it('a real harness permission prompt: recorded as data, replaced by the next, cleared once answered', async () => {
    for (const [harness, first, second] of [
      ['claude', 'claude-2.1.281-read-outside', 'claude-2.1.281-bash'],
      ['codex', 'codex-0.156.1-shell', 'codex-0.156.1-patch'],
    ] as const) {
      // Arrange — the panes Claude Code and Codex really drew, at the width they were captured at.
      const subject = await fixture(harness, await prompt(first), 120);
      await subject.settle();

      // Act + Assert — on screen: needs input, and the request is the one the pane shows.
      await until(subject, 'needs-input');
      should(await subject.permissionRequest()).deepEqual(parsePermissionPrompt(await prompt(first)));

      // The next prompt replaces it beside the same needs-input — its own event, not a new boundary.
      await subject.frame(await prompt(second));
      await subject.settle();
      await untilRequest(subject, parsePermissionPrompt(await prompt(second))?.id);

      // Answered: the prompt is gone, and so is the request.
      await subject.frame(harness === 'claude' ? CLAUDE_IDLE : CODEX_IDLE);
      await subject.settle();
      await until(subject, 'your-turn');
      should(await subject.permissionRequest()).be.undefined();

      const journal = (await subject.journal()).filter(event => event.type.startsWith('turn.'));
      should(journal.map(event => event.type)).deepEqual(['turn.state', 'turn.prompt', 'turn.state']);
      // The request rides the live feed itself, so a page can show it from the event alone.
      should(
        journal.map(
          event => (event.data as { permissionRequest: { id: string } | null }).permissionRequest?.id ?? null,
        ),
      ).deepEqual([
        parsePermissionPrompt(await prompt(first))?.id,
        parsePermissionPrompt(await prompt(second))?.id,
        null,
      ]);
    }
  }, 60_000);

  it('a real harness dialog: recorded as data, a cursor move records nothing, cleared once answered', async () => {
    for (const [harness, first, moved, second] of [
      ['codex', 'codex-0.156.1-hooks-review', 'codex-0.156.1-hooks-review-moved', 'codex-0.156.1-update'],
      ['claude', 'claude-2.1.281-mcp-servers', undefined, 'claude-2.1.281-settings-error'],
    ] as const) {
      // Arrange — the screens Codex and Claude Code really drew, at the width they were captured at.
      const subject = await fixture(harness, await dialogPane(first), 120);
      await subject.settle();
      const shown = parseHarnessDialog(await dialogPane(first));

      // Act + Assert — on screen: needs input, and the record is the dialog the pane shows.
      await until(subject, 'needs-input');
      should(await subject.harnessDialog()).deepEqual(shown);
      should(await subject.permissionRequest()).be.undefined();

      // Somebody at the terminal moving the cursor is the same dialog: nothing more is recorded.
      if (moved !== undefined) {
        await subject.frame(await dialogPane(moved));
        await subject.settle();
        await subject.watcher.tick();
        should((await subject.harnessDialog()) as { id: string }).have.property('id', shown?.id);
        should((await subject.journal()).filter(event => event.type.startsWith('turn.'))).have.length(1);
      }

      // The next dialog replaces it beside the same needs-input.
      await subject.frame(await dialogPane(second));
      await subject.settle();
      const next = parseHarnessDialog(await dialogPane(second));
      await waitFor(
        async () => {
          await subject.watcher.tick();
          return ((await subject.harnessDialog()) as { id?: string } | undefined)?.id === next?.id;
        },
        'harnessDialog to become the next dialog',
        { every: 200 },
      );

      // Answered: the dialog is gone, and so is the record.
      await subject.frame(harness === 'claude' ? CLAUDE_IDLE : CODEX_IDLE);
      await subject.settle();
      await until(subject, 'your-turn');
      should(await subject.harnessDialog()).be.undefined();

      const journal = (await subject.journal()).filter(event => event.type.startsWith('turn.'));
      should(journal.map(event => event.type)).deepEqual(['turn.state', 'turn.prompt', 'turn.state']);
      // The dialog rides the live feed itself, so a page can show it from the event alone.
      should(
        journal.map(event => (event.data as { harnessDialog: { id: string } | null }).harnessDialog?.id ?? null),
      ).deepEqual([shown?.id, next?.id, null]);
    }
  }, 60_000);

  it('should re-derive a turn still running after the daemon restarts, from the transcript alone', async () => {
    // Arrange — a working turn, then a fresh watcher (a restarted daemon) with no memory of it.
    const subject = await fixture('codex', CODEX_WORKING);
    await subject.transcript(codexEvent('task_started'));
    await subject.settle();
    await until(subject, 'working');
    const restarted = new SessionTurnWatcher(subject.ports);

    // Act — the pane goes blank mid-turn (a redraw), and only the transcript is left to say.
    await subject.frame('');
    await subject.settle();
    await restarted.tick();

    // Assert
    should(await subject.turnState()).equal('working');
  }, 30_000);

  it('should refuse a stale change, and never mark a finished session working', async () => {
    const subject = await fixture('claude', CLAUDE_IDLE);

    // A change whose `from` no longer matches the record lost a race and writes nothing.
    should(await subject.ports.record(subject.id, { from: 'working', to: 'your-turn' }, NOW)).be.false();
    // A stop that committed after the watcher looked has the last word.
    await subject.status('stopped');
    should(await subject.ports.record(subject.id, { from: undefined, to: 'working' }, NOW)).be.false();
    should(await subject.turnState()).be.undefined();
    should(await subject.events()).deepEqual([]);
  }, 30_000);

  it('should answer nothing for a transcript file that cannot be read as this session', async () => {
    const subject = await fixture('codex', CODEX_IDLE);
    const storage = (subject.ports as unknown as { storage: never }).storage;
    const file = join(tmpdir(), `ferretry-turn-unreadable-${process.pid}.jsonl`);
    await writeFile(file, '');
    cleanups.add(async () => await rm(file, { force: true }));
    const unreadable = new StorageTurnPorts(
      storage,
      { tail: async () => ({ kind: 'unreadable' }) },
      async () => file,
      { activity: async () => Promise.reject(new Error('unused')), visible: async () => undefined },
      { now: () => NOW },
    );
    should(await unreadable.transcript(subject.id)).be.undefined();
  }, 30_000);

  it('should hand back the live pane as captured, for readers that parse it themselves', async () => {
    // Arrange — the live readout reads the harness's own counter off the same capture the watcher uses.
    const subject = await fixture('claude', CLAUDE_WORKING);
    await subject.settle();

    // Act
    const pane = await subject.ports.paneState(subject.id);

    // Assert
    should(pane?.alive).be.true();
    should(pane?.visible).containEql('Pontificating… (3s · ↓ 1.2k tokens');
  }, 30_000);

  it('should capture the screen again only once the pane has drawn since the last capture', async () => {
    // Arrange — the real controller, counted, under the real clock tmux stamps activity by.
    const subject = await fixture('claude', CLAUDE_IDLE);
    await subject.settle();
    const controller = (subject.ports as unknown as { panes: TmuxController }).panes;
    let captures = 0;
    const counted = new StorageTurnPorts(
      (subject.ports as unknown as { storage: never }).storage,
      { tail: async () => ({ kind: 'unresolved' }) },
      async () => undefined,
      {
        activity: async session => await controller.activity(session),
        visible: async session => {
          captures += 1;
          return await controller.visible(session);
        },
      },
      { now: () => new Date().toISOString() },
    );
    // Past the second the pane last drew in, so a capture now is certainly newer than its last output.
    await waitFor(async () => {
      const drawnAt = (await controller.activity(subject.tmuxSession))?.activityAt;
      return drawnAt !== undefined && Math.floor(Date.now() / 1_000) > drawnAt;
    }, 'the wall clock to pass the second the pane last drew in');

    // Act
    const first = await counted.paneState(subject.id);
    const unchanged = await counted.paneState(subject.id);
    await subject.frame(CLAUDE_WORKING);
    await subject.settle();
    const redrawn = await counted.paneState(subject.id);

    // Assert — one capture for the first look, none for a pane that drew nothing, one for the redraw.
    should(first?.visible).equal(unchanged?.visible);
    should(unchanged?.alive).be.true();
    should(redrawn?.visible).containEql('Pontificating… (3s · ↓ 1.2k tokens');
    should(captures).equal(2);
  }, 30_000);

  it('should read a failed capture as a blank live screen and never hold it', async () => {
    // Arrange
    const subject = await fixture('claude', CLAUDE_IDLE);
    let captures = 0;
    const failing = new StorageTurnPorts(
      (subject.ports as unknown as { storage: never }).storage,
      { tail: async () => ({ kind: 'unresolved' }) },
      async () => undefined,
      {
        activity: async () => ({ dead: false, activityAt: 1, historySize: 0, cursorX: 0, cursorY: 0 }),
        visible: async () => {
          captures += 1;
          return undefined;
        },
      },
      { now: () => new Date().toISOString() },
    );

    // Act
    const first = await failing.paneState(subject.id);
    const second = await failing.paneState(subject.id);

    // Assert
    should(first).match({ alive: true, visible: '' });
    should(second).match({ alive: true, visible: '' });
    should(captures).equal(2);
  }, 30_000);

  it('should forget a pane that died, and report none for it', async () => {
    // Arrange
    const subject = await fixture('claude', CLAUDE_IDLE);
    const dying = new StorageTurnPorts(
      (subject.ports as unknown as { storage: never }).storage,
      { tail: async () => ({ kind: 'unresolved' }) },
      async () => undefined,
      {
        activity: async () => ({ dead: true, exitCode: 1 }),
        visible: async () => Promise.reject(new Error('never asked')),
      },
      { now: () => NOW },
    );

    // Act + Assert
    should(await dying.paneState(subject.id)).be.undefined();
  }, 30_000);

  it('should read no pane and no transcript for a session without either', async () => {
    const subject = await fixture('claude', CLAUDE_IDLE);
    const bare = new StorageTurnPorts(
      // Same storage, a session with no tmux name and no transcript.
      (subject.ports as unknown as { storage: never }).storage,
      { tail: async () => ({ kind: 'unresolved' }) },
      async () => undefined,
      { activity: async () => Promise.reject(new Error('unreachable')), visible: async () => undefined },
      { now: () => NOW },
    );
    should(await bare.transcript(subject.id)).be.undefined();
    const missing = new StorageTurnPorts(
      (subject.ports as unknown as { storage: never }).storage,
      { tail: async () => ({ kind: 'unresolved' }) },
      async () => '/nonexistent/transcript.jsonl',
      { activity: async () => undefined, visible: async () => Promise.reject(new Error('never asked')) },
      { now: () => NOW },
    );
    should(await missing.transcript(subject.id)).be.undefined();
    should(await missing.pane(subject.id)).be.undefined();
    should(await missing.paneState(subject.id)).be.undefined();
    should(await bare.paneState(subject.id)).be.undefined();
  }, 30_000);
});
