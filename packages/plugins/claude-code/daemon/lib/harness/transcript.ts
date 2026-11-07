import type { TranscriptEntry, TurnUsage } from '@ferretry/core-ferrets/contract';
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

/** One transcript line as an entry, or `undefined` when it is not a conversation record. */
export function parseEntry(line: string): TranscriptEntry | undefined {
  let record: Json | undefined;
  try {
    record = asObject(JSON.parse(line));
  } catch {
    return undefined;
  }
  if (record === undefined) return undefined;
  const role = record.type === 'user' || record.type === 'assistant' ? record.type : undefined;
  const id = typeof record.uuid === 'string' ? record.uuid : undefined;
  const at = asInstant(record.timestamp);
  if (role === undefined || id === undefined || at === undefined) return undefined;
  const message = asObject(record.message);
  const content = message?.content;
  const blocks = Array.isArray(content) ? content.map(asObject) : [];
  const tool = blocks.some(block => block?.type === 'tool_use' || block?.type === 'tool_result');
  const text = textOf(content);
  return {
    id,
    at,
    role: tool && text === undefined ? 'tool' : role,
    ...(text === undefined ? {} : { text }),
  };
}

/** Every entry in a transcript's text, in order. */
export function parseEntries(text: string): readonly TranscriptEntry[] {
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .flatMap(line => {
      const entry = parseEntry(line);
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
