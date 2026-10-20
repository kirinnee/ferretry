import type { HandoffDocuments } from '../../imports/conversation-text.ts';
import { transcriptNumber, transcriptObject, transcriptString } from '../value.ts';
import {
  type ConversationAttachment,
  type ConversationDropped,
  NO_DROPS,
  type ReadConversation,
} from './conversation.ts';
import { jsonRecords } from './read-claude.ts';
import { imageFromUrl, pairTools, type ReadItem } from './tool-pairing.ts';
import { userText } from './user-text.ts';

/**
 * A Codex rollout (`sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`), read into the neutral
 * conversation.
 *
 * WHAT IS READ. The `response_item` records — the Responses API items Codex sends back to the model
 * on resume, and so the conversation as the model knew it. The `event_msg` records beside them mirror
 * the same turns for Codex's own screen and are not read, or every message would be carried twice. A
 * `compacted` record restarts the conversation from what it kept: its `replacement_history` when it
 * has one, otherwise its summary as the first user message.
 *
 * WHAT IS DROPPED, and counted. `developer` and `system` messages (Codex's own instructions and
 * permissions blocks), user messages that are wholly injected context (`<environment_context>`,
 * AGENTS.md), and `reasoning` items, whose content is encrypted for OpenAI alone.
 */

/** Codex's current shell tool, whose command is `cmd`. */
const CODEX_EXEC_TOOL = 'exec_command';
/** Every Codex tool that runs a shell command; the older ones name it `command`. */
const CODEX_SHELL_TOOLS: ReadonlySet<string> = new Set([CODEX_EXEC_TOOL, 'shell', 'shell_command', 'container.exec']);

/** The `exec_command` result preamble Codex writes before the command's own output. */
const EXEC_PREAMBLE = /^(?:[\w ]+: [^\n]*\n)*?Process exited with code (-?\d+)\n(?:[\w ]+: [^\n]*\n)*?Output:\n/u;

function parsedArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** The shell command a Codex call ran, when it is one. */
function shellOf(
  type: string,
  name: string | undefined,
  input: unknown,
  payload: Record<string, unknown>,
): { readonly command: string; readonly workdir?: string } | undefined {
  if (type !== 'local_shell_call' && (name === undefined || !CODEX_SHELL_TOOLS.has(name))) return undefined;
  const args = transcriptObject(type === 'local_shell_call' ? payload.action : input);
  if (args === undefined) return undefined;
  const raw = name === CODEX_EXEC_TOOL ? args.cmd : args.command;
  const command =
    typeof raw === 'string'
      ? raw
      : Array.isArray(raw) && raw.every(part => typeof part === 'string')
        ? (raw as readonly string[]).join(' ')
        : undefined;
  if (command === undefined) return undefined;
  const workdir = transcriptString(args.workdir) ?? transcriptString(args.working_directory);
  return { command, ...(workdir === undefined ? {} : { workdir }) };
}

/** A tool result's output as text, and whether it reports a failure. */
function outputOf(value: unknown): { readonly output: string; readonly failed: boolean } {
  if (Array.isArray(value))
    return {
      output: value
        .map(item => transcriptString(transcriptObject(item)?.text) ?? '')
        .filter(text => text !== '')
        .join('\n'),
      failed: false,
    };
  const object = transcriptObject(value);
  if (object !== undefined) return outputOf(object.content ?? object.output ?? '');
  const text = typeof value === 'string' ? value : '';
  const preamble = EXEC_PREAMBLE.exec(text);
  if (preamble !== null) {
    const code = Number(preamble[1]);
    const output = text.slice(preamble[0].length);
    return { output: code === 0 ? output : `Exit code ${code}\n${output}`, failed: code !== 0 };
  }
  // The older shell tools answered with a JSON document: `{output, metadata: {exit_code}}`.
  const legacy = transcriptObject(parsedArguments(text));
  const legacyOutput = transcriptString(legacy?.output);
  if (legacy !== undefined && legacyOutput !== undefined) {
    const code = transcriptNumber(transcriptObject(legacy.metadata)?.exit_code) ?? 0;
    return { output: code === 0 ? legacyOutput : `Exit code ${code}\n${legacyOutput}`, failed: code !== 0 };
  }
  return { output: text, failed: false };
}

/** One response item's contribution, or `undefined` when it carries nothing a conversion keeps. */
function readItem(
  payload: Record<string, unknown>,
  at: string | undefined,
  documents: HandoffDocuments,
  dropped: { reasoning: number; internal: number },
): ReadItem | undefined {
  const type = transcriptString(payload.type) ?? '';
  const stamp = at === undefined ? {} : { at };
  if (type === 'message') {
    const role = transcriptString(payload.role);
    const parts = Array.isArray(payload.content) ? payload.content : [];
    if (role === 'assistant') {
      const said = parts
        .map(part => transcriptString(transcriptObject(part)?.text) ?? '')
        .join('')
        .trim();
      return said === '' ? undefined : { kind: 'assistant', text: said, ...stamp };
    }
    if (role !== 'user') {
      dropped.internal += 1;
      return undefined;
    }
    const texts: string[] = [];
    const attachments: ConversationAttachment[] = [];
    for (const value of parts) {
      const part = transcriptObject(value);
      if (part?.type === 'input_text') texts.push(transcriptString(part.text) ?? '');
      const url = transcriptString(part?.image_url);
      if (part?.type === 'input_image' && url !== undefined) attachments.push(imageFromUrl(url));
    }
    // Codex sends each injected block as its own text part, so one is judged on its own.
    const spoken = texts.flatMap(part => {
      const kept = userText(part, documents);
      return kept === undefined ? [] : [kept];
    });
    if (spoken.length === 0 && attachments.length === 0) {
      dropped.internal += 1;
      return undefined;
    }
    return { kind: 'user', text: spoken.join('\n\n'), attachments, ...stamp };
  }
  if (type === 'reasoning') {
    dropped.reasoning += 1;
    return undefined;
  }
  if (
    type === 'function_call' ||
    type === 'custom_tool_call' ||
    type === 'local_shell_call' ||
    type === 'web_search_call'
  ) {
    const name = transcriptString(payload.name) ?? (type === 'web_search_call' ? 'web_search' : 'shell');
    const input =
      type === 'web_search_call'
        ? transcriptObject(payload.action)
        : parsedArguments(payload.arguments ?? payload.input ?? payload.action);
    const shell = shellOf(type, name, input, payload);
    return {
      kind: 'call',
      id: transcriptString(payload.call_id) ?? transcriptString(payload.id) ?? '',
      name,
      input,
      ...(shell === undefined ? {} : { shell }),
      ...stamp,
    };
  }
  if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'local_shell_call_output') {
    const result = outputOf(payload.output);
    return { kind: 'result', id: transcriptString(payload.call_id) ?? '', ...result };
  }
  return undefined;
}

export function readCodexConversation(text: string, documents: HandoffDocuments): ReadConversation {
  let items: ReadItem[] = [];
  let version: string | undefined;
  let conversationId: string | undefined;
  let model: string | undefined;
  let dropped = { reasoning: 0, sidechains: 0, internal: 0, compactions: 0 } satisfies ConversationDropped;

  const take = (payload: Record<string, unknown>, at: string | undefined): void => {
    const item = readItem(payload, at, documents, dropped);
    if (item !== undefined) items.push(item);
  };

  for (const record of jsonRecords(text)) {
    const payload = transcriptObject(record.payload) ?? {};
    const at = transcriptString(record.timestamp);
    if (record.type === 'session_meta') {
      version ??= transcriptString(payload.cli_version);
      conversationId ??= transcriptString(payload.id);
    } else if (record.type === 'turn_context') model = transcriptString(payload.model) ?? model;
    else if (record.type === 'response_item') take(payload, at);
    else if (record.type === 'compacted') {
      // What was dropped before the boundary went with the history the harness compacted away.
      items = [];
      dropped = { ...NO_DROPS, compactions: dropped.compactions + 1 };
      const kept = Array.isArray(payload.replacement_history) ? payload.replacement_history : undefined;
      const summary = transcriptString(payload.message);
      if (kept !== undefined)
        for (const value of kept) {
          const item = transcriptObject(value);
          if (item !== undefined) take(item, at);
        }
      else if (summary !== undefined && summary.trim() !== '')
        items.push({
          kind: 'user',
          text: `[Summary of the earlier conversation]\n${summary.trim()}`,
          attachments: [],
          ...(at === undefined ? {} : { at }),
        });
    }
  }

  const paired = pairTools(items);
  return {
    harness: 'codex',
    ...(version === undefined ? {} : { version }),
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(model === undefined ? {} : { model }),
    entries: paired.entries,
    dropped: { ...dropped, internal: dropped.internal + paired.orphanResults },
  };
}
