import type { ForkPlan, ForkTarget, TurnRef } from '@ferretry/core-ferrets/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import { claudeTranscriptPath, isConversationId } from '../../lib/harness/claude-path.ts';
import type { ClaudeCore, Serves } from './core.ts';
import { resolveTranscriptFile } from './transcript.ts';

/** The largest conversation a fork copies: the copy is held whole in memory (the same bound copy-on-link keeps). */
const MAX_FORK_BYTES = 256 * 1024 * 1024;
const NEWLINE = 0x0a;

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;

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

/** A line a person typed: a user record that is not Claude's own note, a side thread, a summary or a tool answer. */
function startsTurn(record: Json | undefined): boolean {
  if (record === undefined || record.type !== 'user') return false;
  if (record.isMeta === true || record.isSidechain === true || record.isCompactSummary === true) return false;
  if (record.isVisibleInTranscriptOnly === true) return false;
  const origin = asObject(record.origin)?.kind;
  if (typeof origin === 'string' && origin !== '' && origin !== 'human' && origin !== 'channel') return false;
  const content = asObject(record.message)?.content;
  if (typeof content === 'string') return content !== '';
  return (
    Array.isArray(content) &&
    content.some(block => asObject(block)?.type === 'text') &&
    !content.some(block => asObject(block)?.type === 'tool_result')
  );
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
  return starts[at.turn] ?? lines.length;
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
   * over a name that exists. `discard` removes that one file (proved by its device and inode, so a file put there since is
   * left), and nothing else.
   */
  async fork(from: FerretId, at: TurnRef | undefined, into: ForkTarget): Promise<ForkPlan> {
    if (!into.folder.startsWith('/')) throw new Error('the folder to fork into must be an absolute path');
    const source = await resolveTranscriptFile(core, from);
    if (source === undefined) throw new Error('this ferret has no conversation on disk to fork');
    if (source.stat.size > MAX_FORK_BYTES) throw new Error('that conversation is too large to fork (over 256 MB)');
    const lines = linesOf(await source.home.readBytes(source.file, MAX_FORK_BYTES));
    const cut = cutAfter(lines, at);
    if (typeof cut === 'string') throw new Error(cut);
    const kept = lines.slice(0, cut);
    if (kept.length === 0) throw new Error('there is nothing in that conversation to fork');

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
    const written = file.value;
    const identity = await pool.fileIdentity(written).catch(() => undefined);

    return {
      from,
      ...(at === undefined ? {} : { at }),
      harnessConversation: id,
      discard: async () => {
        // Only the file this fork made: a name that no longer reaches it is left exactly as it is.
        if (identity === undefined)
          throw new Error(`the forked conversation ${id} was not proved to be this fork's own, so it was kept`);
        const now = await pool.fileIdentity(written);
        // Gone already, or another file now: nothing of this fork's to remove.
        if (now === undefined || now.device !== identity.device || now.inode !== identity.inode) return;
        await pool.remove(written);
      },
    };
  },
});
