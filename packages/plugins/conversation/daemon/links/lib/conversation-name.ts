import type { TranscriptHarness as Harness } from '../../reader/lib/transcript/types.ts';
import { SOURCE_TEXT_MAX } from './conversation-text.ts';

/**
 * The NAME a CLI gave a conversation, read out of its transcript with no parser: a name is a record
 * of its own that no message event carries.
 *
 *   Claude Code  `{"type":"custom-title","customTitle":…}` (and `agent-name`) is what the owner typed with
 *                `/rename`; `{"type":"ai-title","aiTitle":…}` and `{"type":"summary","summary":…}` are the
 *                titles it generated. The owner's own name outranks a generated one; within a kind, the
 *                latest record wins.
 *   Codex        `{"type":"event_msg","payload":{"type":"thread_name_updated","thread_name":…}}`, latest
 *                wins. (`session_index.jsonl` holds the same names; see {@link codexIndexNames}.)
 */

/**
 * A record's name as written (lines kept, not cut short), or `undefined` when it is not a usable string. A name is masked for
 * secrets (`cleanTitle`) before it is collapsed to one line and cut, so a value spanning a line or the cut is still found.
 */
const cleaned = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const name = value.slice(0, SOURCE_TEXT_MAX).trim();
  return name === '' ? undefined : name;
};

/**
 * The JSON records of `text`, one per line. With `only`, a line that holds none of these strings is not parsed at all: a record
 * that names a conversation spells its type in the line, so every other line (the bulk of a transcript) is skipped unread.
 */
const records = function* (text: string, only?: readonly string[]): Generator<Record<string, unknown>> {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    if (only !== undefined && !only.some(needle => line.includes(needle))) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value === 'object' && value !== null) yield value as Record<string, unknown>;
  }
};

const CODEX_NAME_MARKS = ['thread_name_updated'] as const;
const CLAUDE_NAME_MARKS = ['custom-title', 'agent-name', 'ai-title', '"summary"'] as const;

/** The names a transcript records, by who gave them: the owner (`chosen`), or the CLI (`generated`). */
export interface TranscriptNames {
  readonly chosen?: string;
  readonly generated?: string;
}

/** Each kind of name a transcript records, the latest of each. */
export function transcriptNames(harness: Harness, text: string): TranscriptNames {
  let chosen: string | undefined;
  let generated: string | undefined;
  for (const record of records(text, harness === 'codex' ? CODEX_NAME_MARKS : CLAUDE_NAME_MARKS)) {
    if (harness === 'codex') {
      const payload = record.payload;
      if (
        record.type === 'event_msg' &&
        typeof payload === 'object' &&
        payload !== null &&
        (payload as Record<string, unknown>).type === 'thread_name_updated'
      )
        chosen = cleaned((payload as Record<string, unknown>).thread_name) ?? chosen;
      continue;
    }
    if (record.type === 'custom-title') chosen = cleaned(record.customTitle) ?? chosen;
    else if (record.type === 'agent-name') chosen = cleaned(record.agentName) ?? chosen;
    else if (record.type === 'ai-title') generated = cleaned(record.aiTitle) ?? generated;
    else if (record.type === 'summary') generated = cleaned(record.summary) ?? generated;
  }
  return { ...(chosen === undefined ? {} : { chosen }), ...(generated === undefined ? {} : { generated }) };
}

/** Codex's `session_index.jsonl`: each line `{id, thread_name, updated_at}`; the latest line per id wins. */
export function codexIndexNames(text: string): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const record of records(text)) {
    const name = cleaned(record.thread_name);
    if (typeof record.id === 'string' && name !== undefined) names.set(record.id, name);
  }
  return names;
}
