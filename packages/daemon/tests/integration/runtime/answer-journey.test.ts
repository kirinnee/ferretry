import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionConfigSchema, SessionStateSchema, SessionViewSchema } from '@ferretry/protocol';
import should from 'should';
import { buildWorld, type DaemonWorld, start } from '../../../bin/fyd.ts';
import { createSessionPaths, parseSessionId } from '../../../src/lib/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * The whole answer, over the daemon the product actually ships.
 *
 * WHY THIS TIER AND NOT A UNIT. Every part of the answer path has unit coverage and the defect this
 * guards was in none of them: it was in how the composition root wired them together — a settled-view
 * map consulted before a lock that did not exist. A test that substitutes the coordinator cannot see
 * that, because the coordinator was not the thing that was wrong.
 *
 * SO NOTHING IS SUBSTITUTED. The daemon boots through `start()` on a throwaway state home and an
 * ephemeral loopback port, and the pane is a REAL tmux session on the daemon's own private socket,
 * running a script that renders a form and blocks on input. The real adapter spawns the real tmux,
 * the real controller captures the real screen, and the real driver proves the real advance.
 *
 * A STUB `tmux` ON `PATH` WAS TRIED FIRST AND CANNOT WORK, which is worth recording so it is not
 * tried again: the composition root resolves the binary with `Bun.which('tmux')`, and `Bun.which`
 * reads the `PATH` this daemon STARTED with — mutating `process.env.PATH` from inside the test
 * changes nothing, and the daemon silently resolves the machine's real tmux instead.
 *
 * THE KEYSTROKE LEDGER IS WRITTEN BY THE AGENT SIDE, not by a double, which is what makes "no second
 * key" a fact rather than an assumption: the form script appends one line every time its `read`
 * completes, so a replay that typed anything at all would show up as a second line in a file the
 * daemon cannot reach.
 *
 * WHAT IS PROVED, in one boot and one restart: a transcript-derived question materializing on a read;
 * an answer over HTTP driving the form and clearing the durable state; two identical retries joining
 * one operation; the same id with another payload refused; a lost response replaying; and a restart
 * replaying — with the submit count unchanged from the first answer onward.
 */

const SESSION_ID = 'answer-1';
const TOOL_USE_ID = 'tool-ship-1';
const QUESTION = 'Ship the change?';
const REQUEST_ID = `question:daemon-a:${SESSION_ID}:${TOOL_USE_ID}`;
const TMUX_SESSION = `fy-${SESSION_ID}`;

/**
 * The agent's side of the conversation: render the form, block, then visibly move on.
 *
 * The screen is CLEARED before the advance is printed. The driver decides a form has advanced by
 * re-reading the pane and finding neither the question nor its option labels, so a script that
 * merely appended a line underneath would leave the question visible and be judged, correctly, as
 * not having moved. The trailing loop keeps the pane alive and keeps counting, so an unwanted second
 * submit is recorded rather than ignored.
 */
const FORM_SCRIPT = `#!/usr/bin/env bash
log="$1"
printf '  ${QUESTION}\\n\\n❯ Yes\\n  No\\n'
if read -r _; then printf 'submit\\n' >> "$log"; fi
printf '\\033[2J\\033[H'
printf 'Understood. Working on it now.\\n'
while read -r _; do printf 'submit\\n' >> "$log"; done
sleep 300
`;

/** Accept Enter without advancing, then advance only when recovery sends its one bounded Escape. */
const FAILURE_SCRIPT = `#!/usr/bin/env bash
log="$1"
printf '  ${QUESTION}\\n\\n❯ Yes\\n  No\\n'
while IFS= read -r -s -n 1 key; do
  if [[ "$key" == $'\\e' ]]; then
    printf 'escape\\n' >> "$log"
    printf '\\033[2J\\033[H'
    printf '> '
    break
  fi
  if [[ -z "$key" ]]; then printf 'enter\\n' >> "$log"; fi
done
if IFS= read -r prose; then
  printf 'prose:%s\\n' "$prose" >> "$log"
  printf '\\033[2J\\033[H'
  printf 'Continuing from the prose fallback.\\n'
fi
sleep 300
`;

const TRANSCRIPT = `${JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: TOOL_USE_ID,
        name: 'AskUserQuestion',
        input: { questions: [{ question: QUESTION, options: [{ label: 'Yes' }, { label: 'No' }] }] },
      },
    ],
  },
})}\n`;

const RESOLVED_TRANSCRIPT = `${TRANSCRIPT}${JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: TOOL_USE_ID, content: 'Yes', is_error: false }],
  },
})}\n`;

/** The tmux this daemon will itself resolve, so the test and the daemon drive one binary. */
const TMUX = Bun.which('tmux');

const sockets = new Set<string>();

async function freeLoopbackPort(): Promise<number> {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => undefined } });
  const port = server.port;
  server.stop(true);
  return port;
}

async function tmuxCommand(socket: string, ...args: string[]): Promise<number> {
  if (TMUX === null) throw new Error('tmux is required for this journey and was not found');
  const child = Bun.spawn([TMUX, '-S', socket, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  return await child.exited;
}

/**
 * Asserts a status and hands back the body.
 *
 * The body travels into the assertion deliberately: a bare `expected 500 to be 200` says nothing
 * about which of a dozen orderings broke, and this route answers every refusal with a stated reason.
 */
async function statusOf(response: Response, expected: number): Promise<string> {
  const body = await response.text();
  should({ status: response.status, body }).match({ status: expected });
  return body;
}

/** How many times the agent's own composer accepted a submit. Written only by the pane. */
async function submits(log: string): Promise<string[]> {
  return (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(line => line !== '');
}

/** A live pane on the daemon's own private socket, rendering the exact question it will be asked. */
async function livePane(home: string, scratch: string): Promise<string> {
  const socket = join(home, 'tmux.sock');
  sockets.add(socket);
  const script = join(scratch, 'form.sh');
  const log = join(scratch, 'submits.log');
  await writeFile(script, FORM_SCRIPT, { mode: 0o700 });
  await chmod(script, 0o700);
  await writeFile(log, '');
  const created = await tmuxCommand(socket, 'new-session', '-d', '-s', TMUX_SESSION, `bash ${script} ${log}`);
  should(created).equal(0);
  // The pane must be RENDERING before the daemon is asked about it; a capture of a pane that has not
  // drawn yet is an empty screen, which the driver would correctly refuse as an unbound form.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const child = Bun.spawn([TMUX as string, '-S', socket, 'capture-pane', '-p', '-t', `=${TMUX_SESSION}`], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [text] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (text.includes(QUESTION) && text.includes('❯ Yes')) break;
    await Bun.sleep(25);
  }
  return log;
}

/** A real form that visibly refuses the answer but responds to recovery's single Escape. */
async function failingPane(home: string, scratch: string): Promise<string> {
  const socket = join(home, 'tmux.sock');
  sockets.add(socket);
  const script = join(scratch, 'failing-form.sh');
  const log = join(scratch, 'failure-input.log');
  await writeFile(script, FAILURE_SCRIPT, { mode: 0o700 });
  await chmod(script, 0o700);
  await writeFile(log, '');
  const created = await tmuxCommand(socket, 'new-session', '-d', '-s', TMUX_SESSION, `bash ${script} ${log}`);
  should(created).equal(0);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const child = Bun.spawn([TMUX as string, '-S', socket, 'capture-pane', '-p', '-t', `=${TMUX_SESSION}`], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [text] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (text.includes(QUESTION) && text.includes('❯ Yes')) break;
    await Bun.sleep(25);
  }
  return log;
}

/**
 * A real session in a real state home, written through the daemon's own storage.
 *
 * Answers with the session's own directory, derived from the layout rather than assembled from a
 * guess: the state home puts sessions under `state/`, and a test that hardcoded `<home>/sessions`
 * would assert against a path this daemon never writes.
 */
async function seed(home: string, port: number, transcript: string): Promise<string> {
  process.env.FY_HOME = home;
  const opened = await buildWorld().storage.open();
  const id = parseSessionId(SESSION_ID);
  const at = '2026-08-06T09:00:00.000Z';
  await opened.storage.writeConfig(
    id,
    SessionConfigSchema.parse({
      id: SESSION_ID,
      incarnation: `${SESSION_ID}-1`,
      runtimeGeneration: 1,
      name: 'Answer Journey',
      boardAccess: 'none',
      agent: 'claude-auto',
      harness: 'claude',
      modelHint: 'opus',
      mode: 'auto',
      remoteControl: false,
      harnessFlags: [],
      cwd: home,
      createdAt: at,
      updatedAt: at,
      turn: 1,
      intervalSeconds: 30,
      timeoutSeconds: 0,
      nudgeAfterSeconds: 0,
      killAfterSeconds: 0,
      directSendMaxChars: 4_096,
      resumeMenuChoice: 'full',
      maxSnapshots: 10,
      retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
    }),
  );
  // Merged onto the RAW document, because `SessionConfigSchema` carries neither block and parsing
  // strips both. `command` and `tmuxSession` are what the answer driver resolves the pane from —
  // `lifecycleConfigDocument` derives `agent` from `command[0]`, and a config without them makes the
  // route answer 500 before it reaches a terminal at all. `transcript` is merged exactly as the
  // daemon's own provenance store merges it; a transcript nothing can resolve is an unread one.
  await opened.storage.updateConfig(id, current => ({
    ...(current as Record<string, unknown>),
    command: ['/usr/bin/env', 'claude'],
    tmuxSession: TMUX_SESSION,
    transcript: {
      v: 1,
      home,
      identity: 'minted',
      harnessSessionId: `${SESSION_ID}-harness`,
      file: transcript,
      resolvedAt: at,
    },
  }));
  await opened.storage.writeState(
    id,
    SessionStateSchema.parse({ id: SESSION_ID, status: 'running', turn: 1, lastActivityAt: at }),
  );
  const directory = createSessionPaths(opened.storage.paths, id).directory;
  await opened.storage.close();
  await writeFile(join(home, 'config', 'daemon.json'), JSON.stringify({ host: '127.0.0.1', port }), { mode: 0o600 });
  return directory;
}

interface Daemon {
  readonly exit: Promise<number>;
  readonly release: () => void;
  readonly cleanups: Array<() => void | Promise<void>>;
  readonly headers: Record<string, string>;
}

/** Boots the production world against the seeded home and waits for it to answer. */
async function boot(home: string, port: number): Promise<Daemon> {
  process.env.FY_HOME = home;
  const shutdownSignal = Promise.withResolvers<void>();
  const world: DaemonWorld = {
    ...buildWorld(),
    untilShutdown: async () => await shutdownSignal.promise,
  };
  const cleanups: Array<() => void | Promise<void>> = [];
  const exit = start(world, cleanups);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined);
    if (health !== undefined) break;
    await Bun.sleep(25);
  }
  const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
  return {
    exit,
    release: () => shutdownSignal.resolve(),
    cleanups,
    headers: { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli', 'content-type': 'application/json' },
  };
}

async function shutdown(daemon: Daemon): Promise<void> {
  daemon.release();
  await daemon.exit;
  for (const cleanup of daemon.cleanups) await cleanup();
}

const answerRequest = (port: number, daemon: Daemon, requestId: string, labels: readonly string[]) =>
  fetch(`http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}/answer`, {
    method: 'POST',
    headers: { ...daemon.headers, 'x-fy-request-id': requestId },
    body: JSON.stringify({
      toolUseId: TOOL_USE_ID,
      labels: [...labels],
      answers: [{ kind: 'selection', labels: [...labels] }],
    }),
  });

const sendRequest = (port: number, daemon: Daemon, requestId: string, message: string) =>
  fetch(`http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}/send`, {
    method: 'POST',
    headers: { ...daemon.headers, 'x-fy-request-id': requestId },
    body: JSON.stringify({ message }),
  });

/** A busy answer/monitor key makes a read return its current view rather than wait; the next poll projects it. */
async function waitForPendingQuestion(port: number, daemon: Daemon) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}`, {
      headers: daemon.headers,
    });
    const view = SessionViewSchema.parse(JSON.parse(await statusOf(response, 200)));
    if (view.state.pendingQuestion?.toolUseId === TOOL_USE_ID) return view;
    await Bun.sleep(25);
  }
  throw new Error(`structured question ${TOOL_USE_ID} did not materialize`);
}

describe('the structured answer journey', () => {
  const previousHome = process.env.FY_HOME;

  afterEach(async () => {
    for (const socket of sockets) await tmuxCommand(socket, 'kill-server').catch(() => 0);
    sockets.clear();
    if (previousHome === undefined) delete process.env.FY_HOME;
    else process.env.FY_HOME = previousHome;
    await cleanupTempDirectories();
  });

  it('materializes a transcript question, drives it once, and never types again for the same request', async () => {
    // Arrange
    const home = await tempDirectory('fyd-answer-home');
    const scratch = await tempDirectory('fyd-answer-scratch');
    const transcript = join(scratch, 'session.jsonl');
    await writeFile(transcript, TRANSCRIPT);
    const port = await freeLoopbackPort();
    const sessionDirectory = await seed(home, port, transcript);
    const log = await livePane(home, scratch);
    const daemon = await boot(home, port);

    // Act + Assert — the read is what materializes the question from the transcript.
    const pending = await waitForPendingQuestion(port, daemon);
    should(pending.state.pendingQuestion).match({ toolUseId: TOOL_USE_ID });
    should(await submits(log)).deepEqual([]);

    // Act — two identical retries of one request id, overlapping on purpose.
    const [first, second] = await Promise.all([
      answerRequest(port, daemon, REQUEST_ID, ['Yes']),
      answerRequest(port, daemon, REQUEST_ID, ['Yes']),
    ]);

    // Assert — one drive, one settlement, and the durable state cleared under the exact tool id.
    const firstBody = await statusOf(first, 200);
    await statusOf(second, 200);
    should(await submits(log)).deepEqual(['submit']);
    const settled = SessionViewSchema.parse(JSON.parse(firstBody));
    should(settled.state.pendingQuestion ?? undefined).be.undefined();
    should(settled.state.lastAnsweredQuestionToolUseId).equal(TOOL_USE_ID);

    // Act + Assert — a lost response replays; the same id with another answer is refused outright.
    const replay = await answerRequest(port, daemon, REQUEST_ID, ['Yes']);
    const conflict = await answerRequest(port, daemon, REQUEST_ID, ['No']);
    await statusOf(replay, 200);
    const refusal = await statusOf(conflict, 409);
    should((JSON.parse(refusal) as { readonly code: string }).code).equal('answer_request_id_reused');
    should(await submits(log)).deepEqual(['submit']);

    // Act — the daemon goes away and comes back, and the client retries across the restart.
    await shutdown(daemon);
    const restarted = await boot(home, port);
    const afterRestart = await answerRequest(port, restarted, REQUEST_ID, ['Yes']);

    // Assert — the receipt outlived the daemon, so the restart replays instead of re-typing.
    const durable = SessionViewSchema.parse(JSON.parse(await statusOf(afterRestart, 200)));
    should(await submits(log)).deepEqual(['submit']);
    should(durable.state.lastAnsweredQuestionToolUseId).equal(TOOL_USE_ID);
    const receipts = await readFile(join(sessionDirectory, 'channel', 'answers.jsonl'), 'utf8');
    should(
      receipts
        .split('\n')
        .filter(Boolean)
        .map(line => (JSON.parse(line) as { readonly outcome: string }).outcome),
    ).deepEqual(['accepted', 'confirmed']);

    await shutdown(restarted);
  }, 120_000);

  it('releases an ambiguous drive to prose while retaining its advisory across send, reads, and restart', async () => {
    const home = await tempDirectory('fyd-answer-failure-home');
    const scratch = await tempDirectory('fyd-answer-failure-scratch');
    const transcript = join(scratch, 'session.jsonl');
    await writeFile(transcript, TRANSCRIPT);
    const port = await freeLoopbackPort();
    const sessionDirectory = await seed(home, port, transcript);
    const log = await failingPane(home, scratch);
    const daemon = await boot(home, port);

    should((await waitForPendingQuestion(port, daemon)).state.pendingQuestion).match({
      toolUseId: TOOL_USE_ID,
    });

    const failed = await answerRequest(port, daemon, `${REQUEST_ID}:failure`, ['Yes']);
    const failureBody = JSON.parse(await statusOf(failed, 409)) as { readonly code: string; readonly error: string };

    should(failureBody.code).equal('answer_released');
    should(failureBody.error).match(/structured form was released/u);
    should(await submits(log)).deepEqual(['enter', 'escape']);
    should(await readFile(join(sessionDirectory, 'last-snapshot.txt'), 'utf8')).match(new RegExp(QUESTION, 'u'));
    const stateResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}`, {
      headers: daemon.headers,
    });
    const released = SessionViewSchema.parse(JSON.parse(await statusOf(stateResponse, 200)));
    should(released.state).match({
      status: 'awaiting_user',
      promptReady: true,
      needsHumanKind: 'structured-answer-released-unconfirmed',
      needsHuman: new RegExp(TOOL_USE_ID, 'u'),
    });
    should(released.state.pendingQuestion ?? undefined).be.undefined();

    const receipts = (await readFile(join(sessionDirectory, 'channel', 'answers.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { readonly outcome: string; readonly resolution?: string });
    should(receipts).match([{ outcome: 'accepted' }, { outcome: 'accepted', resolution: 'quarantined' }]);

    // A positively released native form permits ordinary prose. The real send route types it into
    // the real pane, but that progress is deliberately NOT evidence that the original structured
    // selection landed and therefore must not clear its advisory.
    const prose = await sendRequest(port, daemon, `${REQUEST_ID}:prose`, 'continue in prose');
    await statusOf(prose, 200);
    for (let attempt = 0; attempt < 100 && !(await submits(log)).includes('prose:continue in prose'); attempt += 1)
      await Bun.sleep(25);
    should(await submits(log)).deepEqual(['enter', 'escape', 'prose:continue in prose']);
    for (let read = 0; read < 2; read += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}`, {
        headers: daemon.headers,
      });
      const view = SessionViewSchema.parse(JSON.parse(await statusOf(response, 200)));
      should(view.state).match({
        needsHumanKind: 'structured-answer-released-unconfirmed',
        needsHuman: new RegExp(TOOL_USE_ID, 'u'),
      });
      should(view.state.lastAnsweredQuestionToolUseId ?? undefined).be.undefined();
    }

    await shutdown(daemon);
    const restarted = await boot(home, port);
    const replay = await answerRequest(port, restarted, `${REQUEST_ID}:failure`, ['Yes']);
    should((JSON.parse(await statusOf(replay, 409)) as { readonly code: string }).code).equal('answer_released');
    const freshId = await answerRequest(port, restarted, `${REQUEST_ID}:fresh`, ['Yes']);

    should((JSON.parse(await statusOf(freshId, 409)) as { readonly code: string }).code).equal('answer_refused');
    should(await submits(log)).deepEqual(['enter', 'escape', 'prose:continue in prose']);
    // Repeated production projections must not make an ambiguous answer's attention transient.
    for (let read = 0; read < 2; read += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}`, {
        headers: restarted.headers,
      });
      const view = SessionViewSchema.parse(JSON.parse(await statusOf(response, 200)));
      should(view.state).match({
        needsHumanKind: 'structured-answer-released-unconfirmed',
        needsHuman: new RegExp(TOOL_USE_ID, 'u'),
      });
      should(view.state.lastAnsweredQuestionToolUseId ?? undefined).be.undefined();
    }

    await shutdown(restarted);
  }, 120_000);

  it('retains the exact question and refuses prose when a dead pane cannot prove release', async () => {
    const home = await tempDirectory('fyd-answer-dead-home');
    const scratch = await tempDirectory('fyd-answer-dead-scratch');
    const transcript = join(scratch, 'session.jsonl');
    await writeFile(transcript, TRANSCRIPT);
    const port = await freeLoopbackPort();
    await seed(home, port, transcript);
    const daemon = await boot(home, port);

    should((await waitForPendingQuestion(port, daemon)).state.pendingQuestion).match({
      toolUseId: TOOL_USE_ID,
    });

    const failed = await answerRequest(port, daemon, `${REQUEST_ID}:dead`, ['Yes']);
    const failureBody = JSON.parse(await statusOf(failed, 409)) as { readonly code: string; readonly error: string };

    should(failureBody.code).equal('answer_unconfirmed');
    should(failureBody.error).match(/Automatic native cancellation was not confirmed/u);
    should(failureBody.error).match(/structured form remains bound/u);
    should(failureBody.error).match(new RegExp(QUESTION.replace('?', '\\?'), 'u'));
    const stateResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}`, {
      headers: daemon.headers,
    });
    const retained = SessionViewSchema.parse(JSON.parse(await statusOf(stateResponse, 200)));
    should(retained.state).match({
      status: 'awaiting_question',
      pendingQuestion: { toolUseId: TOOL_USE_ID },
      needsHumanKind: 'structured-answer-unconfirmed',
      needsHuman: new RegExp(TOOL_USE_ID, 'u'),
    });
    const refusedProse = await sendRequest(port, daemon, `${REQUEST_ID}:dead-prose`, 'do not type this');
    should((JSON.parse(await statusOf(refusedProse, 409)) as { readonly code: string }).code).equal('send_refused');

    await shutdown(daemon);
    const restarted = await boot(home, port);
    const replay = await answerRequest(port, restarted, `${REQUEST_ID}:dead`, ['Yes']);
    should((JSON.parse(await statusOf(replay, 409)) as { readonly code: string }).code).equal('answer_unconfirmed');
    const afterRestart = await fetch(`http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}`, {
      headers: restarted.headers,
    });
    should(SessionViewSchema.parse(JSON.parse(await statusOf(afterRestart, 200))).state).match({
      pendingQuestion: { toolUseId: TOOL_USE_ID },
      needsHumanKind: 'structured-answer-unconfirmed',
    });
    const refusedAgain = await sendRequest(port, restarted, `${REQUEST_ID}:dead-prose-retry`, 'still do not type');
    should((JSON.parse(await statusOf(refusedAgain, 409)) as { readonly code: string }).code).equal('send_refused');

    await shutdown(restarted);
  }, 120_000);

  it('quarantines a monitor-observed advance and keeps its human attention durable', async () => {
    const home = await tempDirectory('fyd-answer-monitor-quarantine-home');
    const scratch = await tempDirectory('fyd-answer-monitor-quarantine-scratch');
    const transcript = join(scratch, 'session.jsonl');
    await writeFile(transcript, RESOLVED_TRANSCRIPT);
    const port = await freeLoopbackPort();
    const sessionDirectory = await seed(home, port, transcript);
    const ledger = join(sessionDirectory, 'channel', 'answers.jsonl');
    await mkdir(join(sessionDirectory, 'channel'), { recursive: true });
    await writeFile(
      ledger,
      `${JSON.stringify({
        requestId: `${REQUEST_ID}:monitor`,
        toolUseId: TOOL_USE_ID,
        fingerprint: 'monitor-crash-boundary',
        acceptedAt: '2026-08-06T09:00:01.000Z',
        outcome: 'accepted',
      })}\n`,
    );
    const daemon = await boot(home, port);

    // The production projector, not a coordinator retry, observes that the exact form advanced.
    // Boot's first monitor reconciliation may still hold the answer key when health begins serving,
    // so poll for the first derived advisory and then prove two further reads keep it durable.
    let projected: ReturnType<typeof SessionViewSchema.parse> | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}`, {
        headers: daemon.headers,
      });
      const view = SessionViewSchema.parse(JSON.parse(await statusOf(response, 200)));
      if (view.state.needsHumanKind === 'structured-answer-released-unconfirmed') {
        projected = view;
        break;
      }
      await Bun.sleep(25);
    }
    should(projected?.state).match({
      status: 'awaiting_user',
      needsHumanKind: 'structured-answer-released-unconfirmed',
      needsHuman: new RegExp(TOOL_USE_ID, 'u'),
    });
    should(projected?.state.pendingQuestion ?? undefined).be.undefined();
    for (let read = 0; read < 2; read += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}`, {
        headers: daemon.headers,
      });
      const view = SessionViewSchema.parse(JSON.parse(await statusOf(response, 200)));
      should(view.state).match({
        status: 'awaiting_user',
        needsHumanKind: 'structured-answer-released-unconfirmed',
        needsHuman: new RegExp(TOOL_USE_ID, 'u'),
      });
      should(view.state.pendingQuestion ?? undefined).be.undefined();
    }
    const receipts = (await readFile(ledger, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { readonly outcome: string; readonly resolution?: string });
    should(receipts).match([{ outcome: 'accepted' }, { outcome: 'accepted', resolution: 'quarantined' }]);

    await shutdown(daemon);
  }, 120_000);

  it('contains a damaged answer ledger while serving the ordinary session roster', async () => {
    const home = await tempDirectory('fyd-answer-damaged-ledger-home');
    const scratch = await tempDirectory('fyd-answer-damaged-ledger-scratch');
    const transcript = join(scratch, 'session.jsonl');
    await writeFile(transcript, TRANSCRIPT);
    const port = await freeLoopbackPort();
    const sessionDirectory = await seed(home, port, transcript);
    await mkdir(join(sessionDirectory, 'channel', 'answers.jsonl'), { recursive: true });
    const daemon = await boot(home, port);

    const roster = await fetch(`http://127.0.0.1:${port}/v1/sessions`, { headers: daemon.headers });
    const rosterBody = await statusOf(roster, 200);

    should(rosterBody).match(new RegExp(SESSION_ID, 'u'));
    await shutdown(daemon);
  }, 120_000);
});
