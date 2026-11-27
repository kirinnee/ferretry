import type { ForkPlan, ForkTarget, TurnRef } from '@ferretry/core-ferrets/contract';
import { MAX_ROOT_WINDOW_BYTES, type FencedPath, type FerretId, type RootHandle } from '@ferretry/kernel/contract';
import { claudeTranscriptPath, isConversationId } from '../../lib/harness/claude-path.ts';
import type { ClaudeCore, Serves } from './core.ts';
import { resolveTranscriptFile } from './transcript.ts';

/** The largest conversation a fork copies: the copy is held whole in memory (the same bound copy-on-link keeps). */
const MAX_FORK_BYTES = 256 * 1024 * 1024;
const NEWLINE = 0x0a;

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;

/** Hold one no-link descriptor, including on an unpooled home; a stat followed by readBytes would follow an in-root link. */
async function sourceBytes(home: RootHandle, file: FencedPath): Promise<Uint8Array> {
  const opened = await home.openBytes?.(file);
  if (opened === undefined) throw new Error('the source conversation could not be opened without following a link');
  try {
    const { size } = await opened.stat();
    if (size > MAX_FORK_BYTES) throw new Error('that conversation is too large to fork (over 256 MB)');
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const chunk = await opened.read(offset, Math.min(MAX_ROOT_WINDOW_BYTES, size - offset));
      if (chunk.length === 0) break;
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (!(await opened.stillNames())) throw new Error('the source conversation changed while it was being read');
    return bytes.subarray(0, offset);
  } finally {
    await opened.close();
  }
}

/** One transcript line: its exact bytes (newline included) and what it parsed to, if it parsed. */
interface Line {
  readonly bytes: Uint8Array;
  readonly record: Json | undefined;
}

/** The lines of a transcript with their exact bytes. A last line with no newline is kept only when it is a whole record. */
function linesOf(bytes: Uint8Array): readonly Line[] {
  const decoder = new TextDecoder();
  const lines: Line[] = [];
  let begin = 0;
  while (begin < bytes.length) {
    const newline = bytes.indexOf(NEWLINE, begin);
    const end = newline < 0 ? bytes.length : newline + 1;
    const text = decoder.decode(bytes.subarray(begin, newline < 0 ? bytes.length : newline));
    let record: Json | undefined;
    try {
      record = asObject(JSON.parse(text));
    } catch {
      record = undefined;
    }
    // A last line still being written is not a record yet: a fork never carries half of one.
    if (newline >= 0 || record !== undefined) {
      const whole =
        newline >= 0 ? bytes.subarray(begin, end) : new Uint8Array([...bytes.subarray(begin, end), NEWLINE]);
      lines.push({ bytes: whole, record });
    }
    begin = end;
  }
  return lines;
}

/**
 * Conversation's visible user messages, including native queue drains and Ferretry's channel. The reader lives in another
 * plugin's daemon half; contract/testing/fork-inputs.ts pins both consumers to the same raw fixture across that boundary.
 */
function startsTurn(record: Json | undefined): boolean {
  if (record === undefined) return false;
  const channel = (value: unknown): boolean => {
    const origin = asObject(value);
    return origin?.kind === 'channel' && origin.server === 'ferretry';
  };
  const hasWords = (content: unknown): boolean => {
    const parts = Array.isArray(content) ? content : [content];
    return parts.some(part => {
      const text = typeof part === 'string' ? part : asObject(part)?.type === 'text' ? asObject(part)?.text : undefined;
      return typeof text === 'string' && text.trim() !== '';
    });
  };
  if (record.type === 'attachment') {
    const queued = asObject(record.attachment);
    return (
      queued?.type === 'queued_command' &&
      queued.commandMode === 'prompt' &&
      (asObject(queued.origin)?.kind === 'human' || channel(queued.origin)) &&
      hasWords(queued.prompt)
    );
  }
  if (record.type !== 'user' || record.isCompactSummary === true) return false;
  const kind = asObject(record.origin)?.kind;
  if (
    !channel(record.origin) &&
    (record.isMeta === true ||
      record.isVisibleInTranscriptOnly === true ||
      (typeof kind === 'string' && kind !== '' && kind !== 'human'))
  )
    return false;
  const content = asObject(record.message)?.content;
  return hasWords(content);
}

/** The tool calls with no answer among these records: a cut that leaves one makes a conversation Claude may refuse to resume. */
function unansweredCalls(lines: readonly Line[]): readonly string[] {
  const called = new Set<string>();
  const answered = new Set<string>();
  for (const { record } of lines) {
    const content = asObject(record?.message)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const one = asObject(block);
      if (one?.type === 'tool_use' && typeof one.id === 'string') called.add(one.id);
      if (one?.type === 'tool_result' && typeof one.tool_use_id === 'string') answered.add(one.tool_use_id);
    }
  }
  return [...called].filter(id => !answered.has(id));
}

/**
 * How many lines of the transcript the cut keeps, or the sentence saying why `at` names no place in it.
 * Absent `at`: the whole conversation. `at.entry`: through that record. Otherwise `at.turn`: through the end of that
 * turn, that is, up to (not including) the prompt that opens the next one. A turn is one person's prompt and all that
 * answered it.
 */
function cutAfter(lines: readonly Line[], at: TurnRef | undefined): number | string {
  if (at === undefined) return lines.length;
  if (!Number.isInteger(at.turn) || at.turn < 1) return `turn ${at.turn} is not a turn: turns count from 1`;
  const starts = lines.flatMap((line, index) => (startsTurn(line.record) ? [index] : []));
  if (at.entry !== undefined) {
    const index = lines.findIndex(line => line.record?.uuid === at.entry);
    if (index < 0) return `this conversation has no entry ${at.entry}, so there is nothing to cut at`;
    const turn = starts.filter(start => start <= index).length;
    if (turn !== at.turn) return `entry ${at.entry} is in turn ${turn}, not turn ${at.turn}`;
    const kept = lines.slice(0, index + 1);
    if (unansweredCalls(kept).length > 0)
      return `entry ${at.entry} falls inside a tool call that is answered after it; pick a message before or after the call`;
    return index + 1;
  }
  if (at.turn > starts.length)
    return `turn ${at.turn} does not exist: this conversation has ${starts.length} turn${starts.length === 1 ? '' : 's'}`;
  const end = starts[at.turn] ?? lines.length;
  if (unansweredCalls(lines.slice(0, end)).length > 0)
    return `turn ${at.turn} ends inside a tool call; pick a later turn that includes its answer`;
  return end;
}

/** A top-level copy cannot resume an Agent whose separate transcript was left behind. Refuse before any write. */
function includesSubagent(lines: readonly Line[]): boolean {
  return lines.some(({ record }) => {
    if (typeof asObject(record?.toolUseResult)?.agentId === 'string') return true;
    const content = asObject(record?.message)?.content;
    return (
      Array.isArray(content) &&
      content.some(block => {
        const call = asObject(block);
        return call?.type === 'tool_use' && call.name === 'Agent';
      })
    );
  });
}

/** The kept lines under the new conversation id: only the records that carry the old one change, every other byte is kept. */
function renamed(lines: readonly Line[], from: string, to: string): Uint8Array {
  const encoder = new TextEncoder();
  const parts = lines.map(({ bytes, record }) =>
    record?.sessionId === from ? encoder.encode(`${JSON.stringify({ ...record, sessionId: to })}\n`) : bytes,
  );
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

export const forkPart = (core: ClaudeCore): Serves<'fork'> => ({
  /**
   * Cuts a ferret's conversation into a NEW one (`Harness.fork`). The source transcript is read through the root that
   * proved it and is never written, moved or locked; the cut is written as a new file under a new id in the shared history
   * pool, under the spelling Claude keys `into.folder` by, so the ferret started there resumes it. It is made once and never
   * over a name that exists. No discard is offered: a failed launch keeps the new conversation for the owner, since a
   * pathname identity check followed by removal cannot prove that a concurrent replacement will survive.
   */
  async fork(from: FerretId, at: TurnRef | undefined, into: ForkTarget): Promise<ForkPlan> {
    if (!into.folder.startsWith('/')) throw new Error('the folder to fork into must be an absolute path');
    const source = await resolveTranscriptFile(core, from);
    if (source === undefined) throw new Error('this ferret has no conversation on disk to fork');
    const lines = linesOf(await sourceBytes(source.home, source.file));
    const cut = cutAfter(lines, at);
    if (typeof cut === 'string') throw new Error(cut);
    const kept = lines.slice(0, cut);
    if (kept.length === 0) throw new Error('there is nothing in that conversation to fork');
    if (includesSubagent(kept))
      throw new Error(
        'this cut includes a subagent whose separate transcript cannot be copied safely; pick a cut before it',
      );

    const id = core.deps.newConversationId();
    if (!isConversationId(id) || id === source.conversation)
      throw new Error('a fresh conversation id could not be made, so nothing was written');
    const pool = core.deps.roots.historyPool();
    const relative = claudeTranscriptPath(into.folder, id);
    const file = pool.resolve(relative);
    const folder = pool.resolve(relative.slice(0, relative.lastIndexOf('/')));
    if (!file.ok || !folder.ok) throw new Error('the new conversation would be outside the folders Ferretry may use');
    await pool.makeDirectory(folder.value, { mode: 0o700 });
    await pool.writeBytes(file.value, renamed(kept, source.conversation, id), { exclusive: true });

    return {
      from,
      ...(at === undefined ? {} : { at }),
      harnessConversation: id,
    };
  },
});
