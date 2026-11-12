import type { HarnessTailRecord, TranscriptEntry, TurnUsage } from '@ferretry/core-ferrets/contract';
import type { Instant } from '@ferretry/std';

/**
 * READING CLAUDE CODE'S OWN RECORD OF A CONVERSATION (the transcript): one JSON object per line under
 * `<home>/projects/<folder>/<conversation>.jsonl`. Only the shapes a reader needs: who spoke, what they said,
 * and what each assistant turn spent. A line that is not one of those is skipped, never an error, because the
 * harness writes many other record kinds.
 */

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;

const asInstant = (value: unknown): Instant | undefined =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? (value as Instant) : undefined;

/** The visible text of a message's content: a string, or the text blocks of a list. */
function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap(block => {
    const object = asObject(block);
    return object?.type === 'text' && typeof object.text === 'string' ? [object.text] : [];
  });
  return parts.length === 0 ? undefined : parts.join('\n');
}

/**
 * What `data` says of an entry that is NOT a message but the harness's own record of an input it held or drained
 * (#45, the send tracker's proof; no contract change: `TranscriptEntry.data` carries it). Conversation reads these two
 * words and the entry's masked `text` and `at`, and shows such an entry as no message at all.
 *  - `queue-operation`: Claude's record of its input queue (`operation` `enqueue` while it HOLDS a prompt typed mid-turn,
 *    `dequeue`/`remove` when it lets go of one);
 *  - `queued-prompt`: the record Claude writes when it DRAINS a held prompt into the conversation (`originatedAt`: when
 *    the person typed it).
 */
const QUEUE_OPERATION_PROOF = 'queue-operation';
const QUEUED_PROMPT_PROOF = 'queued-prompt';

/**
 * The tool calls and tool results a message record carries, by their ids (`tool_use.id`, `tool_result.tool_use_id`), as
 * `TranscriptEntry.tools`. A reader that must know whether ONE call was made or answered (the question watch) matches
 * these exactly: the ids are not in the entry's text, which holds only what a person would read. Kept out of `data`, which
 * Conversation shows as a tool entry's content. Absent when the record carries no such block.
 */
function toolIdentity(blocks: readonly (Json | undefined)[]): NonNullable<TranscriptEntry['tools']> {
  const ids = (type: string, field: string): string[] =>
    blocks.flatMap(block => (block?.type === type && typeof block[field] === 'string' ? [block[field] as string] : []));
  const calls = ids('tool_use', 'id');
  const results = ids('tool_result', 'tool_use_id');
  return {
    ...(calls.length === 0 ? {} : { calls }),
    ...(results.length === 0 ? {} : { results }),
  };
}

const QUEUE_OPERATIONS: ReadonlySet<string> = new Set(['enqueue', 'dequeue', 'remove']);

/** The input-proof entry a line is, or `undefined` (a prompt typed mid-turn, held or drained by Claude's own queue). */
function proofEntry(record: Json, ordinal: number): TranscriptEntry | undefined {
  const at = asInstant(record.timestamp);
  if (record.type === 'queue-operation') {
    const operation = typeof record.operation === 'string' ? record.operation : undefined;
    const content = typeof record.content === 'string' ? record.content : undefined;
    if (at === undefined || operation === undefined || !QUEUE_OPERATIONS.has(operation) || content === undefined)
      return undefined;
    return {
      id: `${QUEUE_OPERATION_PROOF}:${ordinal}`,
      at,
      role: 'system',
      text: content,
      data: { proof: QUEUE_OPERATION_PROOF, operation },
    };
  }
  if (record.type !== 'attachment') return undefined;
  const attachment = asObject(record.attachment);
  if (attachment?.type !== 'queued_command' || attachment.commandMode !== 'prompt') return undefined;
  if (asObject(attachment.origin)?.kind !== 'human') return undefined;
  const text = textOf(attachment.prompt);
  const originatedAt = asInstant(attachment.timestamp) ?? asInstant(record.timestamp);
  const drained = at ?? originatedAt;
  if (text === undefined || text.trim() === '' || drained === undefined) return undefined;
  return {
    id: typeof record.uuid === 'string' ? record.uuid : `${QUEUED_PROMPT_PROOF}:${ordinal}`,
    at: drained,
    role: 'system',
    text,
    data: { proof: QUEUED_PROMPT_PROOF, ...(originatedAt === undefined ? {} : { originatedAt }) },
  };
}

/**
 * One transcript line as an entry, or `undefined` when it is not a conversation record. `ordinal` is the line's place among
 * the transcript's lines: it names an input-proof record, which carries no id of its own (an append-only file keeps it).
 */
export function parseEntry(line: string, ordinal = 0): TranscriptEntry | undefined {
  let record: Json | undefined;
  try {
    record = asObject(JSON.parse(line));
  } catch {
    return undefined;
  }
  if (record === undefined) return undefined;
  const proof = proofEntry(record, ordinal);
  if (proof !== undefined) return proof;
  const role = record.type === 'user' || record.type === 'assistant' ? record.type : undefined;
  const id = typeof record.uuid === 'string' ? record.uuid : undefined;
  const at = asInstant(record.timestamp);
  if (role === undefined || id === undefined || at === undefined) return undefined;
  const message = asObject(record.message);
  const content = message?.content;
  const blocks = Array.isArray(content) ? content.map(asObject) : [];
  const tool = blocks.some(block => block?.type === 'tool_use' || block?.type === 'tool_result');
  const text = textOf(content);
  const identity = toolIdentity(blocks);
  return {
    id,
    at,
    role: tool && text === undefined ? 'tool' : role,
    ...(text === undefined ? {} : { text }),
    ...(Object.keys(identity).length === 0 ? {} : { tools: identity }),
  };
}

/** Every entry in a transcript's text, in order. */
export function parseEntries(text: string): readonly TranscriptEntry[] {
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .flatMap((line, ordinal) => {
      const entry = parseEntry(line, ordinal);
      return entry === undefined ? [] : [entry];
    });
}

/** What each assistant turn spent, from the usage record Claude writes on it. */
export function parseUsage(text: string): readonly TurnUsage[] {
  const turns: TurnUsage[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let record: Json | undefined;
    try {
      record = asObject(JSON.parse(line));
    } catch {
      continue;
    }
    if (record?.type !== 'assistant') continue;
    const at = asInstant(record.timestamp);
    const message = asObject(record.message);
    const usage = asObject(message?.usage);
    if (at === undefined || usage === undefined) continue;
    const num = (value: unknown): number | undefined => (typeof value === 'number' && value >= 0 ? value : undefined);
    const input = num(usage.input_tokens);
    const output = num(usage.output_tokens);
    if (input === undefined || output === undefined) continue;
    const cacheRead = num(usage.cache_read_input_tokens);
    const cacheWrite = num(usage.cache_creation_input_tokens);
    turns.push({
      turn: turns.length + 1,
      at,
      ...(typeof message?.model === 'string' ? { model: message.model } : {}),
      inputTokens: input,
      outputTokens: output,
      ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    });
  }
  return turns;
}

const TAIL_USER_ROLES = new Set(['user', 'assistant']);

/**
 * The records of a window cut from the end of a file, with the turn marked as at work when the window cannot say where
 * the turn stands. A cut window drops its first line (the end of a record whose start is outside it), and what that cut
 * record was is unknown: a pasted image, a big tool result, a final message. So unless a message, a piece of work or a
 * turn boundary is read whole in the window, the turn is at work (never "no records": one idle-looking frame then
 * cannot end it). Records that say nothing of the turn (usage, a compaction, an error, a developer or system note) or
 * an unfinished last line after the cut one change nothing: only a record that says where the turn stands decides, and
 * that is the set the turn fold itself reads (it skips developer and system notes). Pure.
 */
export function markCutWindow(records: readonly HarnessTailRecord[], partial: boolean): readonly HarnessTailRecord[] {
  if (!partial) return records;
  if (records.some(decidesTurn)) return records;
  return [...records, { kind: 'work' }];
}

/** A record the turn fold reads for where the turn stands: not a developer or system note, which it skips. */
function decidesTurn(record: HarnessTailRecord): boolean {
  if (record.kind === 'message') return record.role === 'user' || record.role === 'assistant';
  return record.kind === 'work' || record.kind === 'turn';
}

/**
 * The records the turn watch and the live readout read from a transcript's END, without their text (`HarnessTailRecord`):
 * who spoke or worked and when, what each model call spent, where a turn ended and where the context was compacted.
 * `partial` says the text begins mid-record (a window cut from the end of a file), so its first line is not read.
 * A line that is not one of those is skipped, never an error.
 */
export function parseTail(text: string, partial: boolean): readonly HarnessTailRecord[] {
  const lines = text.split('\n');
  if (partial) lines.shift();
  const records: HarnessTailRecord[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    let record: Json | undefined;
    try {
      record = asObject(JSON.parse(line));
    } catch {
      continue;
    }
    if (record === undefined) continue;
    const at = asInstant(record.timestamp);
    const when = at === undefined ? {} : { at };
    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      const metadata = asObject(record.compactMetadata);
      const before =
        typeof metadata?.preTokens === 'number' && metadata.preTokens >= 0 ? metadata.preTokens : undefined;
      const after =
        typeof metadata?.postTokens === 'number' && metadata.postTokens >= 0 ? metadata.postTokens : undefined;
      const trigger = metadata?.trigger === 'manual' || metadata?.trigger === 'auto' ? metadata.trigger : undefined;
      records.push({
        kind: 'compaction',
        ...when,
        ...(trigger === undefined ? {} : { trigger }),
        ...(before === undefined ? {} : { tokensBefore: before }),
        ...(after === undefined ? {} : { tokensAfter: after }),
      });
      continue;
    }
    if (typeof record.type !== 'string' || !TAIL_USER_ROLES.has(record.type)) continue;
    // The summary Claude writes after compaction is the harness tidying its context, never a turn boundary or work.
    if (record.isCompactSummary === true) continue;
    const message = asObject(record.message);
    const content = message?.content;
    const blocks = Array.isArray(content) ? content.map(asObject) : [];
    const working = blocks.some(
      block => block?.type === 'tool_use' || block?.type === 'tool_result' || block?.type === 'thinking',
    );
    const hasText = typeof content === 'string' || blocks.some(block => block?.type === 'text');
    const origin = asObject(record.origin)?.kind;
    const harnessWrote =
      record.isMeta === true ||
      record.isSidechain === true ||
      record.isVisibleInTranscriptOnly === true ||
      (typeof origin === 'string' && origin !== '' && origin !== 'human');
    if (record.type === 'user') {
      if (hasText && !working)
        records.push({
          kind: 'message',
          role: 'user',
          ...when,
          ...(harnessWrote ? { inputSource: 'harness' as const } : {}),
        });
      else if (working) records.push({ kind: 'work', ...when });
      continue;
    }
    if (hasText && !working)
      records.push({
        kind: 'message',
        role: 'assistant',
        ...when,
        ...(message?.model === '<synthetic>' ? { inputSource: 'harness' as const } : {}),
      });
    else records.push({ kind: 'work', ...when });
    const usage = asObject(message?.usage);
    const num = (value: unknown): number | undefined => (typeof value === 'number' && value >= 0 ? value : undefined);
    const input = num(usage?.input_tokens);
    const output = num(usage?.output_tokens);
    if (usage !== undefined && (input !== undefined || output !== undefined)) {
      const cached = num(usage.cache_read_input_tokens);
      const created = num(usage.cache_creation_input_tokens);
      records.push({
        kind: 'usage',
        ...when,
        ...(typeof message?.id === 'string' ? { call: message.id } : {}),
        ...(input === undefined ? {} : { inputTokens: input }),
        ...(output === undefined ? {} : { outputTokens: output }),
        ...(cached === undefined ? {} : { cachedInputTokens: cached }),
        ...(created === undefined ? {} : { cacheCreationInputTokens: created }),
        contextTokens: (input ?? 0) + (cached ?? 0) + (created ?? 0),
      });
    }
    if (message?.stop_reason === 'end_turn') records.push({ kind: 'turn', state: 'completed', ...when });
  }
  return records;
}
