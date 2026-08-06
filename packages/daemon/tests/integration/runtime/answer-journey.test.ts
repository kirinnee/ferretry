import { afterEach, describe, it } from 'bun:test';
import { chmod, readFile, writeFile } from 'node:fs/promises';
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
  let release = (): void => {};
  const world: DaemonWorld = {
    ...buildWorld(),
    untilShutdown: async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    },
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
    release: () => release(),
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
    const read = await fetch(`http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}`, { headers: daemon.headers });
    const pending = SessionViewSchema.parse(JSON.parse(await statusOf(read, 200)));
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
});
