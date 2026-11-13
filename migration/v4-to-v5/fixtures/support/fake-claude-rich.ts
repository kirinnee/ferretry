#!/usr/bin/env bun
/**
 * The rich part of the fake `claude`: plays ONE scripted exchange into a ferret's transcript and its pane.
 *
 *   bun fake-claude-rich.ts <transcript.jsonl> <session id> <script.json>
 *
 * `fake-claude-tui.sh` calls this (only when `FY_FIXTURE_RICH` is set, i.e. only for a `--rich` home) when the daemon types
 * a line `FIXTURE-REC <script.json>`. The script is data the builder wrote; this program never invents a record. It
 * writes what the real Claude Code CLI writes (a user turn, an assistant turn with text, thinking and tool calls, the
 * tool results, an image the person attached) so a conversation looks lived-in, and it can stop the way a real session
 * stops: waiting on a structured question, waiting on a permission prompt, or sitting in the middle of a long turn.
 *
 * Nothing here is a credential and nothing reaches a network: it appends lines to one local file and prints to the pane.
 */
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

type Block = Record<string, unknown>;

type Step =
  | { readonly user: string }
  /** The person attached an image: its bytes (base64) go into the record as the real CLI records them. */
  | { readonly userImage: { readonly file: string; readonly text: string } }
  | { readonly assistant: readonly Block[] }
  /** A tool call and its result as one pair: the assistant's `tool_use`, then the user-side `tool_result`. */
  | {
      readonly tool: {
        readonly name: string;
        readonly input: Record<string, unknown>;
        readonly result: string;
        readonly error?: boolean;
      };
    }
  /** AskUserQuestion: the `tool_use` with NO result yet, the pane's dialog, then one line from the person. */
  | { readonly ask: { readonly questions: readonly Record<string, unknown>[]; readonly then: string } }
  /** A permission prompt: the pane's dialog, then one line; `1`/`y` allows, anything else refuses. */
  | { readonly permission: { readonly tool: string; readonly input: Record<string, unknown>; readonly shown: string } }
  | { readonly print: string }
  | { readonly sleep: number }
  /** Stop in the middle of a turn: print nothing more and wait, as a long-running tool call does. */
  | { readonly hang: true };

interface Script {
  readonly model?: string;
  readonly steps: readonly Step[];
}

const [transcriptArg, sessionArg, scriptArg] = process.argv.slice(2);
if (transcriptArg === undefined || sessionArg === undefined || scriptArg === undefined) {
  console.error('usage: fake-claude-rich.ts <transcript> <session id> <script.json>');
  process.exit(64);
}
const transcript: string = transcriptArg;
const sessionId: string = sessionArg;
const scriptPath: string = scriptArg;
const script = JSON.parse(readFileSync(scriptPath, 'utf8')) as Script;
const model = script.model ?? 'claude-opus-5-5';

/** The uuid of the last record already in the transcript, so each record names its parent as the real CLI does. */
function lastUuid(): string | null {
  try {
    const lines = readFileSync(transcript, 'utf8').trim().split('\n');
    for (let at = lines.length - 1; at >= 0; at--) {
      const parsed = JSON.parse(lines[at] ?? '{}') as { uuid?: unknown };
      if (typeof parsed.uuid === 'string') return parsed.uuid;
    }
  } catch {
    // an empty or missing transcript has no parent
  }
  return null;
}

let parent = lastUuid();

function write(type: 'user' | 'assistant', content: readonly Block[], extra: Record<string, unknown> = {}): void {
  const uuid = randomUUID();
  const message: Record<string, unknown> = { role: type, content };
  if (type === 'assistant') {
    message.id = `msg_${uuid.slice(0, 12)}`;
    message.model = model;
    message.type = 'message';
    message.stop_reason = content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
    message.usage = {
      input_tokens: 1800 + (content.length % 7) * 211,
      output_tokens: 240 + (content.length % 5) * 37,
      cache_creation_input_tokens: 5200,
      cache_read_input_tokens: 41000,
    };
  }
  appendFileSync(
    transcript,
    `${JSON.stringify({
      type,
      uuid,
      parentUuid: parent,
      sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
      version: '2.1.0',
      ...extra,
      message,
    })}\n`,
  );
  parent = uuid;
}

const text = (value: string): Block => ({ type: 'text', text: value });
let toolCounter = 0;
const nextToolId = (): string => `toolu_fixture_${sessionId.slice(0, 8)}_${String((toolCounter += 1))}`;

/** One line from the person (the daemon types an answer into the pane); `null` when stdin closed. */
async function readLine(): Promise<string | null> {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of Bun.stdin.stream()) {
    buffered += decoder.decode(chunk as Uint8Array);
    const end = buffered.indexOf('\n');
    if (end !== -1) return buffered.slice(0, end).trim();
  }
  return null;
}

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

for (const step of script.steps) {
  if ('user' in step) {
    write('user', [text(step.user)]);
  } else if ('userImage' in step) {
    const bytes = readFileSync(step.userImage.file);
    write('user', [
      text(step.userImage.text),
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } },
    ]);
  } else if ('assistant' in step) {
    write('assistant', step.assistant);
  } else if ('tool' in step) {
    const id = nextToolId();
    write('assistant', [{ type: 'tool_use', id, name: step.tool.name, input: step.tool.input }]);
    write(
      'user',
      [{ type: 'tool_result', tool_use_id: id, content: step.tool.result, is_error: step.tool.error === true }],
      {
        toolUseResult: { stdout: step.tool.result, stderr: '', interrupted: false, isImage: false },
      },
    );
  } else if ('ask' in step) {
    const id = nextToolId();
    write('assistant', [
      text('I need one decision from you before I go on.'),
      { type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: step.ask.questions } },
    ]);
    // What the daemon's own PreToolUse hook does when the real CLI is about to ask: hand it the question.
    const questionFile = process.env.FY_QUESTION_FILE;
    if (questionFile !== undefined && questionFile !== '') {
      writeFileSync(
        `${questionFile}.tmp`,
        JSON.stringify({
          session_id: sessionId,
          transcript_path: transcript,
          cwd: process.cwd(),
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_input: { questions: step.ask.questions },
          tool_use_id: id,
        }),
      );
      renameSync(`${questionFile}.tmp`, questionFile);
    }
    out('');
    for (const question of step.ask.questions) {
      out(`  ${String(question.header ?? 'Question')}`);
      out(`  ${String(question.question ?? '')}`);
      const options = Array.isArray(question.options) ? (question.options as { label?: unknown }[]) : [];
      options.forEach((option, index) =>
        out(`  ${index === 0 ? '❯' : ' '} ${String(index + 1)}. ${String(option.label)}`),
      );
      out(`    ${String(options.length + 1)}. Other`);
    }
    out('');
    const answer = await readLine();
    write('user', [{ type: 'tool_result', tool_use_id: id, content: `User has answered: ${answer ?? ''}` }], {
      toolUseResult: { questions: step.ask.questions, answers: { answer: answer ?? '' } },
    });
    write('assistant', [text(`${step.ask.then} (you chose: ${answer ?? 'nothing'})`)]);
  } else if ('permission' in step) {
    const id = nextToolId();
    write('assistant', [{ type: 'tool_use', id, name: step.permission.tool, input: step.permission.input }]);
    out('');
    out(` ${step.permission.tool} command`);
    out('');
    out(`   ${step.permission.shown}`);
    out('');
    out(' Do you want to proceed?');
    out(' ❯ 1. Yes');
    out("   2. Yes, and don't ask again for this command");
    out('   3. No, and tell Claude what to do differently (esc)');
    out('');
    const answer = (await readLine()) ?? '';
    const allowed = answer === '1' || /^y/iu.test(answer);
    write(
      'user',
      [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: allowed
            ? 'Done.'
            : "The user doesn't want to proceed with this tool use. The tool use was rejected.",
          is_error: !allowed,
        },
      ],
      { toolUseResult: allowed ? { stdout: 'Done.', stderr: '' } : 'User rejected tool use' },
    );
  } else if ('print' in step) {
    out(step.print);
  } else if ('sleep' in step) {
    await Bun.sleep(step.sleep * 1000);
  } else {
    // hang: the turn never finishes, so the pane never shows the prompt again.
    out('✻ Working… (esc to interrupt)');
    await Bun.sleep(3_600_000);
  }
}
