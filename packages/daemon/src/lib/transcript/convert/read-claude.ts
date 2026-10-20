import type { HandoffDocuments } from '../../imports/conversation-text.ts';
import { transcriptObject, transcriptString } from '../value.ts';
import {
  type ConversationAttachment,
  type ConversationDropped,
  NO_DROPS,
  type ReadConversation,
} from './conversation.ts';
import { imageFromUrl, pairTools, type ReadItem } from './tool-pairing.ts';
import { userText } from './user-text.ts';

/**
 * A Claude Code transcript (`projects/<cwd>/<id>.jsonl`), read into the neutral conversation.
 *
 * WHAT IS READ. `user` and `assistant` records on the main line, a prompt the person queued while the
 * agent was busy (`attachment` › `queued_command` from a human), and each `compact_boundary`, which
 * restarts the conversation: Claude itself resumes only from the newest one, with the summary it wrote
 * there as the first user message, so a conversion does the same.
 *
 * WHAT IS DROPPED, and counted. Sidechain records (a subagent's own conversation, `isSidechain`),
 * meta records Claude never shows as a message (`isMeta`: a skill body, an image's size line), the
 * `attachment` records that carry its reminders and environment, `thinking` blocks, and the
 * synthetic assistant messages it writes for an API error. Bookkeeping records — `queue-operation`,
 * `last-prompt`, `cost-state`, file-history snapshots — are not conversation and are not counted.
 */

/** Claude's tool for running a shell command, which crosses natively. */
const CLAUDE_SHELL_TOOL = 'Bash';

/** The model Claude names on the assistant messages it writes itself (API errors, interruptions). */
const SYNTHETIC_MODEL = '<synthetic>';

function claudeAttachment(block: Record<string, unknown>): ConversationAttachment | undefined {
  const type = transcriptString(block.type);
  if (type !== 'image' && type !== 'document') return undefined;
  const source = transcriptObject(block.source) ?? {};
  const url = transcriptString(source.url);
  if (type === 'image' && url !== undefined) return imageFromUrl(url);
  const name = transcriptString(block.name) ?? transcriptString(block.title);
  const mediaType = transcriptString(source.media_type);
  const data = transcriptString(source.data);
  return {
    kind: type,
    ...(name === undefined ? {} : { name }),
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(url === undefined ? {} : { uri: url }),
    ...(data === undefined ? {} : { data }),
  };
}

/** A tool result's content as text; an image inside it is named, not carried. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(item => {
      const block = transcriptObject(item);
      if (block?.type === 'text') return transcriptString(block.text) ?? '';
      return block?.type === 'image' ? '[image]' : '';
    })
    .filter(text => text !== '')
    .join('\n');
}

/** The JSON records of a JSONL text; a line that does not parse is skipped. */
export function jsonRecords(text: string): readonly Record<string, unknown>[] {
  return text.split('\n').flatMap(line => {
    if (line.trim() === '') return [];
    try {
      const record = transcriptObject(JSON.parse(line));
      return record === undefined ? [] : [record];
    } catch {
      return [];
    }
  });
}

export function readClaudeConversation(text: string, documents: HandoffDocuments): ReadConversation {
  let items: ReadItem[] = [];
  let version: string | undefined;
  let conversationId: string | undefined;
  let model: string | undefined;
  let dropped = { reasoning: 0, sidechains: 0, internal: 0, compactions: 0 } satisfies ConversationDropped;

  for (const record of jsonRecords(text)) {
    version = transcriptString(record.version) ?? version;
    conversationId ??= transcriptString(record.sessionId);
    const at = transcriptString(record.timestamp);
    const stamp = at === undefined ? {} : { at };
    const type = transcriptString(record.type);
    if (record.isSidechain === true) {
      dropped.sidechains += 1;
      continue;
    }
    if (type === 'system') {
      if (record.subtype === 'compact_boundary') {
        // What was dropped before the boundary went with the history the harness compacted away.
        items = [];
        dropped = { ...NO_DROPS, compactions: dropped.compactions + 1 };
      }
      continue;
    }
    if (type === 'attachment') {
      const attachment = transcriptObject(record.attachment);
      const prompt = transcriptString(attachment?.prompt);
      const human = transcriptObject(attachment?.origin)?.kind === 'human';
      const spoken =
        attachment?.type === 'queued_command' && attachment.commandMode === 'prompt' && human && prompt !== undefined
          ? userText(prompt, documents)
          : undefined;
      if (spoken === undefined) dropped.internal += 1;
      else items.push({ kind: 'user', text: spoken, attachments: [], ...stamp });
      continue;
    }
    if (type !== 'user' && type !== 'assistant') continue;
    const message = transcriptObject(record.message) ?? {};
    const content = message.content;
    const blocks = Array.isArray(content) ? content : [content];

    if (type === 'user') {
      if (record.isMeta === true) {
        dropped.internal += 1;
        continue;
      }
      const texts: string[] = [];
      const attachments: ConversationAttachment[] = [];
      for (const value of blocks) {
        if (typeof value === 'string') {
          texts.push(value);
          continue;
        }
        const block = transcriptObject(value);
        if (block === undefined) continue;
        if (block.type === 'text') texts.push(transcriptString(block.text) ?? '');
        else if (block.type === 'tool_result')
          items.push({
            kind: 'result',
            id: transcriptString(block.tool_use_id) ?? '',
            output: resultText(block.content),
            failed: block.is_error === true,
          });
        else {
          const attachment = claudeAttachment(block);
          if (attachment !== undefined) attachments.push(attachment);
        }
      }
      if (texts.length === 0 && attachments.length === 0) continue;
      const spoken = userText(texts.join('\n\n'), documents);
      const summary = record.isCompactSummary === true && spoken !== undefined;
      if (spoken === undefined && attachments.length === 0) {
        dropped.internal += 1;
        continue;
      }
      items.push({
        kind: 'user',
        text: summary ? `[Summary of the earlier conversation]\n${spoken}` : (spoken ?? ''),
        attachments,
        ...stamp,
      });
      continue;
    }

    const answeredBy = transcriptString(message.model);
    if (answeredBy === SYNTHETIC_MODEL || record.isApiErrorMessage === true) {
      dropped.internal += 1;
      continue;
    }
    model = answeredBy ?? model;
    for (const value of blocks) {
      const block = transcriptObject(value);
      if (block === undefined) continue;
      if (block.type === 'text') {
        const said = transcriptString(block.text) ?? '';
        if (said.trim() !== '') items.push({ kind: 'assistant', text: said, ...stamp });
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') dropped.reasoning += 1;
      else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        const name = transcriptString(block.name) ?? 'tool';
        const input = block.input;
        const command = transcriptString(transcriptObject(input)?.command);
        items.push({
          kind: 'call',
          id: transcriptString(block.id) ?? '',
          name,
          input,
          ...(name === CLAUDE_SHELL_TOOL && command !== undefined ? { shell: { command } } : {}),
          ...stamp,
        });
      } else if (block.type === 'web_search_tool_result')
        items.push({
          kind: 'result',
          id: transcriptString(block.tool_use_id) ?? '',
          output: '[web search results]',
          failed: false,
        });
    }
  }

  const paired = pairTools(items);
  return {
    harness: 'claude',
    ...(version === undefined ? {} : { version }),
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(model === undefined ? {} : { model }),
    entries: paired.entries,
    dropped: { ...dropped, internal: dropped.internal + paired.orphanResults },
  };
}
