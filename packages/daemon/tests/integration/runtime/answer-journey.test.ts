import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionConfigSchema, SessionStateSchema, SessionViewSchema } from '@ferretry/protocol';
import should from 'should';
import { buildWorld, type DaemonWorld, start } from '../../../bin/fyd.ts';
import { createSessionPaths, firstWriteReleasedAnswerAttention, parseSessionId } from '../../../src/lib/index.ts';
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

/** Holds the visible advance behind a file gate, so a concurrent stop can be ordered exactly. */
const GATED_FORM_SCRIPT = `#!/usr/bin/env bash
log="$1"
gate="$2"
printf '  ${QUESTION}\\n\\n❯ Yes\\n  No\\n'
if read -r _; then printf 'submit\\n' >> "$log"; fi
while [[ ! -e "$gate" ]]; do sleep 0.01; done
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

const transcriptFor = (toolUseId: string): string =>
  `${JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'AskUserQuestion',
          input: { questions: [{ question: QUESTION, options: [{ label: 'Yes' }, { label: 'No' }] }] },
        },
      ],
    },
  })}\n`;

const TRANSCRIPT = transcriptFor(TOOL_USE_ID);

const RESOLVED_TRANSCRIPT = `${TRANSCRIPT}${JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: TOOL_USE_ID, content: 'Yes', is_error: false }],
  },
})}\n`;

/**
 * What a RELAUNCH runs in the resume journey: an inert agent that behaves enough like one.
 *
 * `sleep 300` is not enough and the difference is the whole test. The real `TmuxPaneDelivery` waits
 * for a PROMPT before it types, so a pane that renders nothing never accepts the turn, the relaunch
 * reports a delivery failure, the independent probe finds the sleeping pane alive, and the resume
 * ends as `preserved` — which by design never acknowledges. The journey would then pass its status
 * assertions while proving the opposite of what it claims.
 *
 * So this renders `> ` (the prompt shape `promptIsReady` recognises, cursor within the first two
 * columns), records each delivered line into a log the daemon cannot write, and re-renders the
 * prompt so a second relaunch is deliverable too.
 */
const RELAUNCH_SCRIPT = `#!/usr/bin/env bash
log="$1"
printf '> '
while IFS= read -r line; do
  printf 'turn:%s\\n' "$line" >> "$log"
  printf '\\n> '
done
sleep 300
`;

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

/** A real form that records submit immediately and advances only after the test releases its gate. */
async function gatedPane(home: string, scratch: string): Promise<{ readonly gate: string; readonly log: string }> {
  const socket = join(home, 'tmux.sock');
  sockets.add(socket);
  const script = join(scratch, 'gated-form.sh');
  const log = join(scratch, 'gated-input.log');
  const gate = join(scratch, 'allow-advance');
  await writeFile(script, GATED_FORM_SCRIPT, { mode: 0o700 });
  await chmod(script, 0o700);
  await writeFile(log, '');
  const created = await tmuxCommand(socket, 'new-session', '-d', '-s', TMUX_SESSION, `bash ${script} ${log} ${gate}`);
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
  return { gate, log };
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
async function seed(
  home: string,
  port: number,
  transcript: string | undefined,
  /**
   * What a RELAUNCH will actually run. The journeys that never resume keep the shipped
   * `/usr/bin/env claude`, which is only ever inspected; the resume journey would genuinely execute
   * it, and starting a real agent on a developer's machine from a test is not something to leave to
   * whether `claude` happens to be installed. `command[0]` is unchanged, so the launch
   * authorization pinning that reads position 0 sees exactly what it sees in production, and the
   * replacement it starts is `RELAUNCH_SCRIPT` — a pane that really renders a prompt and really
   * accepts the delivered turn.
   */
  command: readonly string[] = ['/usr/bin/env', 'claude'],
): Promise<string> {
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
  // route answer 500 before it reaches a terminal at all. When present, `transcript` is merged
  // exactly as the daemon's own provenance store merges it; absence is the honest unresolved shape.
  await opened.storage.updateConfig(id, current => ({
    ...(current as Record<string, unknown>),
    command: [...command],
    tmuxSession: TMUX_SESSION,
    ...(transcript === undefined
      ? {}
      : {
          transcript: {
            v: 1,
            home,
            identity: 'minted',
            harnessSessionId: `${SESSION_ID}-harness`,
            file: transcript,
            resolvedAt: at,
          },
        }),
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

/** Mutates a seeded state through production storage while no daemon owns that state home. */
async function patchStateOffline(home: string, patch: Readonly<Record<string, unknown>>): Promise<void> {
  process.env.FY_HOME = home;
  const opened = await buildWorld().storage.open();
  try {
    await opened.storage.updateState(
      parseSessionId(SESSION_ID),
      current =>
        ({
          ...(current as Record<string, unknown>),
          ...patch,
        }) as typeof current,
    );
  } finally {
    await opened.storage.close();
  }
}

async function rawState(sessionDirectory: string) {
  return SessionStateSchema.parse(JSON.parse(await readFile(join(sessionDirectory, 'state.json'), 'utf8')));
}

/** Polls storage itself: no session GET is allowed to be the thing that materializes this question. */
async function waitForRawPendingQuestion(sessionDirectory: string, toolUseId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await rawState(sessionDirectory);
    if (state.pendingQuestion?.toolUseId === toolUseId) return state;
    await Bun.sleep(25);
  }
  throw new Error(`monitor did not materialize structured question ${toolUseId} in raw state`);
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

const otherAnswerRequest = (port: number, daemon: Daemon, requestId: string, toolUseId: string, text: string) =>
  fetch(`http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}/answer`, {
    method: 'POST',
    headers: { ...daemon.headers, 'x-fy-request-id': requestId },
    body: JSON.stringify({
      toolUseId,
      labels: [],
      other: text,
      answers: [{ kind: 'other', text }],
    }),
  });

const stopRequest = (port: number, daemon: Daemon, reason: string) =>
  fetch(`http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}/stop`, {
    method: 'POST',
    headers: daemon.headers,
    body: JSON.stringify({ reason }),
  });

/**
 * A real resume over the real route.
 *
 * `actor` is NEVER in the body — the mount says so and means it: a caller that named its own actor
 * would be choosing its own privileges. It is derived at the authorization boundary from the token
 * class plus these two headers, so a peer is produced here exactly the way a relaying daemon
 * produces one: the same admin bearer, carrying the CALLING pane's session id.
 */
const resumeRequest = (
  port: number,
  daemon: Daemon,
  actor: 'admin-cli' | 'peer',
  body: Readonly<Record<string, unknown>> = {},
) =>
  fetch(`http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}/resume`, {
    method: 'POST',
    headers: {
      ...daemon.headers,
      ...(actor === 'peer' ? { 'x-ferretry-session-id': 'some-other-session' } : {}),
    },
    body: JSON.stringify(body),
  });

const sendRequest = (port: number, daemon: Daemon, requestId: string, message: string) =>
  fetch(`http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}/send`, {
    method: 'POST',
    headers: { ...daemon.headers, 'x-fy-request-id': requestId },
    body: JSON.stringify({ message }),
  });

/** A busy answer/monitor key makes a read return its current view rather than wait; the next poll projects it. */
async function waitForPendingQuestion(port: number, daemon: Daemon, toolUseId = TOOL_USE_ID) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}`, {
      headers: daemon.headers,
    });
    const view = SessionViewSchema.parse(JSON.parse(await statusOf(response, 200)));
    if (view.state.pendingQuestion?.toolUseId === toolUseId) return view;
    await Bun.sleep(25);
  }
  throw new Error(`structured question ${toolUseId} did not materialize`);
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

  it('never clears a tool-10 attention when tool-1 fails preflight and Escape releases its form', async () => {
    const olderToolUseId = 'tool-10';
    const currentToolUseId = 'tool-1';
    const cases = [
      {
        label: 'blocking',
        kind: 'structured-answer-unconfirmed' as const,
        message: `answer request standing-request for ${olderToolUseId} may have reached the form, and release was not confirmed; inspect the session before continuing`,
      },
      {
        label: 'released',
        kind: 'structured-answer-released-unconfirmed' as const,
        message: firstWriteReleasedAnswerAttention(olderToolUseId),
      },
    ];

    for (const attention of cases) {
      const home = await tempDirectory(`fyd-answer-colliding-${attention.label}-home`);
      const scratch = await tempDirectory(`fyd-answer-colliding-${attention.label}-scratch`);
      const transcript = join(scratch, 'session.jsonl');
      await writeFile(transcript, transcriptFor(currentToolUseId));
      const port = await freeLoopbackPort();
      const sessionDirectory = await seed(home, port, transcript);
      await patchStateOffline(home, {
        needsHumanKind: attention.kind,
        needsHuman: attention.message,
      });
      const log = await failingPane(home, scratch);
      const daemon = await boot(home, port);

      const pending = await waitForPendingQuestion(port, daemon, currentToolUseId);
      should(pending.state).match({
        pendingQuestion: { toolUseId: currentToolUseId },
        needsHumanKind: attention.kind,
        needsHuman: attention.message,
      });

      // `Other` is valid protocol input, but this real pane renders only Yes/No. The production
      // driver therefore fails with `choice-missing` before any answer key, positively binds the
      // same form for one Escape, and settles this operation as a proved failure.
      const requestId = `${REQUEST_ID}:colliding-${attention.label}`;
      const failed = await otherAnswerRequest(port, daemon, requestId, currentToolUseId, 'Explain in prose');
      const failureBody = JSON.parse(await statusOf(failed, 409)) as { readonly code: string; readonly error: string };
      should(failureBody.code).equal('answer_released');
      should(failureBody.error).match(/structured form was released/u);
      should(await submits(log)).deepEqual(['escape']);

      const response = await fetch(`http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}`, {
        headers: daemon.headers,
      });
      const released = SessionViewSchema.parse(JSON.parse(await statusOf(response, 200)));
      should(released.state).match({
        needsHumanKind: attention.kind,
        needsHuman: attention.message,
      });
      should(released.state.pendingQuestion ?? undefined).be.undefined();
      const outcomes = (await readFile(join(sessionDirectory, 'channel', 'answers.jsonl'), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(
          line =>
            JSON.parse(line) as { readonly requestId: string; readonly outcome: string; readonly resolution?: string },
        )
        .filter(row => row.requestId === requestId)
        .map(row => row.resolution ?? row.outcome);
      should(outcomes).deepEqual(['accepted', 'failed']);

      await shutdown(daemon);
    }
  }, 120_000);

  it('materializes a transcript question on kill-failed state without a GET, then refuses every answer key', async () => {
    const home = await tempDirectory('fyd-answer-kill-failed-home');
    const scratch = await tempDirectory('fyd-answer-kill-failed-scratch');
    const transcript = join(scratch, 'session.jsonl');
    await writeFile(transcript, TRANSCRIPT);
    const port = await freeLoopbackPort();
    const sessionDirectory = await seed(home, port, transcript);
    await patchStateOffline(home, {
      status: 'kill_failed',
      reason: 'the pane remained live after its stop failed',
    });
    const log = await livePane(home, scratch);
    const daemon = await boot(home, port);

    // No session route has been read. The daemon's immediate monitor tick alone must discover the
    // question in raw storage, while preserving the unsafe live-pane verdict that hides/refuses it.
    const materialized = await waitForRawPendingQuestion(sessionDirectory, TOOL_USE_ID);
    should(materialized).match({
      status: 'kill_failed',
      pendingQuestion: { toolUseId: TOOL_USE_ID },
      reason: 'the pane remained live after its stop failed',
    });
    should(await submits(log)).deepEqual([]);

    const refused = await answerRequest(port, daemon, `${REQUEST_ID}:kill-failed`, ['Yes']);
    const refusal = JSON.parse(await statusOf(refused, 409)) as { readonly code: string; readonly error: string };
    should(refusal.code).equal('answer_refused');
    should(refusal.error).match(/stop it successfully before answering/u);
    should(await submits(log)).deepEqual([]);
    should(await rawState(sessionDirectory)).match({
      status: 'kill_failed',
      pendingQuestion: { toolUseId: TOOL_USE_ID },
      reason: 'the pane remained live after its stop failed',
    });

    await shutdown(daemon);
  }, 120_000);

  it('refuses a materialized question on failed state before sending any answer or recovery key', async () => {
    const home = await tempDirectory('fyd-answer-failed-home');
    const scratch = await tempDirectory('fyd-answer-failed-scratch');
    const transcript = join(scratch, 'session.jsonl');
    await writeFile(transcript, TRANSCRIPT);
    const port = await freeLoopbackPort();
    const sessionDirectory = await seed(home, port, transcript);
    await patchStateOffline(home, {
      status: 'failed',
      reason: 'the session already reached a terminal failure',
    });
    const log = await livePane(home, scratch);
    const daemon = await boot(home, port);

    const materialized = await waitForRawPendingQuestion(sessionDirectory, TOOL_USE_ID);
    should(materialized).match({
      status: 'failed',
      pendingQuestion: { toolUseId: TOOL_USE_ID },
      reason: 'the session already reached a terminal failure',
    });
    should(await submits(log)).deepEqual([]);

    const refused = await answerRequest(port, daemon, `${REQUEST_ID}:failed`, ['Yes']);
    const refusal = JSON.parse(await statusOf(refused, 409)) as { readonly code: string; readonly error: string };
    should(refusal.code).equal('answer_refused');
    should(refusal.error).match(/failed.*terminal|terminal.*failed/iu);
    should(await submits(log)).deepEqual([]);
    should(await rawState(sessionDirectory)).match({
      status: 'failed',
      pendingQuestion: { toolUseId: TOOL_USE_ID },
      reason: 'the session already reached a terminal failure',
    });

    await shutdown(daemon);
  }, 120_000);

  it('serializes a stop after live answer keys and lets its kill-failed verdict win durably', async () => {
    const home = await tempDirectory('fyd-answer-stop-race-home');
    const scratch = await tempDirectory('fyd-answer-stop-race-scratch');
    const port = await freeLoopbackPort();
    // Deliberately no transcript provenance: the exact pending form is seeded below, so no monitor
    // projection changes its lifecycle `running` status before the real stop service reads it.
    const sessionDirectory = await seed(home, port, undefined);
    await patchStateOffline(home, {
      status: 'running',
      pendingQuestion: {
        toolUseId: TOOL_USE_ID,
        questions: [{ question: QUESTION, options: [{ label: 'Yes' }, { label: 'No' }] }],
      },
    });
    // The stop snapshots before it kills. A directory at the exact snapshot path makes that real
    // adapter fail while the real tmux pane stays live, deterministically producing `kill_failed`.
    await mkdir(join(sessionDirectory, 'last-snapshot.txt'));
    const pane = await gatedPane(home, scratch);
    const daemon = await boot(home, port);

    let earlyAnswer: Response | undefined;
    const answering = answerRequest(port, daemon, `${REQUEST_ID}:stop-race`, ['Yes']).then(response => {
      earlyAnswer = response;
      return response;
    });
    for (let attempt = 0; attempt < 200 && !(await submits(pane.log)).includes('submit'); attempt += 1)
      await Bun.sleep(25);
    if (!(await submits(pane.log)).includes('submit') && earlyAnswer !== undefined)
      throw new Error(
        `the gated answer settled before sending its key (${earlyAnswer.status}): ${await earlyAnswer.clone().text()}`,
      );
    should(await submits(pane.log)).deepEqual(['submit']);

    // The answer owns the shared lifecycle/answer key until its visible-advance commit. A stop
    // requested now must remain queued rather than publish a verdict that a later answer write can
    // overwrite.
    let stopSettled = false;
    const stopping = stopRequest(port, daemon, 'the race stop must remain authoritative').then(response => {
      stopSettled = true;
      return response;
    });
    await Bun.sleep(100);
    should(stopSettled).be.false();
    should(await rawState(sessionDirectory)).match({ status: 'running', pendingQuestion: { toolUseId: TOOL_USE_ID } });

    await writeFile(pane.gate, 'advance');
    await statusOf(await answering, 200);
    const stopFailure = JSON.parse(await statusOf(await stopping, 500)) as {
      readonly code: string;
      readonly error: string;
    };
    should(stopFailure.code).equal('session_launch_failed');
    should(stopFailure.error).match(/last-snapshot\.txt|directory/iu);

    const final = await rawState(sessionDirectory);
    should(final).match({
      status: 'kill_failed',
      lastAnsweredQuestionToolUseId: TOOL_USE_ID,
      reason: /the race stop must remain authoritative/u,
    });
    should(final.pendingQuestion ?? undefined).be.undefined();
    should(await submits(pane.log)).deepEqual(['submit']);

    await shutdown(daemon);
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

  it('dismisses a released advisory only for a bare operator relaunch, exactly once', async () => {
    // WHY THIS IS A JOURNEY AND NOT A UNIT. The acknowledgement is a decision in the resume domain
    // and an append in the composition root, joined by a port — and every unit on both sides can
    // pass while the wiring is wrong, which is exactly what the wrapper this replaces did. Nothing
    // is substituted here: a real failing form produces a REAL released advisory through the real
    // recovery path, and the dismissal is a real HTTP resume that really relaunches a real pane.
    const home = await tempDirectory('fyd-answer-dismiss-home');
    const scratch = await tempDirectory('fyd-answer-dismiss-scratch');
    const transcript = join(scratch, 'session.jsonl');
    await writeFile(transcript, TRANSCRIPT);
    const port = await freeLoopbackPort();
    // A relaunch under this journey runs a real prompt-rendering fixture; see `RELAUNCH_SCRIPT`.
    const relaunchScript = join(scratch, 'relaunched-agent.sh');
    const relaunchLog = join(scratch, 'relaunch-turns.log');
    await writeFile(relaunchScript, RELAUNCH_SCRIPT, { mode: 0o700 });
    await chmod(relaunchScript, 0o700);
    await writeFile(relaunchLog, '');
    const sessionDirectory = await seed(home, port, transcript, ['/usr/bin/env', 'bash', relaunchScript, relaunchLog]);
    const ledgerPath = join(sessionDirectory, 'channel', 'answers.jsonl');
    // The DURABLE row keeps `outcome: accepted` and names the settlement in `resolution`, so reading
    // `outcome` alone would never see an acknowledgement and the whole assertion would be vacuous.
    // This normalises the way the ledger adapter does when it reads records back.
    const outcomes = async (): Promise<string[]> =>
      (await readFile(ledgerPath, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as { readonly outcome: string; readonly resolution?: string })
        .map(row => row.resolution ?? row.outcome);
    const advisoryOf = async (client: Daemon): Promise<Record<string, unknown>> => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}`, { headers: client.headers });
      return SessionViewSchema.parse(JSON.parse(await statusOf(response, 200))).state as Record<string, unknown>;
    };
    /** Every acknowledgement audit line, parsed — never a regex over the whole journal, where
     *  `admin-cli` and the tool id both appear on rows this test is not making a claim about. */
    const auditRows = async (): Promise<Array<Record<string, unknown>>> =>
      (await readFile(join(sessionDirectory, 'events.jsonl'), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as { readonly type: string; readonly data: Record<string, unknown> })
        .filter(entry => entry.type === 'interaction.answer_acknowledged')
        .map(entry => entry.data);
    const log = await failingPane(home, scratch);
    const daemon = await boot(home, port);

    // Arrange — the real ambiguous drive: keys may have landed, the form was released to prose.
    should((await waitForPendingQuestion(port, daemon)).state.pendingQuestion).match({ toolUseId: TOOL_USE_ID });
    const failed = await answerRequest(port, daemon, `${REQUEST_ID}:failure`, ['Yes']);
    should((JSON.parse(await statusOf(failed, 409)) as { readonly code: string }).code).equal('answer_released');
    should(await advisoryOf(daemon)).match({ needsHumanKind: 'structured-answer-released-unconfirmed' });
    should(await outcomes()).deepEqual(['accepted', 'quarantined']);

    // Act + Assert — PROSE. A message typed into the live pane is progress, never a dismissal.
    await statusOf(await sendRequest(port, daemon, `${REQUEST_ID}:prose`, 'continue in prose'), 200);
    should(await advisoryOf(daemon)).match({ needsHumanKind: 'structured-answer-released-unconfirmed' });
    should(await outcomes()).deepEqual(['accepted', 'quarantined']);

    // Act + Assert — A PEER, on a session whose pane is gone so it takes the relaunch path rather
    // than being refused as already running. It revives the session and dismisses nothing: a
    // relaying daemon is not the person who read the warning.
    await tmuxCommand(join(home, 'tmux.sock'), 'kill-session', '-t', TMUX_SESSION);
    const peer = await resumeRequest(port, daemon, 'peer');
    should(SessionViewSchema.parse(JSON.parse(await statusOf(peer, 200))).state.status).equal('running');
    should(await advisoryOf(daemon)).match({ needsHumanKind: 'structured-answer-released-unconfirmed' });
    should(await outcomes()).deepEqual(['accepted', 'quarantined']);

    // Act + Assert — A MESSAGE-BEARING OPERATOR resume. Still prose, still no dismissal.
    const withProse = await resumeRequest(port, daemon, 'admin-cli', { message: 'pick this back up' });
    await statusOf(withProse, 200);
    should(await advisoryOf(daemon)).match({ needsHumanKind: 'structured-answer-released-unconfirmed' });
    should(await outcomes()).deepEqual(['accepted', 'quarantined']);

    // Act — THE DISMISSAL: an operator, no message at all.
    const dismissed = await resumeRequest(port, daemon, 'admin-cli');
    await statusOf(dismissed, 200);

    // Assert — one acknowledgement on the owned record, the advisory gone, and the audit line
    // naming the operator the service authorized.
    should(await outcomes()).deepEqual(['accepted', 'quarantined', 'acknowledged']);
    // The agent's own keystroke ledger, which the daemon cannot write: dismissing a warning is not
    // answering a question, and nothing was typed at the form on the way through.
    should(await submits(log)).deepEqual(['enter', 'escape', 'prose:continue in prose']);
    const cleared = await advisoryOf(daemon);
    should(cleared.needsHumanKind ?? undefined).be.undefined();
    should(cleared.needsHuman ?? undefined).be.undefined();
    // It dismisses the warning; it never claims the structured answer landed.
    should(cleared.lastAnsweredQuestionToolUseId ?? undefined).be.undefined();
    should(await auditRows()).deepEqual([
      {
        actor: 'admin-cli',
        requestId: `${REQUEST_ID}:failure`,
        toolUseId: TOOL_USE_ID,
        resolution: 'explicit-human-relaunch',
      },
    ]);
    // The turn really landed in the replacement pane, so this was a relaunch and not a preserved
    // harness — the path that would have skipped the dismissal entirely. Three deliveries by now,
    // and they name themselves: the peer's default turn, the operator's own prose, and the
    // dismissal's default turn. An auto-mode session invents a turn document for every message-free
    // relaunch, which is exactly why the dismissal is authorized on the REQUEST carrying no message
    // rather than on the relaunch being bare.
    const delivered = await submits(relaunchLog);
    should(delivered).have.length(3);
    should(delivered[0]).match(/^turn:Read the file .*turns\/turn-\d+\.md now,/u);
    should(delivered[1]).equal('turn:pick this back up');
    should(delivered[2]).match(/^turn:Read the file .*turns\/turn-\d+\.md now,/u);

    // Act — THE CRASH GAP, which is the retry that matters, and it is modelled the way it happens:
    // the daemon DIES. The append is durable before the clear, so a process that stopped between
    // them leaves an `acknowledged` row beside a standing advisory. The repair is done offline
    // because the state home is exclusive — a second `storage.open()` against a live daemon is
    // supposed to be refused, so doing it that way would prove nothing about a real restart.
    await shutdown(daemon);
    process.env.FY_HOME = home;
    const offline = await buildWorld().storage.open();
    await offline.storage.updateState(parseSessionId(SESSION_ID), current => ({
      ...(current as Record<string, unknown>),
      needsHumanKind: 'structured-answer-released-unconfirmed',
      needsHuman: firstWriteReleasedAnswerAttention(TOOL_USE_ID),
    }));
    await offline.storage.close();
    const recovered = await boot(home, port);

    // Act — THE RETRY, immediately, with no read in front of it and nothing arranged in its favour.
    // The transcript is exactly where it always was and the recovery daemon projects the whole of it
    // at startup; what projection does NOT do any more is retire a released advisory on the strength
    // of an acknowledged row. That row suppresses RE-MINTING, while dismissing a standing warning
    // belongs to the explicit resume path — one owner for the clear. This `200` is the proof: had
    // startup projection cleared the warning, this would be an ordinary live session and the bare
    // resume would come back `409 already running`. (An earlier draft moved the transcript aside so
    // the projector would fail closed; that hid the interaction instead of proving it, and it is
    // deliberately not here.)
    await statusOf(await resumeRequest(port, recovered, 'admin-cli'), 200);

    // Assert — the service finishes what the crash interrupted: it appends NOTHING (the owner is
    // already acknowledged), writes no second audit line, and clears the advisory. The retry is a
    // real relaunch, so it does deliver a fourth turn; what it must not do is dismiss twice.
    should(await outcomes()).deepEqual(['accepted', 'quarantined', 'acknowledged']);
    should(await auditRows()).have.length(1);
    should(await submits(relaunchLog)).have.length(4);
    for (let read = 0; read < 2; read += 1)
      should((await advisoryOf(recovered)).needsHumanKind ?? undefined).be.undefined();
    await shutdown(recovered);

    // Act + Assert — ACROSS ANOTHER RESTART, with the real evidence back in place. Projection reads
    // the whole transcript again and must not re-mint what a person dismissed.
    const restarted = await boot(home, port);
    for (let read = 0; read < 2; read += 1)
      should((await advisoryOf(restarted)).needsHumanKind ?? undefined).be.undefined();
    should(await outcomes()).deepEqual(['accepted', 'quarantined', 'acknowledged']);
    should(await auditRows()).have.length(1);

    // Act + Assert — A NEWER QUESTION STILL REFUSES. Dismissing the old warning bought no licence to
    // replace a pane that is mid-conversation: the agent has asked something else since.
    await writeFile(
      transcript,
      `${TRANSCRIPT}${JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-ship-2',
              name: 'AskUserQuestion',
              input: { questions: [{ question: QUESTION, options: [{ label: 'Yes' }, { label: 'No' }] }] },
            },
          ],
        },
      })}\n`,
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await advisoryOf(restarted)).pendingQuestion !== undefined) break;
      await Bun.sleep(25);
    }
    should(await advisoryOf(restarted)).match({ pendingQuestion: { toolUseId: 'tool-ship-2' } });
    const refusedWhileAsking = await resumeRequest(port, restarted, 'admin-cli');
    const refusal = JSON.parse(await statusOf(refusedWhileAsking, 409)) as {
      readonly code: string;
      readonly error: string;
    };
    should(refusal.code).equal('resume_refused');
    should(refusal.error).match(/answer or abandon/u);
    should(await outcomes()).deepEqual(['accepted', 'quarantined', 'acknowledged']);

    await shutdown(restarted);
  }, 120_000);

  it('refuses to dismiss an advisory two ledger records both own, and keeps it standing', async () => {
    // The rendered attention sentence is not an injective encoding of the pair that built it.
    // `(requestId "…:a", toolUseId "tool-ship-1 for tool-ship-9")` and
    // `(requestId "…:a for tool-ship-1", toolUseId "tool-ship-9")` render the SAME sentence, because
    // neither id is constrained enough to keep the delimiter words to itself. So two operations own
    // one warning, and one of them is `confirmed` — a row this path must never rewrite. Counting
    // only the DISMISSABLE records would leave exactly one candidate and miss the ambiguity
    // entirely, which is why ownership is counted over every record. The daemon cannot know which
    // operation the person read about, so it dismisses neither and the warning stays up.
    const home = await tempDirectory('fyd-answer-collision-home');
    const scratch = await tempDirectory('fyd-answer-collision-scratch');
    // No question in the transcript: this journey is about the ledger and the advisory, and a
    // pending question would refuse the resume before ownership was ever consulted.
    const transcript = join(scratch, 'session.jsonl');
    await writeFile(transcript, '');
    const port = await freeLoopbackPort();
    const relaunchScript = join(scratch, 'relaunched-agent.sh');
    const relaunchLog = join(scratch, 'relaunch-turns.log');
    await writeFile(relaunchScript, RELAUNCH_SCRIPT, { mode: 0o700 });
    await chmod(relaunchScript, 0o700);
    await writeFile(relaunchLog, '');
    const sessionDirectory = await seed(home, port, transcript, ['/usr/bin/env', 'bash', relaunchScript, relaunchLog]);
    const ledgerPath = join(sessionDirectory, 'channel', 'answers.jsonl');
    await mkdir(join(sessionDirectory, 'channel'), { recursive: true });
    const row = (requestId: string, toolUseId: string, outcome: string, resolution?: string) =>
      `${JSON.stringify({
        requestId,
        toolUseId,
        fingerprint: `collision-${outcome}-${resolution ?? 'none'}`,
        acceptedAt: '2026-08-06T09:00:01.000Z',
        outcome,
        ...(resolution === undefined ? {} : { resolution }),
      })}\n`;
    // The durable shapes the ledger really writes, and they are NOT the same for these two rows: a
    // release is `accepted` plus `resolution: quarantined`, while a confirmation is a plain
    // `confirmed` outcome. Writing the confirmed row as `accepted` + `resolution` would decode back
    // as `accepted` and quietly stop being the non-candidate co-owner this test is built on.
    await writeFile(
      ledgerPath,
      `${row(`${REQUEST_ID}:a`, `${TOOL_USE_ID} for tool-ship-9`, 'accepted', 'quarantined')}` +
        `${row(`${REQUEST_ID}:a for ${TOOL_USE_ID}`, 'tool-ship-9', 'confirmed')}`,
    );
    // The relaunch below starts a REAL tmux server on this home's own socket; registering it is what
    // lets `afterEach` kill it, rather than leaving a server behind for the rest of the machine.
    sockets.add(join(home, 'tmux.sock'));
    const daemon = await boot(home, port);

    // Arrange — the daemon's OWN projection mints the advisory from the quarantined row, so the
    // standing sentence is one this daemon really writes rather than one the test invented. The
    // confirmed row renders the same sentence, which is the collision.
    let advisory: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}`, { headers: daemon.headers });
      const state = SessionViewSchema.parse(JSON.parse(await statusOf(response, 200))).state as Record<string, unknown>;
      if (state.needsHumanKind === 'structured-answer-released-unconfirmed') {
        advisory = state;
        break;
      }
      await Bun.sleep(25);
    }
    should(advisory).not.be.undefined();

    // Act — an operator asks for exactly the dismissal that works when ownership is unambiguous.
    // No pane exists, so this takes the real relaunch path and really reaches the adapter.
    const refused = await resumeRequest(port, daemon, 'admin-cli');

    // Assert — it fails closed, says why, and changes nothing about the ledger or the warning.
    const body = JSON.parse(await statusOf(refused, 500)) as { readonly code: string; readonly error: string };
    should(body.code).equal('session_resume_failed');
    should(body.error).match(/owned by 2 answer operations/u);
    should((await readFile(ledgerPath, 'utf8')).split('\n').filter(Boolean)).have.length(2);
    should(await readFile(join(sessionDirectory, 'events.jsonl'), 'utf8').catch(() => '')).not.match(
      /interaction\.answer_acknowledged/u,
    );
    const response = await fetch(`http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}`, { headers: daemon.headers });
    should(SessionViewSchema.parse(JSON.parse(await statusOf(response, 200))).state).match({
      needsHumanKind: 'structured-answer-released-unconfirmed',
    });

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
