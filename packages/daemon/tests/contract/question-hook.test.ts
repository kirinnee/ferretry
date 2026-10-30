import { afterAll, beforeAll, describe, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixedLayerFor } from '@ferretry/fleet';
import should from 'should';
import { readAskedQuestion } from '../../src/adapters/session/question/asked-question-file.ts';
import { withAskedQuestion } from '../../src/lib/session/question/asked.ts';
import { projectStructuredQuestion } from '../../src/lib/session/question/projection.ts';
import { ClaudeTranscriptParser } from '../../src/lib/transcript/claude.ts';
import type { TranscriptEvent } from '../../src/lib/transcript/types.ts';

/**
 * The harness contract for structured questions: the question a REAL Claude Code is asking reaches the
 * daemon's projection through the fixed overlay's hook, while its form is still on screen.
 *
 * Live ferrets on Claude Code 2.1.281 keep an `AskUserQuestion` call out of the transcript until the form
 * is answered (measured on real panes, Haiku and Opus alike), so a projection over the transcript alone
 * saw nothing and every interactive ferret's question was offered only as raw keys in the Console; 2.1.220
 * wrote the call as it was asked, which is why it once worked. The fleet's fixed overlay now installs a
 * `PreToolUse` hook that records the call as it is asked (`CLAUDE_QUESTION_HOOKS`). This suite runs the
 * real CLI in a pseudo-terminal, with THAT overlay, against a loopback model scripted to ask one question,
 * and reads what the daemon would read:
 *
 * - while the form is drawn, the hook has recorded the model's own call, for this conversation's
 *   transcript, and with it the projection has the question pending with every option;
 * - once the form is answered, the transcript holds the call and its result, and the hook's record no
 *   longer keeps the question open.
 *
 * DECLARED LIMIT: this harness cannot reproduce the hold-back itself. Against the loopback model both
 * versions write the call while the form is open — with or without the hook, a tool call before it, a
 * pending MCP server, or the account's own cached feature flags — so whatever holds it back is live-only.
 * The live bytes are the unit tier's regression (`tests/unit/session/question/asked.test.ts`); this suite
 * pins the mechanism: the hook fires before the form, its payload is what the daemon parses, and the
 * projection agrees with the transcript once it catches up.
 *
 * Opt-in like the rest of the guard: `packages/fleet/tests/contract/run.sh` sets `FY_HARNESS_CONTRACT=1`
 * and the binary; every other test run skips this file. No network: the model is on 127.0.0.1.
 */

const enabled = process.env.FY_HARNESS_CONTRACT === '1';
const TOOL_USE_ID = 'toolu_fy_contract_question';
const QUESTION = {
  question: 'Which web address should the report viewer live at?',
  header: 'Web address',
  multiSelect: false,
  options: [
    { label: 'reports.example.dev', description: 'A clean address on a domain you have.' },
    { label: 'tests.example.dev', description: 'Same idea, different word.' },
  ],
};
/** The form's footer, matched with whitespace removed: the TUI moves the cursor instead of printing spaces. */
const FORM = /Entertoselect/;

const sse = (events: readonly (readonly [string, unknown])[]): Response =>
  new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

/** Anthropic's streamed Messages reply holding one content block, then `stop_reason`. */
function reply(serial: number, block: Record<string, unknown>, delta: Record<string, unknown>, stop: string): Response {
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  return sse([
    [
      'message_start',
      {
        type: 'message_start',
        message: { id: `msg_fy_${serial}`, type: 'message', role: 'assistant', model: 'claude-fy', content: [], usage },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: block }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

/** A model that asks the question on the first turn and says "OK" to everything after it. */
function scriptedModel(): { readonly port: number; stop(): void } {
  let serial = 0;
  let asked = false;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async request => {
      if (!new URL(request.url).pathname.endsWith('/messages')) return Response.json({ data: [], models: [] });
      const body = (await request.json().catch(() => ({}))) as { tools?: readonly { name?: unknown }[] };
      serial++;
      // The conversation's own request offers the tool; a title or any other side call gets text.
      const offers = Array.isArray(body.tools) && body.tools.some(tool => tool.name === 'AskUserQuestion');
      const asks = offers && !asked;
      asked ||= asks;
      return asks
        ? reply(
            serial,
            { type: 'tool_use', id: TOOL_USE_ID, name: 'AskUserQuestion', input: {} },
            { type: 'input_json_delta', partial_json: JSON.stringify({ questions: [QUESTION] }) },
            'tool_use',
          )
        : reply(serial, { type: 'text', text: '' }, { type: 'text_delta', text: 'OK' }, 'end_turn');
    },
  });
  return { port: server.port as number, stop: () => void server.stop(true) };
}

const parse = async (file: string): Promise<readonly TranscriptEvent[]> => {
  const text = await readFile(file, 'utf8').catch(() => '');
  return new ClaudeTranscriptParser().parse({ text, endOfInput: true }).events;
};

const until = async (check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(200);
  }
  return await check();
};

describe.skipIf(!enabled)('claude contract: a structured question reaches the daemon while its form is open', () => {
  let root: string;
  let model: ReturnType<typeof scriptedModel>;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fyc-question-'));
    model = scriptedModel();
  });
  afterAll(async () => {
    model.stop();
    await rm(root, { recursive: true, force: true });
  });

  it('should project the asked question from the hook, and retire it once the form is answered', async () => {
    // Arrange — a runtime as the fleet lays one out: the fixed overlay as `--settings`, its `.claude.json`.
    const bin = process.env.FY_CONTRACT_CLAUDE_BIN;
    if (bin === undefined || bin === '') throw new Error('FY_HARNESS_CONTRACT=1 but FY_CONTRACT_CLAUDE_BIN is unset');
    const config = path.join(root, 'config');
    const home = path.join(root, 'home');
    const work = path.join(root, 'work');
    for (const directory of [config, home, work]) await mkdir(directory, { recursive: true });
    const cwd = await realpath(work);
    const fixed = fixedLayerFor({
      harness: 'claude',
      agentPermissions: 'skip',
      cwd,
      fyCommand: 'fy',
      acceptsAutoPermissionMode: false,
    });
    if (!fixed.ok) throw new Error(fixed.refusal.message);
    const overlay = path.join(root, 'fixed.json');
    await writeFile(overlay, JSON.stringify(fixed.layer.claudeSettingsOverlay));
    await writeFile(path.join(config, '.claude.json'), JSON.stringify(fixed.layer.claudeJson));
    // The key comes from a helper so the interactive CLI never asks whether to use an environment key.
    await writeFile(path.join(config, 'settings.json'), JSON.stringify({ apiKeyHelper: 'echo fy-contract-not-a-key' }));
    const asked = path.join(root, 'question-asked.json');
    const sessionId = randomUUID();
    const output: string[] = [];
    const decoder = new TextDecoder();
    const child = Bun.spawn(
      [bin, '--permission-mode', 'bypassPermissions', '--settings', overlay, '--session-id', sessionId, 'Ask me.'],
      {
        cwd,
        env: {
          HOME: home,
          PATH: process.env.FY_CONTRACT_PATH ?? '/usr/bin:/bin',
          USER: process.env.USER ?? 'fy-contract',
          LANG: 'C.UTF-8',
          TERM: 'xterm-256color',
          CLAUDE_CONFIG_DIR: config,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.port}`,
          DISABLE_AUTOUPDATER: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          FY_QUESTION_FILE: asked,
        },
        terminal: {
          cols: 120,
          rows: 40,
          data(_terminal, bytes) {
            output.push(decoder.decode(bytes, { stream: true }));
          },
        },
      },
    );
    const screen = (): string => Bun.stripANSI(output.join(''));
    try {
      // Act — wait for the form, as a person would see it.
      const drawn = await until(
        async () => FORM.test(screen().replace(/\s+/gu, '')) && (await Bun.file(asked).exists()),
        60_000,
      );
      should(drawn).be.true(`the form or the hook's file never appeared; the screen was:\n${screen().slice(-3000)}`);
      const payload = JSON.parse(await readFile(asked, 'utf8')) as { transcript_path?: string };
      const transcript = payload.transcript_path ?? '';
      const open = await readAskedQuestion(asked, transcript);
      const whileOpen = await parse(transcript);

      // Assert — the hook recorded the model's own call, and with it the projection has the question.
      should(transcript.endsWith(`${sessionId}.jsonl`)).be.true();
      should(open?.toolUseId).equal(TOOL_USE_ID);
      const pending = projectStructuredQuestion(withAskedQuestion(whileOpen, open));
      should(pending.kind).equal('pending');
      if (pending.kind !== 'pending') return;
      should(pending.question.toolUseId).equal(TOOL_USE_ID);
      should(pending.question.questions).deepEqual([
        {
          question: QUESTION.question,
          header: QUESTION.header,
          options: QUESTION.options,
        },
      ]);

      // Act — answer the form: Enter takes the first option.
      child.terminal?.write('\r');
      const answered = await until(
        async () =>
          (await parse(transcript)).some(event => event.kind === 'tool-result' && event.result.callId === TOOL_USE_ID),
        60_000,
      );

      // Assert — the transcript took over, and the hook's record cannot hold a gone form open.
      should(answered).be.true(`the answer never reached the transcript; the screen was:\n${screen().slice(-3000)}`);
      const after = await parse(transcript);
      should(projectStructuredQuestion(withAskedQuestion(after, await readAskedQuestion(asked, transcript)))).deepEqual(
        { kind: 'resolved', toolUseId: TOOL_USE_ID },
      );
    } finally {
      child.kill('SIGKILL');
      await child.exited;
      child.terminal?.close();
    }
  }, 180_000);
});
