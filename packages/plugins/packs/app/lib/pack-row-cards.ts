/**
 * The Pack cards of one transcript row, from what Conversation's `conversation.row` slot hands a panel.
 *
 * The slot offers a `tool` row's SHELL commands only (`ConversationRowToolCall`: the command line and the text it
 * printed). `projectPackCalls` reads a command's words, not the tool that ran it, so each is given back as the `Bash`
 * call it reads (`shellCommandOf`). The projection sees one row at a time: a `wait` is folded into the start card that
 * stands in the SAME row, and a refused start is marked retried only by a later start in the same row; a `wait` whose
 * start is in another row is its own "Waited for" card, which the card already draws for a start it cannot see.
 */
import type { ConversationRowEntry, ConversationRowToolCall } from '@ferretry/plugin-conversation/contract';
import { projectPackCalls } from './pack-calls.ts';
import type { ToolCall, TranscriptEntry } from './shell-ports.ts';

/** The name of the CLI a ferret runs the Pack commands with. */
export const CLIENT_NAME = 'fy';

const toolCallOf = (call: ConversationRowToolCall): ToolCall => ({
  key: call.key,
  use: { name: 'Bash', input: { command: call.command } },
  ...(call.ts === undefined ? {} : { ts: call.ts }),
  ...(call.result === undefined
    ? {}
    : { result: { text: call.result.text, ...(call.result.isError === true ? { isError: true } : {}) } }),
});

/** The rows of `entry` that are a Pack command, each carrying its read `pack`; none for a row that holds no such command. */
export const packCardsOf = (entry: ConversationRowEntry): readonly TranscriptEntry[] => {
  if (entry.kind !== 'tool' || entry.tools === undefined || entry.tools.length === 0) return [];
  const row: TranscriptEntry = {
    id: entry.id,
    kind: 'tool',
    text: entry.text,
    ...(entry.at === undefined ? {} : { at: entry.at }),
    tools: entry.tools.map(toolCallOf),
  };
  return projectPackCalls([row], CLIENT_NAME).filter(card => card.pack !== undefined);
};
